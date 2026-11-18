import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { CatalogItem, Ticket } from '../shared/types.js';
import { createApp } from './app.js';
import { connect, type Db } from './db.js';
import { Mailer, type OutgoingEmail } from './mail.js';
import { migrate } from './migrate.js';
import { setAiClient } from './modules/ai.js';
import { assetHealth } from './modules/assets.js';
import { assessRisk } from './modules/changes.js';
import { findCandidates } from './modules/problems.js';
import { matchRequest } from './modules/requests.js';
import { matches } from './modules/rules.js';
import { providers, verifyIdToken } from './modules/sso.js';
import { base32Encode, totp, verifyTotp } from './totp.js';

/* ------------------------------------------------------------------ */
/* Pure logic                                                          */
/* ------------------------------------------------------------------ */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('requests in plain words', () => {
  const item = (id: number, name: string, keywords: string, fields: CatalogItem['fields']): CatalogItem =>
    ({ id, name, description: '', icon: '', category: 'Software', keywords, fields, needsApproval: true, priority: 4, active: true });
  const catalog = [
    item(1, 'New software', 'install,app,licence,visio,adobe', [{ key: 'software', label: 'Software', type: 'text' }, { key: 'why', label: 'What it’s for', type: 'textarea' }]),
    item(2, 'Guest Wi-Fi code', 'guest,wifi,visitor', [{ key: 'visitor', label: 'Visitor', type: 'text' }]),
  ];
  it('opens the right form and fills in what and why', () => {
    const [best] = matchRequest(catalog, 'I need Visio for drawing floor plans');
    expect(best.item.name).toBe('New software');
    expect(best.prefill).toEqual({ software: 'Visio', why: 'Drawing floor plans' });
  });
  it('stays quiet for an ordinary fault', () => {
    expect(matchRequest(catalog, 'my printer is jammed')).toEqual([]);
  });
});

describe('change risk, worked out for you', () => {
  const hours = { timeZone: 'UTC', days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, urgent24x7: true };
  const monday = Date.parse('2026-11-23T00:00:00Z');
  const base = { title: 'Install label printer driver', affects: 'Label printer', plan: 'Install driver 8.2 and print a test label.', rollback: 'Uninstall the driver; Windows uses the old one.' };
  it('routine work out of hours with notice is low risk', () => {
    const r = assessRisk({ ...base, plannedStart: monday + 20 * HOUR, plannedEnd: monday + 21 * HOUR }, { hours, now: monday - 3 * DAY, clashes: 0, similarFailures: 0 });
    expect(r).toMatchObject({ score: 0, level: 'low', reasons: [] });
  });
  it('explains every point of a risky change', () => {
    const r = assessRisk({ title: 'Replace core firewall', affects: 'Internet for everyone', plan: '', rollback: '', plannedStart: monday + 10 * HOUR, plannedEnd: monday + 18 * HOUR },
      { hours, now: monday + 9 * HOUR, clashes: 1, similarFailures: 1 });
    expect(r.level).toBe('high');
    expect(r.score).toBe(100);
    expect(r.reasons.map((x) => x.text)).toEqual(expect.arrayContaining(['Touches a service many people rely on', 'Happens while people are working', 'No clear way to undo it', 'Overlaps 1 other change', '1 similar change failed recently']));
  });
});

