import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import type { Hours } from '../shared/hours.js';
import type { User } from '../shared/types.js';

const scrypt = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, (err, key) => (err ? reject(err) : resolve(key))));

export const SESSION_COOKIE = 'fixline_session';
export const SESSION_DAYS = 30;

/** Passwords are never stored: only a salted scrypt hash, as "scrypt$salt$hash". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The browser keeps a random token; the database keeps only its hash, so a leaked table can't log anyone in. */
export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId],
  );
  return token;
}

export async function endSession(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
export interface UserRow extends HoursRow { id: number; email: string; name: string; role: User['role']; department: string; workspace_id: number; workspace_name: string; demo: boolean }
export interface HoursRow { time_zone: string; work_days: string; day_start: number; day_end: number; urgent_24x7: boolean }

export const USER_SELECT = `u.id, u.email, u.name, u.role, u.department, u.workspace_id, w.name AS workspace_name, w.demo,
  w.time_zone, w.work_days, w.day_start, w.day_end, w.urgent_24x7`;

export const toHours = (r: HoursRow): Hours => ({
  timeZone: r.time_zone,
  days: r.work_days.split(',').filter(Boolean).map(Number),
  start: r.day_start,
  end: r.day_end,
  urgent24x7: r.urgent_24x7,
});

export const toUser = (r: UserRow): User => ({
  id: r.id, email: r.email, name: r.name, role: r.role, department: r.department,
  workspaceId: r.workspace_id, workspaceName: r.workspace_name, demo: r.demo, hours: toHours(r),
});

export async function userById(db: Db, id: number): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_SELECT} FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function userForToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_SELECT}
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.id = u.workspace_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

/** A small fixed-window limiter for sign-in attempts, per IP address. */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.until < now) {
      hits.set(key, { n: 1, until: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}
