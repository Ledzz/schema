import type {
  CategoryFacet,
  FacetBucket,
  PartClass,
  PartSummary,
  PriceBreak,
  SearchFacets,
  SearchQuery,
  SearchResult,
} from '../src/shared/parts';

/*
 * Client for the public JSON API behind https://jlcpcb.com/parts.
 *
 * Request shapes were taken from the JLCPCB parts page (captured with REA) and
 * confirmed by replaying them:
 *   - componentLibTypes ["base"] / ["expand"]  -> basic / extended (extended includes preferred)
 *   - preferredComponentFlag true               -> "Promotional Extended" (preferred) parts;
 *                                                  combined with ["base"] it yields the union
 *   - stockFlag true                            -> in stock only
 *   - sortMode STOCK_SORT|PRICE_SORT|MODEL_SORT + sortASC ASC|DESC
 *   - firstSortName / secondSortName            -> category / subcategory
 *   - componentSpecificationList / componentBrandList -> package / manufacturer
 * The API rejects browser-originated (Origin header) requests, so it is only called server-side.
 */

const BASE = 'https://jlcpcb.com/api/overseas-pcb-order/v1';
const SEARCH_URL = `${BASE}/shoppingCart/smtGood/selectSmtComponentList/v2`;
const FACETS_URL = `${BASE}/componentSearch/filterComponentAttribute`;

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Safari/537.36',
};

export type LibraryTypeFilter = { componentLibTypes?: ('base' | 'expand')[]; preferredComponentFlag?: true };

/** Maps the selected part classes onto JLCPCB's filter fields. */
export function libraryTypeFilter(types: PartClass[]): LibraryTypeFilter {
  const set = new Set(types);
  if (set.size === 0 || set.size === 3) return {};
  if (set.has('extended')) {
    // "extended" already contains the preferred subset.
    return { componentLibTypes: set.has('basic') ? ['base', 'expand'] : ['expand'] };
  }
  const filter: LibraryTypeFilter = {};
  if (set.has('basic')) filter.componentLibTypes = ['base'];
  if (set.has('preferred')) filter.preferredComponentFlag = true;
  return filter;
}

const SORTS: Record<SearchQuery['sort'], { sortMode: string; sortASC: string }> = {
  relevance: { sortMode: '', sortASC: '' },
  stock: { sortMode: 'STOCK_SORT', sortASC: 'DESC' },
  price: { sortMode: 'PRICE_SORT', sortASC: 'ASC' },
  mpn: { sortMode: 'MODEL_SORT', sortASC: 'ASC' },
};

export function buildSearchBody(query: SearchQuery): Record<string, unknown> {
  return {
    currentPage: query.page,
    pageSize: query.pageSize,
    searchType: 2,
    searchSource: 'search',
    keyword: query.q.trim(),
    componentLibraryType: null,
    stockFlag: query.inStock ? true : null,
    firstSortName: query.category || null,
    secondSortName: query.category && query.subcategory ? query.subcategory : null,
    componentSpecificationList: query.packages ?? [],
    componentBrandList: query.manufacturers ?? [],
    componentAttributeList: [],
    paramList: [],
    ...SORTS[query.sort],
    ...libraryTypeFilter(query.types),
  };
}

interface RawPrice {
  startNumber: number;
  productPrice: number;
}

interface RawComponent {
  componentCode: string;
  componentModelEn: string | null;
  componentBrandEn: string | null;
  componentSpecificationEn: string | null;
  componentLibraryType: string | null;
  preferredComponentFlag: boolean | null;
  stockCount: number | null;
  componentPrices: RawPrice[] | null;
  describe: string | null;
  erpComponentName: string | null;
  firstSortName: string | null;
  secondSortName: string | null;
  dataManualUrl: string | null;
  minImageAccessIdUrl: string | null;
  urlSuffix: string | null;
  lcscGoodsUrl: string | null;
  attributes: { attribute_name_en: string; attribute_value_name: string }[] | null;
}

export function classify(raw: Pick<RawComponent, 'componentLibraryType' | 'preferredComponentFlag'>): PartClass {
  if (raw.componentLibraryType === 'base') return 'basic';
  return raw.preferredComponentFlag ? 'preferred' : 'extended';
}

