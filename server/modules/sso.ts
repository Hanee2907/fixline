import { createHash, createPublicKey, randomBytes, verify as verifySig } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashPassword } from '../auth.js';
import type { Module } from './index.js';

/**
 * Sign in with Microsoft or Google (OpenID Connect, authorization code + PKCE).
 * A provider appears on the sign-in page only when its client id and secret are set on the server:
 *   SSO_MICROSOFT_CLIENT_ID, SSO_MICROSOFT_CLIENT_SECRET, SSO_MICROSOFT_TENANT (default "organizations")
 *   SSO_GOOGLE_CLIENT_ID, SSO_GOOGLE_CLIENT_SECRET
 * The redirect URL to register with the provider is  <APP_URL>/api/sso/<microsoft|google>/callback.
 *
 * Someone signing in is matched to an account by email. If they have none yet and their email
 * domain belongs to a desk (Settings → Single sign-on domain), they join that desk as an employee.
 */
interface Provider { id: 'microsoft' | 'google'; name: string; discovery: string; clientId: string; clientSecret: string; issuer: (iss: string) => boolean }

export function providers(env = process.env): Provider[] {
  const out: Provider[] = [];
  if (env.SSO_MICROSOFT_CLIENT_ID && env.SSO_MICROSOFT_CLIENT_SECRET) {
    const tenant = env.SSO_MICROSOFT_TENANT || 'organizations';
    out.push({
      id: 'microsoft', name: 'Microsoft', clientId: env.SSO_MICROSOFT_CLIENT_ID, clientSecret: env.SSO_MICROSOFT_CLIENT_SECRET,
      discovery: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`,
      // Multi-tenant issuers carry the user's tenant id; a single-tenant desk pins it.
      issuer: (iss) => /^[0-9a-f-]{36}$/i.test(tenant) ? iss === `https://login.microsoftonline.com/${tenant}/v2.0` : /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(iss),
    });
  }
  if (env.SSO_GOOGLE_CLIENT_ID && env.SSO_GOOGLE_CLIENT_SECRET) {
    out.push({
      id: 'google', name: 'Google', clientId: env.SSO_GOOGLE_CLIENT_ID, clientSecret: env.SSO_GOOGLE_CLIENT_SECRET,
      discovery: 'https://accounts.google.com/.well-known/openid-configuration',
      issuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
    });
  }
  return out;
}

type Jwk = Record<string, unknown> & { kid?: string };
interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function discover(p: Provider): Promise<Discovery> {
  const hit = discoveryCache.get(p.discovery);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.doc;
  const doc = (await (await fetch(p.discovery)).json()) as Discovery;
  discoveryCache.set(p.discovery, { at: Date.now(), doc });
  return doc;
}

async function signingKey(jwksUri: string, kid: string) {
  let hit = jwksCache.get(jwksUri);
  if (!hit || Date.now() - hit.at > 3_600_000 || !hit.keys.some((k) => k.kid === kid)) {
    const { keys } = (await (await fetch(jwksUri)).json()) as { keys: Jwk[] };
    hit = { at: Date.now(), keys };
    jwksCache.set(jwksUri, hit);
  }
  const jwk = hit.keys.find((k) => k.kid === kid);
  return jwk ? createPublicKey({ key: jwk as Extract<Parameters<typeof createPublicKey>[0], { format: 'jwk' }>['key'], format: 'jwk' }) : null;
}

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Checks the ID token's signature (RS256, provider's published keys), issuer, audience, expiry and nonce. */
export async function verifyIdToken(p: Provider, jwksUri: string, token: string, nonce: string, now = Date.now()) {
  const [h, b, sig] = token.split('.');
  if (!h || !b || !sig) throw new Error('Malformed token');
  const header = b64urlJson(h) as { alg: string; kid: string };
  if (header.alg !== 'RS256') throw new Error('Unexpected signing algorithm');
  const key = await signingKey(jwksUri, header.kid);
  if (!key || !verifySig('RSA-SHA256', Buffer.from(`${h}.${b}`), key, Buffer.from(sig, 'base64url'))) throw new Error('Bad signature');
  const claims = b64urlJson(b) as { iss: string; aud: string | string[]; exp: number; nbf?: number; nonce?: string; sub: string; email?: string; email_verified?: boolean; preferred_username?: string; name?: string };
  if (!p.issuer(claims.iss)) throw new Error('Wrong issuer');
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(p.clientId) : claims.aud === p.clientId)) throw new Error('Wrong audience');
  if (claims.exp * 1000 < now - 60_000 || (claims.nbf && claims.nbf * 1000 > now + 60_000)) throw new Error('Expired');
  if (claims.nonce !== nonce) throw new Error('Nonce mismatch');
  return claims;
}

