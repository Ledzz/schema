import { Hono } from 'hono';
import {
  PART_CLASSES,
  type DeviceData,
  type PartClass,
  type PartDetail,
  type PartSummary,
  type SearchFacets,
  type SearchQuery,
  type SearchResult,
  type SortKey,
} from '../src/shared/parts';
import { TtlCache } from './cache';
import { countInStockByClass, getPart, searchFacets, searchParts } from './jlcpcb';
import { getDevice, getStock } from './easyeda';
import { matchPassive, type PassiveMatch } from './match';
import { PASSIVE_KINDS, type PassiveKind } from '../src/shared/passives';

const MINUTE = 60_000;
const searchCache = new TtlCache<SearchResult>(500, 10 * MINUTE);
const facetCache = new TtlCache<SearchFacets>(300, 10 * MINUTE);
const partCache = new TtlCache<PartSummary | null>(2000, 30 * MINUTE);
const deviceCache = new TtlCache<DeviceData | null>(2000, 24 * 60 * MINUTE);
const matchCache = new TtlCache<PassiveMatch>(1000, 30 * MINUTE);

const LCSC_CODE = /^C\d{1,12}$/i;
const SORTS: SortKey[] = ['relevance', 'stock', 'price', 'mpn'];

function list(value: string | undefined): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const types = list(params.get('types') ?? undefined).filter((t): t is PartClass =>
    (PART_CLASSES as string[]).includes(t),
  );
  const sort = params.get('sort') as SortKey | null;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize')) || 30));
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    types,
    inStock: params.get('inStock') !== '0',
    sort: sort && SORTS.includes(sort) ? sort : 'relevance',
    category: params.get('category') || undefined,
    subcategory: params.get('subcategory') || undefined,
    packages: list(params.get('packages') ?? undefined),
    manufacturers: list(params.get('manufacturers') ?? undefined),
    page,
    pageSize,
  };
}

async function partFromDevice(device: DeviceData): Promise<PartSummary> {
  const [stock] = await getStock([device.lcsc]);
  const a = device.attributes;
  const cls = a['JLCPCB Part Class'];
  return {
    lcsc: device.lcsc,
    mpn: a['Manufacturer Part'] || device.title,
    manufacturer: a['Manufacturer'] ?? '',
    package: a['Supplier Footprint'] ?? '',
    description: a['LCSC Part Name'] ?? '',
    category: '',
    subcategory: '',
    // EasyEDA cannot tell preferred from other extended parts.
    partClass: stock?.libraryType === 'base' || cls === 'Basic Part' ? 'basic' : 'extended',
    stock: stock?.stock ?? 0,
    prices: [],
    datasheet: a['Datasheet'] || null,
    image: device.image,
    url: `https://jlcpcb.com/parts/componentSearch?searchTxt=${device.lcsc}`,
    attributes: [],
  };
}

export const api = new Hono().basePath('/api');

api.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: err.message }, 502);
});

api.get('/health', (c) => c.json({ ok: true }));

api.get('/parts/search', async (c) => {
  const query = parseSearchQuery(new URL(c.req.url).searchParams);
  const result = await searchCache.get(JSON.stringify(query), () => searchParts(query));
  return c.json(result);
});

api.get('/parts/facets', async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 200);
  const inStock = c.req.query('inStock') !== '0';
  const packages = list(c.req.query('packages'));
  const facets = await facetCache.get(`${q}|${inStock}|${packages}`, async () => {
    const [f, counts] = await Promise.all([searchFacets(q, inStock, packages), inStock ? countInStockByClass(q, packages) : null]);
    return counts ? { ...f, classCounts: counts } : f;
  });
  return c.json(facets);
});

api.get('/parts/match', async (c) => {
  const kind = c.req.query('kind') as PassiveKind;
  if (!PASSIVE_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${PASSIVE_KINDS.join(', ')}` }, 400);
  const value = (c.req.query('value') ?? '').slice(0, 60);
  const size = (c.req.query('size') ?? '').slice(0, 40);
  return c.json(await matchCache.get(`${kind}|${value}|${size}`, () => matchPassive(kind, value, size)));
});

api.get('/parts/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  if (!LCSC_CODE.test(code)) return c.json({ error: 'Expected an LCSC part number like C25804' }, 400);
  const [partResult, deviceResult] = await Promise.allSettled([
    partCache.get(code, () => getPart(code)),
    deviceCache.get(code, () => getDevice(code)),
  ]);
  const device = deviceResult.status === 'fulfilled' ? deviceResult.value : null;
  let part = partResult.status === 'fulfilled' ? partResult.value : null;
  if (partResult.status === 'rejected') {
    if (!device) throw partResult.reason;
    // JLCPCB unavailable (e.g. rate limited): build the summary from EasyEDA's data instead.
    part = await partFromDevice(device).catch(() => null);
  }
  if (!part && !device) return c.json({ error: `Part ${code} not found` }, 404);
  return c.json({ part, device } satisfies PartDetail);
});

api.post('/parts/stock', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { codes?: unknown };
  const codes = Array.isArray(body.codes)
    ? [...new Set(body.codes.filter((x): x is string => typeof x === 'string' && LCSC_CODE.test(x)))].slice(0, 500)
    : [];
  return c.json(await getStock(codes));
});
