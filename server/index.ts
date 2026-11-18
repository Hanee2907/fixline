import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { Bus } from './bus.js';
import { connect } from './db.js';
import { removeOldDemos } from './demo.js';
import { migrate } from './migrate.js';

const production = process.env.NODE_ENV === 'production';
// In development the web app owns PORT, so the API listens on API_PORT.
const port = Number((production ? process.env.PORT : process.env.API_PORT) ?? 8790);
const WEB = 'dist/web';

console.log(`Starting Fixline API (${process.env.DATABASE_URL ? 'PostgreSQL' : 'local PGlite'})…`);
const db = await connect(process.env.DATABASE_URL, process.env.PGLITE_DIR ?? '.data/pglite');
console.log('Database ready');
await migrate(db);
await removeOldDemos(db);
setInterval(() => removeOldDemos(db).catch(console.error), 60 * 60_000).unref();

// Live updates go through PostgreSQL LISTEN/NOTIFY, so several servers behind a load balancer stay in sync.
const bus = new Bus(db);
await bus.start();
const { app, mailer } = createApp(db, { bus, secureCookies: production && process.env.SECURE_COOKIES !== 'false' });
console.log(`Email: ${mailer.delivery === 'smtp' ? 'sending through SMTP' : 'recorded in the outbox (set SMTP_URL to send)'} · server ${bus.serverId}`);

// In production one server hands out both the API and the built web app.
if (existsSync(WEB)) {
  const indexHtml = readFileSync(`${WEB}/index.html`, 'utf8');
  app.use('/assets/*', serveStatic({ root: WEB }));
  app.use('/favicon.svg', serveStatic({ root: WEB }));
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(indexHtml)));
}

serve({ fetch: app.fetch, port }, () => console.log(`Fixline is running on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await bus.stop();
    await db.close();
    process.exit(0);
  });
}