describe('problems spotted automatically', () => {
  let n = 0;
  const t = (subject: string, category: Ticket['category'] = 'Network') => ({ id: ++n, key: `FX-${n}`, subject, description: '', category, createdAt: new Date().toISOString() });
  it('groups repeat tickets and names the group after a real ticket', () => {
    const groups = findCandidates([t('VPN disconnects every 10 minutes'), t('VPN not connecting at Plant 2'), t('VPN keeps disconnecting at home'), t('Printer offline', 'Printing')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ticketIds).toHaveLength(3);
    expect(groups[0].label).toMatch(/^VPN/);
  });
  it('does not chain unrelated tickets through a common word', () => {
    const groups = findCandidates([
      t('VPN drops and Teams calls cut out when working from home'), t('VPN slow when working from home'),
      t('Teams camera not detected but works in Camera app', 'Software'), t('Teams camera black in meetings', 'Software'),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('device health in plain words', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  it('says what to do, not just what it is', () => {
    expect(assetHealth({ ticketsLast30: 4, warrantyUntil: '2026-03-01', status: 'in_use', purchasedOn: '2021-06-01' }, now))
      .toEqual(['4 tickets in 30 days. Consider replacing it.', 'Out of warranty', 'Over 4 years old']);
    expect(assetHealth({ ticketsLast30: 0, warrantyUntil: '2026-12-01', status: 'in_use', purchasedOn: '2025-01-01' }, now)).toEqual(['Warranty ends in 13 days']);
    expect(assetHealth({ ticketsLast30: 9, warrantyUntil: null, status: 'retired', purchasedOn: null }, now)).toEqual([]);
  });
});

describe('rules', () => {
  const ticket = { subject: 'Payroll export fails', description: 'Since this morning', category: 'Software', priority: 3, channel: 'email', kind: 'incident', requester: { department: 'Finance' } } as unknown as Ticket;
  it('matches any of several words, ignoring case', () => {
    expect(matches(ticket, [{ field: 'text', op: 'contains', value: 'PAYROLL, invoices' }])).toBe(true);
    expect(matches(ticket, [{ field: 'text', op: 'is_not', value: 'payroll' }])).toBe(false);
  });
  it('needs every condition', () => {
    expect(matches(ticket, [{ field: 'priority', op: 'is', value: '3' }, { field: 'department', op: 'is', value: 'finance' }])).toBe(true);
    expect(matches(ticket, [{ field: 'priority', op: 'is', value: '3' }, { field: 'channel', op: 'is', value: 'portal' }])).toBe(false);
  });
});

describe('authenticator codes (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the published test vectors', () => {
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
  });
  it('allows one step of clock drift either way, no more', () => {
    const at = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, at - 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at + 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at - 90_000), at)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', at)).toBe(false);
  });
});

describe('Microsoft / Google ID tokens', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const google = providers({ SSO_GOOGLE_CLIENT_ID: 'client-1', SSO_GOOGLE_CLIENT_SECRET: 'x' })[0];
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (header: object, claims: object) => {
    const head = `${b64(header)}.${b64(claims)}`;
    return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`;
  };
  const now = Date.now();
  const good = { iss: 'https://accounts.google.com', aud: 'client-1', exp: Math.floor(now / 1000) + 300, nonce: 'n1', sub: '42', email: 'a@b.com', email_verified: true };
  let jwks = '';
  afterEach(() => vi.unstubAllGlobals());
  const stubKeys = () => {
    jwks = `https://keys.test/${randomBytes(4).toString('hex')}`; // fresh URL: no cached keys between tests
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] })));
  };
  it('accepts a correctly signed token for this app', async () => {
    stubKeys();
    await expect(verifyIdToken(google, jwks, sign({ alg: 'RS256', kid: 'k1' }, good), 'n1', now)).resolves.toMatchObject({ sub: '42' });
  });
  it.each([
    ['another app', { ...good, aud: 'someone-else' }, 'n1', /audience/],
    ['a replayed sign-in', good, 'other-nonce', /Nonce/],
    ['an old token', { ...good, exp: Math.floor(now / 1000) - 600 }, 'n1', /Expired/],
    ['a different issuer', { ...good, iss: 'https://evil.example' }, 'n1', /issuer/],
  ])('rejects %s', async (_, claims, nonce, err) => {
    stubKeys();
    await expect(verifyIdToken(google, jwks, sign({ alg: 'RS256', kid: 'k1' }, claims), nonce as string, now)).rejects.toThrow(err as RegExp);
  });
  it('rejects tampering and unsigned tokens', async () => {
    stubKeys();
    const [h, , s] = sign({ alg: 'RS256', kid: 'k1' }, good).split('.');
    await expect(verifyIdToken(google, jwks, `${h}.${b64({ ...good, email: 'boss@b.com' })}.${s}`, 'n1', now)).rejects.toThrow(/signature/);
    await expect(verifyIdToken(google, jwks, `${b64({ alg: 'none' })}.${b64(good)}.x`, 'n1', now)).rejects.toThrow(/algorithm/);
  });
});

