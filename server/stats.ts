import type { Db } from './db.js';
import type { Category, Kpis, Reports } from '../shared/types.js';

const num = (v: unknown) => (v == null ? null : Number(v));

export async function kpis(db: Db, workspaceId: number, userId: number, agentsOnline: number): Promise<Kpis> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT
       count(*) FILTER (WHERE status <> 'solved')                                                         AS open,
       count(*) FILTER (WHERE status IN ('new','open') AND
                         CASE WHEN first_response_at IS NULL THEN response_due_at ELSE due_at END BETWEEN now() AND now() + interval '1 hour') AS due_soon,
       count(*) FILTER (WHERE status IN ('new','open') AND
                         CASE WHEN first_response_at IS NULL THEN response_due_at ELSE due_at END < now())   AS breached,
       count(*) FILTER (WHERE status <> 'solved' AND assignee_id IS NULL)                                 AS unassigned,
       count(*) FILTER (WHERE status <> 'solved' AND assignee_id = $2)                                   AS mine,
       count(*) FILTER (WHERE status = 'waiting')                                                          AS waiting,
       avg(extract(epoch FROM first_response_at - created_at) / 60)
         FILTER (WHERE first_response_at IS NOT NULL AND created_at > now() - interval '7 days')        AS first_response,
       count(*) FILTER (WHERE status = 'solved' AND solved_at >= date_trunc('day', now()))                 AS solved_today,
       avg(extract(epoch FROM solved_at - created_at) / 60)
         FILTER (WHERE status = 'solved' AND solved_at > now() - interval '7 days')                     AS avg_fix,
       count(*) FILTER (WHERE rating IS NOT NULL AND solved_at > now() - interval '7 days')                AS ratings,
       count(*) FILTER (WHERE rating = 'good' AND solved_at > now() - interval '7 days')                   AS good,
       count(*) FILTER (WHERE status = 'solved' AND solved_at > now() - interval '7 days')                 AS solved_week,
       count(*) FILTER (WHERE status = 'solved' AND solved_at > now() - interval '7 days' AND solved_at <= due_at) AS on_time
     FROM tickets WHERE workspace_id = $1`,
    [workspaceId, userId],
  );
  const r = rows[0];
  const ratings = Number(r.ratings);
  const solvedWeek = Number(r.solved_week);
  return {
    open: Number(r.open),
    dueSoon: Number(r.due_soon),
    breached: Number(r.breached),
    unassigned: Number(r.unassigned),
    mine: Number(r.mine),
    waiting: Number(r.waiting),
    firstResponseMinutes: num(r.first_response),
    solvedToday: Number(r.solved_today),
    avgFixMinutes: num(r.avg_fix),
    satisfaction: ratings ? Number(r.good) / ratings : null,
    ratings,
    onTimeRate: solvedWeek ? Number(r.on_time) / solvedWeek : null,
    agentsOnline,
  };
}

export async function reports(db: Db, workspaceId: number): Promise<Reports> {
  const volume = await db.query<{ day: string; created: string; solved: string }>(
    `WITH days AS (SELECT generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM tickets t WHERE t.workspace_id = $1 AND date_trunc('day', t.created_at) = d.day) AS created,
            (SELECT count(*) FROM tickets t WHERE t.workspace_id = $1 AND date_trunc('day', t.solved_at) = d.day) AS solved
       FROM days d ORDER BY d.day`,
    [workspaceId],
  );
  const byCategory = await db.query<{ category: Category; count: string }>(
    `SELECT category, count(*) FROM tickets WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY category ORDER BY count(*) DESC`,
    [workspaceId],
  );
  const byAgent = await db.query<{ name: string; solved: string; open: string; avg_fix: string | null }>(
    `SELECT u.name,
            count(t.*) FILTER (WHERE t.status = 'solved' AND t.solved_at > now() - interval '30 days') AS solved,
            count(t.*) FILTER (WHERE t.status <> 'solved') AS open,
            avg(extract(epoch FROM t.solved_at - t.created_at) / 60) FILTER (WHERE t.status = 'solved') AS avg_fix
       FROM users u LEFT JOIN tickets t ON t.assignee_id = u.id
      WHERE u.workspace_id = $1 AND u.role <> 'requester'
      GROUP BY u.id ORDER BY solved DESC`,
    [workspaceId],
  );
  const top = await db.query<{ title: string; uses: number }>(
    'SELECT title, uses FROM articles WHERE workspace_id = $1 ORDER BY uses DESC LIMIT 5',
    [workspaceId],
  );
  const overall = await db.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE status = 'solved') AS solved,
            count(*) FILTER (WHERE status = 'solved' AND solved_at <= due_at) AS on_time,
            avg(extract(epoch FROM first_response_at - created_at) / 60) AS first_response,
            count(*) FILTER (WHERE rating IS NOT NULL) AS ratings,
            count(*) FILTER (WHERE rating = 'good') AS good
       FROM tickets WHERE workspace_id = $1 AND created_at > now() - interval '30 days'`,
    [workspaceId],
  );
  const o = overall.rows[0];
  return {
    volume: volume.rows.map((v) => ({ day: v.day, created: Number(v.created), solved: Number(v.solved) })),
    byCategory: byCategory.rows.map((c) => ({ category: c.category, count: Number(c.count) })),
    byAgent: byAgent.rows.map((a) => ({ name: a.name, solved: Number(a.solved), open: Number(a.open), avgFixMinutes: num(a.avg_fix) })),
    onTimeRate: Number(o.solved) ? Number(o.on_time) / Number(o.solved) : null,
    firstResponseMinutes: num(o.first_response),
    satisfaction: Number(o.ratings) ? Number(o.good) / Number(o.ratings) : null,
    topArticles: top.rows,
  };
}
