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
  - **Wiring.** Drag from a pin end (or click it) to draw a wire without switching tools. Ending on another pin routes the wire around parts; otherwise it bends at right angles, leaving a pin along the pin and turning at each corner. `/` flips the next bend and Backspace takes off the last corner.
  - **Labels and flags.** Name them in the placement bar before placing (`Tab` jumps to the name); power and ground flags suggest the project's own rails and the common ones. Dropped on a pin, a label or flag gets a short stub leading away from the part, placed clear of other wiring. Wiring or labelling a pin removes its no-connect marker.
  - **Wire editing.** Drag a wire's segment sideways (its neighbours stretch) or its corner anywhere; an end that sits on a pin, label or other wire keeps its place with a jog, and labels and branching wires on the moved stretch come along. Dragging a wire's end moves it to another pin or wire. Moving a selection keeps the wires that lead to parts left behind connected.
  - Move with rubber-banding wires (labels and flags drag their wires too), rotate, mirror, duplicate, copy/paste, undo/redo. Deleting a part also deletes the wires, labels and flags that only connected to it.
  - **Right-click menu** for what is under the pointer: a pin (draw a wire, label it, power flag, GND, no-connect, disconnect), a part (rotate, mirror, duplicate, replace, no-fee alternative, add decoupling, datasheet), a wire (name the net, delete a segment), a label (rename the net) or empty space (paste here, circuit block).
  - Box select, zoom and pan, junction dots, pin hover info, net highlighting (double-click a wire or label).
  - **Find** (`⌘F`, schematic and PCB): parts by designator, value, part number or LCSC number and nets by name; Enter jumps to the part or highlights the net.
  - **Align and distribute** selected parts and labels (inspector or Edit menu), on the wiring grid, with wires following.
  - **Net names.** Renaming a label or flag renames every label and flag of that net, so it stays one net (or only that one, if you say so); a warning shows when the new name joins another net. A wire on an unnamed net can be named from its inspector, which adds a label on one of its pins.
  - **Circuit blocks** (`B`, Place menu or toolbar): proven sub-circuits inserted with their parts, wiring, labels and flags in one undo step — 3.3 V regulator (AMS1117), USB-C 5 V power input, indicator LED, I2C pull-ups, push button, reset/enable RC, crystal with load capacitors, 555 astable timer, SWD header and voltage divider. Rails, net names and values are set before inserting; passives are matched to the cheapest JLCPCB part as usual. Your own blocks: select parts and choose **Save as block** (Edit menu or right-click); they appear under My blocks with their net names renameable on insert, and can be exported to a file and imported elsewhere.
  - **Add decoupling** (inspector of a selected IC): 100 nF per supply pin, 1 µF + 10 nF on analog supplies (VDDA, AVCC) and a 10 µF bulk capacitor per rail, in a row under the part with rail and GND flags. Capacitors on rails above 5 V get a voltage rating; supply pins not yet on a rail get connected to the one you choose.
