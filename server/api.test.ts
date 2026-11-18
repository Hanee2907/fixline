import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { LiveEvent, Ticket } from '../shared/types.js';
import { createApp } from './app.js';
import { connect, type Db } from './db.js';
import { migrate } from './migrate.js';

/** The real API on a real PostgreSQL: PGlite in memory locally, the Postgres service in CI. */
let db: Db;
let api: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await connect(process.env.DATABASE_URL, undefined);
  await migrate(db);
  api = createApp(db, { rateLimits: false });
});
afterAll(async () => db.close());

/** A tiny browser: keeps its own session cookie. */
function browser() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
const email = () => `t-${randomBytes(5).toString('hex')}@example.com`;

/** An admin with their own help desk, plus one employee who joined with the code. */
async function deskWithEmployee() {
  const admin = browser();
  await admin.post('/api/auth/signup', { name: 'Ada Admin', email: email(), password: 'long enough pw', workspaceName: 'Test IT' });
  const { body: ws } = await admin.get('/api/settings');
  const emp = browser();
  const r = await emp.post('/api/auth/signup', { name: 'Eve Employee', email: email(), password: 'long enough pw', joinCode: ws.joinCode });
  expect(r.status).toBe(201);
  return { admin, emp, empId: r.body.user.id as number };
}

describe('accounts and roles', () => {
  it('starting a desk makes you admin; joining with the code makes you an employee', async () => {
    const { admin, emp } = await deskWithEmployee();
    expect((await admin.get('/api/auth/me')).body.user.role).toBe('admin');
    expect((await emp.get('/api/auth/me')).body.user.role).toBe('requester');
    expect((await browser().post('/api/auth/signup', { name: 'X', email: email(), password: 'long enough pw', joinCode: 'nope' })).body.field).toBe('joinCode');
  });

  it('keeps IT-only pages from employees', async () => {
    const { emp } = await deskWithEmployee();
    for (const p of ['/api/people', '/api/kpis', '/api/reports', '/api/macros', '/api/settings']) expect((await emp.get(p)).status).toBe(403);
    expect((await browser().get('/api/tickets')).status).toBe(401);
  });

  it('stores only a password hash', async () => {
    const address = email();
    await browser().post('/api/auth/signup', { name: 'P', email: address, password: 'my secret phrase' });
    const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [address]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
  });
});

describe('tickets', () => {
  it('an employee reports a problem; it is sorted automatically and only they and IT can see it', async () => {
    const { admin, emp } = await deskWithEmployee();
    const r = await emp.post('/api/tickets', { subject: 'Outlook keeps asking for password', description: 'Since I changed my password it keeps popping up' });
    expect(r.status).toBe(201);
    const t: Ticket = r.body.ticket;
    expect(t.key).toBe('FX-1001');
    expect(t.category).toBe('Access');
    expect(t.priority).toBe(2);
    expect(t.status).toBe('new');
    expect((await admin.get('/api/tickets')).body.tickets.map((x: Ticket) => x.id)).toContain(t.id);

    // A second employee in the same desk can't see it.
    const { body: ws } = await admin.get('/api/settings');
    const other = browser();
    await other.post('/api/auth/signup', { name: 'Other', email: email(), password: 'long enough pw', joinCode: ws.joinCode });
    expect((await other.get(`/api/tickets/${t.id}`)).status).toBe(404);
    expect((await other.get('/api/tickets')).body.tickets).toHaveLength(0);
  });

  it('internal notes stay internal; the first IT reply stops the response clock', async () => {
    const { admin, emp } = await deskWithEmployee();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Printer offline on 2nd floor' })).body.ticket;
    await admin.post(`/api/tickets/${t.id}/messages`, { kind: 'note', body: 'Probably the stuck queue again' });
    let view = await emp.get(`/api/tickets/${t.id}`);
    expect(view.body.messages.some((m: { kind: string }) => m.kind === 'note')).toBe(false);
    expect(view.body.ticket.firstResponseAt).toBeNull();

    await admin.post(`/api/tickets/${t.id}/messages`, { kind: 'reply', body: 'Looking at it now' });
    view = await emp.get(`/api/tickets/${t.id}`);
    expect(view.body.ticket).toMatchObject({ status: 'open' });
    expect(view.body.ticket.firstResponseAt).not.toBeNull();
    expect(view.body.ticket.assignee.name).toBe('Ada Admin');

    // Employees can't post notes or change tickets.
    await emp.post(`/api/tickets/${t.id}/messages`, { kind: 'note', body: 'sneaky' });
    view = await admin.get(`/api/tickets/${t.id}`);
    expect(view.body.messages.at(-1).kind).toBe('reply');
    expect((await emp.patch(`/api/tickets/${t.id}`, { priority: 1 })).status).toBe(403);
  });

  it('waiting pauses the clock and a reply from the employee resumes it', async () => {
    const { admin, emp } = await deskWithEmployee();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Need Visio licence', description: 'request' })).body.ticket;
    await admin.patch(`/api/tickets/${t.id}`, { status: 'waiting', waitingReason: 'Waiting for manager approval' });
    // Pretend it waited for an hour.
    await db.query(`UPDATE tickets SET paused_at = paused_at - interval '1 hour' WHERE id = $1`, [t.id]);
    const before = (await admin.get(`/api/tickets/${t.id}`)).body.ticket as Ticket;
    expect(before.status).toBe('waiting');
    // The employee answering resumes it.
    await emp.post(`/api/tickets/${t.id}/messages`, { body: 'My manager approved it' });
    const after = (await admin.get(`/api/tickets/${t.id}`)).body.ticket as Ticket;
    expect(after.status).toBe('open');
    expect(after.pausedAt).toBeNull();
    // (The exact working-time maths is covered in features.test.ts.)
    expect(Date.parse(after.dueAt)).toBeGreaterThanOrEqual(Date.parse(before.dueAt));
  });

  it('resolving can save the fix as a guide; the employee rates it and can reopen', async () => {
    const { admin, emp } = await deskWithEmployee();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Second monitor flickering', description: 'since I moved desks' })).body.ticket;
    const r = await admin.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Replaced the DisplayPort cable.', saveArticle: 'Fix a flickering monitor' });
    expect(r.body.ticket.status).toBe('solved');
    expect(r.body.articleId).toBeTypeOf('number');
    expect((await emp.get('/api/articles')).body.articles.map((a: { title: string }) => a.title)).toContain('Fix a flickering monitor');

    expect((await admin.post(`/api/tickets/${t.id}/rate`, { rating: 'good' })).status).toBe(403);
    expect((await emp.post(`/api/tickets/${t.id}/rate`, { rating: 'good' })).body.ticket.rating).toBe('good');
    expect((await emp.post(`/api/tickets/${t.id}/reopen`)).body.ticket.status).toBe('open');
  });

  it('suggests guides while an employee types', async () => {
    const { admin, emp } = await deskWithEmployee();
    await admin.post('/api/articles', { title: 'Connect to the VPN', body: 'Open the VPN client and sign in. If it disconnects, use a wired connection.', category: 'Network' });
    const r = await emp.get('/api/suggest?q=' + encodeURIComponent('my vpn keeps disconnecting'));
    expect(r.body.suggestions[0]).toMatchObject({ type: 'article', title: 'Connect to the VPN' });
    expect(r.body.category).toBe('Network');
  });

  it('resolving an incident solves every linked ticket and tells each person', async () => {
    const { admin, emp } = await deskWithEmployee();
    const a: Ticket = (await emp.post('/api/tickets', { subject: 'VPN down' })).body.ticket;
    const b: Ticket = (await emp.post('/api/tickets', { subject: 'VPN not connecting' })).body.ticket;
    const { body } = await admin.post('/api/incidents', { title: 'VPN outage', message: 'We are on it', ticketIds: [a.id, b.id] });
    expect((await emp.get('/api/incidents')).body.incidents[0]).toMatchObject({ title: 'VPN outage', linked: 2 });
    const r = await admin.post(`/api/incidents/${body.id}/resolve`, { resolution: 'The provider fixed the gateway.' });
    expect(r.body.solved).toBe(2);
    const view = await emp.get(`/api/tickets/${a.id}`);
    expect(view.body.ticket.status).toBe('solved');
    expect(view.body.messages.at(-1).body).toBeTruthy();
    expect((await emp.get('/api/incidents')).body.incidents).toHaveLength(0);
  });
});

