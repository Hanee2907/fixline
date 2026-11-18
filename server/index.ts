import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
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

const { app } = createApp(db, { secureCookies: production && process.env.SECURE_COOKIES !== 'false' });

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
    await db.close();
    process.exit(0);
  });
}
