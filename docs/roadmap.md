# Roadmap

What EasyEDA Pro has that this app doesn't yet, grouped by area. ★ marks the gaps that matter
most for the app's purpose: getting small boards made and assembled at JLCPCB quickly. The
comparison is against EasyEDA Pro 2.x as known in late 2026.

## Next up

1. **3D board view** — part models, catches connector orientation and height problems before
   ordering. *(in progress)*
2. **Custom board outlines, mounting holes, keepouts and pour zones** — almost every real board
   needs one of them; the data model already allows a custom pour outline.
3. **Silkscreen text and logos, movable designators.**
4. **4-layer boards** — cheap at JLCPCB and much easier to route for MCU boards.
5. **Push-and-shove routing and track dragging** — makes manual clean-up pleasant.

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
- 3D models assigned to footprints.

## PCB: board and placement

- ★ Custom board outlines (arcs, cutouts, slots), mounting holes, DXF outline import (only a
  rounded rectangle today).
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

- ★ Custom copper zones with priorities and cutouts; keepout areas for tracks, vias, pours or
  parts (pours always cover the whole board today).
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

- ★ 3D board view with part models; height and clearance checks; enclosure design.

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
