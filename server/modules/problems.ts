import { z } from 'zod';
import { searchTerms } from '../../shared/classify.js';
import type { Category, Person, Problem, ProblemCandidate, Role } from '../../shared/types.js';
import { TICKET_SELECT, addMessage, getTicket, iso, isoOrNull, toTicket } from '../repo.js';
import type { Module } from './index.js';

type Row = Record<string, unknown>;

const SELECT = `
  p.*, w.prefix, u.name AS u_name, u.email AS u_email, u.role AS u_role, u.department AS u_dept,
  (SELECT count(*) FROM tickets t WHERE t.problem_id = p.id) AS linked,
  (SELECT count(*) FROM tickets t WHERE t.problem_id = p.id AND t.status <> 'solved') AS open_linked
  FROM problems p JOIN workspaces w ON w.id = p.workspace_id LEFT JOIN users u ON u.id = p.assignee_id`;

export const toProblem = (r: Row): Problem => ({
  id: r.id as number, key: `PRB-${r.number}`, title: r.title as string, description: r.description as string,
  status: r.status as Problem['status'], rootCause: r.root_cause as string, workaround: r.workaround as string,
  assignee: r.assignee_id ? ({ id: r.assignee_id, name: r.u_name, email: r.u_email, role: r.u_role as Role, department: r.u_dept } as Person) : null,
  linked: Number(r.linked ?? 0), openLinked: Number(r.open_linked ?? 0), createdAt: iso(r.created_at), resolvedAt: isoOrNull(r.resolved_at),
});

/**
 * Finds groups of recent tickets that look like one underlying problem, so nobody has to notice
 * by hand. Two tickets in the same category are linked when they share two meaningful words, or one
 * rare one; across categories they need three, so a passing word ("Teams", "work") can't chain
 * unrelated tickets together. Groups of three or more are suggested, biggest first, named after
 * the ticket that best represents the group.
 */
