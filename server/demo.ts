import { randomBytes } from 'node:crypto';
import { SLA, remainingAtPause, targetsFor } from '../shared/sla.js';
import type { Hours } from '../shared/hours.js';
import type { Category, Priority } from '../shared/types.js';
import type { Db } from './db.js';
import { hashPassword } from './auth.js';
import { samplePasswordPrompt } from './png.js';
import { assessRisk } from './modules/changes.js';

/** A made-up manufacturer, so the demo never looks like a real company's help desk. */
const COMPANY = 'Northwind Manufacturing';

const AGENTS = [
  { key: 'you', name: 'Alex Rivera', dept: 'IT Service Desk', role: 'admin' },
  { key: 'js', name: 'Jordan Smith', dept: 'IT Service Desk', role: 'agent' },
  { key: 'pn', name: 'Priya Nair', dept: 'Network', role: 'agent' },
] as const;

const PEOPLE = [
  { key: 'maya', name: 'Maya Rodriguez', dept: 'Office · 1st floor' },
  { key: 'dev', name: 'Dev Thakur', dept: 'Plant 2' },
  { key: 'ana', name: 'Ana Lopez', dept: 'Finance' },
  { key: 'kiran', name: 'Kiran Patel', dept: 'HR' },
  { key: 'omar', name: 'Omar Bashir', dept: 'Sales · remote' },
  { key: 'sara', name: 'Sara Novak', dept: 'Sales' },
  { key: 'tom', name: 'Tom Chen', dept: 'Warehouse' },
  { key: 'lena', name: 'Lena Fischer', dept: 'Engineering' },
  { key: 'ravi', name: 'Ravi Iyer', dept: 'Plant 1' },
  { key: 'grace', name: 'Grace Kim', dept: 'Marketing' },
] as const;

const ARTICLES: [string, Category, string, number][] = [
  ['Clear old passwords from Credential Manager', 'Access', 'When Outlook or Teams keeps asking for a password after a reset, Windows is still offering the old one.\n1. Open Credential Manager from the Start menu.\n2. Under Windows Credentials, remove entries that start with MicrosoftOffice or MS.Outlook.\n3. Restart Outlook and sign in with the new password.', 14],
  ['Outlook password loop after a password reset', 'Email', 'If clearing Credential Manager did not help: close Outlook, open Control Panel > Mail > Show Profiles, add a new profile, set it as default and open Outlook again.', 6],
  ['Unlock an account after too many sign-in attempts', 'Access', 'Accounts unlock automatically after 15 minutes. To unlock now, an agent can unlock the user in the admin console. Remind the user to update the password on their phone too, which is the most common cause.', 11],
  ['Connect to the VPN', 'Network', '1. Open the VPN client from the system tray.\n2. Choose your nearest site and sign in with your work account.\n3. Approve the prompt on your authenticator app.\nIf it disconnects every few minutes, switch from Wi-Fi to a wired connection and check for a client update.', 9],
  ['Add the 2nd floor printer', 'Printing', 'Settings > Bluetooth & devices > Printers > Add device. Choose PRN-2F-COLOR. If it does not appear, add it manually with the address printers.northwind.local.', 8],
  ['Printer shows offline', 'Printing', 'Check the printer has paper and no error on its screen. On your PC, open the print queue, cancel stuck jobs, then right-click the printer and untick "Use printer offline".', 7],
  ['Second monitor not detected or flickering', 'Hardware', 'Re-seat both ends of the cable, try another port on the dock, then press Win + P and choose Extend. Flickering usually means a loose or damaged cable: swap it before anything else.', 5],
  ['Request new software or a licence', 'Software', 'Open a ticket with the software name and why you need it. Paid licences need your manager to approve; the ticket pauses until they do.', 4],
  ['New hire checklist (IT)', 'Onboarding', 'Create the account, add to department groups, assign licences, prepare and image the laptop, set up MFA on first day, and book a 15-minute welcome session.', 6],
  ['Teams camera or microphone not working', 'Software', 'In Teams: Settings > Devices, choose the right camera and mic. In Windows: Settings > Privacy > Camera and Microphone, allow access for desktop apps. Close other apps that use the camera.', 5],
  ['Wi-Fi keeps dropping in meeting rooms', 'Network', 'Forget the network and reconnect. If several people are affected in the same room, note the room number and time: it usually points to an access point that needs a restart.', 3],
  ['Laptop battery swelling or overheating', 'Hardware', 'Stop using the laptop on battery, shut it down and keep it on a hard surface. Do not press on the case. IT will swap the device and order a replacement battery.', 2],
];

