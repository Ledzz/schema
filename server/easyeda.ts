import { createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { DeviceData, LibraryDoc, StockInfo } from '../src/shared/parts';

/*
 * EasyEDA Pro library access, reverse-engineered from pro.easyeda.com (EasyEDA Pro v3.2.209):
 *
 *  POST /api/devices/search {wd, uid, path, page, pageSize, attributes, tag}
 *    Full-text device search over the system ("lcsc") library. Each device embeds
 *    symbol_info / footprint_info. Their document is either inline (`dataStr`) or stored
 *    encrypted at `dataStrId` with an AES-256-GCM `key` and 12-byte `iv` (hex). The blob is
 *    ciphertext || 16-byte tag; the plaintext is gzip. (lib-worker.js: crypto.subtle.decrypt
 *    {name: "AES-GCM", iv} with a raw-imported key.)
 *
 *  POST /api/components/getSmtPartInfo {numbers: ["C…"], path}
 *    Bulk JLCPCB assembly info: paste_type "base" | "expand", stock_num.
 */

const ORIGIN = 'https://pro.easyeda.com';
/** uuid of the system library owner ("LCSC") that EasyEDA's library panel searches. */
const SYSTEM_LIBRARY = '0819f05c4eef4c71ace90d822a990e87';

interface RawDoc {
  uuid: string;
  display_title?: string;
  title?: string;
  dataStr?: string;
  dataStrId?: string;
  key?: string;
  iv?: string;
}

interface RawDevice {
  uuid: string;
  display_title: string;
  product_code?: string;
  attributes: Record<string, string>;
  images?: string[];
  symbol_info?: RawDoc;
  footprint_info?: RawDoc;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`EasyEDA ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { success: boolean; code: number; result: T; message?: string };
  if (!json.success) throw new Error(`EasyEDA error ${json.code}: ${json.message ?? 'unknown'}`);
  return json.result;
}

export function decryptDataStr(blob: Uint8Array, keyHex: string, ivHex: string): string {
  const data = Buffer.from(blob);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  let plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  if (plain[0] === 0x1f && plain[1] === 0x8b) plain = gunzipSync(plain);
  return plain.toString('utf8');
}

async function loadDoc(raw: RawDoc | undefined): Promise<LibraryDoc | null> {
  if (!raw) return null;
  let dataStr = raw.dataStr ?? '';
  if (!dataStr && raw.dataStrId && raw.key && raw.iv) {
    const url = raw.dataStrId.startsWith('http') ? raw.dataStrId : `https://image-pro.easyeda.com${raw.dataStrId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`EasyEDA document ${res.status}`);
    dataStr = decryptDataStr(new Uint8Array(await res.arrayBuffer()), raw.key, raw.iv);
  }
  if (!dataStr) return null;
  return { uuid: raw.uuid, title: raw.display_title ?? raw.title ?? '', dataStr };
}

/** Finds the EasyEDA system-library device for an LCSC part number and loads its symbol and footprint. */
export async function getDevice(lcsc: string): Promise<DeviceData | null> {
  const result = await post<{ lists: { lcsc?: RawDevice[] } }>('/api/devices/search', {
    attributes: {},
    path: SYSTEM_LIBRARY,
    uid: SYSTEM_LIBRARY,
    page: 1,
    pageSize: 10,
    tag: [],
    wd: lcsc,
  });
  const code = lcsc.toUpperCase();
  const device = (result.lists.lcsc ?? []).find(
    (d) => d.product_code?.toUpperCase() === code || d.attributes?.['Supplier Part']?.toUpperCase() === code,
  );
  if (!device) return null;
  const [symbol, footprint] = await Promise.all([loadDoc(device.symbol_info), loadDoc(device.footprint_info)]);
  return {
    lcsc: code,
    title: device.display_title,
    attributes: device.attributes ?? {},
    symbol,
    footprint,
    image: device.images?.find(Boolean) ?? null,
  };
}

export async function getStock(codes: string[]): Promise<StockInfo[]> {
  if (codes.length === 0) return [];
  const rows = await post<{ component_code: string; paste_type: string; stock_num: number }[]>(
    '/api/components/getSmtPartInfo',
    { numbers: codes, path: SYSTEM_LIBRARY },
  );
  return rows.map((r) => ({
    lcsc: r.component_code,
    libraryType: r.paste_type === 'base' || r.paste_type === 'expand' ? r.paste_type : null,
    stock: r.stock_num ?? 0,
  }));
}
