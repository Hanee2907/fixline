import { z } from 'zod';
import { searchTerms } from '../../shared/classify.js';
import { isOpen, type Hours } from '../../shared/hours.js';
import type { Change, Person, RiskReason, Role } from '../../shared/types.js';
import type { Db } from '../db.js';
import { iso, safeJson, workspaceHours } from '../repo.js';
import type { Module } from './index.js';

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const CORE = /\b(all|everyone|company|server|servers|network|firewall|email|exchange|vpn|erp|database|domain|active directory|wi-?fi|internet|payroll|production)\b/i;

export interface ChangeDraft { title: string; affects: string; plan: string; rollback: string; plannedStart: number; plannedEnd: number }

/**
 * Works out how risky a change is, so nobody has to fill in a risk questionnaire.
 * Every reason is shown in plain words with its points, so the score can be challenged.
 */
export function assessRisk(d: ChangeDraft, ctx: { hours: Hours; now: number; clashes: number; similarFailures: number }): Change['risk'] {
  const reasons: RiskReason[] = [];
  const add = (points: number, text: string) => reasons.push({ points, text });
  if (CORE.test(`${d.title} ${d.affects}`)) add(25, 'Touches a service many people rely on');
  // Does the window overlap working hours? Sample every 15 minutes.
  let duringHours = false;
  for (let t = d.plannedStart; t < d.plannedEnd && !duringHours; t += 15 * 60_000) duringHours = isOpen(t, ctx.hours);
  if (duringHours) add(20, 'Happens while people are working');
  const length = (d.plannedEnd - d.plannedStart) / HOUR;
  if (length > 6) add(20, `Long window (${Math.round(length)} hours)`);
  else if (length > 2) add(10, `Window over 2 hours`);
  if (d.rollback.trim().length < 15) add(25, 'No clear way to undo it');
  if (d.plan.trim().length < 15) add(10, 'Steps not written down');
  if (d.plannedStart - ctx.now < 24 * HOUR) add(15, 'Less than a day’s notice');
  if (ctx.clashes) add(20, `Overlaps ${ctx.clashes} other change${ctx.clashes === 1 ? '' : 's'}`);
  if (ctx.similarFailures) add(Math.min(30, ctx.similarFailures * 15), `${ctx.similarFailures} similar change${ctx.similarFailures === 1 ? '' : 's'} failed recently`);
  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  return { score, level: score < 30 ? 'low' : score < 60 ? 'medium' : 'high', reasons };
}

const SELECT = `
  c.*, r.name AS r_name, r.email AS r_email, r.role AS r_role, r.department AS r_dept,
  a.name AS a_name, a.email AS a_email, a.role AS a_role, a.department AS a_dept
  FROM changes c LEFT JOIN users r ON r.id = c.requested_by LEFT JOIN users a ON a.id = c.approved_by`;

const person = (r: Row, p: 'r' | 'a', id: unknown): Person | null =>
  id ? ({ id, name: r[`${p}_name`], email: r[`${p}_email`], role: r[`${p}_role`] as Role, department: r[`${p}_dept`] } as Person) : null;

function toChange(r: Row, all: Row[]): Change {
  const start = Date.parse(iso(r.planned_start));
  const end = Date.parse(iso(r.planned_end));
  const score = r.risk_score as number;
  return {
    id: r.id as number, key: `CHG-${r.number}`, title: r.title as string, description: r.description as string, plan: r.plan as string,
    rollback: r.rollback as string, affects: r.affects as string, status: r.status as Change['status'],
    plannedStart: iso(r.planned_start), plannedEnd: iso(r.planned_end),
    risk: { score, level: score < 30 ? 'low' : score < 60 ? 'medium' : 'high', reasons: safeJson<RiskReason[]>(r.risk_reasons as string, []) },
    requestedBy: person(r, 'r', r.requested_by), approvedBy: person(r, 'a', r.approved_by), outcome: r.outcome as string,
    problemId: (r.problem_id as number) ?? null,
    clashes: all.filter((o) => o.id !== r.id && ['pending', 'approved'].includes(o.status as string) && ['pending', 'approved'].includes(r.status as string)
      && Date.parse(iso(o.planned_start)) < end && Date.parse(iso(o.planned_end)) > start)
      .map((o) => ({ id: o.id as number, key: `CHG-${o.number}`, title: o.title as string })),
  };
}

