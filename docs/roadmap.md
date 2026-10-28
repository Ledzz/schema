# Roadmap

What EasyEDA Pro has that this app doesn't yet, grouped by area. ★ marks the gaps that matter
most for the app's purpose: getting small boards made and assembled at JLCPCB quickly. The
comparison is against EasyEDA Pro 2.x as known in late 2026.

## Next up

The current direction is making boards easy for people without an electronics background, with
the assistant as the entry point; the professional side (buses, net classes, more layers,
importers) follows.

1. **Design review with fixes** — rules of thumb beyond the electrical check: an IC without
   decoupling, I2C without pull-ups, an LED without its resistor, a regulator without its output
   capacitor, USB-C without CC resistors, exposed USB data without ESD protection, no mounting
   holes; each with a one-line why and a button that runs the existing action.
2. **A maker-sized block library** — a few dozen modules (ESP32-C3, RP2040, TP4056 charging,
   buck converters, WS2812, common sensors, motor drivers, relays, OLED headers) with their
   support circuits, and quick add treating "esp32" as a module.
3. **One-click board** — a pipeline from schematic to checked Gerbers with placement that puts
   connectors at edges, decoupling at its pins and parts grouped by block.
4. **Starters** — complete, checked, routed example projects to modify, offered on the start
   screen (which exists now, with recent projects and "describe what to build").
5. **Running cost** in the status bar as parts are added.
6. **Height and clearance checks against an enclosure** — import the enclosure's STEP and flag
   parts that collide with it.

## Done

- **A responsive editor on big boards and sheets** (2026-10-28): routing, DRC and the board
  picture run in a Web Worker, so the page keeps drawing while the assistant lays out a board
  (routing used to freeze it for up to 20 s a pass); one board model and one netlist analysis
  per edit are shared by every panel; the schematic canvas re-renders only what changed.
- **Groups** (2026-10-27): named, coloured frames around the parts that belong together
  (`⌘G` on a selection, `⇧G` to drag one), moved as one, resized by their corners, renamed on
  the canvas; a group is a region, so deleting the frame leaves the parts. Circuit blocks arrive
  framed. Agents use `add_group`, `list_groups`, `update_group`, `remove_group`, and
  `list_components` says which group each part is in.
- **Project library, start screen and files** (2026-10-27): every project is autosaved in the
  browser's database and listed on the start screen with a sketch; Save and Open write and read
  real files (File System Access API in Chrome and Edge, downloads elsewhere), a dropped `.json`
  opens, and the title shows unsaved changes against the linked file.
- **Saved assistant chats** (2026-10-27): every chat is saved under its project as it goes, comes
  back after a reload or a switch to another project and back, and earlier chats of a project
  can be reopened or deleted from the panel.
- **In-app assistant** (2026-10-27): an Assistant tab that drives the editor's tools from a chat,
  streaming its replies, thinking summaries and every tool call with its result (board pictures
  inline); its system prompt is the two Claude Code skills and the recipes. The server route
  calls Claude or Gemini (translated on the server, models listed live) with the server's key or
  one the user enters; provider, model, effort, token count and cost are in the panel.

- **Differential pairs and length tuning** (2026-10-27): pairs found by net name and routed side
  by side on one layer (straight out of the pads, coupled at the gap, crossing-free pad choice on
  connectors with repeated pins), DRC allowing the pair gap and warning about skew measured over
  the pair's own tracks, an impedance estimate on JLCPCB's stack-ups, net lengths, and meanders
  that lengthen a net to a target or match a pair.
- **Quick add** (2026-10-27): `A` opens a box at the cursor that places a passive by value, a
  rail, ground, net label or no-connect (on the pin under the cursor when there is one), another
  copy of a part in the design, a custom part, a circuit block or a JLCPCB part by keyword.
- **Cross-probing** (2026-10-27): part selection and the highlighted net are shared by the
  schematic and the PCB; ⇧X (or the right-click menu and PCB inspector) shows them in the other
  editor, and the two can be shown side by side, each keeping what the other selects in view.