const MACROS: [string, string][] = [
  ['Ask for a screenshot', 'Thanks for reporting this! Could you send a screenshot of the error message? It will help me find the cause faster.'],
  ['Remote session', 'I can take a look remotely. Are you free for 5 minutes now? I will send you a connection link.'],
  ['Restart first', 'Could you please restart the computer (Start > Power > Restart) and tell me if the problem is still there?'],
  ['Waiting on approval', 'This request needs your manager’s approval. I have asked them, and the ticket is paused until they reply.'],
  ['Fixed, please confirm', 'This should be fixed now. Could you check on your side and let me know? If it happens again, just reply here.'],
];

/** History used to fill reports: the kinds of tickets a help desk solves every day. */
const HISTORY: [string, Category, Priority, string][] = [
  ['Account locked after password change', 'Access', 2, 'Unlocked the account and updated the saved password on the phone.'],
  ['Outlook asking for password', 'Email', 2, 'Cleared old credentials from Credential Manager.'],
  ['Cannot connect to VPN from home', 'Network', 2, 'Updated the VPN client and re-enrolled MFA.'],
  ['Printer offline in Finance', 'Printing', 3, 'Cleared stuck jobs and turned off "use printer offline".'],
  ['Need Visio installed', 'Software', 4, 'Licence approved by manager and installed.'],
  ['Monitor flickering', 'Hardware', 3, 'Replaced the DisplayPort cable.'],
  ['Teams microphone not working', 'Software', 3, 'Allowed microphone access for desktop apps.'],
  ['Wi-Fi drops in Room B', 'Network', 3, 'Restarted the access point in Room B.'],
  ['New starter laptop for Engineering', 'Onboarding', 3, 'Laptop imaged, account created and MFA set up with the user.'],
  ['Shared mailbox missing', 'Email', 3, 'Added the user to the mailbox group; it appeared after restarting Outlook.'],
  ['Excel crashes opening a file', 'Software', 3, 'Repaired Office and disabled a broken add-in.'],
  ['Forgot password', 'Access', 2, 'Reset the password after verifying identity.'],
  ['Scanner not sending to email', 'Printing', 3, 'Updated the scan-to-email password on the device.'],
  ['Laptop very slow', 'Hardware', 3, 'Freed disk space and removed startup apps.'],
];

const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const MIN = 60_000;

