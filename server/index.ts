/*
 * The production server: the API (JLCPCB/EasyEDA proxy and the assistant route) and, when a
 * build is present in dist/, the app itself. With CORS_ORIGIN set it also answers an app served
 * from elsewhere (GitHub Pages) at those origins; the assistant's key header is allowed through.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { api } from './api';
import { KEY_HEADER } from '../src/shared/assistant';

const app = new Hono();
const origins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (origins.length) app.use('/api/*', cors({ origin: origins, allowHeaders: ['content-type', KEY_HEADER], maxAge: 86400 }));
app.route('/', api);
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port }, () => console.log(`Schematics running on http://localhost:${port}${origins.length ? ` (CORS for ${origins.join(', ')})` : ''}`));
