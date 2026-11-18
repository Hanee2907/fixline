import type { Db } from './db.js';
import type { Article, Attachment, Category, Incident, Message, Person, Priority, Role, Status, Ticket } from '../shared/types.js';
import type { Hours } from '../shared/hours.js';
import { toHours, type HoursRow } from './auth.js';
import type { CheckedFile } from './files.js';

export const safeJson = <T,>(v: string | null | undefined, fallback: T): T => { try { return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
export const iso = (v: unknown): string => new Date(v as string).toISOString();
export const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

export const TICKET_SELECT = `
  t.*, w.prefix,
  r.name AS r_name, r.email AS r_email, r.role AS r_role, r.department AS r_dept,
  a.name AS a_name, a.email AS a_email, a.role AS a_role, a.department AS a_dept,
  ap.name AS ap_name, ap.email AS ap_email, ap.role AS ap_role, ap.department AS ap_dept
  FROM tickets t
  JOIN workspaces w ON w.id = t.workspace_id
  JOIN users r ON r.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users ap ON ap.id = t.approver_id`;

type Row = Record<string, unknown>;

export function toTicket(r: Row): Ticket {
  return {
    id: r.id as number,
    key: `${r.prefix}-${r.number}`,
    subject: r.subject as string,
    description: r.description as string,
    category: r.category as Category,
    priority: r.priority as Priority,
    status: r.status as Status,
    waitingReason: r.waiting_reason as string,
    requester: { id: r.requester_id as number, name: r.r_name as string, email: r.r_email as string, role: r.r_role as Role, department: r.r_dept as string },
    assignee: r.assignee_id
      ? { id: r.assignee_id as number, name: r.a_name as string, email: r.a_email as string, role: r.a_role as Role, department: r.a_dept as string }
      : null,
    device: r.device as string,
    location: r.location as string,
    channel: r.channel as Ticket['channel'],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    firstResponseAt: isoOrNull(r.first_response_at),
    responseDueAt: iso(r.response_due_at),
    dueAt: iso(r.due_at),
    pausedAt: isoOrNull(r.paused_at),
    pausedRemaining: r.paused_resolve_left == null ? null : Number(r.paused_resolve_left),
    solvedAt: isoOrNull(r.solved_at),
    resolution: r.resolution as string,
    rating: (r.rating as Ticket['rating']) ?? null,
    incidentId: (r.incident_id as number) ?? null,
    kind: (r.kind as Ticket['kind']) ?? 'incident',
    catalogItemId: (r.catalog_item_id as number) ?? null,
    form: safeJson<Record<string, string>>(r.form as string, {}),
    approval: (r.approval as Ticket['approval']) ?? null,
    approver: r.approver_id
      ? { id: r.approver_id as number, name: r.ap_name as string, email: r.ap_email as string, role: r.ap_role as Role, department: r.ap_dept as string }
      : null,
    assetId: (r.asset_id as number) ?? null,
    problemId: (r.problem_id as number) ?? null,
  };
}

export async function getTicket(db: Db, workspaceId: number, id: number): Promise<Ticket | null> {
  const { rows } = await db.query<Row>(`SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.id = $2`, [workspaceId, id]);
  return rows[0] ? toTicket(rows[0]) : null;
}

export async function listAttachments(db: Db, ticketId: number, includeInternal: boolean): Promise<Attachment[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, message_id, name, type, size, internal FROM attachments WHERE ticket_id = $1 ${includeInternal ? '' : 'AND NOT internal'} ORDER BY id`,
    [ticketId],
  );
  return rows.map((r) => ({ id: r.id as number, messageId: (r.message_id as number) ?? null, name: r.name as string, type: r.type as string, size: r.size as number, internal: r.internal as boolean }));
}

export async function listMessages(db: Db, ticketId: number, includeNotes: boolean): Promise<Message[]> {
  const { rows } = await db.query<Row>(
    `SELECT m.*, u.name, u.email, u.role, u.department FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 ${includeNotes ? '' : "AND m.kind <> 'note'"} ORDER BY m.created_at, m.id`,
    [ticketId],
  );
  const files = await listAttachments(db, ticketId, includeNotes);
  return rows.map((r) => ({
    id: r.id as number,
    ticketId: r.ticket_id as number,
    kind: r.kind as Message['kind'],
    body: r.body as string,
    author: r.author_id ? ({ id: r.author_id, name: r.name, email: r.email, role: r.role, department: r.department } as Person) : null,
    createdAt: iso(r.created_at),
    via: (r.via as Message['via']) ?? 'web',
    attachments: files.filter((f) => f.messageId === r.id),
  }));
}

export async function addMessage(db: Db, ticketId: number, authorId: number | null, kind: Message['kind'], body: string, via: Message['via'] = 'web'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO messages (ticket_id, author_id, kind, body, via) VALUES ($1, $2, $3, $4, $5) RETURNING id', [ticketId, authorId, kind, body, via]);
  return rows[0].id;
}

/** Files are stored in PostgreSQL itself, so every server sees them and backups include them. */
export async function saveAttachments(db: Db, ticketId: number, messageId: number | null, files: CheckedFile[], uploadedBy: number | null, internal: boolean) {
  for (const f of files) {
    await db.query(
      'INSERT INTO attachments (ticket_id, message_id, name, type, size, internal, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [ticketId, messageId, f.name, f.type, f.size, internal, f.data, uploadedBy],
    );
  }
}

export async function workspaceHours(db: Db, workspaceId: number): Promise<Hours> {
  const { rows } = await db.query<HoursRow>('SELECT time_zone, work_days, day_start, day_end, urgent_24x7 FROM workspaces WHERE id = $1', [workspaceId]);
  return toHours(rows[0]);
}

export const toArticle = (r: Row): Article => ({
  id: r.id as number, title: r.title as string, body: r.body as string, category: r.category as Category, uses: r.uses as number, updatedAt: iso(r.updated_at),
});

export const toIncident = (r: Row): Incident => ({
  id: r.id as number, title: r.title as string, message: r.message as string, status: r.status as Incident['status'],
  createdAt: iso(r.created_at), resolvedAt: isoOrNull(r.resolved_at), linked: Number(r.linked ?? 0),
});

export async function listPeople(db: Db, workspaceId: number): Promise<(Person & { open: number; managerId: number | null })[]> {
  const { rows } = await db.query<Row>(
    `SELECT u.id, u.name, u.email, u.role, u.department, u.manager_id,
            (SELECT count(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status <> 'solved') AS open
       FROM users u WHERE u.workspace_id = $1 ORDER BY (u.role = 'requester'), u.name`,
    [workspaceId],
  );
  return rows.map((r) => ({ id: r.id as number, name: r.name as string, email: r.email as string, role: r.role as Role, department: r.department as string, open: Number(r.open), managerId: (r.manager_id as number) ?? null }));
}
