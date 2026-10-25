---
name: pcb-layout
description: Turn a schematic made in this repo's Schematics app into a manufacturable 2-layer PCB for JLCPCB. Loads JLCPCB footprints, sizes the board, places parts sensibly, adds GND copper pours, routes (auto-router plus clean-up), runs DRC and exports Gerbers, drill, BOM and pick-and-place files. Use this whenever the user wants a PCB, board layout, placement, routing, a ground plane or pour, Gerbers, or to "get the board ready to order" — including right after a schematic was designed with the schematic-design skill.
---

# PCB layout

You lay out the board by calling the app's PCB tools through a command line, working on the
same project file as the schematic. The result is a routed board the user opens in the app,
plus fabrication files JLCPCB accepts.

## Setup

The app is the repository this skill lives in: its root is three levels above the skill's real
directory. The skill may be symlinked from `~/.claude/skills`, so resolve the link first —
`cd "$(realpath <skill directory>)/../../.."` — and run every command from there (run
`pnpm install` if `node_modules` is missing).

```bash
pnpm -s schem designs/<slug>.schematic.json <tool> '<json input>'   # one tool call
pnpm -s schem designs/<slug>.schematic.json batch steps.json        # many calls, one process
pnpm -s schem designs/<slug>.schematic.json summary                 # includes PCB state and DRC
```

Batch files are JSON arrays of `{"tool": "...", "input": {...}}`; a batch stops at the first
error and reports the failing step. Errors come back as `{"error": "..."}` with the reason. Keep
batch files in a temporary directory, not the repository.

PCB coordinates are millimetres with the board's top-left corner at (0, 0) and y growing
downward. A part's x/y is its footprint origin, which is normally the body centre. Rotation is
in degrees counter-clockwise as seen on screen.

**Look at the board.** `pcb_render` writes a PNG of the board (to `designs/<slug>-renders/`) and
returns its path; open it with the Read tool to see it. It has millimetre rulers along the top
and left edges, so what you see maps straight to coordinates. Top copper is red, bottom blue,
through-hole gold, unrouted connections dashed white, metal connector bodies dashed orange,
keepouts and mounting-hole rings dashed red, and DRC problems circled (red errors, amber
warnings). Add `"highlight_net": "+5V"` to follow one
net, or `"layers": "bottom"` to see one side. Render after placing and after every routing round:
a picture shows crossings, crowding and odd detours that the numbers don't.

## Before you start

The schematic must be finished: `check_design` without errors, and every part placed from the
JLCPCB library (`place_part` / `place_passive`), because only those have footprints and can be
assembled. If the schematic isn't there yet, use the **schematic-design** skill first.

## Workflow

### 1. Bring the parts onto the board

`pcb_update` loads each part's footprint, sizes the board on first use and packs the parts in
schematic order. Fix anything listed under `without_footprint` in the schematic (usually by
replacing the part) and run it again. Re-run `pcb_update` whenever the schematic changes; it
keeps existing positions and routing.

### 2. Size the board

Use the user's constraints if they gave any (enclosure, mounting, "as small as possible").
Otherwise aim for 2.5–3 times `part_area_mm2` from `pcb_get_state`, rounded to 5 mm, and set it
with `pcb_set_board` (a 1 mm `corner_radius` looks finished). Smaller boards are cheaper but
harder to route; leave more room when there are many connections.

Add the mechanical features now, before placing, because they take board space:

- **Shape:** `pcb_set_board` with `outline` (corner points in order) when the board must fit an
  enclosure or needs a notch or chamfer; corners are rounded by `corner_radius`.
- **Mounting holes:** if the user wants the board screwed down (or it goes in an enclosure),
  `pcb_add_mounting_holes` with `"corners": true` puts M3 holes (3.2 mm, 6.4 mm copper-free
  ring) in each corner. Allow about 7 mm × 7 mm per corner for them when sizing the board.
- **Keepouts:** `pcb_add_keepout` (a `rect` or `outline`) under an antenna, a heat sink or anything
  that must stay copper-free; add `"parts": true` to keep parts out too.
- **Cutouts:** `pcb_add_cutout` for slots and windows milled through the board.

`pcb_get_state` lists their ids; `pcb_remove_features` removes them.

### 3. Place parts — this decides whether routing succeeds

Read the board with `pcb_get_state` and `"include_pads": true` (pad positions and nets), plan the
positions, then apply them with `pcb_move_part` in one batch. Pads move with the part, so read
the state again after moving instead of working out rotated pad offsets by hand, and render the
board to check the result.

- Connectors that mate at the edge (USB-C, barrel jacks) sit with their opening flush with the
  board edge: put that side of the `bbox` on the edge line. The opening is the side away from the
  signal pad row. Headers, switches and other things people touch go near an edge, about 1 mm in.
- Follow the power path in a line: input connector → protection → regulator → loads.
- Decoupling capacitors go within 1–2 mm of the IC pin they serve (match the pad nets); crystals
  sit right next to the MCU's oscillator pins.
