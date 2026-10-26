/**
 * Types shared between the API server and the browser app.
 *
 * JLCPCB assembly classifies every part as one of:
 *  - basic:     always loaded on the pick-and-place machines, no setup fee
 *  - preferred: "Promotional Extended" parts; extended parts whose setup fee is waived
 *  - extended:  everything else; costs a feeder setup fee per unique part
 */
export type PartClass = 'basic' | 'preferred' | 'extended';

export const PART_CLASSES: PartClass[] = ['basic', 'preferred', 'extended'];

export const PART_CLASS_LABEL: Record<PartClass, string> = {
  basic: 'Basic',
  preferred: 'Preferred',
  extended: 'Extended',
};

/** Feeder setup fee JLCPCB charges per unique extended part (USD). */
export const EXTENDED_SETUP_FEE = 3;

export type SortKey = 'relevance' | 'stock' | 'price' | 'mpn';

export interface PriceBreak {
  qty: number;
  price: number;
}

export interface PartSummary {
  lcsc: string;
  mpn: string;
  manufacturer: string;
  package: string;
  description: string;
  category: string;
  subcategory: string;
  partClass: PartClass;
  stock: number;
  prices: PriceBreak[];
  datasheet: string | null;
  image: string | null;
  url: string;
  attributes: { name: string; value: string }[];
}

export interface SearchQuery {
  q: string;
  types: PartClass[];
  inStock: boolean;
  sort: SortKey;
  category?: string;
  subcategory?: string;
  packages?: string[];
  manufacturers?: string[];
  page: number;
  pageSize: number;
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  parts: PartSummary[];
}

export interface FacetBucket {
  name: string;
  count: number;
}

export interface CategoryFacet extends FacetBucket {
  children: FacetBucket[];
}

export interface SearchFacets {
  total: number;
  classCounts: Record<PartClass, number>;
  categories: CategoryFacet[];
  packages: FacetBucket[];
  manufacturers: FacetBucket[];
}

export interface LibraryDoc {
  uuid: string;
  title: string;
  /** EasyEDA Pro line-oriented document (one JSON array per line). */
  dataStr: string;
}

export interface DeviceData {
  lcsc: string;
  title: string;
  attributes: Record<string, string>;
  symbol: LibraryDoc | null;
  footprint: LibraryDoc | null;
  image: string | null;
}

/** A part's 3D model as EasyEDA serves it. */
/** A part's STEP model (AP214, millimetres) and how EasyEDA places it, for the STEP export. */
export interface PartStep {
  lcsc: string;
  title: string;
  /** Same layout as PartModel.transform. */
  transform: number[];
  /** EasyEDA's model file id: parts sharing a model share it. */
  file: string;
  step: string;
}

export interface PartModel {
  lcsc: string;
  title: string;
  /**
   * EasyEDA's "3D Model Transform": target size X, Y, Z in mil (0 = keep), rotation X, Y, Z in
   * degrees, offset X, Y, Z in mil (y up), applied to the model centred on the footprint origin.
   */
  transform: number[];
  /** Wavefront OBJ in millimetres, Z up, with materials inline (newmtl … endmtl). */
  obj: string;
}

export interface PartDetail {
  part: PartSummary | null;
  device: DeviceData | null;
}

export interface StockInfo {
  lcsc: string;
  /** JLCPCB library type; 'preferred' cannot be told apart from 'extended' by this endpoint. */
  libraryType: 'base' | 'expand' | null;
  stock: number;
}

const CHIP_SIZE = /(?<![\w.-])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2220|2512)(?![\w.-])/gi;

/**
 * JLCPCB's keyword search treats "0805" as an optional word, so "10uF 0805" also returns 0603
 * parts. Standalone imperial chip sizes are therefore moved into the exact package filter.
 */
export function splitPackageQuery(q: string): { keyword: string; packages: string[] } {
  const packages = [...new Set([...q.matchAll(CHIP_SIZE)].map((m) => m[1]))];
  if (packages.length === 0) return { keyword: q, packages };
  return { keyword: q.replace(CHIP_SIZE, ' ').replace(/\s+/g, ' ').trim(), packages };
}

/** Unit price for a given order quantity. */
export function priceAt(prices: PriceBreak[], qty: number): number | null {
  let best: number | null = null;
  for (const p of prices) if (qty >= p.qty) best = p.price;
  return best ?? prices[0]?.price ?? null;
}

export const LIBRARY_ATTRIBUTION =
  'Symbols and footprints: JLCEDA/EasyEDA Official Library (https://lceda.cn, https://easyeda.com)';