- **PCB editor** (Schematic / PCB switch in the top bar)
  - **Sync from the schematic.** Loads each part's JLCPCB footprint, or a built-in IPC footprint for unmatched passives. On the first sync it sizes the board and packs parts in schematic order.
  - **Parts.** Drag to move, `R` rotates, `X` flips a part to the bottom side, which mirrors it and moves its pads and silkscreen to the bottom layers.
  - **2 or 4 copper layers** (Board panel or `pcb_set_board`). A 4-layer board adds Inner 1 and Inner 2: a whole-board pour on an inner layer makes it a plane, which auto-routing leaves alone and joins each surface-mount pad of that net to through a short stub and via. Gerbers gain `In1_Cu`/`In2_Cu` layers, and the JLCPCB checklist switches to the multilayer limits.
  - **Interactive routing** (`W`) with 45° corners on any copper layer (`1` top, `2` bottom, `⇧1`/`⇧2` inner layers). Press `V` to drop a via and continue on the other outer layer, or a layer key to jump to that one. Power nets get wider tracks automatically.
  - **Push-and-shove.** Three routing modes, switched with `M` or the chip in the status bar: **Push** (default) moves other nets' tracks and vias out of the way of the route being drawn, recursively, keeping track ends in place with 45° jogs and carrying the tracks that end on a pushed via along; it refuses (in red) where the copper would hit a pad, a via in a pad or the board edge, or a pushed via would crowd another hole or enter a keepout. **Walk around** lets the router find a path to the cursor around obstacles; **Ignore** lets copper overlap for the design check to report. In select mode, dragging a track moves the segment under the pointer sideways while its neighbours keep their 45°/90° angles (a short stub into a pad becomes a 45° jog), dragging an inner corner moves it with 45° bends on both sides, and Alt-dragging moves the whole track while its ends stay on their pads; all of them push (or, in walk-around mode, stop at) other copper, and each route or drag is one undo step.
  - **Ratsnest** and an unrouted count per net. Per-net or whole-board auto-routing uses an A* grid router over the board's layers (planes excluded) that keeps clearance, never places vias in SMD pads, keeps JLCPCB's hole spacing from every drilled hole (and switches layers on an existing via of the net rather than stacking a new one) and keeps other nets out from under metal connector shells where it can. Supply nets get wide tracks, and any net can be routed at a chosen width; wide tracks neck down to the pad width only where they enter fine-pitch pins.
  - **Board shape and mechanics.** Draw a custom outline (an L, a notch, a chamfer; corners are rounded by the corner radius), milled cutouts, non-plated mounting holes with a copper-free ring (one click puts M3 holes in all four corners), and keepout areas that keep tracks, vias, pours or parts out on one or both layers. Drag a rectangle or click the corners of a polygon; holes, keepouts, cutouts and zones move by dragging and delete with `Del`. The router, pours, DRC, Gerbers and the 3D view all follow the real shape.
  - **Silkscreen.** Text on either side (lowercase, several lines, ° µ Ω and common punctuation, in the same stroke font the Gerbers use), logos traced from a PNG, JPEG or SVG image, and designators that can be dragged, rotated, resized or hidden; a designator keeps its place relative to its part when the part moves or turns.
  - **Copper pours** (e.g. a GND fill on both layers), whole-board or as a drawn zone; a zone takes priority over whole-board pours of other nets. Each pour keeps its clearance to other nets, holes and the board edge. Same-net pads join through thermal reliefs (or solidly), slivers below a minimum width are removed, and islands with no same-net copper are dropped. Pours count as connections in the ratsnest and refill live as you edit.
  - **DRC**: copper clearance, shorts, unrouted nets, clearance to the outline, cutouts and hole walls, copper or parts in keepouts and hole rings, silkscreen (text, logos, designators) on pads or off the board, vias in pads, overlapping parts, missing footprints, pads with fewer than two thermal spokes, pours on nets with no pads, tracks or vias of other nets under a metal connector shell (USB, RJ45…).
  - **Export for JLCPCB.** Gerber RS-274X (copper with pours, mask, paste, silkscreen with designators, text and logos, outline and cutouts) and Excellon drill files (plated with slots, and a separate non-plated file for mounting holes) come zipped. The pick-and-place CPL and BOM are CSV files; through-hole parts can be left out of them to solder by hand.
  - **3D view** (`3`, or the cube in the PCB tool rail). The board is extruded 1.6 mm with its drill holes and textured with the finished faces (mask, HASL pads, silkscreen); parts use the 3D models EasyEDA assigns to them, placed by EasyEDA's model transform, and parts without one show as blocks. Orbit, pan and zoom, with top, bottom and angled views. three.js loads only when the view opens.
  - **STEP export** (File menu, the STEP button in the 3D view, or `pcb_export_step`). One AP214 file for enclosure design in FreeCAD, Fusion, SolidWorks and the like: the board as a solid with its outline, round drill and mounting holes as true cylinders, slots and cutouts, plus each part's STEP model from EasyEDA, included once per model and placed like in the 3D view (parts without a model become blocks). The STM32 board comes to about 24 MB.
  - **JLCPCB checklist** (JLCPCB tab in the PCB panel). The board measured against JLCPCB's published limits for standard 2- and 4-layer boards and assembly: board size, track width, copper spacing and edge clearance on the actual copper, design rules, via and drill sizes (including which vias cost extra), annular rings, hole spacing, non-plated holes and cutouts, silkscreen line width, text height and placement, and for assembly library parts, board size, sides, package sizes, pin pitch, extended parts, stock and through-hole parts. Each item shows the value, the limit and pass / warning / fail; clicking one shows the spot on the board.
  - **Order from JLCPCB** (PCB panel or File menu). The sheet runs the checklist (failures block the order), shows the board size, the parts JLCPCB would assemble, their Basic/Extended split, setup fee and estimated cost for the chosen quantity. One click downloads the files and opens JLCPCB's quote page, and the sheet lists the settings to pick there. JLCPCB has no public ordering API, so dropping the files on their page and checking out stay manual.
- **Design data**
  - Live netlist and a design check: unconnected pins, duplicate or unannotated designators, conflicting net names.
  - BOM grouped by part, with counts per part type and the extended setup fee.
  - "Find no-fee alternative" for extended parts, and stock refresh.
  - JLCPCB BOM CSV export.
