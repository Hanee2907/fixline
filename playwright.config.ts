import { defineConfig, devices } from '@playwright/test';

const PORT = 4180;

/** Browser tests run against the real production build: one Node server, built web app, fresh database. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Use the installed Edge locally; CI installs Playwright's Chromium.
    channel: process.env.CI ? undefined : 'msedge',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /portal/ },
  ],
  webServer: {
    command: 'npm run build && node dist-server/server/index.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { NODE_ENV: 'production', PORT: String(PORT), PGLITE_DIR: '.data/e2e', SECURE_COOKIES: 'false' },
  },
});
