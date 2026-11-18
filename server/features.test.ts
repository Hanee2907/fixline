import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { workingTimeBetween } from '../shared/hours.js';
import type { LiveEvent, Ticket } from '../shared/types.js';
import { createApp } from './app.js';
import { Bus } from './bus.js';
import { connect, type Db } from './db.js';
import { Mailer, stripQuoted, type OutgoingEmail } from './mail.js';
import { migrate } from './migrate.js';
import { png } from './png.js';

/** Remembers every email, so tests can read reset links and notifications. */
class CaptureMailer extends Mailer {
  sent: OutgoingEmail[] = [];
  constructor() { super(undefined, 'Fixline <test@fixline.local>'); }
  override async send(db: Db, m: OutgoingEmail) { this.sent.push(m); return super.send(db, m); }
}

let db: Db;
let mailer: CaptureMailer;
let api: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await connect(process.env.DATABASE_URL, undefined);
  await migrate(db);
  mailer = new CaptureMailer();
  api = createApp(db, { rateLimits: false, mailer });
});
afterAll(async () => db.close());

function browser(app = api.app) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://desk.test${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  return {
    get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b),
    put: (p: string, b: unknown) => call('PUT', p, b), patch: (p: string, b: unknown) => call('PATCH', p, b),
  };
}
const email = () => `t-${randomBytes(5).toString('hex')}@example.com`;
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error('timed out'); };

async function desk() {
  const admin = browser();
  const adminEmail = email();
  await admin.post('/api/auth/signup', { name: 'Ada Admin', email: adminEmail, password: 'long enough pw', workspaceName: 'Test IT' });
  const settings = (await admin.get('/api/settings')).body;
  const emp = browser();
  const empEmail = email();
  const r = await emp.post('/api/auth/signup', { name: 'Eve Employee', email: empEmail, password: 'long enough pw', joinCode: settings.joinCode });
  return { admin, emp, empId: r.body.user.id as number, empEmail, adminEmail, settings };
}

const screenshot = png(20, 10, (x) => [x * 10, 80, 160]).toString('base64');
const file = (name: string, data: string) => ({ name, type: 'image/png', data });