/* ------------------------------------------------------------------ */
/* Through the API                                                     */
/* ------------------------------------------------------------------ */
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
afterAll(async () => { setAiClient(null); await db.close(); });

function browser() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.app.request(`http://desk.test${path}`, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('fixline_session')) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b),
    put: (p: string, b: unknown) => call('PUT', p, b), patch: (p: string, b: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p),
  };
}
const email = () => `t-${randomBytes(5).toString('hex')}@example.com`;
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error('timed out'); };
const PW = 'long enough pw';

async function desk() {
  const admin = browser();
  const adminEmail = email();
  await admin.post('/api/auth/signup', { name: 'Ada Admin', email: adminEmail, password: PW, workspaceName: 'Test IT' });
  const { joinCode } = (await admin.get('/api/settings')).body;
  const join = async (name: string) => {
    const b = browser();
    const e = email();
    const r = await b.post('/api/auth/signup', { name, email: e, password: PW, joinCode });
    return { b, id: r.body.user.id as number, email: e };
  };
  return { admin, adminEmail, join };
}

describe('requests and one-tap approvals', () => {
  it('asks the manager by email, waits with the clock paused, and starts when they say yes', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve Employee');
    const mo = await join('Mo Manager');
    await admin.patch(`/api/people/${eve.id}/manager`, { managerId: mo.id });
    const item = (await admin.post('/api/catalog', { name: 'New software', category: 'Software', keywords: 'install,visio', fields: [{ key: 'software', label: 'Software', type: 'text', required: true }] })).body.item;

    expect((await eve.b.post('/api/requests', { itemId: item.id, form: {} })).body.field).toBe('form.software');
    const r = await eve.b.post('/api/requests', { itemId: item.id, form: { software: 'Visio' } });
    expect(r.status).toBe(201);
    expect(r.body.ticket).toMatchObject({ kind: 'request', approval: 'pending', status: 'waiting', approver: { id: mo.id }, form: { Software: 'Visio' } });

    // Eve can't approve her own request; Mo sees it in his list.
    expect((await eve.b.post(`/api/approvals/${r.body.ticket.id}`, { decision: 'approve' })).status).toBe(404);
    expect((await mo.b.get('/api/approvals')).body.tickets.map((t: Ticket) => t.id)).toEqual([r.body.ticket.id]);

    // The email holds a one-tap link that works without signing in, once.
    await until(() => mailer.sent.some((m) => m.to === mo.email));
    const token = mailer.sent.find((m) => m.to === mo.email)!.body.match(/#\/approve\/([\w-]+)/)![1];
    const anyone = browser();
    expect((await anyone.get(`/api/approve/${token}`)).body).toMatchObject({ approver: 'Mo Manager', ticket: { subject: 'New software: Visio', approval: 'pending' } });
    expect((await anyone.post(`/api/approve/${token}`, { decision: 'approve' })).status).toBe(200);
    expect((await anyone.post(`/api/approve/${token}`, { decision: 'decline' })).status).toBe(404);

    const t = (await admin.get(`/api/tickets/${r.body.ticket.id}`)).body.ticket as Ticket;
    expect(t).toMatchObject({ approval: 'approved', status: 'open', pausedAt: null });
    expect(Date.parse(t.dueAt)).toBeGreaterThan(Date.now());
  });

  it('closes a declined request and tells the person why', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve Employee');
    const item = (await admin.post('/api/catalog', { name: 'New laptop', fields: [] })).body.item;
    const { ticket } = (await eve.b.post('/api/requests', { itemId: item.id, form: {} })).body;
    expect(ticket.approver.name).toBe('Ada Admin'); // nobody's manager on file: an admin decides
    await admin.post(`/api/approvals/${ticket.id}`, { decision: 'decline', comment: 'Yours is only a year old' });
    const t = (await eve.b.get(`/api/tickets/${ticket.id}`)).body.ticket as Ticket;
    expect(t).toMatchObject({ approval: 'rejected', status: 'solved' });
    expect(t.resolution).toContain('Yours is only a year old');
  });
});

