import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { searchTerms } from '../../shared/classify.js';
import { remainingAtPause } from '../../shared/sla.js';
import { CATEGORIES, type CatalogItem, type FormField, type Ticket, type User } from '../../shared/types.js';
import { sha256 } from '../auth.js';
import { subjectTag } from '../mail.js';
import { TICKET_SELECT, addMessage, getTicket, safeJson, toTicket, workspaceHours } from '../repo.js';
import type { Module, ModuleContext } from './index.js';

type Row = Record<string, unknown>;
export const toItem = (r: Row): CatalogItem => ({
  id: r.id as number, name: r.name as string, description: r.description as string, icon: r.icon as string,
  category: r.category as CatalogItem['category'], keywords: r.keywords as string, fields: safeJson<FormField[]>(r.fields as string, []),
  needsApproval: r.needs_approval as boolean, priority: r.priority as CatalogItem['priority'], active: r.active as boolean,
});

/**
 * "I need Adobe Acrobat" → the "New software" request, with "Adobe Acrobat" already filled in.
 * Scores each request by the words it shares with what the person typed (its name counts double),
 * then fills the first short text field with whatever follows "need/want/request", and the first
 * long one with the reason ("…for drawing floor plans").
 */
export function matchRequest(items: CatalogItem[], text: string): { item: CatalogItem; score: number; prefill: Record<string, string> }[] {
  const words = searchTerms(text);
  if (!words.length) return [];
  const stem = (w: string) => w.replace(/(ing|es|s)$/, '');
  const scored = items.map((item) => {
    const name = searchTerms(item.name).map(stem);
    const keys = searchTerms(`${item.keywords} ${item.description}`).map(stem);
    let score = 0;
    for (const w of words.map(stem)) {
      if (name.includes(w)) score += 2;
      else if (keys.some((k) => k === w || (w.length > 4 && k.startsWith(w)))) score += 1;
    }
    const what = text.match(/\b(?:need|want|request|get|install|access to|order)\s+(?:a |an |the |new |some )?(.{2,60}?)(?:[.,!?]|$| for | so | because )/i)?.[1]?.trim();
    const first = item.fields.find((f) => f.type === 'text');
    const prefill: Record<string, string> = {};
    if (what && first) prefill[first.key] = what.replace(/^(software|access|a licence for|a license for)\s+/i, '');
    const why = text.match(/\b(?:for|so (?:that )?|because)\s+(.{3,160}?)\s*(?:[.!?]|$)/i)?.[1]?.trim();
    const long = item.fields.find((f) => f.type === 'textarea');
    if (why && long) prefill[long.key] = why.charAt(0).toUpperCase() + why.slice(1);
    return { item, score, prefill };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

function describe(item: CatalogItem, form: Record<string, string>) {
  return item.fields.filter((f) => form[f.label]).map((f) => `${f.label}: ${form[f.label]}`).join('\n');
}

/** A signed, single-use link for approving from an email, valid for 7 days. */
async function approvalLink(ctx: ModuleContext, c: Context, ticketId: number, userId: number) {
  const token = randomBytes(24).toString('base64url');
  await ctx.db.query(`INSERT INTO approval_links (token_hash, ticket_id, user_id, expires_at) VALUES ($1, $2, $3, now() + interval '7 days')`, [sha256(token), ticketId, userId]);
  return `${ctx.appUrl(c)}/#/approve/${token}`;
}

/** Approve or decline. Approving starts the clock; declining closes the request and says why. */
async function decide(ctx: ModuleContext, c: Context, t: Ticket, decider: { id: number; name: string }, decision: 'approve' | 'decline', comment: string, workspaceId: number) {
  if (t.approval !== 'pending') return { error: 'This request has already been decided' };
  if (decision === 'approve') {
    const hours = await workspaceHours(ctx.db, workspaceId);
    const r = await ctx.resumeSets(t, hours);
    await ctx.db.query(
      `UPDATE tickets SET approval = 'approved', approved_at = now(), status = 'open', updated_at = now(), ${r.sql.join(', ')}, due_at = $2, response_due_at = $3 WHERE id = $1`,
      [t.id, ...r.params],
    );
    await addMessage(ctx.db, t.id, decider.id, 'event', `Approved by ${decider.name}${comment ? `: “${comment}”` : ''} · now with IT`);
    ctx.later(ctx.mailer.send(ctx.db, {
      workspaceId, to: t.requester.email, kind: 'reply', ticketId: t.id, logOnly: await isDemo(ctx, workspaceId),
      subject: `${subjectTag(t.key)} Approved: ${t.subject}`,
      body: `Good news: ${decider.name} approved your request. IT will take it from here.${comment ? `\n\n“${comment}”` : ''}\n\nTrack it: ${ctx.appUrl(c)}/#/t/${t.id}`,
    }));
  } else {
    await ctx.db.query(
      `UPDATE tickets SET approval = 'rejected', status = 'solved', solved_at = now(), updated_at = now(), paused_at = NULL,
              resolution = $2, first_response_at = COALESCE(first_response_at, now()) WHERE id = $1`,
      [t.id, `Declined by ${decider.name}${comment ? `: ${comment}` : ''}`],
    );
    await addMessage(ctx.db, t.id, decider.id, 'event', `Declined by ${decider.name}${comment ? `: “${comment}”` : ''}`);
    ctx.later(ctx.mailer.send(ctx.db, {
      workspaceId, to: t.requester.email, kind: 'reply', ticketId: t.id, logOnly: await isDemo(ctx, workspaceId),
      subject: `${subjectTag(t.key)} Not approved: ${t.subject}`,
      body: `${decider.name} didn’t approve this request.${comment ? `\n\n“${comment}”` : ''}\n\nQuestions? Reply to this email.`,
    }));
  }
  await ctx.db.query('DELETE FROM approval_links WHERE ticket_id = $1', [t.id]);
  ctx.emit(workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester.id, approverId: t.approver?.id, actorId: decider.id });
  ctx.emit(workspaceId, { type: 'approval', approverId: t.approver?.id });
  return { ok: true };
}

const isDemo = async (ctx: ModuleContext, workspaceId: number) =>
  (await ctx.db.query<{ demo: boolean }>('SELECT demo FROM workspaces WHERE id = $1', [workspaceId])).rows[0]?.demo ?? false;

const fieldSchema = z.object({
  key: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'textarea', 'select', 'date']), options: z.array(z.string().max(80)).max(30).optional(), required: z.boolean().optional(),
});
const itemSchema = z.object({
  name: z.string().trim().min(2, 'Name it').max(80), description: z.string().trim().max(400).default(''), icon: z.string().trim().max(8).default('📦'),
  category: z.enum(CATEGORIES).default('Other'), keywords: z.string().trim().max(300).default(''), fields: z.array(fieldSchema).max(12).default([]),
  needsApproval: z.boolean().default(true), priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(4), active: z.boolean().default(true),
});