export function normalizePart(raw: RawComponent): PartSummary {
  const prices: PriceBreak[] = (raw.componentPrices ?? [])
    .map((p) => ({ qty: p.startNumber, price: p.productPrice }))
    .sort((a, b) => a.qty - b.qty);
  return {
    lcsc: raw.componentCode,
    mpn: raw.componentModelEn ?? raw.componentCode,
    manufacturer: raw.componentBrandEn ?? '',
    package: raw.componentSpecificationEn ?? '',
    description: raw.describe ?? raw.erpComponentName ?? '',
    // The API reports the leaf category as firstSortName and its parent as secondSortName.
    category: raw.secondSortName ?? '',
    subcategory: raw.firstSortName ?? '',
    partClass: classify(raw),
    stock: raw.stockCount ?? 0,
    prices,
    datasheet: raw.dataManualUrl || null,
    image: raw.minImageAccessIdUrl || null,
    url: raw.urlSuffix ? `https://jlcpcb.com/partdetail/${raw.urlSuffix}` : `https://jlcpcb.com/parts/componentSearch?searchTxt=${raw.componentCode}`,
    attributes: (raw.attributes ?? [])
      .filter((a) => a.attribute_value_name && a.attribute_value_name !== '-')
      .map((a) => ({ name: a.attribute_name_en, value: a.attribute_value_name })),
  };
}

// JLCPCB answers bursts with HTTP 429, so requests are queued and 429s retried with backoff.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(url: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await withSlot(() => fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }));
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`JLCPCB ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { code: number; data: T; message?: string };
    if (json.code !== 200) throw new Error(`JLCPCB error ${json.code}: ${json.message ?? 'unknown'}`);
    return json.data;
  }
}

export async function searchParts(query: SearchQuery): Promise<SearchResult> {
  const data = await post<{ componentPageInfo: { total: number | null; list: RawComponent[] | null } }>(
    SEARCH_URL,
    buildSearchBody(query),
  );
  return {
    total: data.componentPageInfo.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    parts: (data.componentPageInfo.list ?? []).map(normalizePart),
  };
}

/** Exact lookup by LCSC part number (e.g. "C25804"). */
export async function getPart(lcsc: string): Promise<PartSummary | null> {
  const result = await searchParts({ q: lcsc, types: [], inStock: false, sort: 'relevance', page: 1, pageSize: 5 });
  return result.parts.find((p) => p.lcsc.toUpperCase() === lcsc.toUpperCase()) ?? null;
}

/**
 * Exact in-stock counts per part class. The facet endpoint can only filter by JLCPCB's stock
 * *type*, which also includes parts with zero stock, so its class counts overstate in-stock parts.
 */
export async function countInStockByClass(q: string, packages: string[]): Promise<Record<PartClass, number>> {
  const classes: PartClass[] = ['basic', 'preferred', 'extended'];
  const totals = await Promise.all(
    classes.map((t) => searchParts({ q, types: [t], inStock: true, sort: 'relevance', packages, page: 1, pageSize: 1 }).then((r) => r.total)),
  );
  return { basic: totals[0], preferred: totals[1], extended: totals[2] };
}

interface RawBucket {
  name: string;
  docCount: number;
  subAggs: RawBucket[] | null;
}

const bucket = (b: RawBucket): FacetBucket => ({ name: b.name, count: b.docCount });

export async function searchFacets(q: string, inStock: boolean, packages: string[] = []): Promise<SearchFacets> {
  const keyword = q.trim() || null;
  const data = await post<{
    total: number;
    basePart: number;
    preferredPart: number;
    extendPart: number;
    productTypeAggs: RawBucket[] | null;
    componentSpecificationList: RawBucket[] | null;
    componentBrandList: RawBucket[] | null;
  }>(FACETS_URL, {
    baseQueryDto: {
      keyword,
      filterType: 1,
      componentBrandList: [],
      componentSpecificationList: packages,
      componentTypeIdList: [],
      orderLibraryTypeList: [],
      packageTypeList: [],
      productTypeIdList: [],
      // The facet endpoint ignores stockFlag; presaleTypes ["stock"] yields the in-stock counts.
      presaleTypes: inStock ? ['stock'] : [],
    },
    catalogLevel: 1,
    nowCondition: '',
    paramList: [],
    queryString: keyword,
  });
  const byCount = (a: FacetBucket, b: FacetBucket) => b.count - a.count;
  const categories: CategoryFacet[] = (data.productTypeAggs ?? [])
    .map((c) => ({ ...bucket(c), children: (c.subAggs ?? []).map(bucket).sort(byCount) }))
    .sort(byCount);
  return {
    total: data.total ?? 0,
    classCounts: {
      basic: data.basePart ?? 0,
      preferred: data.preferredPart ?? 0,
      // Like the "extended" filter, this count includes the preferred subset.
      extended: data.extendPart ?? 0,
    },
    categories,
    packages: (data.componentSpecificationList ?? []).map(bucket).filter((b) => b.name !== '-').sort(byCount),
    manufacturers: (data.componentBrandList ?? []).map(bucket).sort(byCount),
  };
}
