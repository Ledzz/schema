---
name: schematic-design
description: Design electronic circuits as schematics in this repo's Schematics app (EasyEDA-style editor backed by the JLCPCB parts library) from a plain-language description. Picks in-stock JLCPCB parts with Basic/Preferred parts first to avoid assembly setup fees, places and wires them, runs the design check and reports the BOM cost. Use this whenever the user wants to design, draw, sketch, build or change a circuit or schematic, choose parts for a board, "make a board that does X", add a sub-circuit (LDO, USB-C power, LED, I2C pull-ups, 555 timer, MCU minimum system, sensor breakout), or swap parts for cheaper JLCPCB ones — even if they never say "schematic".
---

# Schematic design

You build the schematic by calling the app's own editing tools through a command line, so
the result is a real project file the user opens in the app — not a drawing or a description.

## Setup

The app is the repository this skill lives in: its root is three levels above the skill's real
directory. The skill may be symlinked from `~/.claude/skills`, so resolve the link first —
`cd "$(realpath <skill directory>)/../../.."` — and run every command from there (run
`pnpm install` if `node_modules` is missing).

```bash
pnpm -s schem designs/<slug>.schematic.json <tool> '<json input>'   # one tool call, prints JSON
pnpm -s schem designs/<slug>.schematic.json batch steps.json        # many calls in one process
pnpm -s schem designs/<slug>.schematic.json tools [tool]            # list tools / one input schema
pnpm -s schem designs/<slug>.schematic.json summary                 # parts, nets, checks, BOM
```

- Keep designs in `designs/` with a short slug (`usb-c-ldo.schematic.json`); the file is created
  on the first call and saved after every successful one. Put scratch files (batch steps) in a
  temporary directory, not the repository.
- Prefer `batch` for anything over a few calls: a JSON array of `{"tool": "...", "input": {...}}`.
  It runs in one process (part lookups are cached), stops at the first error and reports which
  step failed, so you can fix that step and run the rest.
- Errors come back as `{"error": "..."}` with something actionable: the list of valid pins, the
  valid input fields, or why a connection was refused. Results may also carry `note`, `hint` or
  `warnings` — read them, they flag fees and wiring risks.
- Do not edit the project JSON by hand: it holds symbol data, ids and caches the tools maintain.

## Workflow

### 1. Pin down the requirements

Settle what you need to know: power source and voltages, the main ICs or functions, connectors
and interfaces, rough size or cost limits. If the request is quick ("a USB-C board with an LED"),
choose sensible defaults and state them rather than asking a string of questions.

### 2. Plan before placing anything

Write a short plan in the conversation: the functional blocks, each part with its role, and the
nets by name (`+5V`, `+3V3`, `GND`, `SDA`, `LED_A` …). Connecting pins by net name is much more
reliable than drawing long wires, and a plan written down first avoids rework when a pin turns
out to be on the other side of a symbol. `references/recipes.md` has proven sub-circuits
(decoupling, regulators, USB-C power, connectors, LEDs, I2C, buttons, reset, crystals, 555
timers, MCU minimum systems) — read the parts the design uses.

Many of them exist as ready blocks: `insert_block` places a 3.3 V AMS1117 regulator
(`ldo-3v3`), USB-C 5 V input (`usb-c-power`), indicator LED (`led`), I2C pull-ups
(`i2c-pullups`), push button (`button`), reset/enable RC (`reset-rc`), 8 MHz crystal with load
capacitors (`crystal`), 555 astable (`ne555-astable`), SWD header (`swd-header`) or voltage
divider (`divider`) with parts, wiring and flags in one call; its `params` set rails, net names
and values (the tool description lists them). Use blocks for those parts of the plan and the
individual tools for the rest, then move the blocks into place with `update_component`. After
placing an IC, `add_decoupling` adds its supply-pin capacitors and bulk capacitor per rail.

### 3. Choose parts

- **Passives, LEDs and diodes:** use `place_passive` with a value and a size. It normalises the
  value ("4k7", "100n", "0.1u", "10u 16V") and matches the cheapest-to-assemble in-stock part.
  Use 0603 by default, 0402 when space is tight, 0805 for ≥10 µF capacitors, and add a voltage
  to capacitor values on rails above 5 V ("10u 25V"). If it had to settle for an extended part,
  the result has a `note` naming sizes that do have a basic one; switch with `set_passive`
  unless the board needs that exact size.
- **Everything else:** `search_parts` with `"part_types": ["basic", "preferred"]` first, sorted by
  stock. Fall back to extended parts only when nothing suitable exists — each unique extended
  part adds a $3 assembly setup fee. When a filtered search comes back empty, its `hint` says
  whether extended parts match or the keywords are wrong.
- **Connectors are almost never basic.** USB-C receptacles, pin headers and JST sockets are
  extended: accept the fee, or point out that through-hole connectors can be left out of
  assembly and hand-soldered. JLCPCB names USB-C parts "Type-C"; see the recipes for search
  terms that work.
