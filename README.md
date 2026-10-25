# Schematics

A web-based schematic and PCB editor modelled on EasyEDA Pro. Its focus is quick JLCPCB part
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
  - Part type filters with live in-stock counts (Basic, Preferred, Extended), a "No setup fee" preset, and an in-stock toggle.
  - Sort by relevance, stock, price or part number.
  - Category tree and package filters. A chip size typed in the query ("10uF 0805") becomes an exact package filter.
  - Detail pane: symbol, footprint and photo previews, price breaks, parameters, datasheet link.
  - Placing: double-click or Enter. "Replace" swaps the part on a selected component.
- **Quick passives** — tools for resistor, capacitor, inductor, ferrite bead, diode and LED
  (`⇧R` `⇧C` `⇧L` `⇧F` `⇧D` `⇧E`).
  - Type a value as you would write it ("4k7", "100R", "0.1u", "10u 16V", "22uH") and pick a size (0402…1206, SOD-123, SMA…).
  - The cheapest-to-assemble in-stock part is matched automatically: Basic first, then Preferred, then Extended, by stock. You can pick an alternative instead.
  - Set it in the placement bar before placing. Afterwards, double-click a passive (or press Enter) for a quick-edit popover.
  - The inspector edits several selected passives of the same kind at once.
- **Schematic editor**
  - Places real EasyEDA library symbols, including multi-unit parts.
  - Drawing tools: wires, net labels, power and ground flags, no-connect markers.
  - Move with rubber-banding wires, rotate, mirror, duplicate, copy/paste, undo/redo.
  - Box select, zoom and pan, junction dots, pin hover info, net highlighting.
- **PCB editor** (Schematic / PCB switch in the top bar)
  - **Sync from the schematic.** Loads each part's JLCPCB footprint, or a built-in IPC footprint for unmatched passives. On the first sync it sizes the board and packs parts in schematic order.
  - **Parts.** Drag to move, `R` rotates, `X` flips a part to the bottom side, which mirrors it and moves its pads and silkscreen to the bottom layers.
  - **Interactive routing** (`W`) with 45° corners on the top or bottom layer (`1` / `2`). Press `V` to drop a via and continue on the other layer. Power nets get wider tracks automatically.
  - **Ratsnest** and an unrouted count per net. Per-net or whole-board auto-routing uses a two-layer A* grid router that keeps clearance, never places vias in SMD pads and keeps other nets out from under metal connector shells where it can. Supply nets get wide tracks, and any net can be routed at a chosen width; wide tracks neck down to the pad width only where they enter fine-pitch pins.
  - **Copper pours** (e.g. a GND fill on both layers). Each pour keeps its clearance to other nets, holes and the board edge. Same-net pads join through thermal reliefs (or solidly), slivers below a minimum width are removed, and islands with no same-net copper are dropped. Pours count as connections in the ratsnest and refill live as you edit.
  - **DRC**: copper clearance, shorts, unrouted nets, edge clearance, vias in pads, overlapping parts, missing footprints, pads with fewer than two thermal spokes, pours on nets with no pads, tracks or vias of other nets under a metal connector shell (USB, RJ45…).
  - **Export for JLCPCB.** Gerber RS-274X (copper with pours, mask, paste, silkscreen with vector text, outline) and an Excellon drill file (including slots) come zipped. The pick-and-place CPL and BOM are CSV files.
- **Design data**
  - Live netlist and a design check: unconnected pins, duplicate or unannotated designators, conflicting net names.
  - BOM grouped by part, with counts per part type and the extended setup fee.
  - "Find no-fee alternative" for extended parts, and stock refresh.
  - JLCPCB BOM CSV export.
- **Files** — autosave in the browser, plus save/open project JSON, export SVG and netlist. In
  dev mode, designs in `designs/` open with `/?open=<file>.json`, save back to the same file, and reload by themselves when the file changes on disk.

Schematic keys: `W` wire · `N` label · `P`/`G` power/ground · `Q` no-connect · `R` rotate ·
`X` mirror · `Del` delete · `F` fit · `L` toggle library · `⌘Z`/`⌘⇧Z` undo/redo · `⌘D` duplicate.
PCB keys: `W` route · `V` via · `1`/`2` layer · `R` rotate · `X` flip side · `⌫` remove last
corner / delete · `Esc` finish. Space-drag or middle-drag pans, the wheel zooms.

## WebMCP

On load the app registers 33 tools. It uses `document.modelContext` (current spec) when present,
otherwise `navigator.modelContext` (older Chrome builds such as 147, MCP-B polyfill):

- **Parts:** `search_parts`, `get_part_details`, `place_part`, `place_passive`, `set_passive`, `replace_part`
- **Schematic:**
  - `list_components`, `connect_pins` (obstacle-avoiding router), `add_net_label`, `add_power_flag`, `mark_no_connect`, `disconnect_pin`
  - `update_component`, `delete_components`, `annotate`, `focus_components`, `check_pin`, `new_schematic`
- **Checks:** `get_netlist`, `check_design`, `get_bom` (JSON or JLCPCB CSV)
- **PCB:** `pcb_update`, `pcb_get_state`, `pcb_set_board`, `pcb_move_part`, `pcb_autoroute` (optionally at a given width), `pcb_add_vias` (thermal and stitching vias), `pcb_clear_routing`, `pcb_add_pour`, `pcb_remove_pours`, `pcb_check`, `pcb_render` (board picture with mm rulers), `pcb_export`

