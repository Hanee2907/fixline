import { mkdirSync } from 'node:fs';
import pg from 'pg';

/** The slice of a database client the app needs. node-postgres and PGlite both fit it. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements in one round trip on one connection (migrations, transactions). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Real PostgreSQL when DATABASE_URL is set (production, CI, Docker).
 * Otherwise PGlite: PostgreSQL compiled to WebAssembly, so a laptop needs no setup.
 */
export async function connect(url = process.env.DATABASE_URL, dataDir?: string): Promise<Db> {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    return {
      query: (sql, params) => pool.query(sql, params as unknown[]) as never,
      exec: async (sql) => void (await pool.query(sql)),
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = await PGlite.create({ dataDir });
  return {
    query: (sql, params) => lite.query(sql, params as unknown[]) as never,
    exec: async (sql) => void (await lite.exec(sql)),
    close: () => lite.close(),
  };
}
