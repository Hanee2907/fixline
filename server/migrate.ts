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
  {
    id: '002_hours_files_email_presence',
    sql: `
      ALTER TABLE workspaces ADD COLUMN time_zone   TEXT    NOT NULL DEFAULT 'America/Toronto';
      ALTER TABLE workspaces ADD COLUMN work_days   TEXT    NOT NULL DEFAULT '1,2,3,4,5';
      ALTER TABLE workspaces ADD COLUMN day_start   INT     NOT NULL DEFAULT 480;
      ALTER TABLE workspaces ADD COLUMN day_end     INT     NOT NULL DEFAULT 1020;
      ALTER TABLE workspaces ADD COLUMN urgent_24x7 BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE workspaces ADD COLUMN inbound_token TEXT UNIQUE;

      ALTER TABLE tickets ADD COLUMN paused_resolve_left BIGINT;
      ALTER TABLE tickets ADD COLUMN paused_respond_left BIGINT;

      ALTER TABLE messages ADD COLUMN via TEXT NOT NULL DEFAULT 'web';

      CREATE TABLE attachments (
        id          SERIAL PRIMARY KEY,
        ticket_id   INT  NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id  INT  REFERENCES messages(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        size        INT  NOT NULL,
        internal    BOOLEAN NOT NULL DEFAULT FALSE,
        data        BYTEA NOT NULL,
        uploaded_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX attachments_ticket ON attachments(ticket_id);

      CREATE TABLE emails (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  REFERENCES workspaces(id) ON DELETE CASCADE,
        to_email     TEXT NOT NULL,
        subject      TEXT NOT NULL,
        body         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        ticket_id    INT  REFERENCES tickets(id) ON DELETE SET NULL,
        status       TEXT NOT NULL DEFAULT 'logged',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX emails_workspace ON emails(workspace_id, created_at DESC);

      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE presence (
        user_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        server_id    TEXT NOT NULL,
        seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, server_id)
      );
    `,
  },
  {
    id: '003_itsm',
    sql: `
      -- People: who approves whose requests, two-factor sign-in, single sign-on.
      ALTER TABLE users ADD COLUMN manager_id INT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN totp_secret TEXT;
      ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN sso_subject TEXT;
      ALTER TABLE workspaces ADD COLUMN sso_domain TEXT;

      CREATE TABLE login_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts   INT NOT NULL DEFAULT 0
      );

      -- Requests people can make, e.g. "New software", "Access to a shared drive".
      CREATE TABLE catalog_items (
        id             SERIAL PRIMARY KEY,
        workspace_id   INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        icon           TEXT NOT NULL DEFAULT '📦',
        category       TEXT NOT NULL DEFAULT 'Other',
        keywords       TEXT NOT NULL DEFAULT '',
        fields         TEXT NOT NULL DEFAULT '[]',
        needs_approval BOOLEAN NOT NULL DEFAULT TRUE,
        priority       INT  NOT NULL DEFAULT 4,
        active         BOOLEAN NOT NULL DEFAULT TRUE
      );

      ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'incident';
      ALTER TABLE tickets ADD COLUMN catalog_item_id INT REFERENCES catalog_items(id) ON DELETE SET NULL;
      ALTER TABLE tickets ADD COLUMN form TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tickets ADD COLUMN approval TEXT;
      ALTER TABLE tickets ADD COLUMN approver_id INT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE tickets ADD COLUMN approved_at TIMESTAMPTZ;

      CREATE TABLE approval_links (
        token_hash TEXT PRIMARY KEY,
        ticket_id  INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );

      -- Devices and licences.
      CREATE TABLE assets (
        id             SERIAL PRIMARY KEY,
        workspace_id   INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        tag            TEXT NOT NULL,
        name           TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'laptop',
        model          TEXT NOT NULL DEFAULT '',
        serial         TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use','in_stock','repair','retired')),
        assigned_to    INT  REFERENCES users(id) ON DELETE SET NULL,
        location       TEXT NOT NULL DEFAULT '',
        purchased_on   DATE,
        warranty_until DATE,
        notes          TEXT NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, tag)
      );
      ALTER TABLE tickets ADD COLUMN asset_id INT REFERENCES assets(id) ON DELETE SET NULL;

      -- Root causes behind repeated incidents.
      CREATE TABLE problems (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        number       INT  NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating','known_error','resolved')),
        root_cause   TEXT NOT NULL DEFAULT '',
        workaround   TEXT NOT NULL DEFAULT '',
        assignee_id  INT  REFERENCES users(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at  TIMESTAMPTZ
      );
      ALTER TABLE tickets ADD COLUMN problem_id INT REFERENCES problems(id) ON DELETE SET NULL;

      -- Planned changes, with approval and a calendar.
      CREATE TABLE changes (
        id             SERIAL PRIMARY KEY,
        workspace_id   INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        number         INT  NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        plan           TEXT NOT NULL DEFAULT '',
        rollback       TEXT NOT NULL DEFAULT '',
        affects        TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','done','failed','cancelled')),
        planned_start  TIMESTAMPTZ NOT NULL,
        planned_end    TIMESTAMPTZ NOT NULL,
        risk_score     INT  NOT NULL DEFAULT 0,
        risk_reasons   TEXT NOT NULL DEFAULT '[]',
        requested_by   INT  REFERENCES users(id) ON DELETE SET NULL,
        approved_by    INT  REFERENCES users(id) ON DELETE SET NULL,
        outcome        TEXT NOT NULL DEFAULT '',
        problem_id     INT  REFERENCES problems(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX changes_calendar ON changes(workspace_id, planned_start);

      -- "When … then …" rules.
      CREATE TABLE rules (
        id           SERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        enabled      BOOLEAN NOT NULL DEFAULT TRUE,
        conditions   TEXT NOT NULL DEFAULT '[]',
        actions      TEXT NOT NULL DEFAULT '[]',
        runs         INT  NOT NULL DEFAULT 0,
        last_run_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Who did what, when.
      CREATE TABLE audit_log (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id INT  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        actor_id     INT  REFERENCES users(id) ON DELETE SET NULL,
        action       TEXT NOT NULL,
        target       TEXT NOT NULL DEFAULT '',
        detail       TEXT NOT NULL DEFAULT '',
        ip           TEXT NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_workspace ON audit_log(workspace_id, created_at DESC);
    `,
  },
];

/** Any fixed number works; every Fixline process uses the same one to take turns migrating. */
const MIGRATION_LOCK = 4_729_311;

export async function migrate(db: Db) {
  // Several servers (or test files) can start at once. The lock makes them migrate one at a time,
  // and each re-reads what's already applied once it has the lock.
  await db.exclusive(MIGRATION_LOCK, async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS fixline_migrations (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM fixline_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await tx.exec(`BEGIN;\n${m.sql}\nINSERT INTO fixline_migrations (id) VALUES ('${m.id}');\nCOMMIT;`);
    }
  });
}
