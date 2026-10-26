# AGENTS.md

Notes for coding agents working on this repository. The [README](README.md) describes the
features and architecture; this file covers how to work on the code.

## What this is

A schematic and PCB editor in the browser, modelled on EasyEDA Pro and built around JLCPCB parts
and assembly. Vite + React 19 + TypeScript on the client, a Hono API that proxies the JLCPCB and
EasyEDA endpoints, and a zustand store with undo. The editor's operations are also tools: WebMCP
for in-browser agents and the `pnpm schem` CLI for headless use (the Claude Code skills in
`.claude/skills/` drive that CLI).

## Commands

```bash
pnpm install
pnpm dev                 # UI + API in one Vite server; uses the next free port if 5173 is taken
pnpm typecheck           # tsc, strict, noUnusedLocals/Parameters (tests included)
pnpm test                # vitest, no network
pnpm build               # production bundle; the chunk-size warning is expected
pnpm -s schem <designs/x.schematic.json> <tool> '<json>'   # run one tool on a design file
pnpm -s schem <file> batch steps.json | summary | tools [name] | export
```

Before committing, run `pnpm typecheck` and `pnpm test`; run `pnpm build` when imports or
lazy-loaded modules changed.

## Where things are

- `src/lib/schematic/` – schematic model, geometry, netlist, ops, wire router, BOM.
- `src/lib/pcb/` – PCB model (`types.ts`), board model and connectivity (`board.ts`), board shape,
  holes and keepouts (`outline.ts`), pours (`pour.ts`, Clipper), DRC (`drc.ts`), A* router
  (`router.ts`), editing actions (`actions.ts`), Gerber/drill/CPL (`gerber.ts`), board pictures
  (`render.ts`), silkscreen text, logos and designator labels (`silk.ts`, `font.ts`, `logo.ts`),
  3D (`model3d.ts`, `viewer3d.ts`), ordering (`order.ts`) and the JLCPCB checklist (`jlcpcb.ts`,
  whose `JLC` constants hold JLCPCB's published limits).
- `src/lib/actions.ts`, `src/lib/passives.ts` – schematic actions shared by the UI and the tools.
- `src/lib/webmcp.ts` – every agent tool (`TOOLS`), input validation and `runTool`.
- `scripts/schem.ts` – the CLI: browser shims, then the same `TOOLS`, with CLI overrides for tools
  that would download files in a browser (`pcb_export`, `pcb_render`, …).
- `server/` – Hono API; `designs.ts` is the dev-only read/write of `designs/*.json`.
- `src/store/editor.ts` – the single zustand store (project, history, UI state, tools).
- `src/components/` – canvases, panels and chrome; shared UI bits in `components/ui.tsx`
  (`Field`, `IconButton`, `cx`, `inputClass`).
- `docs/roadmap.md` – what is missing compared to EasyEDA Pro and what is next;
  `docs/reverse-engineering.md` – how the JLCPCB/EasyEDA APIs and document formats work.

## How the code works

- **Edits go through the store's history.** Change the project with `st().commit(doc => …)`, or
  `commitPcb(pcb => …)` in `pcb/actions.ts`, so undo works. Drags use `beginTransient` /
  `updateTransient` / `endTransient` and become one undo step.
- **Derived data is recomputed, never stored.** Board model, pour fills, connectivity, airwires
  and DRC come from `buildBoard` / `pcbConnectivity` / `runDrc` on the current project.
- **UI and tools share actions.** Put new behaviour in `src/lib/**/actions.ts` (or a lib module)
  and call it from both the component and the tool, rather than writing it twice.
- **Units and axes.** Schematic coordinates are symbol units on a 10-unit grid, y down. PCB is
  millimetres, y down, origin at the board's top-left. EasyEDA footprints are mil with y up
  (converted in `pcb/footprint.ts`); Gerber, drill and CPL are mm with y up from the board's
  bottom-left (converted in `gerber.ts`).
- **Silkscreen comes from one place.** Designators, text and logos are positioned and stroked by
  `pcb/silk.ts`; Gerbers, pictures, the 3D texture, DRC and the canvas all call it, so draw new
  silkscreen through it rather than calling `textStrokes` directly.
- **The board is not a rectangle.** Ask `pcb/outline.ts` (`boardEdges`, `insideBoard`,
  `edgeDistance`, `keepoutAreas`) instead of using `board.x/y/width/height`, which are only the
  bounding box when a custom outline is set.
- **Agent tools** (`src/lib/webmcp.ts`): `inputSchema` is enforced by `validateInput` (unknown
  fields, missing required fields, types, enums), so keep schemas accurate. Throw `Error`s with
  an actionable message (valid pins, valid nets, what to call next); they reach the agent as
  `{ error }`. Mark read-only tools with `readOnlyHint` and destructive ones with
  `consequentialHint`. A new tool shows up in the CLI automatically; add a CLI override only when
  the browser behaviour (downloads, SVG) makes no sense in a terminal.
- **Heavy dependencies stay lazy.** three.js loads only when the 3D view opens (`Board3D` is
  `lazy()`-loaded in `App.tsx` and is the only importer of `pcb/viewer3d.ts`); don't import
  either from code on the main path. `clipper-lib` is
  CommonJS: keep the `default ?? namespace` interop in `pour.ts`.
- **External APIs are unofficial.** JLCPCB and EasyEDA endpoints (see the reverse-engineering doc)
  can change or rate-limit; the server already retries 429s and limits concurrency. Tests use
  fixtures and must not touch the network.

## Conventions

- No linter or formatter is configured: match the surrounding code. Two-space indent, single
  quotes, semicolons, long lines are fine.
- Each module starts with a short block comment saying what it is for; exported functions get a
  one-line JSDoc. Comments explain why, not what.
- Prefer small pure functions in `src/lib/` with tests in `tests/`; components stay thin.
- Tailwind classes and lucide-react icons for UI; colours come from CSS variables in
  `src/index.css` (`--pcb-top`, `--select`, …) so both themes work.
- When a feature changes what users or agents can do, update in the same change: the README
  (features list, tool list and tool count), `docs/roadmap.md` (move items to Done), and the
  skills in `.claude/skills/` if agents should use it.

## Designs and verification

- `designs/` holds the user's own designs and is not committed. Don't edit a project JSON by hand
  (it carries symbol data, ids and caches); change designs with `pnpm schem` tools. Don't modify a
  user's design to test something: copy it to the scratch directory, or to a throwaway
  `designs/zz-*.schematic.json` you delete afterwards.
- `designs/stm32-tmc2209.schematic.json` is a fully routed, DRC-clean 2-layer board (QFN driver,
  LQFP MCU, pours, thermal vias); it is a good stress case for router, pour and DRC changes.
  `pcb_render` writes a PNG with mm rulers that you can look at.
- To check UI changes, run `pnpm dev` and open `/?open=<file>.json&mode=pcb`. The page reloads a
  design when its file changes on disk. In dev, the store can be inspected from the page with
  `(await import('/src/store/editor.ts')).useEditor.getState()`. After HMR the 3D view can keep
  an old viewer instance; reload the page.
- Router changes: compare `pcb_autoroute` and `pcb_check` results on a copy of the STM32 board
  before and after; DRC must not gain errors.

## Git

Work lands directly on `main` (git@github.com:Ledzz/schema.git) as one commit per feature or fix.
Commit subjects are short and imperative ("Add …", "Fix …", "Router: …"); the body says what
changed and why.
