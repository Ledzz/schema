import { describe, expect, it } from 'vitest';
import { buildSearchBody, classify, libraryTypeFilter, normalizePart } from '../server/jlcpcb';
import { decryptDataStr } from '../server/easyeda';
import { parseSearchQuery } from '../server/api';
import { bomToJlcpcbCsv, buildBom } from '../src/lib/schematic/bom';
import { priceAt, splitPackageQuery } from '../src/shared/parts';
import { comp } from './fixtures';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

describe('JLCPCB part type filter', () => {
  it('maps part classes onto JLCPCB filter fields', () => {
    expect(libraryTypeFilter([])).toEqual({});
    expect(libraryTypeFilter(['basic', 'preferred', 'extended'])).toEqual({});
    expect(libraryTypeFilter(['basic'])).toEqual({ componentLibTypes: ['base'] });
    expect(libraryTypeFilter(['preferred'])).toEqual({ preferredComponentFlag: true });
    expect(libraryTypeFilter(['basic', 'preferred'])).toEqual({ componentLibTypes: ['base'], preferredComponentFlag: true });
    expect(libraryTypeFilter(['extended'])).toEqual({ componentLibTypes: ['expand'] });
    expect(libraryTypeFilter(['preferred', 'extended'])).toEqual({ componentLibTypes: ['expand'] });
    expect(libraryTypeFilter(['basic', 'extended'])).toEqual({ componentLibTypes: ['base', 'expand'] });
  });

  it('classifies parts', () => {
    expect(classify({ componentLibraryType: 'base', preferredComponentFlag: false })).toBe('basic');
    expect(classify({ componentLibraryType: 'expand', preferredComponentFlag: true })).toBe('preferred');
    expect(classify({ componentLibraryType: 'expand', preferredComponentFlag: false })).toBe('extended');
  });

  it('builds the search body', () => {
    const body = buildSearchBody({ q: ' 10k ', types: ['basic'], inStock: true, sort: 'stock', category: 'Resistors', subcategory: 'Chip Resistor - Surface Mount', packages: ['0603'], page: 2, pageSize: 25 });
    expect(body).toMatchObject({
      keyword: '10k',
      currentPage: 2,
      pageSize: 25,
      stockFlag: true,
      sortMode: 'STOCK_SORT',
      sortASC: 'DESC',
      firstSortName: 'Resistors',
      secondSortName: 'Chip Resistor - Surface Mount',
      componentSpecificationList: ['0603'],
      componentLibTypes: ['base'],
    });
  });

  it('moves standalone chip sizes from the keyword into the package filter', () => {
    expect(splitPackageQuery('10uF 0805')).toEqual({ keyword: '10uF', packages: ['0805'] });
    expect(splitPackageQuery('0603 10k 0402')).toEqual({ keyword: '10k', packages: ['0603', '0402'] });
    expect(splitPackageQuery('RC0603FR-0710KL')).toEqual({ keyword: 'RC0603FR-0710KL', packages: [] });
    expect(splitPackageQuery('C0805 AMS1117')).toEqual({ keyword: 'C0805 AMS1117', packages: [] });
  });

  it('parses API query strings defensively', () => {
    const q = parseSearchQuery(new URLSearchParams('q=x&types=basic,bogus&pageSize=1000&sort=nope&inStock=0'));
    expect(q).toMatchObject({ types: ['basic'], pageSize: 100, sort: 'relevance', inStock: false, page: 1 });
  });

  it('normalizes raw components', () => {
    const part = normalizePart({
      componentCode: 'C1',
      componentModelEn: 'MPN',
      componentBrandEn: 'ACME',
      componentSpecificationEn: '0603',
      componentLibraryType: 'expand',
      preferredComponentFlag: true,
      stockCount: 5,
      componentPrices: [
        { startNumber: 100, productPrice: 0.5 },
        { startNumber: 1, productPrice: 1 },
      ],
      describe: 'desc',
      erpComponentName: null,
      firstSortName: 'Chip Resistor',
      secondSortName: 'Resistors',
      dataManualUrl: '',
      minImageAccessIdUrl: null,
      urlSuffix: 'MPN/C1',
      lcscGoodsUrl: null,
      attributes: [
        { attribute_name_en: 'Tolerance', attribute_value_name: '1%' },
        { attribute_name_en: 'Empty', attribute_value_name: '-' },
      ],
    });
    expect(part).toMatchObject({ partClass: 'preferred', category: 'Resistors', subcategory: 'Chip Resistor', datasheet: null, url: 'https://jlcpcb.com/partdetail/MPN/C1' });
    expect(part.prices).toEqual([
      { qty: 1, price: 1 },
      { qty: 100, price: 0.5 },
    ]);
    expect(part.attributes).toEqual([{ name: 'Tolerance', value: '1%' }]);
    expect(priceAt(part.prices, 150)).toBe(0.5);
    expect(priceAt(part.prices, 10)).toBe(1);
  });
});

describe('EasyEDA document decryption', () => {
  it('decrypts AES-256-GCM (ciphertext || tag) and gunzips', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plain = '["DOCTYPE","SYMBOL","1.1"]';
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const blob = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final(), cipher.getAuthTag()]);
    expect(decryptDataStr(blob, key.toString('hex'), iv.toString('hex'))).toBe(plain);
  });
});

describe('BOM', () => {
  const parts = [
    comp('1', 'res', 'R2', 0, 0, { lcsc: 'C25804', partClass: 'basic', value: '10k', stock: 100, prices: [{ qty: 1, price: 0.01 }], attrs: { Footprint: 'R0603' } }),
    comp('2', 'res', 'R1', 0, 0, { lcsc: 'C25804', partClass: 'basic', value: '10k', stock: 100, prices: [{ qty: 1, price: 0.01 }], attrs: { Footprint: 'R0603' } }),
    comp('3', 'ldo', 'U1', 0, 0, { lcsc: 'C8287', partClass: 'extended', value: 'STM32', stock: 1, prices: [{ qty: 1, price: 5 }], attrs: { Footprint: 'LQFP-144' } }),
    comp('4', 'res', 'J1', 0, 0, { value: 'Header', attrs: {} }),
  ];

  it('groups by part, counts types and estimates setup fees', () => {
    const bom = buildBom(parts, 2);
    expect(bom.uniqueParts).toBe(3);
    expect(bom.byClass).toEqual({ basic: 1, preferred: 0, extended: 1, unassigned: 1 });
    expect(bom.setupFee).toBe(3);
    expect(bom.lines.find((l) => l.lcsc === 'C25804')?.designators).toEqual(['R1', 'R2']);
    expect(bom.lowStock.map((l) => l.lcsc)).toEqual(['C8287']);
    expect(bom.partsCost).toBeCloseTo(0.01 * 4 + 5 * 2);
  });

  it('exports the JLCPCB CSV layout', () => {
    const csv = bomToJlcpcbCsv(buildBom(parts));
    expect(csv.split('\n')[0]).toBe('Comment,Designator,Footprint,LCSC Part #,Quantity,JLCPCB Part Type');
    expect(csv).toContain('10k,"R1,R2",R0603,C25804,2,basic');
  });
});