export async function createDemoWorkspace(db: Db, now = new Date(), timeZone = 'America/Toronto') {
  const rand = rng(11);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const tag = randomBytes(5).toString('hex');
  // The demo desk is open 7:00–23:00 every day in the visitor's own time zone, so it feels alive
  // at most hours; at night the countdowns show "after hours", which is the feature working.
  const { rows: ws } = await db.query<{ id: number }>(
    `INSERT INTO workspaces (name, join_code, demo, time_zone, work_days, day_start, day_end, urgent_24x7, inbound_token)
     VALUES ($1, $2, TRUE, $3, '0,1,2,3,4,5,6', 420, 1380, TRUE, $4) RETURNING id`,
    [COMPANY, `demo-${tag}`, timeZone, randomBytes(18).toString('base64url')],
  );
  const workspaceId = ws[0].id;
  const hours: Hours = { timeZone, days: [0, 1, 2, 3, 4, 5, 6], start: 420, end: 1380, urgent24x7: true };
  const pw = await hashPassword(randomBytes(24).toString('hex')); // nobody can sign in to a demo with a password

  const ids: Record<string, number> = {};
  const userValues: unknown[] = [];
  const all = [...AGENTS.map((a) => ({ ...a })), ...PEOPLE.map((p) => ({ ...p, role: 'requester' as const }))];
  const tuples = all.map((u, i) => {
    userValues.push(workspaceId, `${u.key}.${tag}@demo.fixline`, u.name, u.role, u.dept, pw);
    return `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`;
  });
  const { rows: us } = await db.query<{ id: number; email: string }>(
    `INSERT INTO users (workspace_id, email, name, role, department, password_hash) VALUES ${tuples.join(', ')} RETURNING id, email`,
    userValues,
  );
  for (const u of us) ids[u.email.split('.')[0]] = u.id;

  // Knowledge base and saved replies.
  for (const [title, category, body, uses] of ARTICLES) {
    await db.query('INSERT INTO articles (workspace_id, title, body, category, uses) VALUES ($1, $2, $3, $4, $5)', [workspaceId, title, body, category, uses]);
  }
  for (const [title, body] of MACROS) await db.query('INSERT INTO macros (workspace_id, title, body) VALUES ($1, $2, $3)', [workspaceId, title, body]);

  const { rows: inc } = await db.query<{ id: number }>(
    `INSERT INTO incidents (workspace_id, title, message, created_at) VALUES ($1, 'VPN outage · Plant 2', $2, $3) RETURNING id`,
    [workspaceId, 'The VPN is down for Plant 2 and some remote staff. We are working with the provider; next update by the top of the hour. No need to open a new ticket.', new Date(now.getTime() - 70 * MIN)],
  );
  const incidentId = inc[0].id;

  type Seed = {
    subject: string; description: string; category: Category; priority: Priority; status: 'new' | 'open' | 'waiting' | 'solved';
    requester: string; assignee?: string; ago: number; responded?: number; solvedAfter?: number; pausedAgo?: number; waitingReason?: string;
    device?: string; location?: string; resolution?: string; rating?: 'good' | 'bad'; incident?: boolean;
    thread?: [string, 'reply' | 'note', string, number][]; // author key, kind, body, minutes after creation
  };
  const seeds: Seed[] = [];

  // Two weeks of solved tickets, for reports and "similar tickets".
  for (let i = 0; i < 46; i++) {
    const [subject, category, priority, resolution] = pick(HISTORY);
    const ago = Math.floor(rand() * 14 * 24 * 60) + 600;
    const target = SLA[priority].resolve / MIN;
    seeds.push({
      subject, description: subject + '.', category, priority, status: 'solved',
      requester: pick(PEOPLE).key, assignee: pick(AGENTS).key, ago,
      responded: 4 + Math.floor(rand() * 30), solvedAfter: Math.floor(target * (0.15 + rand() * (rand() < 0.88 ? 0.8 : 1.4))),
      resolution, rating: rand() < 0.7 ? (rand() < 0.95 ? 'good' : 'bad') : undefined,
    });
  }

  // Maya's laptop keeps coming back: three earlier tickets this month (plus today's), so its health warning fires.
  seeds.push(
    { subject: 'Laptop very slow', description: 'Takes 10 minutes to start and Excel freezes.', category: 'Hardware', priority: 3, status: 'solved', requester: 'maya', assignee: 'js', ago: 9 * 24 * 60, responded: 15, solvedAfter: 180, resolution: 'Freed disk space and removed startup apps.', rating: 'good', device: 'LT-0231 · Win 11' },
    { subject: 'Laptop fan very loud and hot', description: 'The fan runs at full speed all day.', category: 'Hardware', priority: 3, status: 'solved', requester: 'maya', assignee: 'you', ago: 16 * 24 * 60, responded: 22, solvedAfter: 240, resolution: 'Cleaned the vents; battery health is at 61%.', device: 'LT-0231 · Win 11' },
    { subject: 'Wi-Fi drops on my laptop only', description: 'Everyone else is fine, my laptop loses Wi-Fi a few times an hour.', category: 'Network', priority: 3, status: 'solved', requester: 'maya', assignee: 'pn', ago: 24 * 24 * 60, responded: 30, solvedAfter: 300, resolution: 'Updated the Wi-Fi driver.', rating: 'good', device: 'LT-0231 · Win 11' },
  );

  // Today's queue: the tickets from the reference design, each in a different state.
  seeds.push(
    { subject: 'Account locked after password change', description: 'I changed my password this morning and now I am locked out of my PC.', category: 'Access', priority: 2, status: 'solved', requester: 'tom', assignee: 'you', ago: 55, responded: 3, solvedAfter: 9, resolution: 'Unlocked the account; the old password was still saved on Tom’s phone.', rating: 'good', location: 'Warehouse' },
    { subject: 'Request: Adobe Acrobat licence', description: 'Could I get Acrobat Pro to edit supplier contracts? No rush.', category: 'Software', priority: 4, status: 'waiting', requester: 'sara', ago: 26 * 60, responded: 40, pausedAgo: 25 * 60, waitingReason: 'Waiting for manager approval', thread: [['js', 'reply', 'This request needs your manager’s approval. I have asked them, and the ticket is paused until they reply.', 40]] },
    { subject: 'Laptop battery swelling', description: 'The bottom of my laptop is bulging and the trackpad clicks by itself.', category: 'Hardware', priority: 3, status: 'waiting', requester: 'lena', assignee: 'js', ago: 5 * 60, responded: 12, pausedAgo: 4 * 60, waitingReason: 'Waiting on replacement part', device: 'LT-0144 · Win 11', thread: [['js', 'reply', 'Please stop using it on battery. I have a loaner ready at the IT desk and ordered a new battery.', 12]] },
    { subject: 'New hire: laptop + accounts for Monday', description: 'Priya joins Finance on Monday. She needs a laptop, email and access to the finance shared drive.', category: 'Onboarding', priority: 4, status: 'open', requester: 'kiran', assignee: 'js', ago: (2 * 24 + 20) * 60, responded: 30, location: 'HR' },
    { subject: 'Production line PC won’t boot', description: 'The HMI PC on Line 4 shows a black screen after the logo. The line is running on manual.', category: 'Hardware', priority: 1, status: 'open', requester: 'dev', assignee: 'js', ago: 128, responded: 6, device: 'PC-L4-HMI · Win 10 IoT', location: 'Plant 2, Line 4', thread: [['js', 'reply', 'On my way to Line 4 with a spare drive.', 6], ['js', 'note', 'Drive failed SMART check. Imaging the spare now.', 70]] },
    { subject: 'Label printer offline, shipping dock', description: 'The Zebra printer at the shipping dock says offline, we can’t print shipping labels.', category: 'Printing', priority: 2, status: 'new', requester: 'tom', ago: 32, location: 'Warehouse · shipping dock' },
    { subject: 'Can’t print to 2nd floor printer', description: 'My print jobs to the 2nd floor colour printer just disappear.', category: 'Printing', priority: 3, status: 'open', requester: 'ana', assignee: 'you', ago: 415, responded: 20, location: 'Finance', thread: [['you', 'reply', 'Thanks Ana! Could you send a screenshot of the print queue?', 20], ['ana', 'reply', 'Here it is, three jobs stuck with “error”.', 60]] },
    { subject: 'VPN disconnects every 10 minutes', description: 'Working from home, the VPN drops every 10 minutes and Teams calls cut out.', category: 'Network', priority: 2, status: 'open', requester: 'omar', ago: 192, responded: 10, incident: true, location: 'Remote', thread: [['pn', 'note', 'Matches the Plant 2 VPN outage. Linked.', 10]] },
    { subject: 'VPN not connecting at Plant 2', description: 'VPN client says "gateway unreachable".', category: 'Network', priority: 2, status: 'new', requester: 'ravi', ago: 34, incident: true, location: 'Plant 2' },
    { subject: 'Cannot reach shared drive over VPN', description: 'Mapped drives are empty since this morning.', category: 'Network', priority: 3, status: 'new', requester: 'grace', ago: 21, incident: true },
    { subject: 'Second monitor flickering', description: 'My second screen flickers every few seconds since I moved desks.', category: 'Hardware', priority: 3, status: 'new', requester: 'lena', ago: 50, device: 'LT-0144 · Win 11', location: 'Engineering' },
    { subject: 'Teams camera not detected', description: 'Teams says no camera found, but it works in the Camera app.', category: 'Software', priority: 3, status: 'open', requester: 'grace', assignee: 'pn', ago: 160, responded: 25, location: 'Marketing' },
    { subject: 'Shared mailbox missing in Outlook', description: 'The sales@ shared mailbox disappeared from Outlook.', category: 'Email', priority: 3, status: 'open', requester: 'sara', assignee: 'you', ago: 300, responded: 35 },
    { subject: 'Excel crashes when opening macro file', description: 'The weekly report file crashes Excel as soon as I enable macros.', category: 'Software', priority: 3, status: 'new', requester: 'ana', ago: 15, location: 'Finance' },
    { subject: 'Outlook keeps asking for password', description: 'Since I changed my password yesterday, Outlook pops up a login box every few minutes. Web mail works fine.', category: 'Email', priority: 2, status: 'open', requester: 'maya', assignee: 'you', ago: 18, device: 'LT-0231 · Win 11', location: 'Office, 1st floor', thread: [['you', 'note', 'Old password still saved in Credential Manager, same as a few tickets last week.', 8]] },
  );

  seeds.sort((a, b) => b.ago - a.ago);
  const ticketIds: Record<string, { id: number; number: number }> = {};
  let number = 1001;
  for (const s of seeds) {
    const created = new Date(now.getTime() - s.ago * MIN);
    const at = (m: number) => new Date(created.getTime() + m * MIN);
    // Deadlines count working time only, exactly as for real tickets.
    const { responseDueAt: responseDue, dueAt: due } = targetsFor(s.priority, created, hours);
    const solvedAt = s.status === 'solved' ? at(s.solvedAfter ?? 30) : null;
    const pausedAt = s.pausedAgo != null ? new Date(now.getTime() - s.pausedAgo * MIN) : null;
    const pausedLeft = pausedAt ? remainingAtPause({ priority: s.priority, dueAt: due.toISOString(), responseDueAt: responseDue.toISOString() }, pausedAt, hours) : null;
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO tickets (workspace_id, number, subject, description, category, priority, status, waiting_reason, requester_id, assignee_id,
                            device, location, channel, created_at, updated_at, first_response_at, response_due_at, due_at, paused_at, solved_at,
                            resolution, rating, incident_id, paused_resolve_left, paused_respond_left)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'portal',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [workspaceId, number++, s.subject, s.description, s.category, s.priority, s.status, s.waitingReason ?? '', ids[s.requester], s.assignee ? ids[s.assignee] : null,
        s.device ?? '', s.location ?? '', created, solvedAt ?? pausedAt ?? created, s.responded != null ? at(s.responded) : null, responseDue, due, pausedAt, solvedAt,
        s.resolution ?? '', s.rating ?? null, s.incident ? incidentId : null, pausedLeft?.resolve ?? null, pausedLeft?.respond ?? null],
    );
    const ticketId = rows[0].id;
    ticketIds[s.subject] = { id: ticketId, number: number - 1 };
    await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, null, 'event', 'Ticket created', created]);
    for (const [who, kind, body, after] of s.thread ?? []) {
      await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, ids[who], kind, body, at(after)]);
    }
    if (s.status === 'solved') {
      await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, s.assignee ? ids[s.assignee] : null, 'event', `Resolved: ${s.resolution}`, solvedAt]);
    }
  }
  await db.query('UPDATE workspaces SET next_number = $2 WHERE id = $1', [workspaceId, number]);

  // Maya attached a screenshot of the password prompt.
  const outlook = ticketIds['Outlook keeps asking for password'];
  const shot = samplePasswordPrompt();
  await db.query('INSERT INTO attachments (ticket_id, message_id, name, type, size, data, uploaded_by) VALUES ($1, NULL, $2, $3, $4, $5, $6)', [
    outlook.id, 'outlook-password-prompt.png', 'image/png', shot.length, shot, ids.maya,
  ]);

  // A few emails in the outbox, as the desk would have sent them today (demo desks never really send).
  const mail = (to: string, subject: string, body: string, kind: string, ticket: { id: number }, ago: number) =>
    db.query('INSERT INTO emails (workspace_id, to_email, subject, body, kind, ticket_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      workspaceId, `${to}.${tag}@demo.fixline`, subject, body, kind, ticket.id, 'logged', new Date(now.getTime() - ago * MIN),
    ]);
  const key = (subject: string) => `[FX-${ticketIds[subject].number}]`;
  await mail('tom', `${key('Account locked after password change')} Fixed: Account locked after password change`, 'Hi Tom,\n\nGood news: your ticket is fixed.\n\nUnlocked the account; the old password was still saved on Tom’s phone.', 'solved', ticketIds['Account locked after password change'], 46);
  await mail('ana', `Re: ${key('Can’t print to 2nd floor printer')} Can’t print to 2nd floor printer`, 'Alex Rivera from IT replied:\n\nThanks Ana! Could you send a screenshot of the print queue?', 'reply', ticketIds['Can’t print to 2nd floor printer'], 395);
  await mail('maya', `${key('Outlook keeps asking for password')} We got your request: Outlook keeps asking for password`, 'Hi Maya,\n\nThanks for letting IT know. Your ticket is in the queue as Email, high priority. Someone will reply within 30m of working time.', 'created', outlook, 18);
  await seedItsm(db, { workspaceId, ids, ticketIds, now, hours, tag });
  return { workspaceId, agentId: ids.you, requesterId: ids.maya };
}

