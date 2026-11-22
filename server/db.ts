import { mkdirSync } from 'node:fs';
import pg from 'pg';

/** The slice of a database client the app needs. node-postgres and PGlite both fit it. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements in one round trip on one connection (migrations, transactions). */
  exec(sql: string): Promise<void>;
  /** PostgreSQL LISTEN: every server connected to this database hears NOTIFY on the channel. */
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  /**
   * Runs `fn` on one connection while holding a PostgreSQL advisory lock, so only one
   * process at a time does it (for example, several servers starting together and migrating).
   */
  exclusive<T>(lockKey: number, fn: (db: Pick<Db, 'query' | 'exec'>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Real PostgreSQL when DATABASE_URL is set (production, CI, Docker).
 * Otherwise PGlite: PostgreSQL compiled to WebAssembly, so a laptop needs no setup.
 */
export async function connect(url = process.env.DATABASE_URL, dataDir?: string): Promise<Db> {
  if (url) {
    const ssl = /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: url, max: 10, ssl });
    return {
      query: (sql, params) => pool.query(sql, params as unknown[]) as never,
      exec: async (sql) => void (await pool.query(sql)),
      /**
       * LISTEN needs its own long-lived connection (a pooled one could be handed to someone else).
       * If that connection drops, it reconnects and listens again.
       */
      async listen(channel, onMessage) {
        let client: pg.Client | null = null;
        let stopped = false;
        const start = async () => {
          if (stopped) return;
          client = new pg.Client({ connectionString: url, ssl });
          client.on('notification', (n) => { if (n.channel === channel && n.payload) onMessage(n.payload); });
          client.on('error', () => {
            client?.end().catch(() => {});
            client = null;
            setTimeout(() => void start().catch(() => {}), 2000);
          });
          await client.connect();
          await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
        };
        await start();
        return async () => { stopped = true; await client?.end().catch(() => {}); };
      },
      async exclusive(lockKey, fn) {
        const client = await pool.connect();
        try {
          await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
          try {
            return await fn({
              query: (sql, params) => client.query(sql, params as unknown[]) as never,
              exec: async (sql) => void (await client.query(sql)),
            });
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
          }
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = await PGlite.create({ dataDir });
  return {
    query: (sql, params) => lite.query(sql, params as unknown[]) as never,
    exec: async (sql) => void (await lite.exec(sql)),
    listen: async (channel, onMessage) => {
      const off = await lite.listen(channel, onMessage);
      return async () => { await off(); };
    },
    // PGlite is a single in-process connection, so there is nothing to race against.
    exclusive: (_lockKey, fn) => fn({
      query: (sql, params) => lite.query(sql, params as unknown[]) as never,
      exec: async (sql) => void (await lite.exec(sql)),
    }),
    close: () => lite.close(),
  };
}
