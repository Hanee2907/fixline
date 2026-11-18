import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AuditEntry } from '../../shared/types.js';
import { sha256, userById, verifyPassword } from '../auth.js';
import type { Db } from '../db.js';
import { iso } from '../repo.js';
import { newRecoveryCodes, newSecret, otpauthUri, verifyTotp } from '../totp.js';
import type { Module } from './index.js';

/** After the password is right, a short-lived ticket that only the 6-digit code can turn into a session. */
export async function createChallenge(db: Db, userId: number) {
  const token = randomBytes(24).toString('base64url');
  await db.query(`DELETE FROM login_challenges WHERE user_id = $1 OR expires_at < now()`, [userId]);
  await db.query(`INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [sha256(token), userId]);
  return token;
}

const normaliseRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z2-7]/g, '');

/** Checks a 6-digit code, or uses up one recovery code. */
async function checkSecondFactor(db: Db, userId: number, code: string): Promise<'totp' | 'recovery' | null> {
  const { rows } = await db.query<{ totp_secret: string | null; recovery_codes: string }>('SELECT totp_secret, recovery_codes FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u?.totp_secret) return null;
  if (verifyTotp(u.totp_secret, code)) return 'totp';
  const hashes = u.recovery_codes.split(',').filter(Boolean);
  const h = sha256(normaliseRecovery(code));
  if (normaliseRecovery(code).length === 8 && hashes.includes(h)) {
    await db.query('UPDATE users SET recovery_codes = $2 WHERE id = $1', [userId, hashes.filter((x) => x !== h).join(',')]);
    return 'recovery';
  }
  return null;
}

export const security: Module = {
  public(app, ctx) {
    const limit = ctx.rateLimit(10, 15 * 60_000);
    /** Step two of signing in. Five wrong codes and the challenge is gone. */
    app.post('/api/auth/2fa', async (c) => {
      if (!limit(ctx.clientKey(c))) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429);
      const p = z.object({ challenge: z.string().min(20).max(200), code: z.string().max(20) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json({ error: 'Enter the 6-digit code' }, 400);
      const { rows } = await ctx.db.query<{ user_id: number; attempts: number }>(
        'UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, attempts', [sha256(p.data.challenge)],
      );
      const ch = rows[0];
      if (!ch || ch.attempts > 5) return c.json({ error: 'That sign-in took too long. Start again.', restart: true }, 400);
      const kind = await checkSecondFactor(ctx.db, ch.user_id, p.data.code);
      const user = await userById(ctx.db, ch.user_id);
      if (!kind || !user) {
        if (user) await ctx.audit(c, user.workspaceId, user.id, 'sign_in.code_wrong');
        return c.json({ error: 'That code isn’t right' }, 401);
      }
      await ctx.db.query('DELETE FROM login_challenges WHERE user_id = $1', [ch.user_id]);
      await ctx.startSession(c, ch.user_id);
      await ctx.audit(c, user.workspaceId, user.id, 'sign_in', '', kind === 'recovery' ? 'with a recovery code' : 'with an authenticator code');
      return c.json({ user });
    });
  },

  private(app, ctx) {
    const { db } = ctx;

    /** Step 1 of turning on 2FA: a fresh secret and its QR code. Nothing changes until a code is confirmed. */
    app.post('/api/2fa/setup', async (c) => {
      const u = c.get('user');
      if (u.demo) return c.json({ error: 'Two-factor sign-in isn’t available in the demo' }, 400);
      if (u.twoFactor) return c.json({ error: 'Already on' }, 409);
      const secret = newSecret();
      await db.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [u.id, secret]);
      const uri = otpauthUri(secret, u.email);
      return c.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
    });

    app.post('/api/2fa/enable', async (c) => {
      const u = c.get('user');
      const p = z.object({ code: z.string().max(20) }).safeParse(await ctx.body(c));
      const { rows } = await db.query<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = $1', [u.id]);
      if (!p.success || !rows[0]?.totp_secret || !verifyTotp(rows[0].totp_secret, p.data.code)) return c.json({ error: 'That code isn’t right. Check the time on your phone and try the newest code.' }, 400);
      const codes = newRecoveryCodes();
      await db.query('UPDATE users SET totp_enabled = TRUE, recovery_codes = $2 WHERE id = $1', [u.id, codes.map((x) => sha256(normaliseRecovery(x))).join(',')]);
      await ctx.audit(c, u.workspaceId, u.id, 'security.2fa_on');
      return c.json({ recoveryCodes: codes });
    });

    app.post('/api/2fa/disable', async (c) => {
      const u = c.get('user');
      const p = z.object({ password: z.string().max(200) }).safeParse(await ctx.body(c));
      const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
      if (!p.success || !(await verifyPassword(p.data.password, rows[0].password_hash))) return c.json({ error: 'Password is wrong' }, 401);
      await db.query(`UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, recovery_codes = '' WHERE id = $1`, [u.id]);
      await ctx.audit(c, u.workspaceId, u.id, 'security.2fa_off');
      return c.json({ ok: true });
    });

    /** Who did what, newest first. Filter by person, action or text. */
    app.get('/api/audit', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const q = (c.req.query('q') ?? '').trim().slice(0, 100);
      const params: unknown[] = [u.workspaceId];
      let where = 'a.workspace_id = $1';
      if (q) { params.push(`%${q}%`); where += ` AND (a.action ILIKE $2 OR a.target ILIKE $2 OR a.detail ILIKE $2 OR u.name ILIKE $2)`; }
      const { rows } = await db.query<{ id: string; name: string | null; action: string; target: string; detail: string; ip: string; created_at: string }>(
        `SELECT a.id, u.name, a.action, a.target, a.detail, a.ip, a.created_at FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 300`,
        params,
      );
      const entries: AuditEntry[] = rows.map((r) => ({ id: Number(r.id), actor: r.name, action: r.action, target: r.target, detail: r.detail, ip: r.ip, createdAt: iso(r.created_at) }));
      return c.json({ entries });
    });

    app.get('/api/audit.csv', ctx.agentOnly, ctx.adminOnly, async (c) => {
      const u = c.get('user');
      const { rows } = await db.query<Record<string, string>>(
        `SELECT a.created_at, u.name, a.action, a.target, a.detail, a.ip FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 10000`, [u.workspaceId],
      );
      const cell = (v: unknown) => {
        let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = ['when,who,action,target,detail,ip', ...rows.map((r) => [r.created_at, r.name, r.action, r.target, r.detail, r.ip].map(cell).join(','))].join('\n');
      return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="fixline-audit-log.csv"' });
    });
  },
};