/** Demo workspaces are throwaway: removed a day after they were made. */
export async function removeOldDemos(db: Db) {
  await db.query(`DELETE FROM workspaces WHERE demo AND created_at < now() - interval '1 day'`);
}

type FieldSeed = { key: string; label: string; type: 'text' | 'textarea' | 'select' | 'date'; options?: string[]; required?: boolean };
const CATALOG: { name: string; icon: string; category: Category; description: string; keywords: string; approval: boolean; priority: Priority; fields: FieldSeed[] }[] = [
  { name: 'New software', icon: '💿', category: 'Software', description: 'Install an app or get a licence.', keywords: 'install,app,licence,license,adobe,acrobat,visio,program,software', approval: true, priority: 4,
    fields: [{ key: 'software', label: 'Software', type: 'text', required: true }, { key: 'why', label: 'What it’s for', type: 'textarea', required: true }, { key: 'when', label: 'Needed by', type: 'date' }] },
  { name: 'Access to a shared drive or mailbox', icon: '🗂️', category: 'Access', description: 'Folders, shared mailboxes, Teams sites.', keywords: 'access,folder,drive,mailbox,shared,permission,teams site', approval: true, priority: 3,
    fields: [{ key: 'what', label: 'Drive or mailbox', type: 'text', required: true }, { key: 'level', label: 'Access', type: 'select', options: ['Read only', 'Read and edit'], required: true }] },
  { name: 'New laptop or monitor', icon: '💻', category: 'Hardware', description: 'Replace or add a device.', keywords: 'laptop,monitor,screen,computer,pc,dock,keyboard,mouse,headset', approval: true, priority: 4,
    fields: [{ key: 'item', label: 'What you need', type: 'select', options: ['Laptop', 'Monitor', 'Dock', 'Keyboard and mouse', 'Headset'], required: true }, { key: 'why', label: 'Why', type: 'textarea' }] },
  { name: 'New starter', icon: '👋', category: 'Onboarding', description: 'Laptop, accounts and access for someone joining.', keywords: 'new hire,starter,joining,onboard,onboarding,new employee', approval: false, priority: 3,
    fields: [{ key: 'name', label: 'Their name', type: 'text', required: true }, { key: 'start', label: 'Start date', type: 'date', required: true }, { key: 'team', label: 'Team', type: 'text', required: true }, { key: 'needs', label: 'Anything special', type: 'textarea' }] },
  { name: 'Replacement cable or charger', icon: '🔌', category: 'Hardware', description: 'Same-day swap at the IT desk, no approval needed.', keywords: 'cable,charger,adapter,power,usb', approval: false, priority: 4,
    fields: [{ key: 'item', label: 'What broke', type: 'text', required: true }] },
  { name: 'Guest Wi-Fi code', icon: '📶', category: 'Network', description: 'A Wi-Fi code for visitors, valid for a day.', keywords: 'guest,wifi,wi-fi,visitor,internet', approval: false, priority: 4,
    fields: [{ key: 'visitor', label: 'Visitor or company', type: 'text', required: true }, { key: 'date', label: 'Date', type: 'date', required: true }] },
];

