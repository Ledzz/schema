import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';

/*
 * Dev-only access to project files in ./designs, so the app can open designs made with the
 * `pnpm schem` command line (and the skills that use it) and save edits back for them.
 * Only plain *.json names directly inside ./designs are accepted.
 */
const DIR = resolve(process.cwd(), 'designs');
const NAME = /^[\w.-]+\.json$/;

export const designs = new Hono().basePath('/api/dev/designs');

designs.get('/', async (c) => {
  const files = await readdir(DIR).catch(() => [] as string[]);
  return c.json(files.filter((f) => NAME.test(f)).sort());
});

designs.get('/:name', async (c) => {
  const name = c.req.param('name');
  if (!NAME.test(name)) return c.json({ error: 'Invalid design name' }, 400);
  try {
    return c.json(JSON.parse(await readFile(join(DIR, name), 'utf8')));
  } catch {
    return c.json({ error: `designs/${name} not found` }, 404);
  }
});

designs.put('/:name', async (c) => {
  const name = c.req.param('name');
  if (!NAME.test(name)) return c.json({ error: 'Invalid design name' }, 400);
  const body = (await c.req.json().catch(() => null)) as { version?: number; components?: unknown } | null;
  if (!body || body.version !== 1 || !Array.isArray(body.components)) return c.json({ error: 'Not a schematic project' }, 400);
  await mkdir(DIR, { recursive: true });
  const tmp = join(DIR, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(body, null, 1));
  await rename(tmp, join(DIR, name));
  return c.json({ ok: true, path: `designs/${name}` });
});
