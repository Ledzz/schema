# Schematics

A web-based schematic editor modelled on EasyEDA Pro. Its focus is quick JLCPCB part
selection: every search result shows whether a part is **Basic**, **Preferred** (promotional
extended, no setup fee) or **Extended** ($3 setup fee per unique part), and you can filter on
that. The editor also exposes its tools to in-browser AI agents through **WebMCP**.

How EasyEDA Pro and the JLCPCB parts API work, and how that was worked out, is in
[docs/reverse-engineering.md](docs/reverse-engineering.md).

## Run

```bash
pnpm install
pnpm dev          # http://localhost:5173 — UI and API proxy in one Vite server
```

Production:

```bash
pnpm build && pnpm start   # serves dist/ and the API on http://localhost:8787 (PORT to change)
```

Checks: `pnpm typecheck`, `pnpm test`.

## Features

- **Parts library** (bottom panel, `/` to focus) — searches 7M+ JLCPCB/LCSC parts.
  - Part type filters with live counts (Basic, Preferred, Extended), a "No setup fee" preset, and an in-stock toggle.
  - Sort by relevance, stock, price or part number.
  - Category tree and package filters. A chip size typed in the query ("10uF 0805") becomes an exact package filter.
  - Detail pane: symbol, footprint and photo previews, price breaks, parameters, datasheet link.
  - Placing: double-click or Enter. "Replace" swaps the part on a selected component.
- **Schematic editor**
  - Places real EasyEDA library symbols, including multi-unit parts.
  - Drawing tools: wires, net labels, power and ground flags, no-connect markers.
  - Move with rubber-banding wires, rotate, mirror, duplicate, copy/paste, undo/redo.
  - Box select, zoom and pan, junction dots, pin hover info, net highlighting.
- **Design data**
  - Live netlist and a design check: unconnected pins, duplicate or unannotated designators, conflicting net names.
  - BOM grouped by part, with counts per part type and the extended setup fee.
  - "Find no-fee alternative" for extended parts, and stock refresh.
  - JLCPCB BOM CSV export.
- **Files** — autosave in the browser, plus save/open project JSON, export SVG and netlist.

Keys: `W` wire · `N` label · `P`/`G` power/ground · `Q` no-connect · `R` rotate · `X` mirror ·
`Del` delete · `F` fit · `L` toggle library · `⌘Z`/`⌘⇧Z` undo/redo · `⌘D` duplicate ·
Space-drag or middle-drag pans, the wheel zooms.

## WebMCP

On load the app registers 18 tools. It uses `document.modelContext` (current spec) when present,
otherwise `navigator.modelContext` (older Chrome builds such as 147, MCP-B polyfill):

`search_parts`, `get_part_details`, `place_part`, `list_components`, `connect_pins`
(obstacle-avoiding router), `add_net_label`, `add_power_flag`, `mark_no_connect`,
`update_component`, `replace_part`, `delete_components`, `get_netlist`, `check_design`,
`get_bom` (JSON or JLCPCB CSV), `annotate`, `focus_components`, `check_pin`, `new_schematic`.

Pins are addressed as `R1.2` or `U1.VIN`. Read-only tools carry `readOnlyHint`. Destructive tools
carry `consequentialHint`, and `new_schematic` also asks the user to confirm. Errors come back as
`{error}` results, so the agent sees the reason (for example the list of valid pins). The
**Agent** tab lists the tools, lets you run any of them by hand, and logs every call an agent makes.

To try it in Chrome, enable `chrome://flags/#enable-webmcp-testing`, or start Chrome with
`--enable-features=WebMCP,WebMCPTesting`.

## Architecture

```
server/            Hono API (runs inside Vite in dev, standalone in prod)
  jlcpcb.ts        JLCPCB parts search, facets, type filters, 429 retry + concurrency limit
  easyeda.ts       EasyEDA device lookup, AES-GCM document decryption, bulk stock
  api.ts           /api/parts/search | facets | :code | stock
src/
  shared/parts.ts  types shared by server and client
  lib/easyeda/     symbol and footprint parsers for EasyEDA Pro documents
  lib/schematic/   geometry, connectivity/netlist, ops (move/rotate…), router, BOM, hit-testing
  lib/actions.ts   high-level actions used by both the UI and the WebMCP tools
  lib/webmcp.ts    tool definitions and registration
  store/           zustand editor store with history and autosave
  components/      canvas (SVG), library panel, side panels, chrome
```

## Limitations

- Schematic capture only. There is no PCB layout, simulation, or multi-sheet hierarchy.
- The JLCPCB and EasyEDA endpoints are unofficial and undocumented. They can change, rate-limit
  or block without notice.
- Symbols and footprints come from the JLCEDA/EasyEDA Official Library. Its embedded notice
  grants commercial use when the data is used in JLCEDA/EasyEDA, so check the terms before using
  this tool commercially. The app credits the library wherever that data is shown.