/** Requests, devices, problems, changes, rules and the audit trail for the demo desk. */
async function seedItsm(db: Db, d: { workspaceId: number; ids: Record<string, number>; ticketIds: Record<string, { id: number; number: number }>; now: Date; hours: Hours; tag: string }) {
  const { workspaceId: ws, ids, ticketIds, now, hours } = d;
  const day = 24 * 60 * MIN;
  const dateAgo = (days: number) => new Date(now.getTime() - days * day).toISOString().slice(0, 10);

  // Who approves whose requests.
  for (const [person, manager] of [['sara', 'maya'], ['omar', 'maya'], ['grace', 'maya'], ['ana', 'kiran'], ['tom', 'kiran'], ['dev', 'ravi']]) {
    await db.query('UPDATE users SET manager_id = $2 WHERE id = $1', [ids[person], ids[manager]]);
  }

  const catalog: Record<string, number> = {};
  for (const c of CATALOG) {
    const { rows } = await db.query<{ id: number }>(
      'INSERT INTO catalog_items (workspace_id, name, description, icon, category, keywords, fields, needs_approval, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [ws, c.name, c.description, c.icon, c.category, c.keywords, JSON.stringify(c.fields), c.approval, c.priority],
    );
    catalog[c.name] = rows[0].id;
  }

  // Sara's Acrobat request waits for her manager, Maya (switch to Maya's view to approve it).
  const acrobat = ticketIds['Request: Adobe Acrobat licence'].id;
  await db.query(
    `UPDATE tickets SET kind = 'request', catalog_item_id = $2, form = $3, approval = 'pending', approver_id = $4, waiting_reason = 'Waiting for approval from Maya Rodriguez', subject = 'New software: Adobe Acrobat Pro' WHERE id = $1`,
    [acrobat, catalog['New software'], JSON.stringify({ Software: 'Adobe Acrobat Pro', 'What it’s for': 'Editing supplier contracts' }), ids.maya],
  );
  await db.query(`UPDATE messages SET kind = 'event', author_id = NULL, body = 'Sent to Maya Rodriguez for approval · the clock waits until then' WHERE ticket_id = $1 AND author_id IS NOT NULL`, [acrobat]);
  const starter = ticketIds['New hire: laptop + accounts for Monday'].id;
  await db.query(`UPDATE tickets SET kind = 'request', catalog_item_id = $2, form = $3 WHERE id = $1`, [starter, catalog['New starter'], JSON.stringify({ 'Their name': 'Priya Shah', 'Start date': dateAgo(-3), Team: 'Finance', 'Anything special': 'Access to the finance shared drive' })]);

  // Devices. Maya's laptop is old, out of warranty and keeps coming back.
  // [tag, name, type, model, status, assigned to, bought (days ago), warranty ended (days ago; negative = still covered), location]
  const ASSETS: [string, string, string, string, string, string | null, number, number, string][] = [
    ['LT-0231', 'Maya’s laptop', 'laptop', 'Dell Latitude 5410', 'in_use', 'maya', 1680, 220, 'Office, 1st floor'],
    ['LT-0144', 'Lena’s laptop', 'laptop', 'Lenovo ThinkPad T14', 'repair', 'lena', 770, -20, 'IT desk'],
    ['LT-0310', 'Ana’s laptop', 'laptop', 'Lenovo ThinkPad T14s', 'in_use', 'ana', 440, -660, 'Finance'],
    ['LT-0322', 'Omar’s laptop', 'laptop', 'Dell Latitude 7450', 'in_use', 'omar', 180, -910, 'Remote'],
    ['LT-0350', 'Spare laptop', 'laptop', 'Dell Latitude 7450', 'in_stock', null, 70, -1020, 'IT store room'],
    ['PC-L4-HMI', 'Line 4 HMI PC', 'desktop', 'Advantech TPC-1551', 'in_use', 'dev', 2000, 900, 'Plant 2, Line 4'],
    ['PRN-2F-COLOR', '2nd floor colour printer', 'printer', 'HP Color LaserJet M554', 'in_use', null, 1090, -12, 'Office, 2nd floor'],
    ['ZB-DOCK-01', 'Shipping dock label printer', 'printer', 'Zebra ZT411', 'in_use', null, 1390, 300, 'Warehouse, shipping dock'],
    ['MN-0412', 'Monitor 27"', 'monitor', 'Dell P2723D', 'in_stock', null, 150, -950, 'IT store room'],
  ];
  for (const [tag, name, type, model, status, who, bought, warranty, location] of ASSETS) {
    await db.query(
      'INSERT INTO assets (workspace_id, tag, name, type, model, serial, status, assigned_to, location, purchased_on, warranty_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [ws, tag, name, type, model, `SN${tag.replace(/\W/g, '')}${d.tag.slice(0, 4).toUpperCase()}`, status, who ? ids[who] : null, location, dateAgo(bought), dateAgo(warranty)],
    );
  }
  // Tickets that mention a device are linked to it, as new ones are automatically.
  await db.query(`UPDATE tickets t SET asset_id = a.id FROM assets a WHERE t.workspace_id = $1 AND a.workspace_id = $1 AND split_part(t.device, ' ', 1) = a.tag`, [ws]);
  await db.query(`UPDATE tickets t SET asset_id = a.id FROM assets a WHERE t.workspace_id = $1 AND a.workspace_id = $1 AND a.tag = 'ZB-DOCK-01' AND t.subject LIKE 'Label printer%'`, [ws]);
  await db.query(`UPDATE tickets t SET asset_id = a.id FROM assets a WHERE t.workspace_id = $1 AND a.workspace_id = $1 AND a.tag = 'PRN-2F-COLOR' AND t.subject LIKE '%2nd floor printer%'`, [ws]);

  // A known problem: Outlook password prompts after a password change, with a workaround.
  const { rows: prb } = await db.query<{ id: number }>(
    `INSERT INTO problems (workspace_id, number, title, description, status, root_cause, workaround, assignee_id, created_at)
     VALUES ($1, 101, 'Outlook asks for a password again after a password change', $2, 'known_error', $3, $4, $5, $6) RETURNING id`,
    [ws, 'Several people a week see Outlook password prompts right after changing their password.',
      'Windows keeps the old password in Credential Manager and Outlook keeps trying it.',
      'Open Credential Manager, remove entries starting with MicrosoftOffice or MS.Outlook, then restart Outlook.',
      ids.you, new Date(now.getTime() - 12 * day)],
  );
  await db.query(`UPDATE tickets SET problem_id = $2 WHERE workspace_id = $1 AND subject IN ('Outlook asking for password', 'Outlook keeps asking for password')`, [ws, prb[0].id]);

  // Changes: one done, one approved for tonight (employees see a banner), two waiting for a decision.
  const at = (hoursFromNow: number) => now.getTime() + hoursFromNow * 60 * MIN;
  const CHANGES: { title: string; affects: string; plan: string; rollback: string; start: number; end: number; status: string; by: string; approvedBy?: string; outcome?: string }[] = [
    { title: 'Update VPN client to 7.2 on all laptops', affects: 'VPN, all laptops', plan: 'Push the update through Intune in three waves: IT, Sales, everyone else.', rollback: 'Intune can roll back to 7.1 for any wave within an hour.', start: -7 * 24 - 4, end: -7 * 24 - 1, status: 'done', by: 'pn', approvedBy: 'you', outcome: 'Done. 212 of 214 laptops updated; two were offline and updated next morning.' },
    { title: 'Restart Plant 2 VPN gateway and apply firmware fix', affects: 'VPN at Plant 2', plan: '1. Back up config. 2. Apply vendor firmware 9.4.3. 3. Restart. 4. Test from Plant 2 and from home.', rollback: 'Gateway keeps the previous firmware; boot into it from the console (10 minutes).', start: 6, end: 7, status: 'approved', by: 'pn', approvedBy: 'you' },
    { title: 'Replace core network switch at Plant 1', affects: 'Network, Plant 1 production', plan: 'Swap the switch and move cables port by port.', rollback: '', start: 6.5, end: 14, status: 'pending', by: 'pn' },
    { title: 'Install new driver for the shipping dock label printer', affects: 'Label printer ZB-DOCK-01', plan: 'Install Zebra driver 8.2 on the two shipping PCs and print a test label.', rollback: 'Uninstall it; Windows falls back to the old driver.', start: 3 * 24, end: 3 * 24 + 0.5, status: 'pending', by: 'js' },
  ];
  let n = 2001;
  for (const c of CHANGES) {
    const plannedStart = at(c.start);
    const plannedEnd = at(c.end);
    const live = (s: string) => s === 'pending' || s === 'approved';
    const clashes = CHANGES.filter((o) => o !== c && live(o.status) && live(c.status) && at(o.start) < plannedEnd && at(o.end) > plannedStart).length;
    const filedAt = Math.min(now.getTime() - 2 * 60 * MIN, plannedStart - 3 * day);
    const risk = assessRisk({ title: c.title, affects: c.affects, plan: c.plan, rollback: c.rollback, plannedStart, plannedEnd }, { hours, now: filedAt, clashes, similarFailures: 0 });
    await db.query(
      `INSERT INTO changes (workspace_id, number, title, plan, rollback, affects, status, planned_start, planned_end, risk_score, risk_reasons, requested_by, approved_by, outcome, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ws, n++, c.title, c.plan, c.rollback, c.affects, c.status, new Date(plannedStart), new Date(plannedEnd), risk.score, JSON.stringify(risk.reasons),
        ids[c.by], c.approvedBy ? ids[c.approvedBy] : null, c.outcome ?? '', new Date(filedAt)],
    );
  }

  // Automation rules, written as sentences.
  const RULES: [string, unknown[], unknown[], number][] = [
    ['Production line PCs are urgent', [{ field: 'text', op: 'contains', value: 'line 4, hmi, production line' }], [{ type: 'priority', value: 1 }, { type: 'alert_agents' }], 3],
    ['Printers go to Jordan', [{ field: 'category', op: 'is', value: 'Printing' }], [{ type: 'assign', userId: ids.js }], 11],
    ['Outlook password prompts → known problem', [{ field: 'text', op: 'contains', value: 'outlook' }, { field: 'text', op: 'contains', value: 'password' }], [{ type: 'link_problem', problemId: prb[0].id }, { type: 'note', text: 'Known problem PRB-101: clear Credential Manager first.' }], 4],
  ];
  for (const [name, conditions, actions, runs] of RULES) {
    await db.query('INSERT INTO rules (workspace_id, name, conditions, actions, runs, last_run_at) VALUES ($1,$2,$3,$4,$5,$6)', [ws, name, JSON.stringify(conditions), JSON.stringify(actions), runs, new Date(now.getTime() - runs * 90 * MIN)]);
  }

  // A day of audit history.
  const AUDIT: [string, string, string, string, number][] = [
    ['you', 'sign_in', '', 'with Microsoft', 8 * 60],
    ['js', 'sign_in', '', 'with a password', 7 * 60],
    ['pn', 'sign_in.failed', '', 'wrong password', 6 * 60 + 5],
    ['pn', 'sign_in', '', 'with a password', 6 * 60],
    ['you', 'change.approved', 'CHG-2002', 'Restart Plant 2 VPN gateway and apply firmware fix', 5 * 60],
    ['you', 'rule.updated', 'Printers go to Jordan', 'on', 4 * 60],
    ['you', 'person.role_changed', 'Priya Nair', 'agent', 3 * 60],
    ['you', 'security.2fa_on', '', '', 2 * 60],
    ['you', 'ticket.resolved', `FX-${ticketIds['Account locked after password change'].number}`, '', 46],
  ];
  for (const [who, action, target, detail, ago] of AUDIT) {
    await db.query('INSERT INTO audit_log (workspace_id, actor_id, action, target, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [ws, ids[who], action, target, detail, `10.20.1.${ago % 200}`, new Date(now.getTime() - ago * MIN)]);
  }
}