async function context(db: Db, ws: number, d: ChangeDraft, excludeId = 0) {
  const clashes = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM changes WHERE workspace_id = $1 AND id <> $2 AND status IN ('pending','approved') AND planned_start < $4 AND planned_end > $3`,
    [ws, excludeId, new Date(d.plannedStart), new Date(d.plannedEnd)],
  );
  const failed = await db.query<{ title: string; affects: string }>(`SELECT title, affects FROM changes WHERE workspace_id = $1 AND status = 'failed' AND created_at > now() - interval '120 days'`, [ws]);
  const mine = new Set(searchTerms(`${d.title} ${d.affects}`));
  const similarFailures = failed.rows.filter((f) => searchTerms(`${f.title} ${f.affects}`).filter((w) => mine.has(w)).length >= 1).length;
  return { hours: await workspaceHours(db, ws), now: Date.now(), clashes: Number(clashes.rows[0].n), similarFailures };
}

const draftSchema = z.object({
  title: z.string().trim().min(3, 'Say what’s changing').max(140), description: z.string().trim().max(4000).default(''),
  plan: z.string().trim().max(8000).default(''), rollback: z.string().trim().max(8000).default(''), affects: z.string().trim().max(300).default(''),
  plannedStart: z.iso.datetime({ offset: true }), plannedEnd: z.iso.datetime({ offset: true }), problemId: z.number().int().positive().nullable().default(null),
}).refine((d) => Date.parse(d.plannedEnd) > Date.parse(d.plannedStart), { message: 'It has to end after it starts', path: ['plannedEnd'] });

export const changes: Module = {
  private(app, ctx) {
    const { db } = ctx;
    const all = async (ws: number) => (await db.query<Row>(`SELECT ${SELECT} WHERE c.workspace_id = $1 ORDER BY c.planned_start`, [ws])).rows;

    app.get('/api/changes', ctx.agentOnly, async (c) => {
      const rows = await all(c.get('user').workspaceId);
      return c.json({ changes: rows.map((r) => toChange(r, rows)) });
    });

    /** Planned maintenance in the next day, for the banner employees see. */
    app.get('/api/maintenance', async (c) => {
      const { rows } = await db.query<{ title: string; affects: string; planned_start: string; planned_end: string }>(
        `SELECT title, affects, planned_start, planned_end FROM changes WHERE workspace_id = $1 AND status = 'approved'
          AND planned_end > now() AND planned_start < now() + interval '24 hours' ORDER BY planned_start`,
        [c.get('user').workspaceId],
      );
      return c.json({ maintenance: rows.map((r) => ({ title: r.title, affects: r.affects, start: iso(r.planned_start), end: iso(r.planned_end) })) });
    });

    /** Live risk while someone fills in the form. */
    app.post('/api/changes/risk', ctx.agentOnly, async (c) => {
      const p = draftSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = { ...p.data, plannedStart: Date.parse(p.data.plannedStart), plannedEnd: Date.parse(p.data.plannedEnd) };
      return c.json({ risk: assessRisk(d, await context(db, c.get('user').workspaceId, d)) });
    });

    app.post('/api/changes', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = draftSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = { ...p.data, plannedStart: Date.parse(p.data.plannedStart), plannedEnd: Date.parse(p.data.plannedEnd) };
      const risk = assessRisk(d, await context(db, u.workspaceId, d));
      // Low-risk changes are pre-approved: no meeting needed for routine work.
      const status = risk.level === 'low' ? 'approved' : 'pending';
      const n = Number((await db.query<{ n: number }>('SELECT COALESCE(max(number), 2000) + 1 AS n FROM changes WHERE workspace_id = $1', [u.workspaceId])).rows[0].n);
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO changes (workspace_id, number, title, description, plan, rollback, affects, status, planned_start, planned_end, risk_score, risk_reasons, requested_by, approved_by, problem_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [u.workspaceId, n, d.title, d.description, d.plan, d.rollback, d.affects, status, new Date(d.plannedStart), new Date(d.plannedEnd),
          risk.score, JSON.stringify(risk.reasons), u.id, status === 'approved' ? u.id : null, d.problemId],
      );
      await ctx.audit(c, u.workspaceId, u.id, 'change.created', `CHG-${n} ${d.title}`, `risk ${risk.score} (${risk.level})${status === 'approved' ? ', pre-approved' : ''}`);
      ctx.emit(u.workspaceId, { type: 'change' });
      return c.json({ id: rows[0].id, status, risk }, 201);
    });

    /** Approving needs an admin, and never the person who asked for it (unless they're the only admin). */
    app.post('/api/changes/:id/decide', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ decision: z.enum(['approve', 'reject']) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const ch = await db.query<{ requested_by: number; number: number }>(`SELECT requested_by, number FROM changes WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`, [u.workspaceId, ctx.idOf(c)]);
      if (!ch.rows[0]) return c.json({ error: 'Not waiting for approval' }, 409);
      const admins = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE workspace_id = $1 AND role = 'admin'`, [u.workspaceId])).rows[0].n);
      if (ch.rows[0].requested_by === u.id && admins > 1) return c.json({ error: 'Someone else has to approve your own change' }, 403);
      await db.query('UPDATE changes SET status = $3, approved_by = $4 WHERE workspace_id = $1 AND id = $2', [u.workspaceId, ctx.idOf(c), p.data.decision === 'approve' ? 'approved' : 'rejected', u.id]);
      await ctx.audit(c, u.workspaceId, u.id, `change.${p.data.decision === 'approve' ? 'approved' : 'rejected'}`, `CHG-${ch.rows[0].number}`);
      ctx.emit(u.workspaceId, { type: 'change' });
      return c.json({ ok: true });
    });

    app.post('/api/changes/:id/complete', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ result: z.enum(['done', 'failed', 'cancelled']), outcome: z.string().trim().max(4000).default('') }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const { rows } = await db.query<{ number: number }>(`UPDATE changes SET status = $3, outcome = $4 WHERE workspace_id = $1 AND id = $2 AND status IN ('approved','pending') RETURNING number`, [u.workspaceId, ctx.idOf(c), p.data.result, p.data.outcome]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      await ctx.audit(c, u.workspaceId, u.id, `change.${p.data.result}`, `CHG-${rows[0].number}`, p.data.outcome);
      ctx.emit(u.workspaceId, { type: 'change' });
      return c.json({ ok: true });
    });
  },
};
