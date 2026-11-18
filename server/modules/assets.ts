import type { Context } from 'hono';
import type { Env } from '../app.js';
import { z } from 'zod';
import type { Asset, Person, Role } from '../../shared/types.js';
import type { Db } from '../db.js';
import { TICKET_SELECT, toTicket } from '../repo.js';
import type { Module } from './index.js';

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const dateStr = (v: unknown) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));

/** Plain-language warnings that tell IT what to do about a device, not just what it is. */
export function assetHealth(a: { ticketsLast30: number; warrantyUntil: string | null; status: string; purchasedOn: string | null }, now = Date.now()): string[] {
  const out: string[] = [];
  if (a.status === 'retired') return out;
  if (a.ticketsLast30 >= 3) out.push(`${a.ticketsLast30} tickets in 30 days. Consider replacing it.`);
  if (a.warrantyUntil) {
    const days = Math.round((Date.parse(a.warrantyUntil) - now) / DAY);
    if (days < 0) out.push('Out of warranty');
    else if (days <= 45) out.push(`Warranty ends in ${days} day${days === 1 ? '' : 's'}`);
  }
  if (a.purchasedOn && (now - Date.parse(a.purchasedOn)) / (365 * DAY) >= 4) out.push('Over 4 years old');
  return out;
}

const SELECT = `
  a.*, u.name AS u_name, u.email AS u_email, u.role AS u_role, u.department AS u_dept,
  (SELECT count(*) FROM tickets t WHERE t.asset_id = a.id AND t.created_at > now() - interval '30 days') AS last30,
  (SELECT count(*) FROM tickets t WHERE t.asset_id = a.id AND t.status <> 'solved') AS open
  FROM assets a LEFT JOIN users u ON u.id = a.assigned_to`;

export function toAsset(r: Row): Asset {
  const base = {
    id: r.id as number, tag: r.tag as string, name: r.name as string, type: r.type as string, model: r.model as string, serial: r.serial as string,
    status: r.status as Asset['status'],
    assignedTo: r.assigned_to ? ({ id: r.assigned_to, name: r.u_name, email: r.u_email, role: r.u_role as Role, department: r.u_dept } as Person) : null,
    location: r.location as string, purchasedOn: dateStr(r.purchased_on), warrantyUntil: dateStr(r.warranty_until), notes: r.notes as string,
    ticketsLast30: Number(r.last30 ?? 0), openTickets: Number(r.open ?? 0),
  };
  return { ...base, health: assetHealth(base) };
}

export async function getAsset(db: Db, workspaceId: number, id: number) {
  const { rows } = await db.query<Row>(`SELECT ${SELECT} WHERE a.workspace_id = $1 AND a.id = $2`, [workspaceId, id]);
  return rows[0] ? toAsset(rows[0]) : null;
}

/**
 * Links a new ticket to the right device without asking: an asset tag written in the ticket
 * ("LT-0231") wins; otherwise, if the person has exactly one computer, it's that one.
 */
export async function autoLinkAsset(db: Db, workspaceId: number, ticketId: number) {
  const { rows } = await db.query<{ subject: string; description: string; device: string; requester_id: number }>('SELECT subject, description, device, requester_id FROM tickets WHERE id = $1', [ticketId]);
  const t = rows[0];
  if (!t) return;
  const text = `${t.subject} ${t.description} ${t.device}`.toUpperCase();
  const tags = [...new Set(text.match(/\b[A-Z]{2,4}-\d{2,6}\b/g) ?? [])];
  let assetId: number | undefined;
  if (tags.length) {
    const hit = await db.query<{ id: number }>('SELECT id FROM assets WHERE workspace_id = $1 AND upper(tag) = ANY($2::text[]) LIMIT 1', [workspaceId, tags]);
    assetId = hit.rows[0]?.id;
  }
  if (!assetId) {
    const mine = await db.query<{ id: number; tag: string; model: string }>(
      `SELECT id, tag, model FROM assets WHERE workspace_id = $1 AND assigned_to = $2 AND status = 'in_use' AND type IN ('laptop','desktop')`, [workspaceId, t.requester_id],
    );
    if (mine.rows.length === 1) assetId = mine.rows[0].id;
  }
  if (assetId) {
    const a = await db.query<{ tag: string; model: string }>('SELECT tag, model FROM assets WHERE id = $1', [assetId]);
    await db.query(`UPDATE tickets SET asset_id = $2, device = CASE WHEN device = '' THEN $3 ELSE device END WHERE id = $1`, [ticketId, assetId, `${a.rows[0].tag}${a.rows[0].model ? ` · ${a.rows[0].model}` : ''}`]);
  }
}

