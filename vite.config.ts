import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5192, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false } } },
  test: {
    root: '.',
    testTimeout: 30000,
    projects: [
      { extends: true, test: { name: 'server', include: ['server/**/*.test.ts', 'shared/**/*.test.ts'], environment: 'node', pool: 'forks' } },
      { extends: true, test: { name: 'web', include: ['web/src/**/*.test.tsx'], environment: 'jsdom' } },
    ],
  },
});