describe('devices', () => {
  it('links new tickets to the person’s laptop and warns when it keeps coming back', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve Employee');
    const a = (await admin.post('/api/assets', { tag: 'lt-0100', name: 'Eve’s laptop', type: 'laptop', status: 'in_use', assignedTo: eve.id, purchasedOn: '2020-01-15' })).body.asset;
    expect(a.tag).toBe('LT-0100');
    expect((await admin.post('/api/assets', { tag: 'LT-0100', name: 'Copy' })).status).toBe(409);
    for (const s of ['Laptop is slow', 'Fan very loud', 'Battery drains fast']) await eve.b.post('/api/tickets', { subject: s });
    const d = (await admin.get(`/api/assets/${a.id}`)).body;
    expect(d.tickets).toHaveLength(3);
    expect(d.tickets[0]).toMatchObject({ assetId: a.id, device: 'LT-0100' });
    expect(d.asset.health).toEqual(['3 tickets in 30 days. Consider replacing it.', 'Over 4 years old']);
    expect((await eve.b.get('/api/my/assets')).body.assets.map((x: { tag: string }) => x.tag)).toEqual(['LT-0100']);
    expect((await eve.b.get('/api/assets')).status).toBe(403);
  });

  it('imports a spreadsheet and updates tags that already exist', async () => {
    const { admin } = await desk();
    const r = await admin.post('/api/assets/import', { csv: 'tag,name,type,model\nPC-1,Front desk PC,desktop,OptiPlex\nPC-2,Back office,desktop,\n' });
    expect(r.body).toMatchObject({ imported: 2 });
    expect((await admin.post('/api/assets/import', { csv: 'tag,name\nPC-1,Reception PC\n' })).body).toMatchObject({ imported: 0, updated: 1 });
    // Only the name column was in the sheet, so the model is untouched.
    expect((await admin.get('/api/assets?q=PC-1')).body.assets[0]).toMatchObject({ name: 'Reception PC', model: 'OptiPlex' });
  });
});

describe('problems', () => {
  it('spots repeat tickets, groups them, and sends the workaround to everyone at once', async () => {
    const { admin, join } = await desk();
    const people = await Promise.all(['Ann', 'Bob', 'Cat'].map((n) => join(n)));
    const ids: number[] = [];
    for (const [i, s] of ['VPN disconnects every few minutes', 'VPN not connecting from home', 'VPN keeps disconnecting'].entries()) {
      ids.push((await people[i].b.post('/api/tickets', { subject: s })).body.ticket.id);
    }
    const { candidates } = (await admin.get('/api/problems/candidates')).body;
    expect(candidates[0].ticketIds.sort()).toEqual([...ids].sort());
    const { id } = (await admin.post('/api/problems', { title: candidates[0].label, ticketIds: ids })).body;
    expect((await admin.get('/api/problems/candidates')).body.candidates).toEqual([]);
    expect((await admin.post(`/api/problems/${id}/share-workaround`)).status).toBe(400);
    await admin.patch(`/api/problems/${id}`, { status: 'known_error', workaround: 'Switch to the backup VPN profile.' });
    expect((await admin.post(`/api/problems/${id}/share-workaround`)).body).toEqual({ sent: 3 });
    const msgs = (await people[1].b.get(`/api/tickets/${ids[1]}`)).body.messages;
    expect(msgs.at(-1)).toMatchObject({ kind: 'reply', body: expect.stringContaining('backup VPN profile') });
  });
});