export const requests: Module = {
  /** One-click approvals from email: the link opens a page that shows the request; the decision is a POST. */
  public(app, ctx) {
    const lookup = async (token: string) => {
      const { rows } = await ctx.db.query<{ ticket_id: number; user_id: number; name: string; workspace_id: number }>(
        `SELECT l.ticket_id, l.user_id, u.name, u.workspace_id FROM approval_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = $1 AND l.expires_at > now()`,
        [sha256(token)],
      );
      return rows[0];
    };
    app.get('/api/approve/:token', async (c) => {
      const link = await lookup(c.req.param('token'));
      if (!link) return c.json({ error: 'This approval link has expired or was already used.' }, 404);
      const t = await getTicket(ctx.db, link.workspace_id, link.ticket_id);
      if (!t) return c.json({ error: 'Not found' }, 404);
      return c.json({ approver: link.name, ticket: { key: t.key, subject: t.subject, requester: t.requester.name, department: t.requester.department, form: t.form, description: t.description, approval: t.approval, createdAt: t.createdAt } });
    });
    app.post('/api/approve/:token', async (c) => {
      const link = await lookup(c.req.param('token'));
      if (!link) return c.json({ error: 'This approval link has expired or was already used.' }, 404);
      const p = z.object({ decision: z.enum(['approve', 'decline']), comment: z.string().trim().max(500).default('') }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const t = await getTicket(ctx.db, link.workspace_id, link.ticket_id);
      if (!t) return c.json({ error: 'Not found' }, 404);
      const r = await decide(ctx, c, t, { id: link.user_id, name: link.name }, p.data.decision, p.data.comment, link.workspace_id);
      if ('error' in r) return c.json(r, 409);
      await ctx.audit(c, link.workspace_id, link.user_id, p.data.decision === 'approve' ? 'request.approved' : 'request.declined', t.key, 'from the email link');
      return c.json({ ok: true });
    });
  },

  private(app, ctx) {
    const { db } = ctx;
    app.get('/api/catalog', async (c) => {
      const u = c.get('user');
      const { rows } = await db.query(`SELECT * FROM catalog_items WHERE workspace_id = $1 ${ctx.isAgent(u) ? '' : 'AND active'} ORDER BY name`, [u.workspaceId]);
      return c.json({ items: rows.map(toItem) });
    });

    app.get('/api/catalog/match', async (c) => {
      const u = c.get('user');
      const { rows } = await db.query('SELECT * FROM catalog_items WHERE workspace_id = $1 AND active', [u.workspaceId]);
      const q = (c.req.query('q') ?? '').slice(0, 300);
      return c.json({ matches: matchRequest(rows.map(toItem), q).map((m) => ({ item: m.item, prefill: m.prefill })) });
    });

    app.post('/api/catalog', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const p = itemSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = p.data;
      const { rows } = await db.query('INSERT INTO catalog_items (workspace_id, name, description, icon, category, keywords, fields, needs_approval, priority, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [
        u.workspaceId, d.name, d.description, d.icon, d.category, d.keywords, JSON.stringify(d.fields), d.needsApproval, d.priority, d.active,
      ]);
      await ctx.audit(c, u.workspaceId, u.id, 'catalog.created', d.name);
      return c.json({ item: toItem(rows[0]) }, 201);
    });

    app.put('/api/catalog/:id', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const p = itemSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = p.data;
      const { rows } = await db.query('UPDATE catalog_items SET name=$3, description=$4, icon=$5, category=$6, keywords=$7, fields=$8, needs_approval=$9, priority=$10, active=$11 WHERE workspace_id=$1 AND id=$2 RETURNING *', [
        u.workspaceId, ctx.idOf(c), d.name, d.description, d.icon, d.category, d.keywords, JSON.stringify(d.fields), d.needsApproval, d.priority, d.active,
      ]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      await ctx.audit(c, u.workspaceId, u.id, 'catalog.updated', d.name);
      return c.json({ item: toItem(rows[0]) });
    });

    /** Makes a request. If it needs approval, the clock waits and the person's manager is asked. */
    app.post('/api/requests', async (c) => {
      const u = c.get('user');
      const p = z.object({ itemId: z.number().int().positive(), form: z.record(z.string(), z.string().max(2000)).default({}), note: z.string().trim().max(2000).default('') }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const { rows } = await db.query('SELECT * FROM catalog_items WHERE workspace_id = $1 AND id = $2 AND active', [u.workspaceId, p.data.itemId]);
      if (!rows[0]) return c.json({ error: 'That request type isn’t available' }, 404);
      const item = toItem(rows[0]);
      const form: Record<string, string> = {};
      for (const f of item.fields) {
        const v = (p.data.form[f.key] ?? '').trim();
        if (f.required && !v) return c.json({ error: `Fill in “${f.label}”`, field: `form.${f.key}` }, 400);
        if (f.type === 'select' && v && !f.options?.includes(v)) return c.json({ error: `Pick one of the options for “${f.label}”`, field: `form.${f.key}` }, 400);
        if (v) form[f.label] = v;
      }
      const summary = Object.values(form)[0];
      const t0 = await ctx.createTicket(c, u.workspaceId, u.id, u, {
        subject: `${item.name}${summary ? `: ${summary}` : ''}`.slice(0, 140),
        description: [describe(item, form), p.data.note].filter(Boolean).join('\n\n'),
        category: item.category, priority: item.priority, channel: 'portal',
      }, []);
      await db.query(`UPDATE tickets SET kind = 'request', catalog_item_id = $2, form = $3 WHERE id = $1`, [t0.id, item.id, JSON.stringify(form)]);

      if (item.needsApproval) {
        // The manager approves; with no manager on file, an admin does (never the person asking).
        const mgr = await db.query<{ id: number; name: string; email: string }>(
          `SELECT m.id, m.name, m.email FROM users u JOIN users m ON m.id = u.manager_id WHERE u.id = $1
           UNION ALL SELECT id, name, email FROM (SELECT id, name, email FROM users WHERE workspace_id = $2 AND role = 'admin' AND id <> $1 ORDER BY id LIMIT 1) a
           LIMIT 1`,
          [u.id, u.workspaceId],
        );
        const approver = mgr.rows[0];
        if (approver) {
          const hours = await workspaceHours(db, u.workspaceId);
          const t = (await getTicket(db, u.workspaceId, t0.id))!;
          const left = remainingAtPause(t, new Date(), hours);
          await db.query(
            `UPDATE tickets SET approval = 'pending', approver_id = $2, status = 'waiting', paused_at = now(), paused_resolve_left = $3, paused_respond_left = $4,
                    waiting_reason = $5 WHERE id = $1`,
            [t0.id, approver.id, left.resolve, left.respond, `Waiting for approval from ${approver.name}`],
          );
          await addMessage(db, t0.id, null, 'event', `Sent to ${approver.name} for approval · the clock waits until then`);
          const link = await approvalLink(ctx, c, t0.id, approver.id);
          ctx.later(ctx.mailer.send(db, {
            workspaceId: u.workspaceId, to: approver.email, kind: 'reply', ticketId: t0.id, logOnly: u.demo,
            subject: `${subjectTag(t0.key)} Approval needed: ${item.name} for ${u.name}`,
            body: `${u.name} asked for: ${item.name}\n\n${describe(item, form)}${p.data.note ? `\n\n“${p.data.note}”` : ''}\n\nApprove or decline with one click (no sign-in needed):\n${link}`,
            logBody: `${u.name} asked for: ${item.name}\n\n${describe(item, form)}\n\n(One-click approve/decline link included; links aren't stored.)`,
          }));
          ctx.emit(u.workspaceId, { type: 'approval', approverId: approver.id, ticketId: t0.id });
        }
      }
      return c.json({ ticket: await getTicket(db, u.workspaceId, t0.id) }, 201);
    });

    /** Requests waiting for my decision. */
    app.get('/api/approvals', async (c) => {
      const u = c.get('user');
      const { rows } = await db.query<Row>(`SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.approver_id = $2 AND t.approval = 'pending' ORDER BY t.created_at`, [u.workspaceId, u.id]);
      return c.json({ tickets: rows.map(toTicket) });
    });

    app.post('/api/approvals/:id', async (c) => {
      const u: User = c.get('user');
      const t = await getTicket(db, u.workspaceId, ctx.idOf(c));
      if (!t || (t.approver?.id !== u.id && u.role !== 'admin')) return c.json({ error: 'Not found' }, 404);
      const p = z.object({ decision: z.enum(['approve', 'decline']), comment: z.string().trim().max(500).default('') }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const r = await decide(ctx, c, t, u, p.data.decision, p.data.comment, u.workspaceId);
      if ('error' in r) return c.json(r, 409);
      await ctx.audit(c, u.workspaceId, u.id, p.data.decision === 'approve' ? 'request.approved' : 'request.declined', t.key);
      return c.json({ ticket: await getTicket(db, u.workspaceId, t.id) });
    });

    /** Admins set who approves whose requests. */
    app.patch('/api/people/:id/manager', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ managerId: z.number().int().positive().nullable() }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const id = ctx.idOf(c);
      if (p.data.managerId === id) return c.json({ error: 'Someone can’t be their own manager' }, 400);
      if (p.data.managerId) {
        const ok = await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2', [p.data.managerId, u.workspaceId]);
        if (!ok.rows.length) return c.json({ error: 'Unknown person' }, 400);
      }
      const { rows } = await db.query('UPDATE users SET manager_id = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id', [u.workspaceId, id, p.data.managerId]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      await ctx.audit(c, u.workspaceId, u.id, 'person.manager_changed', String(id));
      return c.json({ ok: true });
    });
  },
};
