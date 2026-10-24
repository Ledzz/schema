import type { PartDetail, SearchFacets, SearchQuery, SearchResult, StockInfo } from '../shared/parts';

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
  getJson<SearchResult>(`/api/parts/search?${searchQueryParams(q)}`, { signal });

export const fetchFacets = (q: string, inStock: boolean, packages: string[], signal?: AbortSignal) =>
  getJson<SearchFacets>(`/api/parts/facets?${new URLSearchParams({ q, inStock: inStock ? '1' : '0', packages: packages.join(',') })}`, { signal });

const detailCache = new Map<string, Promise<PartDetail>>();

export function fetchPartDetail(lcsc: string): Promise<PartDetail> {
  const code = lcsc.trim().toUpperCase();
  let hit = detailCache.get(code);
  if (!hit) {
    hit = getJson<PartDetail>(`/api/parts/${encodeURIComponent(code)}`);
    hit.catch(() => detailCache.delete(code));
    detailCache.set(code, hit);
  }
  return hit;
}

export const fetchStock = (codes: string[]) =>
  getJson<StockInfo[]>('/api/parts/stock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
