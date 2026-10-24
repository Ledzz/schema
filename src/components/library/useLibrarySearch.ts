import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFacets, fetchSearch } from '../../lib/api';
import { splitPackageQuery, type PartClass, type PartSummary, type SearchFacets, type SearchQuery, type SortKey } from '../../shared/parts';

export interface LibraryFilters {
  q: string;
  types: PartClass[];
  inStock: boolean;
  sort: SortKey;
  category?: string;
  subcategory?: string;
  packages: string[];
}

const PREFS_KEY = 'schematics:library';
const PAGE_SIZE = 50;

function loadPrefs(): Pick<LibraryFilters, 'types' | 'inStock' | 'sort'> {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      types: Array.isArray(p.types) ? p.types : [],
      inStock: typeof p.inStock === 'boolean' ? p.inStock : true,
      sort: p.sort ?? 'relevance',
    };
  } catch {
    return { types: [], inStock: true, sort: 'relevance' };
  }
}

export function useLibrarySearch() {
  const [filters, setFilters] = useState<LibraryFilters>(() => ({ q: '', packages: [], ...loadPrefs() }));
  const [debouncedQ, setDebouncedQ] = useState(filters.q);
  const [parts, setParts] = useState<PartSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<SearchFacets | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 280);
    return () => clearTimeout(t);
  }, [filters.q]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ types: filters.types, inStock: filters.inStock, sort: filters.sort }));
    } catch {
      /* ignore */
    }
  }, [filters.types, filters.inStock, filters.sort]);

  const split = useMemo(() => splitPackageQuery(debouncedQ), [debouncedQ]);
  const impliedPackages = split.packages;

  const query = useCallback(
    (p: number): SearchQuery => ({
      q: split.keyword,
      types: filters.types,
      inStock: filters.inStock,
      sort: filters.sort,
      category: filters.category,
      subcategory: filters.subcategory,
      packages: [...new Set([...filters.packages, ...split.packages])],
      page: p,
      pageSize: PAGE_SIZE,
    }),
    [split, filters.types, filters.inStock, filters.sort, filters.category, filters.subcategory, filters.packages],
  );

  const run = useCallback(
    async (p: number) => {
      searchAbort.current?.abort();
      const ctrl = new AbortController();
      searchAbort.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await fetchSearch(query(p), ctrl.signal);
        if (ctrl.signal.aborted) return;
        setTotal(res.total);
        setPage(p);
        setParts((prev) => (p === 1 ? res.parts : [...prev, ...res.parts.filter((x) => !prev.some((y) => y.lcsc === x.lcsc))]));
      } catch (err) {
        if (!ctrl.signal.aborted) setError((err as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    run(1);
  }, [run]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchFacets(split.keyword, filters.inStock, split.packages, ctrl.signal)
      .then((f) => !ctrl.signal.aborted && setFacets(f))
      .catch(() => !ctrl.signal.aborted && setFacets(null));
    return () => ctrl.abort();
  }, [split, filters.inStock]);

  const update = useCallback((patch: Partial<LibraryFilters>) => setFilters((f) => ({ ...f, ...patch })), []);

  return {
    filters,
    update,
    parts,
    total,
    loading,
    error,
    facets,
    impliedPackages,
    hasMore: parts.length < total,
    loadMore: () => !loading && parts.length < total && run(page + 1),
    retry: () => run(1),
  };
}
