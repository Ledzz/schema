import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';

/** Mounts the Hono API (JLCPCB / EasyEDA proxy) inside the Vite dev server. */
function apiDevServer(): Plugin {
  return {
    name: 'schematics-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const { api } = (await server.ssrLoadModule('/server/api.ts')) as { api: Hono };
          await getRequestListener(api.fetch)(req, res);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiDevServer()],
  server: { port: 5173 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
