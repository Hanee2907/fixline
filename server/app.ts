import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { searchTerms, suggestCategory, suggestPriority } from '../shared/classify.js';
import { SLA, resumeShift, targetsFor } from '../shared/sla.js';
import { CATEGORIES, type LiveEvent, type Suggestion, type Ticket, type User } from '../shared/types.js';
import {
  SESSION_COOKIE, SESSION_DAYS, USER_SELECT, createSession, endSession, hashPassword, rateLimiter, toUser, userById, userForToken,
  verifyPassword, type UserRow,
} from './auth.js';
import { Bus } from './bus.js';
import type { Db } from './db.js';
import { createDemoWorkspace } from './demo.js';
import { TICKET_SELECT, addMessage, getTicket, listMessages, listPeople, toArticle, toIncident, toTicket } from './repo.js';
import { kpis, reports } from './stats.js';

type Env = { Variables: { user: User } };

const text = (max: number) => z.string().trim().max(max);
const category = z.enum(CATEGORIES);
const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const isAgent = (u: User) => u.role === 'agent' || u.role === 'admin';

function firstError(err: z.ZodError) {
  const issue = err.issues[0];
  return { error: issue.message, field: issue.path.join('.') || undefined };
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const clientKey = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';

/** Postgres full-text search for "anything like this": articles, plus solved tickets for agents. */
async function similar(db: Db, workspaceId: number, query: string, withTickets: boolean, excludeTicket?: number): Promise<Suggestion[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const tsq = terms.map((t) => t.replace(/'/g, '')).join(' | ');
  const out: Suggestion[] = [];
  const arts = await db.query<{ id: number; title: string; uses: number; score: number }>(
    `SELECT id, title, uses, ts_rank(to_tsvector('english', title || ' ' || body), to_tsquery('english', $2)) AS score
       FROM articles WHERE workspace_id = $1 AND to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', $2)
      ORDER BY score DESC, uses DESC LIMIT 4`,
    [workspaceId, tsq],
  );
  for (const a of arts.rows) out.push({ type: 'article', id: a.id, title: a.title, detail: `fixed ${a.uses}×`, score: Number(a.score) + a.uses / 200 });
  if (withTickets) {
    const ts = await db.query<{ id: number; number: number; prefix: string; subject: string; minutes: number; score: number }>(
      `SELECT t.id, t.number, w.prefix, t.subject, extract(epoch FROM t.solved_at - t.created_at) / 60 AS minutes,
              ts_rank(to_tsvector('english', t.subject || ' ' || t.description || ' ' || t.resolution), to_tsquery('english', $2)) AS score
         FROM tickets t JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.workspace_id = $1 AND t.status = 'solved' AND t.id <> $3
          AND to_tsvector('english', t.subject || ' ' || t.description || ' ' || t.resolution) @@ to_tsquery('english', $2)
        ORDER BY score DESC, t.solved_at DESC LIMIT 2`,
      [workspaceId, tsq, excludeTicket ?? 0],
    );
    for (const t of ts.rows) out.push({ type: 'ticket', id: t.id, title: `${t.prefix}-${t.number} · ${t.subject}`, detail: `solved in ${Math.max(1, Math.round(Number(t.minutes)))}m`, score: Number(t.score) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function createApp(db: Db, opts: { secureCookies?: boolean; bus?: Bus; rateLimits?: boolean } = {}) {
  const app = new Hono<Env>();
  const bus = opts.bus ?? new Bus();
  const limits = opts.rateLimits ?? true;
  const signInLimit = limits ? rateLimiter(20, 15 * 60_000) : () => true;
  const demoLimit = limits ? rateLimiter(15, 60 * 60_000) : () => true;
  const emit = (workspaceId: number, e: LiveEvent) => bus.publish(workspaceId, e);

  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false }));

  const startSession = async (c: Context, userId: number) => {
    const token = await createSession(db, userId);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: opts.secureCookies ?? false, path: '/', maxAge: SESSION_DAYS * 86_400 });
  };

  // Writes must be JSON: a browser can't send cross-site JSON without CORS, which blocks CSRF.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) && c.req.raw.body !== null && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ error: 'Send JSON' }, 415);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- Accounts ----------
  const signup = z.object({
    name: text(60).min(1, 'Add your name'),
    email: z.email('That email doesn’t look right').trim().toLowerCase().max(200),
    password: z.string().min(8, 'Use at least 8 characters').max(200),
    workspaceName: text(80).optional(),
    joinCode: text(40).optional(),
    department: text(60).optional(),
  });

  app.post('/api/auth/signup', async (c) => {
    if (!signInLimit(clientKey(c))) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429);
    const p = signup.safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const d = p.data;
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [d.email])).rows.length) {
      return c.json({ error: 'That email already has an account. Try signing in.', field: 'email' }, 409);
    }
    let workspaceId: number;
    let role: 'admin' | 'requester';
    if (d.joinCode) {
      const ws = await db.query<{ id: number }>('SELECT id FROM workspaces WHERE join_code = $1 AND NOT demo', [d.joinCode]);
      if (!ws.rows[0]) return c.json({ error: 'That join code isn’t right. Ask your IT team for it.', field: 'joinCode' }, 400);
      workspaceId = ws.rows[0].id;
      role = 'requester';
    } else {
      // Starting a new help desk: you become its admin.
      const ws = await db.query<{ id: number }>('INSERT INTO workspaces (name, join_code) VALUES ($1, $2) RETURNING id', [
        d.workspaceName || `${d.name.split(' ')[0]}’s IT desk`, randomBytes(4).toString('hex'),
      ]);
      workspaceId = ws.rows[0].id;
      role = 'admin';
    }
    const { rows } = await db.query<{ id: number }>(
      'INSERT INTO users (workspace_id, email, name, role, department, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [workspaceId, d.email, d.name, role, d.department ?? '', await hashPassword(d.password)],
    );
    await startSession(c, rows[0].id);
    return c.json({ user: await userById(db, rows[0].id) }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    if (!signInLimit(clientKey(c))) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429);
    const p = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).safeParse(await body(c));
    if (!p.success) return c.json({ error: 'Add your email and password' }, 400);
    const { rows } = await db.query<UserRow & { password_hash: string }>(
      `SELECT ${USER_SELECT}, u.password_hash FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.email = $1 AND NOT w.demo`,
      [p.data.email],
    );
    if (!rows[0] || !(await verifyPassword(p.data.password, rows[0].password_hash))) return c.json({ error: 'Email or password is wrong' }, 401);
    await startSession(c, rows[0].id);
    return c.json({ user: toUser(rows[0]) });
  });

  /** A throwaway workspace full of realistic tickets. You can switch between the agent and an employee. */
  app.post('/api/auth/demo', async (c) => {
    if (!demoLimit(clientKey(c))) return c.json({ error: 'Too many demos from here. Try again later.' }, 429);
    const p = z.object({ as: z.enum(['agent', 'requester']).default('agent') }).safeParse((await body(c)) ?? {});
    const ws = await createDemoWorkspace(db);
    const userId = p.success && p.data.as === 'requester' ? ws.requesterId : ws.agentId;
    await startSession(c, userId);
    return c.json({ user: await userById(db, userId) }, 201);
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await endSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', async (c) => c.json({ user: await userForToken(db, getCookie(c, SESSION_COOKIE)) }));

  // Everything below needs a signed-in user.
  app.use('/api/*', async (c, next) => {
    const user = await userForToken(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: 'Please sign in' }, 401);
    c.set('user', user);
    await next();
  });
  const agentOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!isAgent(c.get('user'))) return c.json({ error: 'Only IT staff can do that' }, 403);
    await next();
  };

  /** In a demo, hop between the IT agent and Maya the employee to watch live updates both ways. */
  app.post('/api/demo/switch', async (c) => {
    const me = c.get('user');
    if (!me.demo) return c.json({ error: 'Only in the demo' }, 403);
    const target = isAgent(me) ? 'maya' : 'you';
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM users WHERE workspace_id = $1 AND email LIKE $2`, [me.workspaceId, `${target}.%`]);
    if (!rows[0]) return c.json({ error: 'Not found' }, 404);
    await startSession(c, rows[0].id);
    return c.json({ user: await userById(db, rows[0].id) });
  });

  // ---------- Live updates (Server-Sent Events) ----------
  app.get('/api/live', (c) => {
    const user = c.get('user');
    return streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe(user.workspaceId, {
        userId: user.id,
        role: user.role,
        send: (e) => void stream.writeSSE({ event: 'change', data: JSON.stringify(e) }).catch(() => {}),
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {});
      }
      unsubscribe();
    });
  });

  // ---------- Tickets ----------
  const idOf = (c: Context) => {
    const id = Number(c.req.param('id'));
    return Number.isInteger(id) && id > 0 ? id : 0;
  };

  /** Finds a ticket the current user may see: agents see their workspace, employees only their own. */
  const visible = async (c: Context<Env>): Promise<Ticket | null> => {
    const user = c.get('user');
    const t = await getTicket(db, user.workspaceId, idOf(c));
    if (!t || (!isAgent(user) && t.requester.id !== user.id)) return null;
    return t;
  };

  app.get('/api/tickets', async (c) => {
    const user = c.get('user');
    const view = c.req.query('view') ?? 'all';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const where = ['t.workspace_id = $1'];
    const params: unknown[] = [user.workspaceId];
    if (!isAgent(user)) {
      params.push(user.id);
      where.push(`t.requester_id = $${params.length}`);
    } else if (view === 'mine') {
      params.push(user.id);
      where.push(`t.assignee_id = $${params.length} AND t.status <> 'solved'`);
    } else if (view === 'unassigned') where.push(`t.assignee_id IS NULL AND t.status <> 'solved'`);
    else if (view === 'breaching') where.push(`t.status IN ('new','open') AND CASE WHEN t.first_response_at IS NULL THEN t.response_due_at ELSE t.due_at END < now() + interval '1 hour'`);
    else if (view === 'waiting') where.push(`t.status = 'waiting'`);
    else if (view === 'solved') where.push(`t.status = 'solved'`);
    else if (view.startsWith('incident:')) {
      params.push(Number(view.slice(9)) || 0);
      where.push(`t.incident_id = $${params.length}`);
    } else where.push(`t.status <> 'solved'`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.subject ILIKE $${params.length} OR t.description ILIKE $${params.length} OR r.name ILIKE $${params.length} OR (w.prefix || '-' || t.number) ILIKE $${params.length})`);
    }
    const order = view === 'solved' || !isAgent(user)
      ? 't.updated_at DESC'
      : `(t.status = 'waiting'), CASE WHEN t.first_response_at IS NULL THEN t.response_due_at ELSE t.due_at END ASC`;
    const { rows } = await db.query<Record<string, unknown>>(`SELECT ${TICKET_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
    return c.json({ tickets: rows.map(toTicket) });
  });

  app.get('/api/tickets/:id', async (c) => {
    const t = await visible(c);
    if (!t) return c.json({ error: 'Not found' }, 404);
    const user = c.get('user');
    const messages = await listMessages(db, t.id, isAgent(user));
    const suggestions = isAgent(user) && t.status !== 'solved' ? await similar(db, user.workspaceId, `${t.subject} ${t.description}`, true, t.id) : [];
    return c.json({ ticket: t, messages, suggestions });
  });

  const create = z.object({
    subject: text(140).min(3, 'Give it a short title'),
    description: text(5000).default(''),
    category: category.optional(),
    priority: priority.optional(),
    device: text(80).default(''),
    location: text(80).default(''),
    requesterId: z.number().int().positive().optional(),
    channel: z.enum(['portal', 'email', 'phone']).default('portal'),
  });

  app.post('/api/tickets', async (c) => {
    const user = c.get('user');
    const p = create.safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const d = p.data;
    let requesterId = user.id;
    if (d.requesterId && isAgent(user)) {
      const r = await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2', [d.requesterId, user.workspaceId]);
      if (!r.rows.length) return c.json({ error: 'Unknown person', field: 'requesterId' }, 400);
      requesterId = d.requesterId;
    }
    const all = `${d.subject} ${d.description}`;
    const prio = isAgent(user) && d.priority ? d.priority : suggestPriority(all);
    const cat = d.category ?? suggestCategory(all);
    const now = new Date();
    const { responseDueAt, dueAt } = targetsFor(prio, now);
    // Ticket numbers per workspace, handed out atomically.
    const num = await db.query<{ number: number }>('UPDATE workspaces SET next_number = next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS number', [user.workspaceId]);
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO tickets (workspace_id, number, subject, description, category, priority, requester_id, device, location, channel,
                            created_at, updated_at, response_due_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13) RETURNING id`,
      [user.workspaceId, num.rows[0].number, d.subject, d.description, cat, prio, requesterId, d.device, d.location, isAgent(user) ? d.channel : 'portal', now, responseDueAt, dueAt],
    );
    const id = rows[0].id;
    await addMessage(db, id, null, 'event', `Ticket created · sorted as ${cat}, ${SLA[prio].label.toLowerCase()} priority`);
    emit(user.workspaceId, { type: 'ticket', ticketId: id, requesterId, actorId: user.id });
    return c.json({ ticket: await getTicket(db, user.workspaceId, id) }, 201);
  });

  const patch = z.object({
    status: z.enum(['new', 'open', 'waiting']).optional(),
    waitingReason: text(120).optional(),
    priority: priority.optional(),
    category: category.optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
    incidentId: z.number().int().positive().nullable().optional(),
    subject: text(140).min(3).optional(),
  }).strict();

  app.patch('/api/tickets/:id', agentOnly, async (c) => {
    const user = c.get('user');
    const t = await visible(c);
    if (!t) return c.json({ error: 'Not found' }, 404);
    const p = patch.safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const d = p.data;
    const sets: string[] = [];
    const params: unknown[] = [t.id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    const events: string[] = [];
    const now = new Date();

    if (d.assigneeId !== undefined && d.assigneeId !== (t.assignee?.id ?? null)) {
      if (d.assigneeId) {
        const a = await db.query<{ name: string }>(`SELECT name FROM users WHERE id = $1 AND workspace_id = $2 AND role <> 'requester'`, [d.assigneeId, user.workspaceId]);
        if (!a.rows[0]) return c.json({ error: 'Pick someone from IT', field: 'assigneeId' }, 400);
        events.push(d.assigneeId === user.id ? `${user.name} took this ticket` : `Assigned to ${a.rows[0].name}`);
      } else events.push('Unassigned');
      set('assignee_id', d.assigneeId);
      if (d.assigneeId && t.status === 'new' && !d.status) set('status', 'open');
    }
    if (d.priority && d.priority !== t.priority) {
      // New targets from when the ticket arrived, as if it had been sorted right the first time.
      const { responseDueAt, dueAt } = targetsFor(d.priority, new Date(t.createdAt));
      const shift = t.pausedAt ? 0 : Date.parse(t.dueAt) - targetsFor(t.priority, new Date(t.createdAt)).dueAt.getTime();
      set('priority', d.priority);
      set('response_due_at', responseDueAt);
      set('due_at', new Date(dueAt.getTime() + Math.max(0, shift)));
      events.push(`Priority changed to P${d.priority} · ${SLA[d.priority].label}`);
    }
    if (d.category && d.category !== t.category) { set('category', d.category); events.push(`Category changed to ${d.category}`); }
    if (d.subject && d.subject !== t.subject) set('subject', d.subject);
    if (d.status && d.status !== t.status && t.status !== 'solved') {
      if (d.status === 'waiting') {
        set('paused_at', now);
        set('waiting_reason', d.waitingReason || 'Waiting on the requester');
        events.push(`Paused · ${d.waitingReason || 'waiting on the requester'}`);
      } else if (t.status === 'waiting' && t.pausedAt) {
        // The clock resumes: deadlines move by however long the ticket waited.
        const shift = resumeShift(t.pausedAt, now);
        set('due_at', new Date(Date.parse(t.dueAt) + shift));
        set('response_due_at', new Date(Date.parse(t.responseDueAt) + shift));
        set('paused_at', null);
        set('waiting_reason', '');
        events.push('Resumed · clock running again');
      }
      set('status', d.status);
    } else if (d.waitingReason !== undefined && t.status === 'waiting') set('waiting_reason', d.waitingReason);
    if (d.incidentId !== undefined && d.incidentId !== t.incidentId) {
      if (d.incidentId) {
        const i = await db.query<{ title: string }>('SELECT title FROM incidents WHERE id = $1 AND workspace_id = $2', [d.incidentId, user.workspaceId]);
        if (!i.rows[0]) return c.json({ error: 'Unknown incident', field: 'incidentId' }, 400);
        events.push(`Linked to incident: ${i.rows[0].title}`);
      } else events.push('Unlinked from incident');
      set('incident_id', d.incidentId);
    }
    if (!sets.length) return c.json({ ticket: t });
    sets.push('updated_at = now()');
    await db.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1`, params);
    for (const e of events) await addMessage(db, t.id, user.id, 'event', e);
    emit(user.workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester.id, actorId: user.id });
    if (d.incidentId !== undefined) emit(user.workspaceId, { type: 'incident' });
    return c.json({ ticket: await getTicket(db, user.workspaceId, t.id) });
  });

  app.post('/api/tickets/:id/messages', async (c) => {
    const user = c.get('user');
    const t = await visible(c);
    if (!t) return c.json({ error: 'Not found' }, 404);
    const p = z.object({ kind: z.enum(['reply', 'note']).default('reply'), body: text(10_000).min(1, 'Write something first'), articleId: z.number().int().positive().optional() }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const kind = isAgent(user) ? p.data.kind : 'reply';
    await addMessage(db, t.id, user.id, kind, p.data.body);
    const sets = ['updated_at = now()'];
    if (isAgent(user) && kind === 'reply') {
      if (!t.firstResponseAt) sets.push('first_response_at = now()');
      if (t.status === 'new') sets.push(`status = 'open'`);
      if (!t.assignee) sets.push(`assignee_id = ${user.id}`);
    }
    if (!isAgent(user)) {
      if (t.status === 'waiting' && t.pausedAt) {
        // The employee answered: the ticket comes back and its clock resumes.
        const shift = resumeShift(t.pausedAt, new Date());
        sets.push(`status = 'open'`, 'paused_at = NULL', `waiting_reason = ''`,
          `due_at = due_at + interval '${Math.round(shift / 1000)} seconds'`, `response_due_at = response_due_at + interval '${Math.round(shift / 1000)} seconds'`);
        await addMessage(db, t.id, null, 'event', `${user.name} replied · clock running again`);
      } else if (t.status === 'solved') {
        sets.push(`status = 'open'`, 'solved_at = NULL', 'rating = NULL');
        await addMessage(db, t.id, null, 'event', `Reopened by ${user.name}`);
      }
    }
    await db.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1`, [t.id]);
    if (p.data.articleId) await db.query('UPDATE articles SET uses = uses + 1 WHERE id = $1 AND workspace_id = $2', [p.data.articleId, user.workspaceId]);
    emit(user.workspaceId, { type: 'message', ticketId: t.id, requesterId: kind === 'note' ? undefined : t.requester.id, actorId: user.id });
    if (kind === 'note') emit(user.workspaceId, { type: 'ticket', ticketId: t.id, actorId: user.id });
    return c.json({ ticket: await getTicket(db, user.workspaceId, t.id), messages: await listMessages(db, t.id, isAgent(user)) }, 201);
  });

  app.post('/api/tickets/:id/resolve', agentOnly, async (c) => {
    const user = c.get('user');
    const t = await visible(c);
    if (!t) return c.json({ error: 'Not found' }, 404);
    const p = z.object({ resolution: text(4000).min(3, 'Say briefly what fixed it'), notify: z.boolean().default(true), saveArticle: text(140).optional() }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    await db.query(
      `UPDATE tickets SET status = 'solved', solved_at = now(), updated_at = now(), resolution = $2, paused_at = NULL,
              first_response_at = COALESCE(first_response_at, now()), assignee_id = COALESCE(assignee_id, $3) WHERE id = $1`,
      [t.id, p.data.resolution, user.id],
    );
    if (p.data.notify) await addMessage(db, t.id, user.id, 'reply', `Good news: this is fixed. ${p.data.resolution}\n\nIf it happens again, just reply here and the ticket reopens.`);
    await addMessage(db, t.id, user.id, 'event', `Resolved by ${user.name}`);
    let articleId: number | null = null;
    if (p.data.saveArticle) {
      // One click turns a fix into a guide, so the knowledge base grows by itself.
      const a = await db.query<{ id: number }>('INSERT INTO articles (workspace_id, title, body, category, uses) VALUES ($1, $2, $3, $4, 1) RETURNING id', [
        user.workspaceId, p.data.saveArticle, `${t.description}\n\nFix: ${p.data.resolution}`, t.category,
      ]);
      articleId = a.rows[0].id;
      emit(user.workspaceId, { type: 'article' });
    }
    emit(user.workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester.id, actorId: user.id });
    return c.json({ ticket: await getTicket(db, user.workspaceId, t.id), articleId });
  });

  app.post('/api/tickets/:id/reopen', async (c) => {
    const user = c.get('user');
    const t = await visible(c);
    if (!t || t.status !== 'solved') return c.json({ error: 'Not found' }, 404);
    const { responseDueAt, dueAt } = targetsFor(t.priority, new Date());
    await db.query(`UPDATE tickets SET status = 'open', solved_at = NULL, rating = NULL, updated_at = now(), response_due_at = $2, due_at = $3 WHERE id = $1`, [t.id, responseDueAt, dueAt]);
    await addMessage(db, t.id, user.id, 'event', `Reopened by ${user.name}`);
    emit(user.workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester.id, actorId: user.id });
    return c.json({ ticket: await getTicket(db, user.workspaceId, t.id) });
  });

  app.post('/api/tickets/:id/rate', async (c) => {
    const user = c.get('user');
    const t = await visible(c);
    if (!t || t.requester.id !== user.id || t.status !== 'solved') return c.json({ error: 'Only the person who asked can rate a solved ticket' }, 403);
    const p = z.object({ rating: z.enum(['good', 'bad']), comment: text(1000).optional() }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    await db.query('UPDATE tickets SET rating = $2 WHERE id = $1', [t.id, p.data.rating]);
    await addMessage(db, t.id, user.id, 'event', `Rated ${p.data.rating === 'good' ? '👍 good' : '👎 not good'}${p.data.comment ? ` · “${p.data.comment}”` : ''}`);
    emit(user.workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester.id, actorId: user.id });
    return c.json({ ticket: await getTicket(db, user.workspaceId, t.id) });
  });

  // ---------- Suggestions, knowledge base, saved replies ----------
  app.get('/api/suggest', async (c) => {
    const user = c.get('user');
    const q = (c.req.query('q') ?? '').slice(0, 500);
    return c.json({
      suggestions: await similar(db, user.workspaceId, q, isAgent(user)),
      category: suggestCategory(q),
      priority: suggestPriority(q),
    });
  });

  app.get('/api/articles', async (c) => {
    const user = c.get('user');
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const { rows } = q
      ? await db.query(`SELECT * FROM articles WHERE workspace_id = $1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY uses DESC`, [user.workspaceId, `%${q}%`])
      : await db.query('SELECT * FROM articles WHERE workspace_id = $1 ORDER BY uses DESC, title', [user.workspaceId]);
    return c.json({ articles: rows.map(toArticle) });
  });

  app.get('/api/articles/:id', async (c) => {
    const user = c.get('user');
    const { rows } = await db.query('SELECT * FROM articles WHERE workspace_id = $1 AND id = $2', [user.workspaceId, idOf(c)]);
    return rows[0] ? c.json({ article: toArticle(rows[0]) }) : c.json({ error: 'Not found' }, 404);
  });

  /** An employee says a guide solved their problem: counts towards "fixed 14×". */
  app.post('/api/articles/:id/helped', async (c) => {
    const user = c.get('user');
    await db.query('UPDATE articles SET uses = uses + 1 WHERE workspace_id = $1 AND id = $2', [user.workspaceId, idOf(c)]);
    return c.json({ ok: true });
  });

  const article = z.object({ title: text(140).min(3, 'Add a title'), body: text(20_000).min(10, 'Write the steps'), category });
  app.post('/api/articles', agentOnly, async (c) => {
    const user = c.get('user');
    const p = article.safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const { rows } = await db.query('INSERT INTO articles (workspace_id, title, body, category) VALUES ($1, $2, $3, $4) RETURNING *', [user.workspaceId, p.data.title, p.data.body, p.data.category]);
    emit(user.workspaceId, { type: 'article' });
    return c.json({ article: toArticle(rows[0]) }, 201);
  });
  app.put('/api/articles/:id', agentOnly, async (c) => {
    const user = c.get('user');
    const p = article.safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const { rows } = await db.query('UPDATE articles SET title = $3, body = $4, category = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *', [user.workspaceId, idOf(c), p.data.title, p.data.body, p.data.category]);
    if (!rows[0]) return c.json({ error: 'Not found' }, 404);
    emit(user.workspaceId, { type: 'article' });
    return c.json({ article: toArticle(rows[0]) });
  });
  app.delete('/api/articles/:id', agentOnly, async (c) => {
    const user = c.get('user');
    const { rows } = await db.query('DELETE FROM articles WHERE workspace_id = $1 AND id = $2 RETURNING id', [user.workspaceId, idOf(c)]);
    emit(user.workspaceId, { type: 'article' });
    return rows[0] ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/macros', agentOnly, async (c) => {
    const { rows } = await db.query<{ id: number; title: string; body: string }>('SELECT id, title, body FROM macros WHERE workspace_id = $1 ORDER BY title', [c.get('user').workspaceId]);
    return c.json({ macros: rows });
  });
  app.post('/api/macros', agentOnly, async (c) => {
    const p = z.object({ title: text(80).min(2), body: text(5000).min(2) }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const { rows } = await db.query('INSERT INTO macros (workspace_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body', [c.get('user').workspaceId, p.data.title, p.data.body]);
    return c.json({ macro: rows[0] }, 201);
  });
  app.delete('/api/macros/:id', agentOnly, async (c) => {
    await db.query('DELETE FROM macros WHERE workspace_id = $1 AND id = $2', [c.get('user').workspaceId, idOf(c)]);
    return c.json({ ok: true });
  });

  // ---------- Incidents (known issues) ----------
  app.get('/api/incidents', async (c) => {
    const user = c.get('user');
    const { rows } = await db.query(
      `SELECT i.*, (SELECT count(*) FROM tickets t WHERE t.incident_id = i.id) AS linked FROM incidents i
        WHERE i.workspace_id = $1 ${isAgent(user) ? '' : "AND i.status = 'active'"} ORDER BY (i.status = 'active') DESC, i.created_at DESC LIMIT 30`,
      [user.workspaceId],
    );
    return c.json({ incidents: rows.map(toIncident) });
  });

  app.post('/api/incidents', agentOnly, async (c) => {
    const user = c.get('user');
    const p = z.object({ title: text(120).min(3, 'Name the problem'), message: text(1000).default(''), ticketIds: z.array(z.number().int().positive()).max(200).default([]) }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const { rows } = await db.query<{ id: number }>('INSERT INTO incidents (workspace_id, title, message) VALUES ($1, $2, $3) RETURNING id', [user.workspaceId, p.data.title, p.data.message]);
    if (p.data.ticketIds.length) {
      await db.query(`UPDATE tickets SET incident_id = $1, updated_at = now() WHERE workspace_id = $2 AND id = ANY($3::int[]) AND status <> 'solved'`, [rows[0].id, user.workspaceId, p.data.ticketIds]);
    }
    emit(user.workspaceId, { type: 'incident' });
    return c.json({ id: rows[0].id }, 201);
  });

  /** Fixing the outage fixes every linked ticket, and tells each person who reported it. */
  app.post('/api/incidents/:id/resolve', agentOnly, async (c) => {
    const user = c.get('user');
    const p = z.object({ resolution: text(2000).min(3, 'Say what fixed it') }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    const inc = await db.query('UPDATE incidents SET status = $3, resolved_at = now() WHERE workspace_id = $1 AND id = $2 AND status = $4 RETURNING id', [user.workspaceId, idOf(c), 'resolved', 'active']);
    if (!inc.rows.length) return c.json({ error: 'Not found' }, 404);
    const { rows } = await db.query<{ id: number; requester_id: number }>(
      `UPDATE tickets SET status = 'solved', solved_at = now(), updated_at = now(), resolution = $3, paused_at = NULL,
              first_response_at = COALESCE(first_response_at, now()), assignee_id = COALESCE(assignee_id, $4)
        WHERE workspace_id = $1 AND incident_id = $2 AND status <> 'solved' RETURNING id, requester_id`,
      [user.workspaceId, idOf(c), p.data.resolution, user.id],
    );
    for (const t of rows) {
      await addMessage(db, t.id, user.id, 'reply', `The wider problem behind this ticket is fixed: ${p.data.resolution}\n\nIf you still have trouble, reply here.`);
      emit(user.workspaceId, { type: 'ticket', ticketId: t.id, requesterId: t.requester_id, actorId: user.id });
    }
    emit(user.workspaceId, { type: 'incident' });
    return c.json({ solved: rows.length });
  });

  // ---------- People, workspace, numbers ----------
  app.get('/api/people', agentOnly, async (c) => c.json({ people: await listPeople(db, c.get('user').workspaceId) }));

  app.patch('/api/people/:id', agentOnly, async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Only admins can change roles' }, 403);
    const p = z.object({ role: z.enum(['requester', 'agent', 'admin']) }).safeParse(await body(c));
    if (!p.success) return c.json(firstError(p.error), 400);
    if (idOf(c) === user.id) return c.json({ error: 'You can’t change your own role' }, 400);
    const { rows } = await db.query('UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id', [user.workspaceId, idOf(c), p.data.role]);
    return rows[0] ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/workspace', agentOnly, async (c) => {
    const { rows } = await db.query<{ name: string; join_code: string; demo: boolean }>('SELECT name, join_code, demo FROM workspaces WHERE id = $1', [c.get('user').workspaceId]);
    return c.json({ name: rows[0].name, joinCode: rows[0].demo ? null : rows[0].join_code });
  });

  app.get('/api/kpis', agentOnly, async (c) => {
    const user = c.get('user');
    return c.json({ kpis: await kpis(db, user.workspaceId, user.id, bus.agentsOnline(user.workspaceId)) });
  });
  app.get('/api/reports', agentOnly, async (c) => c.json({ reports: await reports(db, c.get('user').workspaceId) }));

  /** Deleting your account removes you; admins of a real workspace delete the whole workspace. */
  app.delete('/api/me', async (c) => {
    const user = c.get('user');
    if (user.role === 'admin') await db.query('DELETE FROM workspaces WHERE id = $1', [user.workspaceId]);
    else await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong on our side' }, 500);
  });

  return { app, bus };
}
