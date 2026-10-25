# EasyEDA Pro & JLCPCB parts — reverse-engineering notes

Gathered with REA (Reverse Engineer Anything) on 2026-10-24 against EasyEDA Pro **v3.2.209**
(`https://pro.easyeda.com/editor`, not logged in) and the JLCPCB parts site. Each finding is
marked as observed (seen in captured traffic or shipped code), confirmed (also replayed by
hand) or inferred.

## Evidence

| Evidence ID | What |
|---|---|
| `ev_d4e22b66…a122e` | Browser target list: EasyEDA Pro editor page |
| `ev_a387bb39…d6b` | Passive page inspection: scripts, workers, startup XHRs |
| `ev_11eea4da…b6` | Screenshot of the editor start page |
| `ev_df772eed…d6b` | Scenario: editor startup with request/response bodies |
| `ev_4a40c99e…cbb65` | Scenario: open the Library panel, search "10k 0603" |
| `ev_205fe3bb…6f36` | Scenario: JLCPCB parts search page, request bodies |
| `ev_2d2bd067…ce9` | WebMCP discovery on this app (CDP domain not available in Chrome 147) |

## EasyEDA Pro architecture (observed)

- The shell page `pro.easyeda.com/editor` loads versioned modules from `modules.lceda.cn`:
  `pro-mgr` (project/library manager), `pro-ui`, `pro-sch` (schematic), `pro-pcb`, `pro-panel`,
  `smt-gl-engine` (WebGL renderer), `pro-api`, `pro-sw` (service worker loader).
- Heavy work runs in workers served from the editor URL: `?entry=ui-worker.js`,
  `?entry=sch-worker.js`, `?entry=mgr-lib-worker.js`.
- Library documents (symbols, footprints) use a line-oriented format: one JSON array per line,
  e.g. `["PIN","e5",1,null,-90,355,10,0,null,0,0,1]`. Coordinates are y-up; units are 10 mil for
  symbols and mil for footprints.

## Library search pipeline (observed + confirmed)

When you search in EasyEDA's Library panel it issues, in order:

1. `POST /api/devices/search` — `{wd, uid, path, page, pageSize: 50, attributes: {}, tag: []}`
   with `uid`/`path` = `0819f05c4eef4c71ace90d822a990e87` (the "LCSC" system library). Returns
   device records with `attributes["JLCPCB Part Class"]` (`Basic Part` / `Extended Part`),
   `product_code` (LCSC number) and embedded `symbol_info` / `footprint_info`.
2. `POST /api/std/v2/components/search` — legacy EasyEDA Standard library (counts only).
3. `POST /api/components/getSmtPartInfo` — `{numbers: ["C…"], path}` → per part
   `paste_type: "base" | "expand"`, `stock_num`, price list.
4. `POST /api/v2/eda/product/search` — `{codes: "C1,C2,…"}` → LCSC parameter facets.

**Why basic/extended is hard to find in EasyEDA:** the data is there (step 1 and 3) but the
results table only shows it in a narrow, truncated "JLCP…" column, ranked by text relevance, 50
rows per page out of tens of thousands. The `attributes` filter in step 1 is passed to an
Elasticsearch `match` query: `{"JLCPCB Part Class": "Basic Part"}` matches any record containing
"Part", so it cannot be used to filter by class (confirmed by replay).

## Symbol / footprint data (observed + confirmed)

`symbol_info` / `footprint_info` either embed `dataStr` or point to an encrypted blob:
`{dataStrId: "https://image-pro.easyeda.com/datastr/…", key: <64 hex>, iv: <24 hex>}`.
The blob is AES-256-GCM ciphertext followed by the 16-byte tag; the plaintext is gzip.
EasyEDA's `lib-worker.js` decrypts with `crypto.subtle.importKey("raw", key, "AES-GCM")` +
`decrypt({name: "AES-GCM", iv})`. See `server/easyeda.ts` and the unit test.

Every official-library document carries a notice that the data belongs to JLCEDA/EasyEDA, asks
anyone reproducing it to credit "JLCEDA/EasyEDA Official Library" with links to lceda.cn and
easyeda.com, and grants commercial use **when used in JLCEDA/EasyEDA**. This app fetches the data
on demand, keeps it only inside the user's own project file and shows that attribution.

## JLCPCB parts API (observed + confirmed)

Taken from the JLCPCB parts page and replayed:

- `POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2`
  - `componentLibTypes: ["base"]` → basic, `["expand"]` → extended (includes preferred)
  - `preferredComponentFlag: true` → "Promotional Extended" (setup fee waived);
    with `["base"]` it returns the union (351 + 1235 = 1586 parts on 2026-10-24)
  - `stockFlag: true` → stock > 0; `presaleType: "stock"` also matches zero-stock parts
  - `sortMode: STOCK_SORT | PRICE_SORT | MODEL_SORT`, `sortASC: ASC | DESC`
  - `firstSortName` / `secondSortName` → category / subcategory
  - `componentSpecificationList` → exact package; the keyword search treats "0805" as optional,
    so the app moves standalone chip sizes into this filter
- `POST …/v1/componentSearch/filterComponentAttribute` → facets: category tree, packages,
  brands and `basePart` / `preferredPart` / `extendPart` counts. It ignores `stockFlag`; the
  app computes exact in-stock class counts with three count-only searches.
- Requests with a browser `Origin` header get **403**, and bursts get **429**, so the app calls
  the API from its own server with a small concurrency limit and retries.

## WebMCP (observed)

Chrome for Testing 147 with `--enable-features=WebMCP,WebMCPTesting` exposes
`navigator.modelContext` (`registerTool`, `unregisterTool`) and `navigator.modelContextTesting`
(`listTools`, `executeTool`). The current spec draft moves the API to `document.modelContext`
with `registerTool(tool, {signal})`; the app supports both.

## 3D models (observed + confirmed, 2026-10-25)

Found by reading EasyEDA Pro's shipped bundles (`pro-mgr`, `pro-ui`, `smt-gl-engine` 3.2.x from
`modules.lceda.cn`) and replaying the requests by hand.

1. A device's attributes name its model: `3D Model` (document uuid), `3D Model Title` and
   `3D Model Transform`. The footprint record repeats them as `model_3d {uri, title, transform}`.
2. `GET https://pro.easyeda.com/api/v2/components/{uuid}?path=<library owner uuid>` returns the
   model document (`docType` 16). Its `dataStr` is `{"model": <file id>, "type": "wrl",
   "unit": "mm"}`. The device's uuid itself is *not* the file key (the CDN answers NoSuchKey).
3. `https://modules.easyeda.com/3dmodel/{file id}` serves the mesh as OBJ: millimetres, Z up,
   with materials written inline between `newmtl` and `endmtl`. The `d` field is unreliable
   (most models write 0 for opaque, some 1). `…/qAxj6KHrDKw4blvCG8QJPs7Y/{file id}` serves the
   original STEP. The Chinese editor uses `modules.lceda.cn` for the same paths
   (`smt-gl-engine` `Oh()` picks the host per edition).
4. `3D Model Transform` is nine numbers: target size X, Y, Z in mil (Z 0 = keep), rotation in
   degrees (the first is about Z, the board normal), offset X, Y, Z in mil (y up). Confirmed
   against six parts: the model's box, centred on the footprint origin with its bottom on the
   board, then rotated and offset, lands on the pads (e.g. a KF301 terminal's outline matches its
   footprint's to 0.05 mm; a SOT-89 model with leads at -x gets 180°).
5. Not every device's model document exists (an XH connector's returns 404); the app draws a
   block for those.
