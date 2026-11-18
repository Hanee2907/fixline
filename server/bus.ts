import { randomBytes } from 'node:crypto';
import type { LiveEvent, Role } from '../shared/types.js';
import type { Db } from './db.js';

interface Listener {
  userId: number;
  role: Role;
  send: (e: LiveEvent) => void;
}

const CHANNEL = 'fixline_events';
const PRESENCE_EVERY = 15_000;
const PRESENCE_FRESH = '45 seconds';

/**
 * Live updates for any number of servers.
 *
 * Each server keeps its own open browser connections (Server-Sent Events). Events are published
 * through PostgreSQL NOTIFY, and every server LISTENs on the same channel, so a change made on one
 * server reaches browsers connected to all the others. There's no extra message broker to run:
 * the database the app already needs does the job.
 *
 * Who's online is kept in a small `presence` table with a heartbeat, so the count is right across
 * servers too. Without a database (unit tests) the bus simply delivers in-process.
 *
 * Events carry ids only. Browsers re-fetch what changed through the permission-checked API,
 * so nothing private ever travels over the stream.
 */
export class Bus {
  readonly serverId = randomBytes(6).toString('hex');
  private rooms = new Map<number, Set<Listener>>();
  private unlisten: (() => Promise<void>) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private db?: Db) {}

  /** Starts listening for events from every server. */
  async start() {
    if (!this.db || this.unlisten) return;
    this.unlisten = await this.db.listen(CHANNEL, (payload) => {
      try {
        const { w, e } = JSON.parse(payload) as { w: number; e: LiveEvent };
        this.deliver(w, e);
      } catch { /* ignore malformed */ }
    });
    this.heartbeat = setInterval(() => void this.beat().catch(() => {}), PRESENCE_EVERY);
    this.heartbeat.unref?.();
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.unlisten?.();
    this.unlisten = null;
    await this.db?.query('DELETE FROM presence WHERE server_id = $1', [this.serverId]).catch(() => {});
  }

  subscribe(workspaceId: number, l: Listener): () => void {
    let room = this.rooms.get(workspaceId);
    if (!room) this.rooms.set(workspaceId, (room = new Set()));
    room.add(l);
    if (l.role !== 'requester') {
      void this.markPresent(workspaceId, l.userId).then(() => this.publish(workspaceId, { type: 'presence' }));
    }
    return () => {
      room!.delete(l);
      if (room!.size === 0) this.rooms.delete(workspaceId);
      if (l.role !== 'requester' && ![...(this.rooms.get(workspaceId) ?? [])].some((x) => x.userId === l.userId)) {
        void this.markGone(l.userId).then(() => this.publish(workspaceId, { type: 'presence' }));
      }
    };
  }

  publish(workspaceId: number, e: LiveEvent) {
    if (this.unlisten && this.db) {
      // Everyone, this server included, hears it back through LISTEN.
      void this.db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ w: workspaceId, e })]).catch(() => this.deliver(workspaceId, e));
    } else {
      this.deliver(workspaceId, e);
    }
  }

  /** Hands an event to this server's open connections that are allowed to hear it. */
  private deliver(workspaceId: number, e: LiveEvent) {
    for (const l of this.rooms.get(workspaceId) ?? []) {
      const forRequester = e.type === 'incident' || e.type === 'article' || (e.requesterId !== undefined && e.requesterId === l.userId);
      if (l.role !== 'requester' || forRequester) l.send(e);
    }
  }

  /** IT staff online right now, across all servers. */
  async agentsOnline(workspaceId: number): Promise<number> {
    if (!this.db) {
      const ids = new Set<number>();
      for (const l of this.rooms.get(workspaceId) ?? []) if (l.role !== 'requester') ids.add(l.userId);
      return ids.size;
    }
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(DISTINCT user_id) AS n FROM presence WHERE workspace_id = $1 AND seen_at > now() - interval '${PRESENCE_FRESH}'`,
      [workspaceId],
    );
    return Number(rows[0].n);
  }

  private async markPresent(workspaceId: number, userId: number) {
    await this.db?.query(
      `INSERT INTO presence (user_id, workspace_id, server_id, seen_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, server_id) DO UPDATE SET seen_at = now(), workspace_id = EXCLUDED.workspace_id`,
      [userId, workspaceId, this.serverId],
    ).catch(() => {});
  }

  private async markGone(userId: number) {
    await this.db?.query('DELETE FROM presence WHERE user_id = $1 AND server_id = $2', [userId, this.serverId]).catch(() => {});
  }

  private async beat() {
    for (const [workspaceId, room] of this.rooms) {
      for (const userId of new Set([...room].filter((l) => l.role !== 'requester').map((l) => l.userId))) {
        await this.markPresent(workspaceId, userId);
      }
    }
    await this.db?.query(`DELETE FROM presence WHERE seen_at < now() - interval '5 minutes'`).catch(() => {});
  }
}
