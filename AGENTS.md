# AGENTS.md

Notes for coding agents working on this repository. The [README](README.md) describes the
features and architecture; this file covers how to work on the code.

## What this is

A schematic and PCB editor in the browser, modelled on EasyEDA Pro and built around JLCPCB parts
and assembly. Vite + React 19 + TypeScript on the client, a Hono API that proxies the JLCPCB and
EasyEDA endpoints, and a zustand store with undo. The editor's operations are also tools: the in-app assistant, WebMCP
for in-browser agents and the `pnpm schem` CLI for headless use (the Claude Code skills in
`.claude/skills/` drive that CLI and are also the assistant's system prompt).

## Commands

```bash
pnpm install
pnpm dev                 # UI + API in one Vite server; uses the next free port if 5173 is taken
ANTHROPIC_API_KEY=… pnpm dev   # the Assistant tab then needs no key from the user (GEMINI_API_KEY for Gemini)
pnpm typecheck           # tsc, strict, noUnusedLocals/Parameters (tests included)
pnpm test                # vitest, no network
pnpm build               # production bundle; the chunk-size warning is expected
pnpm -s schem <designs/x.schematic.json> <tool> '<json>'   # run one tool on a design file
pnpm -s schem <file> batch steps.json | summary | tools [name] | export
```

Before committing, run `pnpm typecheck` and `pnpm test`; run `pnpm build` when imports or
lazy-loaded modules changed.

Deployment is `.github/workflows/deploy.yml`: a push to `main` publishes the app to GitHub Pages
(built with `BASE_PATH=/<repo>/` and `VITE_API_BASE` from the repository variable `API_BASE`) and
the API server's image to GHCR (`Dockerfile`; `deploy/docker-compose.yml` runs it). Client code
reaches the API through `apiUrl()` in `src/lib/api.ts`, never a bare `/api/...` string, so the
Pages build can point at a server elsewhere; the server allows those origins with `CORS_ORIGIN`.

## Where things are

- `src/lib/schematic/` – schematic model, geometry, netlist, ops, wire router, BOM, sheets
  (`sheets.ts`), groups (`groups.ts`: frame, tab and contents geometry; the store-aware actions
  are `src/lib/grouping.ts`) and generated symbols (`symbolgen.ts`).
- `src/lib/projects.ts` – the project library and files: every project is autosaved into
  IndexedDB (`src/lib/db.ts`, with an in-memory fallback for tests and the CLI) and listed on the
  start screen (`components/StartScreen.tsx`); Save/Open use the File System Access API where
  the browser has it and downloads elsewhere. `src/lib/designs.ts` is the dev-only sync with
  `designs/`. The assistant's chats are in the same database, per project.
- `src/lib/pcb/` – PCB model (`types.ts`), board model and connectivity (`board.ts`), board shape,
  holes and keepouts (`outline.ts`), pours (`pour.ts`, Clipper), DRC (`drc.ts`), A* router
  (`router.ts`), editing actions (`actions.ts`), Gerber/drill/CPL (`gerber.ts`), board pictures
  (`render.ts`), push-and-shove and segment dragging (`shove.ts`), silkscreen text, logos and
  designator labels (`silk.ts`, `font.ts`, `logo.ts`),
  3D (`model3d.ts`, `viewer3d.ts`), STEP export (`step.ts`), IPC-7351 footprints (`ipc.ts`),
  differential pairs and length tuning (`diffpair.ts` geometry, `tuning.ts` actions), ordering (`order.ts`) and the JLCPCB checklist (`jlcpcb.ts`,
  whose `JLC` constants hold JLCPCB's published limits).
- `src/lib/actions.ts`, `src/lib/passives.ts` – schematic actions shared by the UI and the tools;
  `src/lib/blocks.ts` (circuit blocks, as data plus `insertBlock`) and `src/lib/decoupling.ts`
  build on them. Multi-step edits use the store's `historyMark` / `squashHistory` /
  `revertHistory` to become one undo step, or nothing if a step fails.
- `src/lib/library.ts` – symbols, footprints and parts made in the project (`user:` keys), used
  by the parts editor (`components/library/PartsEditor.tsx`) and the custom-part tools.
- `src/lib/quickadd.ts` – quick add: typed text to ranked suggestions (`quickSuggestions`) and
  placing one (`placeQuickItem`); the box is `components/canvas/QuickAdd.tsx`.
- `src/lib/crossprobe.ts` – cross-probing: the store keeps part selection and the highlighted net
  in step between the editors (`partsIn`); this shows them in the other editor and keeps them in
  view side by side (`split`).
- `src/lib/webmcp.ts` – every agent tool (`TOOLS`), input validation and `runTool`.
- `src/lib/assistant/` – the in-app assistant: `prompt.ts` (system prompt from the skills),
  `loop.ts` (one turn: request, tool calls, results, repeat), `tools.ts` (the tools in the API's
  shape, `pcb_render` as an image, the editor-state line), `stream.ts` and `transport.ts` (SSE).
  The conversation and settings are in `src/store/assistant.ts`, the chat in
  `components/panels/AssistantPanel.tsx`, and `server/assistant.ts` is the route that calls the
  Claude API (official SDK, streaming, prompt caching, server-side fallback on refusals) or, via
  `server/gemini.ts`, Gemini: the conversation stays in the Claude API's shape and that module
  translates it both ways (contents, function calls and responses, thought signatures kept in a
  field of their own on the stored blocks), and lists the models the key can use.
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
  and DRC come from `buildBoard` / `pcbConnectivity` / `runDrc` on the current project. A group
  is a region, not a list: `groupMembers` finds its contents by geometry whenever they matter
  (`moveItems` takes them along with the frame), so nothing has to be kept in step.
- **Big schematics must stay smooth.** `connectivity()` in `lib/actions.ts` caches one analysis
  per document and hands back the pre-drag result while a transient edit is in progress; use it
  rather than calling `analyze` yourself, so every panel shares the work. The schematic canvas
  draws the sheet in a memoised `Drawing` layer whose props change only with the drawing,
  selection or highlighted net; pointer-driven state (ghosts, hover, the box) lives outside it.
  `analyze` finds T-junctions through a grid of cells, not every wire end against every segment.
  Measure with a duplicated STM32 sheet (⌘A, ⌘D a few times gives ~250 parts) before and after
  touching the canvas or the netlist.
- **UI and tools share actions.** Put new behaviour in `src/lib/**/actions.ts` (or a lib module)
  and call it from both the component and the tool, rather than writing it twice.
- **Sides vs layers.** `Side` (`top`/`bottom`) is where parts, silkscreen, mask and paste are;
  `CopperLayer` adds `inner1`/`inner2` on 4-layer boards. Use `copperLayers(pcb)` for the stack
  instead of assuming top and bottom; vias and through-hole pads span every layer of it.
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
- **The skills are the assistant's prompt.** `src/lib/assistant/prompt.ts` imports the skill
  Markdown as raw text and drops the frontmatter, the title line and the `## Setup` section
  (which must stay the only command-line-specific section). Design knowledge belongs in the skill
  bodies and `references/recipes.md`, where both the CLI skills and the assistant read it; the
  preamble in `prompt.ts` only explains how the app differs from the command line. The system
  prompt is identical for every request so it caches; keep anything that varies out of it.
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