const assetSchema = z.object({
  tag: z.string().trim().min(2, 'Add an asset tag').max(30).regex(/^[\w.-]+$/, 'Letters, numbers and dashes only'),
  name: z.string().trim().min(1, 'Name it').max(80),
  type: z.enum(['laptop', 'desktop', 'monitor', 'phone', 'printer', 'dock', 'licence', 'server', 'other']).default('laptop'),
  model: z.string().trim().max(80).default(''), serial: z.string().trim().max(80).default(''),
  status: z.enum(['in_use', 'in_stock', 'repair', 'retired']).default('in_stock'),
  assignedTo: z.number().int().positive().nullable().default(null), location: z.string().trim().max(80).default(''),
  purchasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  notes: z.string().trim().max(2000).default(''),
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const cells: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((x) => x.trim()));
  }
  return rows;
}

export const assets: Module = {
  private(app, ctx) {
    const { db } = ctx;
    // Every new ticket gets its device linked automatically.
    ctx.hooks.ticketCreated.push((ws, id) => autoLinkAsset(db, ws, id));

    app.get('/api/assets', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const q = (c.req.query('q') ?? '').trim().slice(0, 80);
      const params: unknown[] = [u.workspaceId];
      let where = 'a.workspace_id = $1';
      if (q) { params.push(`%${q}%`); where += ` AND (a.tag ILIKE $2 OR a.name ILIKE $2 OR a.model ILIKE $2 OR a.serial ILIKE $2 OR u.name ILIKE $2)`; }
      const { rows } = await db.query<Row>(`SELECT ${SELECT} WHERE ${where} ORDER BY (a.status = 'retired'), a.tag LIMIT 500`, params);
      return c.json({ assets: rows.map(toAsset) });
    });

    app.get('/api/assets/:id', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const a = await getAsset(db, u.workspaceId, ctx.idOf(c));
      if (!a) return c.json({ error: 'Not found' }, 404);
      const { rows } = await db.query<Row>(`SELECT ${TICKET_SELECT} WHERE t.workspace_id = $1 AND t.asset_id = $2 ORDER BY t.created_at DESC LIMIT 50`, [u.workspaceId, a.id]);
      return c.json({ asset: a, tickets: rows.map(toTicket) });
    });

    /** An employee's own devices, so they can pick one when reporting a problem. */
    app.get('/api/my/assets', async (c) => {
      const u = c.get('user');
      const { rows } = await db.query<Row>(`SELECT ${SELECT} WHERE a.workspace_id = $1 AND a.assigned_to = $2 AND a.status <> 'retired' ORDER BY a.tag`, [u.workspaceId, u.id]);
      return c.json({ assets: rows.map(toAsset) });
    });

    const save = async (c: Context<Env>, id?: number) => {
      const u = c.get('user');
      const p = assetSchema.safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const d = p.data;
      if (d.assignedTo) {
        const ok = await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2', [d.assignedTo, u.workspaceId]);
        if (!ok.rows.length) return c.json({ error: 'Unknown person', field: 'assignedTo' }, 400);
      }
      const status = d.assignedTo && d.status === 'in_stock' ? 'in_use' : d.status;
      const vals = [u.workspaceId, d.tag.toUpperCase(), d.name, d.type, d.model, d.serial, status, d.assignedTo, d.location, d.purchasedOn, d.warrantyUntil, d.notes];
      try {
        const { rows } = id
          ? await db.query<{ id: number }>('UPDATE assets SET tag=$2, name=$3, type=$4, model=$5, serial=$6, status=$7, assigned_to=$8, location=$9, purchased_on=$10, warranty_until=$11, notes=$12 WHERE workspace_id=$1 AND id=$13 RETURNING id', [...vals, id])
          : await db.query<{ id: number }>('INSERT INTO assets (workspace_id, tag, name, type, model, serial, status, assigned_to, location, purchased_on, warranty_until, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id', vals);
        if (!rows[0]) return c.json({ error: 'Not found' }, 404);
        await ctx.audit(c, u.workspaceId, u.id, id ? 'asset.updated' : 'asset.created', d.tag.toUpperCase());
        ctx.emit(u.workspaceId, { type: 'asset' });
        return c.json({ asset: await getAsset(db, u.workspaceId, rows[0].id) }, id ? 200 : 201);
      } catch (e) {
        if (String(e).includes('unique') || String(e).includes('duplicate')) return c.json({ error: `${d.tag.toUpperCase()} is already used`, field: 'tag' }, 409);
        throw e;
      }
    };
    app.post('/api/assets', ctx.agentOnly, (c) => save(c));
    app.put('/api/assets/:id', ctx.agentOnly, (c) => save(c, ctx.idOf(c)));

    /** Bring in a spreadsheet: tag, name, type, model, serial, assigned to (email), location, purchased, warranty. */
    app.post('/api/assets/import', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ csv: z.string().max(2_000_000) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json({ error: 'Paste a CSV' }, 400);
      const rows = parseCsv(p.data.csv);
      const header = (rows.shift() ?? []).map((h) => h.toLowerCase());
      const col = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const cols = { tag: col(['tag', 'asset']), name: col(['name']), type: col(['type']), model: col(['model']), serial: col(['serial']), user: col(['assigned', 'user', 'email', 'owner']), location: col(['location']), purchased: col(['purchas', 'bought']), warranty: col(['warranty']) };
      if (cols.tag < 0) return c.json({ error: 'The first row needs a “tag” column' }, 400);
      // A tag that already exists is updated, but only in the columns this spreadsheet has.
      const present: [number, string][] = [[cols.name, 'name'], [cols.type, 'type'], [cols.model, 'model'], [cols.serial, 'serial'], [cols.location, 'location'], [cols.purchased, 'purchased_on'], [cols.warranty, 'warranty_until']];
      const updates = present.filter(([i]) => i >= 0).map(([, c]) => `${c} = EXCLUDED.${c}`);
      if (cols.user >= 0) updates.push('assigned_to = EXCLUDED.assigned_to', 'status = EXCLUDED.status');
      const onConflict = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
      let imported = 0; let updated = 0; const skipped: string[] = [];
      for (const r of rows) {
        const tag = (r[cols.tag] ?? '').toUpperCase();
        if (!/^[\w.-]{2,30}$/.test(tag)) { skipped.push(`“${tag || '(blank)'}”: not a valid tag`); continue; }
        const email = cols.user >= 0 ? (r[cols.user] ?? '').toLowerCase() : '';
        const owner = email ? (await db.query<{ id: number }>('SELECT id FROM users WHERE workspace_id = $1 AND email = $2', [u.workspaceId, email])).rows[0]?.id ?? null : null;
        const date = (i: number) => (i >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r[i] ?? '') ? r[i] : null);
        const type = cols.type >= 0 && /^(laptop|desktop|monitor|phone|printer|dock|licence|server|other)$/i.test(r[cols.type] ?? '') ? r[cols.type].toLowerCase() : 'laptop';
        const res = await db.query(
          `INSERT INTO assets (workspace_id, tag, name, type, model, serial, status, assigned_to, location, purchased_on, warranty_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (workspace_id, tag) ${onConflict} RETURNING (xmax = 0) AS inserted`,
          [u.workspaceId, tag, (cols.name >= 0 && r[cols.name]) || tag, type, cols.model >= 0 ? r[cols.model] ?? '' : '', cols.serial >= 0 ? r[cols.serial] ?? '' : '',
            owner ? 'in_use' : 'in_stock', owner, cols.location >= 0 ? r[cols.location] ?? '' : '', date(cols.purchased), date(cols.warranty)],
        );
        const row = res.rows[0] as { inserted: boolean } | undefined;
        if (!row) skipped.push(`${tag}: already exists`);
        else if (row.inserted) imported++;
        else updated++;
      }
      await ctx.audit(c, u.workspaceId, u.id, 'asset.imported', `${imported} new, ${updated} updated`);
      ctx.emit(u.workspaceId, { type: 'asset' });
      return c.json({ imported, updated, skipped: skipped.slice(0, 20) });
    });

    /** Link or unlink a device on a ticket. */
    app.put('/api/tickets/:id/asset', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      const p = z.object({ assetId: z.number().int().positive().nullable() }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      if (p.data.assetId && !(await getAsset(db, u.workspaceId, p.data.assetId))) return c.json({ error: 'Unknown asset' }, 400);
      const { rows } = await db.query<{ requester_id: number }>('UPDATE tickets SET asset_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING requester_id', [u.workspaceId, ctx.idOf(c), p.data.assetId]);
      if (!rows[0]) return c.json({ error: 'Not found' }, 404);
      ctx.emit(u.workspaceId, { type: 'ticket', ticketId: ctx.idOf(c), actorId: u.id });
      return c.json({ ok: true });
    });
  },
};
