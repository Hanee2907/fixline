import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../app.js';
import { SLA, targetsFor } from '../../shared/sla.js';
import { CATEGORIES, type Rule, type RuleAction, type RuleCondition, type Ticket } from '../../shared/types.js';
import type { Db } from '../db.js';
import { TICKET_SELECT, addMessage, getTicket, isoOrNull, safeJson, toTicket, workspaceHours } from '../repo.js';
import type { Module, ModuleContext } from './index.js';

type Row = Record<string, unknown>;
const toRule = (r: Row): Rule => ({
  id: r.id as number, name: r.name as string, enabled: r.enabled as boolean,
  conditions: safeJson<RuleCondition[]>(r.conditions as string, []), actions: safeJson<RuleAction[]>(r.actions as string, []),
  runs: r.runs as number, lastRunAt: isoOrNull(r.last_run_at),
});

/** Does a ticket meet every condition? Comparisons ignore upper/lower case. */
export function matches(t: Ticket, conditions: RuleCondition[]): boolean {
  return conditions.every((c) => {
    const v = c.value.toLowerCase().trim();
    const field = c.field === 'category' ? t.category : c.field === 'priority' ? `p${t.priority}` : c.field === 'channel' ? t.channel
      : c.field === 'kind' ? t.kind : c.field === 'department' ? t.requester.department : `${t.subject} ${t.description}`;
    const f = field.toLowerCase();
    const want = c.field === 'priority' && /^\d$/.test(v) ? `p${v}` : v;
    if (c.op === 'contains' || c.field === 'text') return want.split(/\s*,\s*|\s+or\s+/).some((w) => w && f.includes(w)) === (c.op !== 'is_not');
    return c.op === 'is' ? f === want : f !== want;
  });
}