const COOKIE = 'fixline_sso';

export const sso: Module = {
  public(app, ctx) {
    const { db } = ctx;
    app.get('/api/sso/providers', (c) => c.json({ providers: providers().map((p) => ({ id: p.id, name: p.name })) }));

    app.get('/api/sso/:provider/start', async (c) => {
      const p = providers().find((x) => x.id === c.req.param('provider'));
      if (!p) return c.redirect('/#/sso-error/not-configured');
      const d = await discover(p);
      const state = randomBytes(18).toString('base64url');
      const nonce = randomBytes(18).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      setCookie(c, COOKIE, Buffer.from(JSON.stringify({ state, nonce, verifier, provider: p.id })).toString('base64url'), {
        httpOnly: true, sameSite: 'Lax', secure: new URL(ctx.appUrl(c)).protocol === 'https:', path: '/api/sso', maxAge: 600,
      });
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: p.clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: `${ctx.appUrl(c)}/api/sso/${p.id}/callback`,
        state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account',
      }).toString();
      return c.redirect(url.toString());
    });

    app.get('/api/sso/:provider/callback', async (c) => {
      const fail = (why: string) => { deleteCookie(c, COOKIE, { path: '/api/sso' }); return c.redirect(`/#/sso-error/${why}`); };
      const p = providers().find((x) => x.id === c.req.param('provider'));
      const raw = getCookie(c, COOKIE);
      if (!p || !raw) return fail('expired');
      let saved: { state: string; nonce: string; verifier: string; provider: string };
      try { saved = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return fail('expired'); }
      if (saved.provider !== p.id || c.req.query('state') !== saved.state || !c.req.query('code')) return fail('expired');
      try {
        const d = await discover(p);
        const tokenRes = await fetch(d.token_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code: c.req.query('code')!, redirect_uri: `${ctx.appUrl(c)}/api/sso/${p.id}/callback`,
            client_id: p.clientId, client_secret: p.clientSecret, code_verifier: saved.verifier,
          }),
        });
        const tokens = (await tokenRes.json()) as { id_token?: string };
        if (!tokens.id_token) return fail('provider');
        const claims = await verifyIdToken(p, d.jwks_uri, tokens.id_token, saved.nonce);
        const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase();
        if (!email.includes('@') || (p.id === 'google' && claims.email_verified !== true)) return fail('no-email');

        let user = (await db.query<{ id: number; workspace_id: number; sso_subject: string | null }>(
          'SELECT u.id, u.workspace_id, u.sso_subject FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.email = $1 AND NOT w.demo', [email],
        )).rows[0];
        const subject = `${p.id}:${claims.sub}`;
        if (user && user.sso_subject && user.sso_subject !== subject) return fail('mismatch');
        if (!user) {
          // No account yet: join the desk that owns this email domain, if any.
          const ws = (await db.query<{ id: number }>('SELECT id FROM workspaces WHERE sso_domain = $1 AND NOT demo', [email.split('@')[1]])).rows[0];
          if (!ws) return fail('no-account');
          const { rows } = await db.query<{ id: number }>(
            'INSERT INTO users (workspace_id, email, name, role, password_hash, sso_subject) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [ws.id, email, (claims.name ?? email.split('@')[0]).slice(0, 60), 'requester', await hashPassword(randomBytes(24).toString('hex')), subject],
          );
          user = { id: rows[0].id, workspace_id: ws.id, sso_subject: subject };
        } else if (!user.sso_subject) {
          await db.query('UPDATE users SET sso_subject = $2 WHERE id = $1', [user.id, subject]);
        }
        deleteCookie(c, COOKIE, { path: '/api/sso' });
        await ctx.startSession(c, user.id);
        await ctx.audit(c, user.workspace_id, user.id, 'sign_in', '', `with ${p.name}`);
        return c.redirect('/#/');
      } catch (e) {
        console.error('SSO failed', e);
        return fail('provider');
      }
    });
  },
  private() {},
};