Pins are addressed as `R1.2` or `U1.VIN`. Wires, labels and flags that the tools add never touch
other wiring, and `update_component` refuses a move whose dragged wires would join two nets, so an
agent cannot short nets by accident; when there is no room, the tool says so. Inputs are checked
against each tool's schema, and a misspelt or missing field fails with the list of valid ones.
Read-only tools carry `readOnlyHint`. Destructive tools carry `consequentialHint`, and
`new_schematic` also asks the user to confirm. Errors come back as `{error}` results, so the agent
sees the reason. The **Agent** tab lists the tools, lets you run any of them by hand, and logs
every call an agent makes.

To try it in Chrome, enable `chrome://flags/#enable-webmcp-testing`, or start Chrome with
`--enable-features=WebMCP,WebMCPTesting`.

## Claude Code skills and the `schem` CLI

The same tools also run headless, so Claude Code or a script can build designs without a browser:

```bash
pnpm -s schem designs/blinky.schematic.json tools               # list tools; `tools <name>` shows one schema
pnpm -s schem designs/blinky.schematic.json place_passive '{"kind":"resistor","value":"1k","size":"0603"}'
pnpm -s schem designs/blinky.schematic.json batch steps.json    # [{"tool": "...", "input": {...}}, ...]
pnpm -s schem designs/blinky.schematic.json summary             # parts, nets, checks, BOM, PCB and DRC
pnpm -s schem designs/blinky.schematic.json export              # Gerbers, drill, BOM, CPL → designs/blinky-fab/
pnpm -s schem designs/blinky.schematic.json pcb_render '{}'     # PNG of the board → designs/blinky-renders/
```

Each run loads the project file (creating it if needed), runs the tool or batch, prints JSON and
saves the file. Errors print `{"error": "..."}` and exit with status 1. A batch stops at the
first failing step unless you pass `--keep-going`.

Two Claude Code skills in [.claude/skills](.claude/skills) drive the CLI:

- **schematic-design** turns a plain-language description into a checked schematic with in-stock
  JLCPCB parts, Basic first. It includes recipes for regulators, USB-C power, LEDs, I2C,
  crystals and MCU minimum systems.
- **pcb-layout** loads footprints, sizes the board, places parts, adds GND pours, routes, runs DRC
  and writes the fabrication files.

They load automatically when Claude Code runs in this repository. Ask for something like "design
a USB-C board with a 3.3 V LDO and a status LED", then "make the PCB". To use them from any
directory, link them into your personal skills (they still build designs in this repository):

```bash
ln -s "$PWD/.claude/skills/schematic-design" "$PWD/.claude/skills/pcb-layout" ~/.claude/skills/
```

To open a design in the app, run `pnpm dev` and visit `/?open=<file>.json` (add `&mode=pcb` for
the board). In dev mode, ⌘S then writes your edits back to `designs/<file>.json`, and the page
reloads the design by itself whenever the file changes (unless it has unsaved edits of its own),
so you and Claude can take turns on the same design.

## Architecture

```
server/            Hono API (runs inside Vite in dev, standalone in prod)
  jlcpcb.ts        JLCPCB parts search, facets, type filters, 429 retry + concurrency limit
  easyeda.ts       EasyEDA device lookup, AES-GCM document decryption, bulk stock
  match.ts         passive value -> best JLCPCB part
  api.ts           /api/parts/search | facets | match | :code | stock
  designs.ts       dev-only read/write of designs/*.json for the ?open= round trip
scripts/schem.ts   headless CLI running the WebMCP tools on a project file
.claude/skills/    schematic-design and pcb-layout skills for Claude Code
src/
  shared/          types and passive value parsing shared by server and client
  lib/easyeda/     symbol and footprint parsers for EasyEDA Pro documents
  lib/schematic/   geometry, connectivity/netlist, ops (move/rotate…), router, BOM, hit-testing
  lib/pcb/         footprints (mm), board model + connectivity, copper pours (Clipper), DRC, A* router, Gerber/drill/CPL
  lib/actions.ts   schematic actions used by both the UI and the WebMCP tools
  lib/passives.ts  generic passive placement and matching
  lib/webmcp.ts    tool definitions and registration
  store/           zustand editor store with history and autosave
  components/      schematic canvas, PCB canvas, library panel, side panels, chrome
```

## Limitations

- **Missing PCB features.** Pours always cover the whole board; there's no tool yet to draw a custom zone outline (the data model supports one). No keepouts, no differential pairs or length tuning, no 3D view. There is also no multi-sheet schematic hierarchy and no simulation.
- **Auto-router.** It is a simple grid router meant for small boards. Expect to clean up dense layouts by hand.
- **Gerber output.** Covered by unit tests and a structural check. Look at it in JLCPCB's Gerber viewer before ordering.
- **CPL rotations.** These are the design's own rotations. JLCPCB sometimes needs per-part rotation fixes, which you confirm in their placement preview.
- **Unofficial APIs.** The JLCPCB and EasyEDA endpoints are undocumented. They can change, rate-limit or block without notice.
- **Library licence.** Symbols and footprints come from the JLCEDA/EasyEDA Official Library. Its embedded notice grants commercial use when the data is used in JLCEDA/EasyEDA, so check the terms before using this tool commercially. The app credits the library wherever that data is shown.
