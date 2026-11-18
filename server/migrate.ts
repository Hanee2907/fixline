import type { Db } from './db.js';

/** Ordered schema changes; each runs once, inside a transaction. */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE workspaces (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        join_code   TEXT NOT NULL UNIQUE,
        prefix      TEXT NOT NULL DEFAULT 'FX',
        next_number INT  NOT NULL DEFAULT 1001,
        demo        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE users (
        id            SERIAL PRIMARY KEY,
        workspace_id  INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('requester','agent','admin')),
        department    TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX users_workspace ON users(workspace_id, role);

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE incidents (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        message      TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at  TIMESTAMPTZ
      );

      CREATE TABLE tickets (
        id                SERIAL PRIMARY KEY,
        workspace_id      INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        number            INT  NOT NULL,
        subject           TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        category          TEXT NOT NULL DEFAULT 'Other',
        priority          INT  NOT NULL CHECK (priority BETWEEN 1 AND 4),
        status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','open','waiting','solved')),
        waiting_reason    TEXT NOT NULL DEFAULT '',
        requester_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assignee_id       INT  REFERENCES users(id) ON DELETE SET NULL,
        device            TEXT NOT NULL DEFAULT '',
        location          TEXT NOT NULL DEFAULT '',
        channel           TEXT NOT NULL DEFAULT 'portal',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        first_response_at TIMESTAMPTZ,
        response_due_at   TIMESTAMPTZ NOT NULL,
        due_at            TIMESTAMPTZ NOT NULL,
        paused_at         TIMESTAMPTZ,
        solved_at         TIMESTAMPTZ,
        resolution        TEXT NOT NULL DEFAULT '',
        rating            TEXT CHECK (rating IN ('good','bad')),
        incident_id       INT REFERENCES incidents(id) ON DELETE SET NULL,
        UNIQUE (workspace_id, number)
      );
      CREATE INDEX tickets_queue ON tickets(workspace_id, status, due_at);
      CREATE INDEX tickets_requester ON tickets(requester_id);
      CREATE INDEX tickets_search ON tickets USING GIN (to_tsvector('english', subject || ' ' || description || ' ' || resolution));

      CREATE TABLE messages (
        id         SERIAL PRIMARY KEY,
        ticket_id  INT  NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author_id  INT  REFERENCES users(id) ON DELETE SET NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('reply','note','event')),
        body       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX messages_ticket ON messages(ticket_id, created_at);

      CREATE TABLE articles (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        category     TEXT NOT NULL DEFAULT 'Other',
        uses         INT  NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX articles_search ON articles USING GIN (to_tsvector('english', title || ' ' || body));

      CREATE TABLE macros (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL
      );
    `,
  },
];

export async function migrate(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS fixline_migrations (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM fixline_migrations');
  const done = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.exec(`BEGIN;\n${m.sql}\nINSERT INTO fixline_migrations (id) VALUES ('${m.id}');\nCOMMIT;`);
  }
}
