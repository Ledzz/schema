import type { PartDetail, PartModel, PartStep, SearchFacets, SearchQuery, SearchResult, StockInfo } from '../shared/parts';

/**
 * Where the API is: the page's own origin normally, another host when the app is served as
 * static files (GitHub Pages) and the server runs elsewhere, set at build time as VITE_API_BASE.
 * The CLI has no import.meta.env and keeps the relative paths it routes in-process.
 */
export const API_BASE = ((typeof import.meta.env !== 'undefined' && (import.meta.env.VITE_API_BASE as string | undefined)) || '').replace(/\/+$/, '');
export const apiUrl = (path: string) => `${API_BASE}${path}`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export function searchQueryParams(q: SearchQuery): URLSearchParams {
  const params = new URLSearchParams({
    q: q.q,
    sort: q.sort,
    page: String(q.page),
    pageSize: String(q.pageSize),
    inStock: q.inStock ? '1' : '0',
  });
  if (q.types.length) params.set('types', q.types.join(','));
  if (q.category) params.set('category', q.category);
  if (q.subcategory) params.set('subcategory', q.subcategory);
  if (q.packages?.length) params.set('packages', q.packages.join(','));
  if (q.manufacturers?.length) params.set('manufacturers', q.manufacturers.join(','));
  return params;
}

export const fetchSearch = (q: SearchQuery, signal?: AbortSignal) =>
  getJson<SearchResult>(apiUrl(`/api/parts/search?${searchQueryParams(q)}`), { signal });

export const fetchFacets = (q: string, inStock: boolean, packages: string[], signal?: AbortSignal) =>
  getJson<SearchFacets>(apiUrl(`/api/parts/facets?${new URLSearchParams({ q, inStock: inStock ? '1' : '0', packages: packages.join(',') })}`), { signal });

const detailCache = new Map<string, Promise<PartDetail>>();

export function fetchPartDetail(lcsc: string): Promise<PartDetail> {
  const code = lcsc.trim().toUpperCase();
  let hit = detailCache.get(code);
  if (!hit) {
    hit = getJson<PartDetail>(apiUrl(`/api/parts/${encodeURIComponent(code)}`));
    hit.catch(() => detailCache.delete(code));
    detailCache.set(code, hit);
  }
  return hit;
}

const modelCache = new Map<string, Promise<PartModel | null>>();

/** A part's 3D model, or null when EasyEDA has none (results are kept for the session). */
/** A part's STEP model for the STEP export, or null when EasyEDA has none. */
export async function fetchPartStep(lcsc: string): Promise<PartStep | null> {
  const res = await fetch(apiUrl(`/api/parts/${encodeURIComponent(lcsc.trim().toUpperCase())}/step`));
  return res.ok ? ((await res.json()) as PartStep) : null;
}

export function fetchPartModel(lcsc: string): Promise<PartModel | null> {
  const code = lcsc.trim().toUpperCase();
  let hit = modelCache.get(code);
  if (!hit) {
    hit = fetch(apiUrl(`/api/parts/${encodeURIComponent(code)}/model`)).then((res) => (res.ok ? (res.json() as Promise<PartModel>) : null));
    hit.catch(() => modelCache.delete(code));
    modelCache.set(code, hit);
  }
  return hit;
}

export const fetchStock = (codes: string[]) =>
  getJson<StockInfo[]>(apiUrl('/api/parts/stock'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