- **Files** — autosave in the browser, plus save/open project JSON, export SVG and netlist. In
  dev mode, designs in `designs/` open with `/?open=<file>.json`, save back to the same file, and reload by themselves when the file changes on disk.

Schematic keys: `W` wire · `N` label · `P`/`G` power/ground · `Q` no-connect · `R` rotate ·
`X` mirror · `Del` delete · `F` fit · `L` toggle library · `⌘Z`/`⌘⇧Z` undo/redo · `⌘D` duplicate.
PCB keys: `W` route · `V` via · `M` routing mode (push / walk around / ignore) · `1`/`2` top/bottom layer · `⇧1`/`⇧2` inner layers · `R` rotate · `X` flip side · `⌫` remove last
corner / delete · `Esc` finish. Space-drag or middle-drag pans, the wheel zooms.

## WebMCP

On load the app registers 46 tools. It uses `document.modelContext` (current spec) when present,
otherwise `navigator.modelContext` (older Chrome builds such as 147, MCP-B polyfill):

- **Parts:** `search_parts`, `get_part_details`, `place_part`, `place_passive`, `set_passive`, `replace_part`
- **Schematic:**
  - `list_components`, `connect_pins` (obstacle-avoiding router), `add_net_label`, `add_power_flag`, `mark_no_connect`, `disconnect_pin`
  - `insert_block` (circuit blocks), `add_decoupling`, `rename_net`
  - `update_component`, `delete_components`, `annotate`, `focus_components`, `check_pin`, `new_schematic`
- **Checks:** `get_netlist`, `check_design`, `get_bom` (JSON or JLCPCB CSV)
- **PCB:** `pcb_update`, `pcb_get_state`, `pcb_set_board` (size or custom outline), `pcb_add_mounting_holes`, `pcb_add_keepout`, `pcb_add_cutout`, `pcb_add_text`, `pcb_add_logo`, `pcb_update_silkscreen`, `pcb_set_designator`, `pcb_remove_features`, `pcb_move_part`, `pcb_autoroute` (optionally at a given width), `pcb_add_vias` (thermal and stitching vias), `pcb_clear_routing`, `pcb_add_pour` (whole board or a zone), `pcb_remove_pours`, `pcb_check`, `pcb_jlcpcb_check` (JLCPCB manufacturing checklist), `pcb_render` (board picture with mm rulers), `pcb_export_step` (assembled board as STEP), `pcb_export` (optionally without through-hole parts in the assembly files)

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
  api.ts           /api/parts/search | facets | match | :code | :code/model | stock
  designs.ts       dev-only read/write of designs/*.json for the ?open= round trip
scripts/schem.ts   headless CLI running the WebMCP tools on a project file
.claude/skills/    schematic-design and pcb-layout skills for Claude Code
src/
  shared/          types and passive value parsing shared by server and client
  lib/easyeda/     symbol and footprint parsers for EasyEDA Pro documents
  lib/schematic/   geometry, connectivity/netlist, ops (move/rotate…), router, BOM, hit-testing
  lib/pcb/         footprints (mm), board model + connectivity, copper pours (Clipper), DRC, A* router, Gerber/drill/CPL,
                   board pictures, 3D models and the three.js viewer, JLCPCB ordering
  lib/actions.ts   schematic actions used by both the UI and the WebMCP tools
  lib/passives.ts  generic passive placement and matching
  lib/webmcp.ts    tool definitions and registration
  store/           zustand editor store with history and autosave
  components/      schematic canvas, PCB canvas, library panel, side panels, chrome
```

## Limitations

- **Missing PCB features.** No more than 4 layers, no blind or buried vias or impedance control; outlines are straight-sided polygons (no arcs or DXF import); no differential pairs or length tuning. There is also no multi-sheet schematic hierarchy and no simulation. See [docs/roadmap.md](docs/roadmap.md).
- **Auto-router.** It is a simple grid router meant for small boards. Expect to clean up dense layouts by hand.
- **Gerber output.** Covered by unit tests and a structural check. Look at it in JLCPCB's Gerber viewer before ordering.
- **CPL rotations.** These are the design's own rotations. JLCPCB sometimes needs per-part rotation fixes, which you confirm in their placement preview.
- **Unofficial APIs.** The JLCPCB and EasyEDA endpoints are undocumented. They can change, rate-limit or block without notice.
- **Library licence.** Symbols and footprints come from the JLCEDA/EasyEDA Official Library. Its embedded notice grants commercial use when the data is used in JLCEDA/EasyEDA, so check the terms before using this tool commercially. The app credits the library wherever that data is shown.