- Group parts by function and rotate them so pins face the parts they connect to; fewer
  crossings mean the router succeeds more often.
- Keep at least 0.5 mm between part outlines and 1 mm between other parts and the board edge.
  DRC reports overlapping parts and copper too close to the edge.
- Use the bottom side (`"side": "bottom"`) only when the top is truly full. Assembly on both sides
  costs more.

### 4. Ground pours

`pcb_add_pour` with `"net": "GND"` on both layers. For a local plane of another net (say a wide
VM area under a motor driver), add a zone with `rect` or `outline`: zones take priority and the
GND pour flows around them. A ground plane gives every signal a short
return path and makes most GND connections for free, which leaves the router far less to do.
Pours keep 0.3 mm from other nets, join GND pads through thermal reliefs, and refill by
themselves after every move or route, so add them once, before routing.

Chips with an exposed thermal pad (QFN drivers such as the TMC2209, many regulators and
amplifiers) shed their heat through it. Put thermal vias in that pad with `pcb_add_vias`
(`"net": "GND"`, a grid at about 1 mm pitch that stays inside the pad) so the heat reaches the
bottom pour. DRC then warns about vias in an SMD pad; that is expected for thermal vias — tell
the user to choose via tenting or filling when ordering. The same tool places stitching vias
that tie the top and bottom pours together where one of them is cut up.

### 5. Route

`pcb_autoroute` routes the remaining connections, shortest first. Supply and ground nets (GND,
VCC, VIN, VM, +5V, +3V3 …) get the 0.5 mm power width automatically; everything else gets
0.25 mm, which is only good for a few hundred milliamps. So route the high-current nets first,
one at a time with `"net"` and `"width"`: motor outputs, sense-resistor connections, LED strings,
heater or relay drives — 0.5 mm carries about 1.5 A, 1 mm about 2.5 A on JLCPCB's 1 oz copper.
Then run it once more without a net for the rest. Check `failed` in the result and `unrouted` in
`pcb_get_state`:

- If some connections fail, improve placement around them (move or rotate parts, give more
  room), then `pcb_clear_routing` (optionally for one net) and route again.
- Two or three placement/route rounds are normal. If a dense board (fine-pitch ICs, more than ~40
  parts) still fails, tell the user which nets remain. They can finish those by hand in the
  app's PCB tab (press W to route, V to change layers).
- Render the routed board and look at it. `pcb_get_state` with `"include_tracks": true` lists
  every track (net, layer, width, length, corner points) and via when you need exact positions,
  for example to find a long detour worth fixing by moving a part.
- The router keeps other nets out from under metal connector shells (`metal_shell` parts in
  `pcb_get_state`) where it can. When it can't, DRC warns that a track runs under the shell; move
  the connector or the parts next to it, clear that net and route again.

### 6. Design rule check

`pcb_check` must report no errors before you export. Read the warnings too: a pad with fewer
than two thermal spokes may solder poorly or lose its GND connection, and a track under a metal
shell is only insulated by solder mask. Overlapping parts and vias in pads are worth fixing.
The render circles each problem, which makes it easy to see what to move.

### 7. Export and hand off

`pcb_export` writes `designs/<slug>-fab/`:

- `<slug>-gerbers.zip`: Gerbers and drill files (a separate non-plated one when the board has
  mounting holes), uploaded to JLCPCB as is;
- `<slug>-BOM.csv` and `<slug>-CPL.csv`: bill of materials and pick-and-place for JLCPCB
  assembly (CPL y is measured up from the bottom edge, as JLCPCB expects);
- `<slug>.net.txt`: the netlist, for reference.

Then tell the user:

- board size, layer count, part count, that DRC passed, and anything worth a look (DRC warnings
  you accepted, nets you could not route); show the final render's path so they can open it;
- where the files are and what each one is for;
- to check the Gerbers in JLCPCB's viewer after uploading, and the part rotations in their
  assembly preview (CPL rotations follow the design and occasionally need a fix there);
- that through-hole parts (pin headers, most connectors) add a hand-soldering charge to JLCPCB
  assembly; if the user would rather solder them, export again with
  `"hand_solder_through_hole": true`, which leaves them out of the BOM and CPL;
- that the app's **Order from JLCPCB** button (PCB panel, or File menu) does the ordering
  legwork: it checks the board, downloads the files, opens JLCPCB's quote page and lists the
  settings to pick there. JLCPCB has no public API, so the upload and checkout stay manual;
- how to look at the board: run `pnpm dev` and open the local URL it prints (usually
  `http://localhost:5173`) with `/?open=<slug>.schematic.json&mode=pcb` added. The open page
  updates by itself whenever you change the file, and edits saved there (⌘S) go back to the
  same file, so re-read it with `summary` before changing anything.

## Limits worth knowing

- The auto-router is a simple grid router meant for small boards. Good placement matters more
  than anything else.
- Outlines are straight-sided polygons (rounded corners, no arcs). There are no differential
  pairs or length tuning yet.
- Keepouts don't move existing tracks: after adding one over routed copper, clear the nets
  `pcb_check` names and route them again.
