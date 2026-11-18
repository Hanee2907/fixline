import { randomBytes } from 'node:crypto';
import { SLA } from '../shared/sla.js';
import type { Category, Priority } from '../shared/types.js';
import type { Db } from './db.js';
import { hashPassword } from './auth.js';

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

export async function createDemoWorkspace(db: Db, now = new Date()) {
  const rand = rng(11);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const tag = randomBytes(5).toString('hex');
  const { rows: ws } = await db.query<{ id: number }>(
    `INSERT INTO workspaces (name, join_code, demo) VALUES ($1, $2, TRUE) RETURNING id`,
    [COMPANY, `demo-${tag}`],
  );
  const workspaceId = ws[0].id;
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

  // Today's queue: the tickets from the reference design, each in a different state.
  seeds.push(
    { subject: 'Account locked after password change', description: 'I changed my password this morning and now I am locked out of my PC.', category: 'Access', priority: 2, status: 'solved', requester: 'tom', assignee: 'you', ago: 55, responded: 3, solvedAfter: 9, resolution: 'Unlocked the account; the old password was still saved on Tom’s phone.', rating: 'good', location: 'Warehouse' },
    { subject: 'Request: Adobe Acrobat licence', description: 'Could I get Acrobat Pro to edit supplier contracts? No rush.', category: 'Software', priority: 4, status: 'waiting', requester: 'sara', ago: 26 * 60, responded: 40, pausedAgo: 25 * 60, waitingReason: 'Waiting for manager approval', thread: [['js', 'reply', 'This request needs your manager’s approval. I have asked them, and the ticket is paused until they reply.', 40]] },
    { subject: 'Laptop battery swelling', description: 'The bottom of my laptop is bulging and the trackpad clicks by itself.', category: 'Hardware', priority: 3, status: 'waiting', requester: 'lena', assignee: 'js', ago: 5 * 60, responded: 12, pausedAgo: 4 * 60, waitingReason: 'Waiting on replacement part', device: 'LT-0144 · Win 11', thread: [['js', 'reply', 'Please stop using it on battery. I have a loaner ready at the IT desk and ordered a new battery.', 12]] },
    { subject: 'New hire: laptop + accounts for Monday', description: 'Priya joins Finance on Monday. She needs a laptop, email and access to the finance shared drive.', category: 'Onboarding', priority: 4, status: 'open', requester: 'kiran', assignee: 'js', ago: (2 * 24 + 20) * 60, responded: 30, location: 'HR' },
    { subject: 'Production line PC won’t boot', description: 'The HMI PC on Line 4 shows a black screen after the logo. The line is running on manual.', category: 'Hardware', priority: 1, status: 'open', requester: 'dev', assignee: 'js', ago: 128, responded: 6, device: 'PC-L4-HMI · Win 10 IoT', location: 'Plant 2, Line 4', thread: [['js', 'reply', 'On my way to Line 4 with a spare drive.', 6], ['js', 'note', 'Drive failed SMART check. Imaging the spare now.', 70]] },
    { subject: 'Label printer offline, shipping dock', description: 'The Zebra printer at the shipping dock says offline, we can’t print shipping labels.', category: 'Printing', priority: 2, status: 'new', requester: 'tom', ago: 242, location: 'Warehouse · shipping dock' },
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
  let number = 1001;
  for (const s of seeds) {
    const created = new Date(now.getTime() - s.ago * MIN);
    const at = (m: number) => new Date(created.getTime() + m * MIN);
    const responseDue = new Date(created.getTime() + SLA[s.priority].respond);
    const due = new Date(created.getTime() + SLA[s.priority].resolve);
    const solvedAt = s.status === 'solved' ? at(s.solvedAfter ?? 30) : null;
    const pausedAt = s.pausedAgo != null ? new Date(now.getTime() - s.pausedAgo * MIN) : null;
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO tickets (workspace_id, number, subject, description, category, priority, status, waiting_reason, requester_id, assignee_id,
                            device, location, channel, created_at, updated_at, first_response_at, response_due_at, due_at, paused_at, solved_at,
                            resolution, rating, incident_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'portal',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [workspaceId, number++, s.subject, s.description, s.category, s.priority, s.status, s.waitingReason ?? '', ids[s.requester], s.assignee ? ids[s.assignee] : null,
        s.device ?? '', s.location ?? '', created, solvedAt ?? pausedAt ?? created, s.responded != null ? at(s.responded) : null, responseDue, due, pausedAt, solvedAt,
        s.resolution ?? '', s.rating ?? null, s.incident ? incidentId : null],
    );
    const ticketId = rows[0].id;
    await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, null, 'event', 'Ticket created', created]);
    for (const [who, kind, body, after] of s.thread ?? []) {
      await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, ids[who], kind, body, at(after)]);
    }
    if (s.status === 'solved') {
      await db.query('INSERT INTO messages (ticket_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, $5)', [ticketId, s.assignee ? ids[s.assignee] : null, 'event', `Resolved: ${s.resolution}`, solvedAt]);
    }
  }
  await db.query('UPDATE workspaces SET next_number = $2 WHERE id = $1', [workspaceId, number]);
  return { workspaceId, agentId: ids.you, requesterId: ids.maya };
}

/** Demo workspaces are throwaway: removed a day after they were made. */
export async function removeOldDemos(db: Db) {
  await db.query(`DELETE FROM workspaces WHERE demo AND created_at < now() - interval '1 day'`);
}