- **Symbol, footprint and part editors** (2026-10-26): symbols from a pin list or drawn on the
  grid, footprints from IPC-7351 land patterns for common packages or pad by pad, and parts that
  pair them with their fields, all saved in the project. Library parts' symbols and footprints can
  be edited as copies; redrawn symbols keep their wires. Agents use `create_symbol`,
  `create_footprint`, `create_part`, `place_custom_part` and `set_footprint`.
- **Multiple sheets and hierarchical blocks** (2026-10-26): sheet tabs (add, rename, delete),
  labels and power flags joining nets across sheets, hierarchical ports, and blocks standing for
  a sheet with a pin per port that keep their places as ports change. Agents use `list_sheets`,
  `add_sheet`, `switch_sheet`, `place_block`, and address block pins as `Power.VIN`.
- **Rip-up and retry in the auto-router** (2026-10-26): connections the greedy pass leaves are
  routed through other nets' copper at a cost, what is in the way is ripped up and routed again,
  and a change is kept only when fewer connections are left; the STM32 board routes completely
  from scratch on 2 and 4 layers.
- **Curved outlines and DXF import** (2026-10-26): outline edges can be arcs (bent by a handle in
  the editor, or `outline_bulges` for agents), and an enclosure's DXF drawing gives the outline
  with exact arcs, cutouts and mounting holes (`pcb_import_dxf`).
- **Copper and silkscreen in the STEP export** (2026-10-26): the outer copper and silkscreen as
  thin coloured solids, a part per piece grouped by layer, read back with OpenCascade.
- **Track corners, whole tracks and via pushing** (2026-10-26): corners drag with 45° bends,
  Alt-drag moves a whole track with its ends kept on their pads, and Push moves other nets' vias
  (with the tracks ending on them) as well as tracks. Moving copper is refused near other nets'
  pads, and a router stub into a pad no longer stops a segment drag.
- **Circuit blocks and automatic decoupling** (2026-10-26): ten sub-circuits from the
  schematic-design recipes (regulator, USB-C power, LED, I2C pull-ups, button, reset RC,
  crystal, 555 timer, SWD header, divider) inserted with parts and wiring in one undo step, and
  decoupling capacitors for a selected IC's supply pins; both also as agent tools.
- **Easier schematic wiring and labelling** (2026-10-26): wires start by dragging from a pin
  and route around parts from pin to pin, with automatic bends, `/` to flip one and Backspace to
  take off a corner; labels and flags are named before placing (with the project's rails as
  suggestions) and get a stub pointing away from the part when dropped on a pin; deleting a
  part takes the wiring that only served it.
- **STEP export of the assembled board** (2026-10-26): one AP214 file with the board solid
  (outline, cylindrical drill and mounting holes, slots, cutouts) and EasyEDA's STEP model of
  every part, each model included once and placed as in the 3D view; from the File menu, the 3D
  view, an agent tool and the command line. Checked by reading it with OpenCascade.
- **Push-and-shove routing and track dragging** (2026-10-26): Push, Walk around and Ignore
  routing modes (`M`); routes and dragged segments push other nets' tracks aside recursively,
  keeping their ends with 45° jogs and stopping at pads, vias and the edge; walk-around routes
  find a path to the cursor; segments drag sideways with their corners sliding along their
  neighbours. Vias aren't pushed yet, and agents still route with the auto-router.
- **4-layer boards** (2026-10-26): Inner 1 and Inner 2 copper layers with tracks, vias through all
  layers, pours and inner planes. Auto-routing keeps off the planes and joins each SMD pad of a
  plane net to its plane with a short stub and via; Gerbers gain inner layers; the JLCPCB checklist
  uses the multilayer limits and checks inner copper against drill holes.
- **JLCPCB checklist** (2026-10-26): the board measured against JLCPCB's published PCB and
  assembly limits, in the PCB panel, the order sheet (failures block the order) and as an agent
  tool. Silkscreen defaults now meet JLCPCB's 1 mm text and 0.15 mm line minimums.