describe('changes', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  it('approves routine work by itself, holds risky work, and warns employees before it happens', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve Employee');
    // 02:00 in Toronto, three days out: outside working hours with plenty of notice.
    const night = new Date(Date.now() + 3 * DAY); night.setUTCHours(7, 0, 0, 0);
    const low = await admin.post('/api/changes', { title: 'Install label printer driver', affects: 'Label printer', plan: 'Install driver 8.2 and print a test label.', rollback: 'Uninstall it; Windows falls back to the old driver.', plannedStart: at(night.getTime()), plannedEnd: at(night.getTime() + HOUR) });
    expect(low.body).toMatchObject({ status: 'approved', risk: { level: 'low' } });

    const soon = Date.now() + HOUR;
    const high = await admin.post('/api/changes', { title: 'Replace core firewall', affects: 'Internet for everyone', plan: '', rollback: '', plannedStart: at(soon), plannedEnd: at(soon + 2 * HOUR) });
    expect(high.body.status).toBe('pending');
    expect(high.body.risk.reasons.map((r: { text: string }) => r.text)).toContain('No clear way to undo it');
    expect((await eve.b.get('/api/maintenance')).body.maintenance).toEqual([]);
    await admin.post(`/api/changes/${high.body.id}/decide`, { decision: 'approve' });
    expect((await eve.b.get('/api/maintenance')).body.maintenance[0]).toMatchObject({ title: 'Replace core firewall', affects: 'Internet for everyone' });
    expect((await eve.b.post('/api/changes', { title: 'x' })).status).toBe(403);
  });
});

describe('automation', () => {
  it('tests a rule on recent tickets, then applies it to new ones and says so', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve Employee');
    await eve.b.post('/api/tickets', { subject: 'Payroll report missing' });
    await eve.b.post('/api/tickets', { subject: 'Mouse broken' });
    const conditions = [{ field: 'text', op: 'contains', value: 'payroll' }];
    expect((await admin.post('/api/rules/test', { conditions })).body).toMatchObject({ checked: 2, matched: 1 });
    await admin.post('/api/rules', { name: 'Payroll is urgent', conditions, actions: [{ type: 'priority', value: 1 }, { type: 'note', text: 'Call Finance first.' }] });
    const { ticket } = (await eve.b.post('/api/tickets', { subject: 'PAYROLL export fails' })).body;
    const d = (await admin.get(`/api/tickets/${ticket.id}`)).body;
    expect(d.ticket.priority).toBe(1);
    expect(d.messages.map((m: { body: string }) => m.body)).toEqual(expect.arrayContaining(['Call Finance first.', '⚡ Rule “Payroll is urgent” priority set to P1 · Urgent, added a note']));
    expect((await admin.get('/api/rules')).body.rules[0].runs).toBe(1);
    // Employees never see internal notes added by rules.
    expect((await eve.b.get(`/api/tickets/${ticket.id}`)).body.messages.some((m: { body: string }) => m.body === 'Call Finance first.')).toBe(false);
  });
});

