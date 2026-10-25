import { basename, dirname, resolve } from 'node:path';
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
      // Tell open pages when a design file changes on disk (written by `pnpm schem` or an editor),
      // so a page showing that design can reload it.
      const designsDir = resolve(server.config.root, 'designs');
      server.watcher.add(designsDir);
      const designChanged = (file: string) => {
        if (dirname(file) !== designsDir || !/^[\w.-]+\.json$/.test(basename(file))) return;
        server.ws.send({ type: 'custom', event: 'schematics:design-changed', data: { name: basename(file) } });
      };
      server.watcher.on('change', designChanged);
      server.watcher.on('add', designChanged);

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          // Design files are only reachable from the dev server.
          const module = req.url.startsWith('/api/dev/designs')
            ? ((await server.ssrLoadModule('/server/designs.ts')) as { designs: Hono }).designs
            : ((await server.ssrLoadModule('/server/api.ts')) as { api: Hono }).api;
          await getRequestListener(module.fetch)(req, res);
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