export function findCandidates(tickets: { id: number; key: string; subject: string; description: string; category: Category; createdAt: string }[]): ProblemCandidate[] {
  const terms = tickets.map((t) => new Set(searchTerms(`${t.subject} ${t.description}`).map((w) => w.replace(/(ing|ed|es|s)$/, ''))));
  const freq = new Map<string, number>();
  for (const set of terms) for (const w of set) freq.set(w, (freq.get(w) ?? 0) + 1);
  const parent = tickets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const shared = [...terms[i]].filter((w) => terms[j].has(w));
      const sameCategory = tickets[i].category === tickets[j].category;
      const rare = shared.length === 1 && (freq.get(shared[0]) ?? 0) <= Math.max(3, tickets.length / 4) && shared[0].length >= 3;
      const strong = sameCategory ? shared.length >= 2 || rare : shared.length >= 3;
      if (strong) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  tickets.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out: ProblemCandidate[] = [];
  for (const idx of groups.values()) {
    if (idx.length < 3) continue;
    const count = new Map<string, number>();
    for (const i of idx) for (const w of terms[i]) count.set(w, (count.get(w) ?? 0) + 1);
    const top = [...count.entries()].filter(([, n]) => n >= Math.ceil(idx.length / 2)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    const cats = new Map<Category, number>();
    for (const i of idx) cats.set(tickets[i].category, (cats.get(tickets[i].category) ?? 0) + 1);
    // The ticket sharing the most of the group's common words reads best as the group's name.
    const best = idx.reduce((a, b) => (top.filter((w) => terms[b].has(w)).length > top.filter((w) => terms[a].has(w)).length ? b : a), idx[0]);
    out.push({
      label: tickets[best].subject,
      ticketIds: idx.map((i) => tickets[i].id), keys: idx.map((i) => tickets[i].key),
      since: idx.map((i) => tickets[i].createdAt).sort()[0],
      category: [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
    });
  }
  return out.sort((a, b) => b.ticketIds.length - a.ticketIds.length);
}

export const problems: Module = {
  private(app, ctx) {
    const { db } = ctx;
    const nextNumber = async (ws: number) => Number((await db.query<{ n: number }>('SELECT COALESCE(max(number), 100) + 1 AS n FROM problems WHERE workspace_id = $1', [ws])).rows[0].n);

    app.get('/api/problems', ctx.agentOnly, async (c) => {
      const { rows } = await db.query<Row>(`SELECT ${SELECT} WHERE p.workspace_id = $1 ORDER BY (p.status = 'resolved'), p.created_at DESC`, [c.get('user').workspaceId]);
      return c.json({ problems: rows.map(toProblem) });
    });

    /** "5 similar VPN tickets in the last day": groups worth turning into a problem. */
    app.get('/api/problems/candidates', ctx.agentOnly, async (c) => {
      const { rows } = await db.query<Row>(
        `SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.created_at > now() - interval '3 days' AND t.problem_id IS NULL AND t.kind = 'incident'
          ORDER BY t.created_at DESC LIMIT 300`,
        [c.get('user').workspaceId],
      );
      return c.json({ candidates: findCandidates(rows.map(toTicket)).slice(0, 5) });
    });

    app.get('/api/problems/:id', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const { rows } = await db.query<Row>(`SELECT ${SELECT} WHERE p.workspace_id = $1 AND p.id = $2`, [u.workspaceId, ctx.idOf(c)]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      const tickets = await db.query<Row>(`SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.problem_id = $2 ORDER BY t.created_at DESC`, [u.workspaceId, rows[0].id]);
      return c.json({ problem: toProblem(rows[0]), tickets: tickets.rows.map(toTicket) });
    });

    app.post('/api/problems', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ title: z.string().trim().min(3, 'Name the problem').max(140), description: z.string().trim().max(4000).default(''), ticketIds: z.array(z.number().int().positive()).max(200).default([]) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const { rows } = await db.query<{ id: number }>('INSERT INTO problems (workspace_id, number, title, description, assignee_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [u.workspaceId, await nextNumber(u.workspaceId), p.data.title, p.data.description, u.id]);
      const id = rows[0].id;
      if (p.data.ticketIds.length) {
        const linked = await db.query<{ id: number }>('UPDATE tickets SET problem_id = $1, updated_at = now() WHERE workspace_id = $2 AND id = ANY($3::int[]) RETURNING id', [id, u.workspaceId, p.data.ticketIds]);
        for (const t of linked.rows) await addMessage(db, t.id, u.id, 'event', `Linked to problem: ${p.data.title}`);
      }
      await ctx.audit(c, u.workspaceId, u.id, 'problem.created', p.data.title, `${p.data.ticketIds.length} tickets`);
      ctx.emit(u.workspaceId, { type: 'problem' });
      return c.json({ id }, 201);
    });

    app.patch('/api/problems/:id', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({
        title: z.string().trim().min(3).max(140).optional(), description: z.string().trim().max(4000).optional(),
        status: z.enum(['investigating', 'known_error', 'resolved']).optional(), rootCause: z.string().trim().max(4000).optional(),
        workaround: z.string().trim().max(4000).optional(), assigneeId: z.number().int().positive().nullable().optional(),
      }).strict().safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = p.data;
      const { rows } = await db.query<{ id: number }>(
        `UPDATE problems SET title = COALESCE($3, title), description = COALESCE($4, description), status = COALESCE($5, status),
                root_cause = COALESCE($6, root_cause), workaround = COALESCE($7, workaround),
                assignee_id = CASE WHEN $8::boolean THEN $9 ELSE assignee_id END,
                resolved_at = CASE WHEN $5 = 'resolved' THEN COALESCE(resolved_at, now()) WHEN $5 IS NULL THEN resolved_at ELSE NULL END
          WHERE workspace_id = $1 AND id = $2 RETURNING id`,
        [u.workspaceId, ctx.idOf(c), d.title ?? null, d.description ?? null, d.status ?? null, d.rootCause ?? null, d.workaround ?? null, d.assigneeId !== undefined, d.assigneeId ?? null],
      );
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      if (d.status) await ctx.audit(c, u.workspaceId, u.id, 'problem.status', `PRB ${ctx.idOf(c)}`, d.status);
      ctx.emit(u.workspaceId, { type: 'problem' });
      return c.json({ ok: true });
    });

    /** Sends the workaround to everyone still waiting on a linked ticket, in one go. */
    app.post('/api/problems/:id/share-workaround', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const pr = await db.query<{ title: string; workaround: string }>('SELECT title, workaround FROM problems WHERE workspace_id = $1 AND id = $2', [u.workspaceId, ctx.idOf(c)]);
      if (!pr.rows[0]) return c.json({ error: 'Not found' }, 404);
      if (!pr.rows[0].workaround) return c.json({ error: 'Write the workaround first' }, 400);
      const { rows } = await db.query<{ id: number }>(`SELECT id FROM tickets WHERE workspace_id = $1 AND problem_id = $2 AND status <> 'solved'`, [u.workspaceId, ctx.idOf(c)]);
      for (const r of rows) {
        const text = `We know about this one and are fixing the cause. Until then, this works:\n\n${pr.rows[0].workaround}`;
        await addMessage(db, r.id, u.id, 'reply', text);
        await db.query(`UPDATE tickets SET first_response_at = COALESCE(first_response_at, now()), status = CASE WHEN status = 'new' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`, [r.id]);
        const t = await getTicket(db, u.workspaceId, r.id);
        if (t) {
          ctx.emit(u.workspaceId, { type: 'message', ticketId: t.id, requesterId: t.requester.id, actorId: u.id });
          ctx.later(ctx.notify.agentReplied(u.workspaceId, t, u.name, text, ctx.appUrl(c)));
        }
      }
      await db.query(`UPDATE problems SET status = 'known_error' WHERE id = $1 AND status = 'investigating'`, [ctx.idOf(c)]);
      ctx.emit(u.workspaceId, { type: 'problem' });
      return c.json({ sent: rows.length });
    });

    app.put('/api/tickets/:id/problem', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ problemId: z.number().int().positive().nullable() }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      if (p.data.problemId) {
        const ok = await db.query('SELECT 1 FROM problems WHERE workspace_id = $1 AND id = $2', [u.workspaceId, p.data.problemId]);
        if (!ok.rows.length) return c.json({ error: 'Unknown problem' }, 400);
      }
      const { rows } = await db.query('UPDATE tickets SET problem_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING id', [u.workspaceId, ctx.idOf(c), p.data.problemId]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      ctx.emit(u.workspaceId, { type: 'ticket', ticketId: ctx.idOf(c), actorId: u.id });
      return c.json({ ok: true });
    });
  },
};
