# Roadmap

What EasyEDA Pro has that this app doesn't yet, grouped by area. ★ marks the gaps that matter
most for the app's purpose: getting small boards made and assembled at JLCPCB quickly. The
comparison is against EasyEDA Pro 2.x as known in late 2026.

## Next up

1. **Silkscreen text and logos, movable designators.**
2. **4-layer boards** — cheap at JLCPCB and much easier to route for MCU boards.
3. **Push-and-shove routing and track dragging** — makes manual clean-up pleasant.
4. **STEP export of the assembled board** — the 3D view already has the models; enclosure
   design needs the board as a STEP file.
5. **Arcs in outlines and DXF outline import** — to match an enclosure drawing exactly.

## Done

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
- ★ More than 2 layers: 4/6-layer stackups, layer stack manager, JLC impedance calculator,
  blind and buried vias.
- Align and distribute, part locking, rooms, measure tool, dimension lines, grid setting.
- ★ Silkscreen text, logos and images; movable designators.
- Test points, fiducials, tooling holes, panelization (V-cuts, tabs).

## PCB: routing

- ★ Push-and-shove or walk-around interactive routing, dragging track segments.
- Differential pairs, length matching (serpentines), curved tracks, teardrops, BGA fanout.
- A stronger auto-router (ours is a basic grid router).

## PCB: copper, rules, checks

- Zone priorities beyond "zones before whole-board pours", and cutouts inside a single zone.
- Per-net and net-class rules, rule areas.
- Per-pad thermal settings; stitching-via arrays in the UI (an agent tool only today).
- More DRC: silkscreen over pads, annular ring, drill-to-copper, courtyard overlap (approximated
  with bounding boxes today), checks against JLC's limits.

## Outputs and ordering

- ODB++, IPC-356, DXF, PDF fabrication and assembly drawings, STEP export, export to Altium or
  KiCad.
- Fully one-click ordering (EasyEDA uses JLC's internal upload service; ours is the guided
  order sheet).
- Stencil ordering, parts pre-ordering and reservation, 3D-printed or CNC enclosures.

## 3D and mechanical

- STEP export, height and clearance checks, enclosure design (the 3D view itself is done).

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
