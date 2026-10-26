# Roadmap

What EasyEDA Pro has that this app doesn't yet, grouped by area. ★ marks the gaps that matter
most for the app's purpose: getting small boards made and assembled at JLCPCB quickly. The
comparison is against EasyEDA Pro 2.x as known in late 2026.

## Next up

1. **Arcs in outlines and DXF outline import** — to match an enclosure drawing exactly.
2. **Cross-probing between schematic and PCB** — select a part or net in one, see it in the
   other.
3. **A smarter auto-router** — rip-up and retry around dense fine-pitch parts, where the grid
   router still leaves a connection or two for manual routing.
4. **Length tuning and differential pairs** — for USB and other matched signals.
5. **Height and clearance checks against an enclosure** — import the enclosure's STEP and flag
   parts that collide with it.

## Done

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

- ★ Multiple sheets and hierarchical blocks (everything is one sheet today).
- Buses and bus entries.
- Drawing tools: text, lines, rectangles, images, sheet frame and title block.
- Find and replace, select similar, align and distribute, a property table for bulk edits
  (bulk editing exists only for passives).
- ★ Cross-probing between schematic and PCB.
- Net classes and differential-pair marking.
- Stricter design check: pin-type conflicts such as two outputs on one net.
- Snippets, reusable blocks and templates.
- PDF and print export (SVG only today).

## Libraries

- ★ Symbol, footprint and device editors, including an IPC footprint generator (parts come only
  from the JLC/EasyEDA library and the built-in passives).
- Personal and team libraries; importing libraries from KiCad or Altium.
- Choosing or editing a footprint's 3D model (EasyEDA's assignment is used as is).

## PCB: board and placement

- Arcs in board outlines and DXF outline import (outlines are straight-sided polygons with
  rounded corners today).
- 6+ layers, a layer stack manager, JLC's impedance calculator, blind and buried vias (2 and 4
  layers with through vias today).
- Align and distribute, part locking, rooms, measure tool, dimension lines, grid setting.
- Multi-colour or greyscale artwork (logos are traced to one colour), TrueType fonts.
- Test points, fiducials, tooling holes, panelization (V-cuts, tabs).

## PCB: routing

- Pushing vias out of the way, dragging corners and whole tracks (segments drag today), glossing
  (tidying routed tracks).
- Differential pairs, length matching (serpentines), curved tracks, teardrops, BGA fanout.
- A stronger auto-router (ours is a basic grid router).

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

- Height and clearance checks, enclosure design (the 3D view and STEP export are done); copper
  and silkscreen in the STEP file (it has the bare board shape today).

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
- WebMCP and command-line tools, and Claude skills that design and lay out boards end to end.