describe('two-step sign-in and the audit log', () => {
  it('needs the code after the password, accepts a recovery code once, and records it all', async () => {
    const { admin, adminEmail, join } = await desk();
    const { secret } = (await admin.post('/api/2fa/setup')).body;
    expect((await admin.post('/api/2fa/enable', { code: '000000' })).status).toBe(400);
    const { recoveryCodes } = (await admin.post('/api/2fa/enable', { code: totp(secret) })).body;
    expect(recoveryCodes).toHaveLength(8);

    const fresh = browser();
    const step1 = await fresh.post('/api/auth/login', { email: adminEmail, password: PW });
    expect(step1.body).toEqual({ twoFactor: true, challenge: expect.any(String) });
    expect((await fresh.get('/api/auth/me')).body.user).toBeNull();
    expect((await fresh.post('/api/auth/2fa', { challenge: step1.body.challenge, code: '123456' })).status).toBe(401);
    expect((await fresh.post('/api/auth/2fa', { challenge: step1.body.challenge, code: totp(secret) })).body.user.twoFactor).toBe(true);

    const other = browser();
    const c2 = (await other.post('/api/auth/login', { email: adminEmail, password: PW })).body.challenge;
    expect((await other.post('/api/auth/2fa', { challenge: c2, code: recoveryCodes[0].toLowerCase() })).status).toBe(200);
    const third = browser();
    const c3 = (await third.post('/api/auth/login', { email: adminEmail, password: PW })).body.challenge;
    expect((await third.post('/api/auth/2fa', { challenge: c3, code: recoveryCodes[0] })).status).toBe(401);

    const actions = (await admin.get('/api/audit')).body.entries.map((e: { action: string; detail: string }) => `${e.action} ${e.detail}`.trim());
    expect(actions).toEqual(expect.arrayContaining(['security.2fa_on', 'sign_in with an authenticator code', 'sign_in with a recovery code', 'sign_in.code_wrong']));
    const csv = (await admin.get('/api/audit.csv')).body as string;
    expect(csv.split('\n')[0]).toBe('when,who,action,target,detail,ip');
    const eve = await join('Eve');
    expect((await eve.b.get('/api/audit')).status).toBe(403);
  });

  it('keeps spreadsheet formulas in the audit export inert', async () => {
    const { admin } = await desk();
    await admin.post('/api/rules', { name: '=HYPERLINK("http://x")', conditions: [{ field: 'text', op: 'contains', value: 'a' }], actions: [{ type: 'alert_agents' }] });
    expect((await admin.get('/api/audit.csv')).body).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('the AI assistant', () => {
  const calls: { system: unknown; content: string }[] = [];
  const fake = (reply: string) => ({
    beta: { messages: { create: async (p: { system: unknown; messages: { content: string }[] }) => { calls.push({ system: p.system, content: p.messages[0].content }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }; } } },
  }) as unknown as Anthropic;

  it('is off unless the server has a key', async () => {
    setAiClient(null);
    const { admin } = await desk();
    expect((await admin.get('/api/ai/status')).body).toEqual({ enabled: false, model: null });
    expect((await admin.post('/api/ai/ask', { question: 'How do I add a printer?' })).status).toBe(503);
  });

  it('answers only from the desk’s guides and says which ones', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve');
    const { article } = (await admin.post('/api/articles', { title: 'Add the 2nd floor printer', body: 'Settings > Printers > Add device > PRN-2F.', category: 'Printing' })).body;
    setAiClient(fake(`1. Open Settings > Printers.\n2. Add PRN-2F.\nSOURCES: ${article.id}`));
    const r = (await eve.b.post('/api/ai/ask', { question: 'how do I add the printer' })).body;
    expect(r).toEqual({ answer: '1. Open Settings > Printers.\n2. Add PRN-2F.', sources: [{ id: article.id, title: 'Add the 2nd floor printer' }], suggestTicket: false });
    expect(calls.at(-1)!.content).toContain('PRN-2F');

    setAiClient(fake('NO_ANSWER'));
    expect((await eve.b.post('/api/ai/ask', { question: 'printer makes a grinding noise' })).body).toMatchObject({ answer: null, suggestTicket: true });
  });

  it('never puts internal notes into a reply draft, and only IT can ask for one', async () => {
    const { admin, join } = await desk();
    const eve = await join('Eve');
    const { ticket } = (await eve.b.post('/api/tickets', { subject: 'Outlook asks for password' })).body;
    await admin.post(`/api/tickets/${ticket.id}/messages`, { kind: 'note', body: 'SECRET-NOTE: she reused an old password' });
    setAiClient(fake('Hi Eve, try clearing Credential Manager.'));
    const r = await admin.post(`/api/ai/tickets/${ticket.id}/draft`, {});
    expect(r.body.draft).toBe('Hi Eve, try clearing Credential Manager.');
    expect(calls.at(-1)!.content).not.toContain('SECRET-NOTE');
    expect((await eve.b.post(`/api/ai/tickets/${ticket.id}/draft`, {})).status).toBe(403);
  });
});

describe('single sign-on', () => {
  it('shows no buttons until the server is set up, and refuses to start', async () => {
    const b = browser();
    expect((await b.get('/api/sso/providers')).body).toEqual({ providers: [] });
    const r = await b.get('/api/sso/google/start');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/#/sso-error/not-configured');
  });
  it('lets an admin claim an email domain once', async () => {
    const a = await desk();
    const b = await desk();
    const domain = `${randomBytes(4).toString('hex')}.example.com`;
    expect((await a.admin.put('/api/settings', { ssoDomain: domain.toUpperCase() })).status).toBe(200);
    expect((await a.admin.get('/api/settings')).body.ssoDomain).toBe(domain);
    expect((await b.admin.put('/api/settings', { ssoDomain: domain })).status).toBe(409);
    expect((await b.admin.put('/api/settings', { ssoDomain: 'not a domain' })).status).toBe(400);
  });
});