- **Silkscreen text and logos, movable designators** (2026-10-26): text on either side with a
  fuller stroke font (lowercase, symbols, several lines, proportional spacing), logos traced from
  PNG/JPEG/SVG images, and designators that can be moved, rotated, resized or hidden. Gerbers,
  board pictures, the 3D view and DRC (silkscreen on pads or off the board) include them; agents
  have `pcb_add_text`, `pcb_add_logo`, `pcb_update_silkscreen` and `pcb_set_designator`.
- **Custom board outlines, mounting holes, keepouts and pour zones** (2026-10-25): polygon
  outlines with rounded corners, milled cutouts, NPTH mounting holes with a copper-free ring,
  keepouts for tracks, vias, pours or parts per layer, and drawn pour zones that take priority
  over whole-board pours. Drawn in the editor or placed by agent tools; the router, pours, DRC,
  Gerbers (Edge_Cuts, NPTH drill, mask openings) and 3D view follow them.
- **3D board view** (2026-10-25): EasyEDA's part models on a textured board with real drill
  holes; parts without a model show as blocks.

## Schematic

- Buses and bus entries.
- Drawing tools: text, lines, rectangles, images, sheet frame and title block.
- Find and replace, select similar, a property table for bulk edits (bulk editing exists only
  for passives).
- Net classes and differential-pair marking.
- Stricter design check: pin-type conflicts such as two outputs on one net.
- Shared team block libraries (your own blocks are saved per browser, with export/import).
- PDF and print export (SVG only today).

## Libraries

- Personal and team libraries (parts made in the editor are saved per project); importing
  libraries from KiCad or Altium.
- Multi-unit symbols in the symbol editor (it edits the units a library symbol has but cannot add
  any), BGA and other packages the footprint generator doesn't know.
- Choosing or editing a footprint's 3D model (EasyEDA's assignment is used as is).

## PCB: board and placement

- DXF export of the outline, and true arcs (rather than fine polylines) in the Gerber outline and
  the STEP board.
- 6+ layers, a layer stack manager, JLC's impedance calculator, blind and buried vias (2 and 4
  layers with through vias today).
- Align and distribute, part locking, rooms, measure tool, dimension lines, grid setting.
- Multi-colour or greyscale artwork (logos are traced to one colour), TrueType fonts.
- Test points, fiducials, tooling holes, panelization (V-cuts, tabs).

## PCB: routing

- Glossing (tidying routed tracks), pushing pads' parts, dragging vias with their tracks.
- Curved tracks, teardrops, BGA fanout; interactive (push-and-shove) routing of a pair, pairs
  changing layer, and length-matching groups beyond pairs.
- Smarter routing still: negotiated congestion for whole boards, BGA fanout.

## PCB: copper, rules, checks

- Zone priorities beyond "zones before whole-board pours", and cutouts inside a single zone.
- Per-net and net-class rules, rule areas.
- Per-pad thermal settings; stitching-via arrays in the UI (an agent tool only today).
- More DRC: silkscreen over mask openings rather than pads, drill-to-copper, courtyard overlap
  (approximated with bounding boxes today), solder mask slivers. (JLCPCB's limits are checked by
  the JLCPCB checklist.)

## Outputs and ordering

- ODB++, IPC-356, DXF, PDF fabrication and assembly drawings, export to Altium or
  KiCad.
- Fully one-click ordering (EasyEDA uses JLC's internal upload service; ours is the guided
  order sheet).
- Stencil ordering, parts pre-ordering and reservation, 3D-printed or CNC enclosures.

## 3D and mechanical

- Height and clearance checks, enclosure design (the 3D view and STEP export are done); solder
  mask and inner layers in the STEP file.

## Simulation

- SPICE simulation.

## Projects and platform

- Cloud projects: sharing, comments, version history.
- Desktop and offline client.
- Importers for Altium, KiCad, Eagle, OrCAD/PADS and LTspice.
- Several schematics and PCBs per project; printing.

## Where this app is ahead

- Basic / Preferred / Extended filters and live stock in part search.
- Passives that pick the cheapest part to assemble by themselves.
- Setup-fee and cost estimates in the order sheet.
- A built-in design assistant, WebMCP and command-line tools, and Claude skills that design and
  lay out boards end to end.