describe('attachments', () => {
  it('a screenshot on a new ticket can be opened by the employee and IT', async () => {
    const { admin, emp } = await desk();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Error when opening Excel', attachments: [file('error.png', screenshot)] })).body.ticket;
    const detail = (await admin.get(`/api/tickets/${t.id}`)).body;
    expect(detail.attachments).toEqual([expect.objectContaining({ name: 'error.png', type: 'image/png', internal: false })]);
    const dl = await emp.get(`/api/attachments/${detail.attachments[0].id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(dl.body as ArrayBuffer).toString('base64')).toBe(screenshot);
  });

  it('judges files by their bytes: a script named .png and SVGs are refused, logs are fine', async () => {
    const { emp } = await desk();
    const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const r = await emp.post('/api/tickets', { subject: 'Look at this', attachments: [file('cute.png', fake)] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/isn’t a supported file/);
    const log = Buffer.from('2026-11-18 09:00 ERROR could not reach server\n').toString('base64');
    expect((await emp.post('/api/tickets', { subject: 'Sync failing', attachments: [{ name: 'sync.log', type: 'text/plain', data: log }] })).status).toBe(201);
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await emp.post('/api/tickets', { subject: 'Huge file', attachments: [file('big.png', big.toString('base64'))] })).body.error).toMatch(/over 5 MB/);
  });

  it('files on internal notes stay internal', async () => {
    const { admin, emp } = await desk();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Laptop slow' })).body.ticket;
    await admin.post(`/api/tickets/${t.id}/messages`, { kind: 'note', body: 'Task manager shows 100% disk', attachments: [file('taskmgr.png', screenshot)] });
    const agentView = (await admin.get(`/api/tickets/${t.id}`)).body;
    const att = agentView.messages.find((m: { kind: string }) => m.kind === 'note').attachments[0];
    expect(att.internal).toBe(true);
    const empView = (await emp.get(`/api/tickets/${t.id}`)).body;
    expect(JSON.stringify(empView)).not.toContain('taskmgr.png');
    expect((await emp.get(`/api/attachments/${att.id}`)).status).toBe(404);
  });
});

describe('email', () => {
  it('confirms new tickets, and tells the employee when IT replies and when it is fixed', async () => {
    const { admin, emp, empEmail } = await desk();
    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Printer offline' })).body.ticket;
    await admin.post(`/api/tickets/${t.id}/messages`, { kind: 'reply', body: 'On my way' });
    await admin.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Cleared the queue.' });
    await until(() => mailer.sent.filter((m) => m.ticketId === t.id).length >= 3);
    const mine = mailer.sent.filter((m) => m.ticketId === t.id);
    expect(mine.map((m) => m.kind)).toEqual(['created', 'reply', 'solved']);
    expect(mine.every((m) => m.to === empEmail)).toBe(true);
    expect(mine[0].subject).toBe(`[${t.key}] We got your request: Printer offline`);
    expect(mine[2].body).toContain('http://desk.test/#/t/');
    const outbox = (await admin.get('/api/emails')).body.emails;
    expect(outbox.filter((e: { ticketId: number }) => e.ticketId === t.id)).toHaveLength(3);
  });

  it('an email to the desk becomes a ticket; a reply with the tag lands on the same ticket', async () => {
    const { admin, settings } = await desk();
    const token = settings.inboundAddress.split('/').pop();
    expect((await browser().post('/api/inbound/not-a-token', { from: 'a@b.c', subject: 'x' })).status).toBe(404);
    const sender = email();
    const r = await browser().post(`/api/inbound/${token}`, { from: `Ravi Iyer <${sender}>`, subject: 'Scanner not sending to email', text: 'The scanner on floor 2 stopped sending scans.', attachments: [file('scanner.png', screenshot)] });
    expect(r.body.action).toBe('created');
    const t: Ticket = (await admin.get(`/api/tickets/${r.body.ticketId}`)).body.ticket;
    expect(t).toMatchObject({ channel: 'email', category: 'Printing' });
    expect(t.requester).toMatchObject({ name: 'Ravi Iyer', email: sender });

    const reply = await browser().post(`/api/inbound/${token}`, {
      from: { email: sender, name: 'Ravi Iyer' }, subject: `Re: [${t.key}] Scanner not sending to email`,
      text: 'It works again after a restart, thanks!\n\nOn Tue, Nov 18, 2026 at 9:02 AM Fixline wrote:\n> Hi Ravi, ...',
    });
    expect(reply.body).toMatchObject({ ticketId: t.id, action: 'replied' });
    const msgs = (await admin.get(`/api/tickets/${t.id}`)).body.messages;
    const last = msgs.filter((m: { kind: string }) => m.kind === 'reply').at(-1);
    expect(last).toMatchObject({ body: 'It works again after a restart, thanks!', via: 'email' });
  });

  it('strips quoted history from replies', () => {
    expect(stripQuoted('Yes please\r\n\r\n-----Original Message-----\r\nFrom: IT')).toBe('Yes please');
    expect(stripQuoted('Done.\n> earlier text')).toBe('Done.');
  });
});

describe('forgot password', () => {
  it('sends a single-use link, ends old sessions, and never reveals who has an account', async () => {
    const { emp, empEmail } = await desk();
    const none = await browser().post('/api/auth/forgot', { email: 'nobody@example.com' });
    const some = await browser().post('/api/auth/forgot', { email: empEmail });
    expect(none.body.message).toBe(some.body.message);
    await until(() => mailer.sent.some((m) => m.kind === 'reset' && m.to === empEmail));
    const sent = mailer.sent.filter((m) => m.kind === 'reset' && m.to === empEmail).at(-1)!;
    const token = sent.body.match(/#\/reset\/([\w-]+)/)![1];
    // The outbox never stores the link.
    const { rows } = await db.query<{ body: string }>(`SELECT body FROM emails WHERE kind = 'reset' AND to_email = $1`, [empEmail]);
    expect(rows[0].body).not.toContain(token);

    const fresh = browser();
    const r = await fresh.post('/api/auth/reset', { token, password: 'a brand new password' });
    expect(r.status).toBe(200);
    expect((await emp.get('/api/auth/me')).body.user).toBeNull(); // the old session ended
    expect((await browser().post('/api/auth/reset', { token, password: 'another password' })).status).toBe(400); // single use
    expect((await browser().post('/api/auth/login', { email: empEmail, password: 'a brand new password' })).status).toBe(200);
  });
});

describe('working hours', () => {
  it('admins set the hours; pausing keeps the exact working time that was left', async () => {
    const { admin, emp } = await desk();
    expect((await emp.put('/api/settings', { hours: {} })).status).toBe(403);
    const bad = await admin.put('/api/settings', { hours: { timeZone: 'Mars/Base', days: [1], start: 480, end: 1020, urgent24x7: true } });
    expect(bad.body.field).toBe('hours.timeZone');
    const ok = await admin.put('/api/settings', { hours: { timeZone: 'Europe/London', days: [1, 2, 3, 4, 5], start: 540, end: 1050, urgent24x7: false } });
    expect(ok.body.user.hours).toMatchObject({ timeZone: 'Europe/London', start: 540, end: 1050, urgent24x7: false });

    const t: Ticket = (await emp.post('/api/tickets', { subject: 'Need Visio licence', description: 'request' })).body.ticket;
    const hours = ok.body.user.hours;
    await admin.patch(`/api/tickets/${t.id}`, { status: 'waiting', waitingReason: 'Waiting for manager approval' });
    const paused = (await admin.get(`/api/tickets/${t.id}`)).body.ticket as Ticket;
    expect(paused.pausedRemaining).toBeGreaterThan(0);
    // It waited a long time; that time doesn't count.
    await db.query(`UPDATE tickets SET paused_at = paused_at - interval '3 days' WHERE id = $1`, [t.id]);
    await emp.post(`/api/tickets/${t.id}/messages`, { body: 'Approved by my manager' });
    const resumed = (await admin.get(`/api/tickets/${t.id}`)).body.ticket as Ticket;
    expect(resumed.status).toBe('open');
    const left = workingTimeBetween(Date.now(), Date.parse(resumed.dueAt), hours, resumed.priority);
    expect(Math.abs(left - paused.pausedRemaining!)).toBeLessThan(60_000);
  });
});

describe('several servers', () => {
  it('a change on one server reaches browsers on another, and presence is shared', async () => {
    const busA = new Bus(db);
    const busB = new Bus(db);
    await busA.start();
    await busB.start();
    const serverA = createApp(db, { rateLimits: false, bus: busA, mailer });
    const { admin, emp } = await desk();
    const me = (await admin.get('/api/auth/me')).body.user;

    const heardOnB: LiveEvent[] = [];
    const off = busB.subscribe(me.workspaceId, { userId: me.id, role: 'admin', send: (e) => heardOnB.push(e) });
    await until(async () => (await busA.agentsOnline(me.workspaceId)) === 1); // seen from the other server

    // The employee happens to be on server A.
    const viaA = browser(serverA.app);
    await viaA.post('/api/auth/login', { email: (await emp.get('/api/auth/me')).body.user.email, password: 'long enough pw' });
    const t: Ticket = (await viaA.post('/api/tickets', { subject: 'Wi-Fi drops in Room B' })).body.ticket;
    await until(() => heardOnB.some((e) => e.ticketId === t.id));

    off();
    await until(async () => (await busA.agentsOnline(me.workspaceId)) === 0);
    await busA.stop();
    await busB.stop();
  });
});