- **Before wiring any IC,** call `get_part_details` to learn its pin names and numbers. Symbols
  come from the EasyEDA library and names and numbering vary between vendors.
- **Designators:** library parts bring their own prefixes ("USB", "H", "LED", even "U" for a
  header), so pass `designator` explicitly for connectors (`J1`) and anything else that matters.

### 4. Place parts in a tidy grid

Coordinates are schematic units: y grows downward and wiring runs on a 10-unit grid. The tools
nudge a part by up to 5 units so its pins land on that grid; a few library symbols have odd pin
pitches and keep some pins between grid lines, which still connect fine.

- Lay blocks out left to right in signal-flow order (power input → regulation → MCU →
  peripherals), roughly 250 units apart, with parts inside a block 60–100 units apart.
- Stand two-pin parts that sit between a rail and GND upright (`"rotation": 90` or `270`). Which
  pin ends up on top depends on the symbol, so read the pin positions in the result, then put the
  power flag on the upper pin and the ground flag on the lower one.
- Leave about 30 units of free space around pins that will get flags or labels. The tools refuse
  rather than touch another net, so cramped parts mean refusals and rework.
- **Bigger designs on several sheets.** Past roughly 25 parts, or with clearly separate functions
  (power, MCU, motor driver), give each its own sheet: `add_sheet` with a name makes it current,
  so the parts, labels and flags you place next go on it, and each sheet has its own coordinates.
  `switch_sheet` goes back to an earlier one and `list_sheets` shows what is where. Labels and
  power flags of the same name connect across sheets, which is all most designs need.
- **Hierarchical blocks** suit a sheet that is a module with a defined interface. On that sheet,
  give each interface pin `add_net_label` with `"scope": "hierarchical"`. On the parent sheet,
  `place_block` with the sheet's name draws a block with a pin per port, and you connect them
  with `connect_pins`, `add_net_label` or `add_power_flag` on `"<sheet name>.<port>"`
  (`"Power.VIN"`). A port reaches only its block's pin, so the same port name on two sheets
  stays two nets (named `Sheet/port` unless a label names them).

### 5. Connect

- **Power and ground:** `add_power_flag` on each pin (`+3V3`, `+5V`, `GND` …). Flags with the
  same name are connected, so no long wires are needed.
- **Signals between blocks:** `add_net_label` with the same name on every pin of the net. For a
  net that leaves its block, label all of its pins instead of wiring some and labelling others:
  it is tidier and always fits.
- **Short local links** (resistor → LED, crystal → load capacitor): `connect_pins`. It routes
  around parts and refuses rather than touching other wiring. Labels and flags can still be
  added to a pin that is already wired, which also names the net.
- Address pins as `U1.VIN` or `U1.3`; when a name repeats (two `VOUT` pins), use the numbers.
  For diodes and LEDs always use names — `D1.A` (anode) and `D1.K` (cathode) — because the
  generic symbol and library symbols number them differently.
- If a connection is refused for lack of room, move the part with `update_component` (attached
  wires follow it; a move that would join two nets is refused) or use labels.
- To undo a connection, `disconnect_pin` removes the wires ending on a pin and any label or flag
  they leave dangling. `delete_components` likewise removes the wiring that only connected to the
  deleted parts. There is no undo across commands otherwise.
- Mark intentionally unused IC pins with `mark_no_connect` so the check stays meaningful.

### 6. Check and improve

- `check_design` until there are no errors and only warnings you understand and accept. Two
  power flags on one net (say `+3V3` and `GND`) is a short and reported as an error.
- `get_netlist` and compare it with the plan: every net should have exactly the pins you meant.
- `get_bom`: note extended parts and the setup fee. Where an extended part has a basic
  equivalent that works electrically, swap it (`set_passive` for passives, `replace_part` for
  the rest) — this is the main cost lever for JLCPCB assembly. `replace_part` keeps the
  designator and position but warns when the new symbol numbers or places its pins differently;
  fix the wiring it points at before moving on.

### 7. Hand off

Tell the user, briefly:

- what the circuit does and the main design choices and assumptions (with the calculations,
  e.g. LED current or timer frequency);
- the parts (designator, value, LCSC number, Basic/Preferred/Extended) and the setup fee;
- how to look at it: run `pnpm dev` and open the local URL it prints (usually
  `http://localhost:5173`) with `/?open=<slug>.schematic.json` added. The open page updates by
  itself whenever you change the file, and edits they save there (⌘S) go back to the same file,
  so you can pick up from their changes — re-read it with `summary` before changing anything.

Offer the **pcb-layout** skill as the next step when they want a board.

## Things that trip people up

- The JLCPCB keyword search treats words loosely. Be specific ("AMS1117-3.3", "Type-C 6P"), and
  note that a chip size typed in the query ("10uF 0805") is applied as an exact package filter.
- Parts without an LCSC number cannot be assembled by JLCPCB and get no footprint on the PCB.
  Every placed part should come from `place_part` / `place_passive`.
- `place_part` without x/y drops the part to the right of the drawing. Give explicit positions
  so the layout stays readable.