/** Runs the actions of one rule on one ticket, and says what it did in the ticket's history. */
async function apply(ctx: ModuleContext, ws: number, t: Ticket, rule: Rule) {
  const { db } = ctx;
  const done: string[] = [];
  for (const a of rule.actions) {
    if (a.type === 'assign') {
      const who = await db.query<{ name: string }>(`SELECT name FROM users WHERE id = $1 AND workspace_id = $2 AND role <> 'requester'`, [a.userId, ws]);
      if (who.rows[0]) {
        await db.query(`UPDATE tickets SET assignee_id = $2, status = CASE WHEN status = 'new' THEN 'open' ELSE status END WHERE id = $1`, [t.id, a.userId]);
        done.push(`assigned to ${who.rows[0].name}`);
      }
    } else if (a.type === 'priority' && a.value !== t.priority) {
      const { responseDueAt, dueAt } = targetsFor(a.value, new Date(t.createdAt), await workspaceHours(db, ws));
      await db.query('UPDATE tickets SET priority = $2, response_due_at = $3, due_at = $4 WHERE id = $1', [t.id, a.value, responseDueAt, dueAt]);
      done.push(`priority set to P${a.value} · ${SLA[a.value].label}`);
    } else if (a.type === 'category' && a.value !== t.category) {
      await db.query('UPDATE tickets SET category = $2 WHERE id = $1', [t.id, a.value]);
      done.push(`category set to ${a.value}`);
    } else if (a.type === 'note') {
      await addMessage(db, t.id, null, 'note', a.text);
      done.push('added a note');
    } else if (a.type === 'link_problem') {
      const ok = await db.query('UPDATE tickets SET problem_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM problems WHERE id = $2 AND workspace_id = $3) RETURNING id', [t.id, a.problemId, ws]);
      if (ok.rows.length) done.push('linked to a known problem');
    } else if (a.type === 'alert_agents') {
      const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE workspace_id = $1 AND role <> 'requester'`, [ws]);
      const demo = (await db.query<{ demo: boolean }>('SELECT demo FROM workspaces WHERE id = $1', [ws])).rows[0]?.demo;
      for (const r of rows) {
        ctx.later(ctx.mailer.send(db, { workspaceId: ws, to: r.email, kind: 'urgent', ticketId: t.id, logOnly: demo, subject: `[${t.key}] Rule “${rule.name}”: ${t.subject}`, body: `${t.requester.name}: ${t.description || t.subject}` }));
      }
      done.push('alerted IT');
    }
  }
  if (done.length) {
    await addMessage(db, t.id, null, 'event', `⚡ Rule “${rule.name}” ${done.join(', ')}`);
    await db.query('UPDATE rules SET runs = runs + 1, last_run_at = now() WHERE id = $1', [rule.id]);
  }
}

export async function runRules(ctx: ModuleContext, ws: number, ticketId: number) {
  const { rows } = await ctx.db.query<Row>('SELECT * FROM rules WHERE workspace_id = $1 AND enabled ORDER BY id', [ws]);
  for (const r of rows) {
    const t = await getTicket(ctx.db, ws, ticketId); // fresh each time: an earlier rule may have changed it
    if (t && matches(t, toRule(r).conditions)) await apply(ctx, ws, t, toRule(r));
  }
}

const condition = z.object({ field: z.enum(['category', 'priority', 'text', 'channel', 'kind', 'department']), op: z.enum(['is', 'is_not', 'contains']), value: z.string().trim().min(1).max(200) });
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign'), userId: z.number().int().positive() }),
  z.object({ type: z.literal('priority'), value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }),
  z.object({ type: z.literal('category'), value: z.enum(CATEGORIES) }),
  z.object({ type: z.literal('note'), text: z.string().trim().min(1).max(1000) }),
  z.object({ type: z.literal('alert_agents') }),
  z.object({ type: z.literal('link_problem'), problemId: z.number().int().positive() }),
]);
const ruleSchema = z.object({ name: z.string().trim().min(2, 'Name the rule').max(80), enabled: z.boolean().default(true), conditions: z.array(condition).min(1, 'Add at least one “when”').max(8), actions: z.array(action).min(1, 'Add at least one “then”').max(8) });

async function recentTickets(db: Db, ws: number) {
  const { rows } = await db.query<Row>(`SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.created_at > now() - interval '30 days' ORDER BY t.created_at DESC LIMIT 1000`, [ws]);
  return rows.map(toTicket);
}

export const rules: Module = {
  private(app, ctx) {
    const { db } = ctx;
    // Rules run on every new ticket, right after it's sorted and its device is linked.
    ctx.hooks.ticketCreated.push((ws, id) => runRules(ctx, ws, id));

    app.get('/api/rules', ctx.agentOnly, async (c) => {
      const { rows } = await db.query<Row>('SELECT * FROM rules WHERE workspace_id = $1 ORDER BY id', [c.get('user').workspaceId]);
      return c.json({ rules: rows.map(toRule) });
    });

    /** "Test on last month": which recent tickets would this rule have caught? */
    app.post('/api/rules/test', ctx.agentOnly, async (c) => {
      const p = z.object({ conditions: z.array(condition).min(1).max(8) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const all = await recentTickets(db, c.get('user').workspaceId);
      const hit = all.filter((t) => matches(t, p.data.conditions));
      return c.json({ checked: all.length, matched: hit.length, examples: hit.slice(0, 6).map((t) => ({ id: t.id, key: t.key, subject: t.subject })) });
    });

    const save = async (c: Context<Env>, id?: number) => {
      const u = c.get('user');
      const p = ruleSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = p.data;
      const { rows } = id
        ? await db.query<Row>('UPDATE rules SET name=$3, enabled=$4, conditions=$5, actions=$6 WHERE workspace_id=$1 AND id=$2 RETURNING *', [u.workspaceId, id, d.name, d.enabled, JSON.stringify(d.conditions), JSON.stringify(d.actions)])
        : await db.query<Row>('INSERT INTO rules (workspace_id, name, enabled, conditions, actions) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.workspaceId, d.name, d.enabled, JSON.stringify(d.conditions), JSON.stringify(d.actions)]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      await ctx.audit(c, u.workspaceId, u.id, id ? 'rule.updated' : 'rule.created', d.name, d.enabled ? 'on' : 'off');
      return c.json({ rule: toRule(rows[0]) }, id ? 200 : 201);
    };
    app.post('/api/rules', ctx.agentOnly, ctx.adminOnly, (c) => save(c));
    app.put('/api/rules/:id', ctx.agentOnly, ctx.adminOnly, (c) => save(c, ctx.idOf(c)));
    app.delete('/api/rules/:id', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const { rows } = await db.query<{ name: string }>('DELETE FROM rules WHERE workspace_id = $1 AND id = $2 RETURNING name', [u.workspaceId, ctx.idOf(c)]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      await ctx.audit(c, u.workspaceId, u.id, 'rule.deleted', rows[0].name);
      return c.json({ ok: true });
    });
  },
};