describe('live updates', () => {
  it('agents hear every change; an employee only hears about their own tickets', async () => {
    const { admin, emp, empId } = await deskWithEmployee();
    const me = (await admin.get('/api/auth/me')).body.user;
    const agentHeard: LiveEvent[] = [];
    const empHeard: LiveEvent[] = [];
    const otherHeard: LiveEvent[] = [];
    const offA = api.bus.subscribe(me.workspaceId, { userId: me.id, role: 'admin', send: (e) => agentHeard.push(e) });
    const offE = api.bus.subscribe(me.workspaceId, { userId: empId, role: 'requester', send: (e) => empHeard.push(e) });
    const offO = api.bus.subscribe(me.workspaceId, { userId: 999999, role: 'requester', send: (e) => otherHeard.push(e) });
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Laptop battery swelling' })).body.ticket;
    await admin.post(`/api/tickets/${t.id}/messages`, { kind: 'note', body: 'internal' });
    offA(); offE(); offO();
    expect(agentHeard.filter((e) => e.ticketId === t.id).length).toBeGreaterThanOrEqual(2);
    expect(empHeard.some((e) => e.ticketId === t.id)).toBe(true);
    expect(empHeard.filter((e) => e.type === 'message')).toHaveLength(0); // a note isn't announced to the employee
    expect(otherHeard.filter((e) => e.ticketId)).toHaveLength(0);
  });
});

describe('demo', () => {
  it('builds a realistic desk and lets you switch between agent and employee', async () => {
    const b = browser();
    expect((await b.post('/api/auth/demo', { as: 'agent' })).status).toBe(201);
    const k = (await b.get('/api/kpis')).body.kpis;
    expect(k.open).toBeGreaterThan(10);
    expect(k.breached).toBeGreaterThanOrEqual(1);
    expect(k.satisfaction).toBeGreaterThan(0.7);
    const queue = (await b.get('/api/tickets')).body.tickets as Ticket[];
    const outlook = queue.find((t) => t.subject.startsWith('Outlook'))!;
    const detail = (await b.get(`/api/tickets/${outlook.id}`)).body;
    expect(detail.suggestions[0].title).toMatch(/Credential Manager/);
    const rep = (await b.get('/api/reports')).body.reports;
    expect(rep.volume).toHaveLength(14);

    const switched = await b.post('/api/demo/switch');
    expect(switched.body.user).toMatchObject({ role: 'requester', name: 'Maya Rodriguez' });
    const mine = (await b.get('/api/tickets')).body.tickets as Ticket[];
    expect(mine.every((t) => t.requester.name === 'Maya Rodriguez')).toBe(true);
    // Demo accounts have no usable password.
    expect((await browser().post('/api/auth/login', { email: switched.body.user.email, password: '' })).status).toBe(401);
  });
});
