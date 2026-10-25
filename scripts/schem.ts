/*
 * Headless command line for the editor's tools — the same tools the app exposes over WebMCP —
 * working on a project file. Used by the schematic-design and pcb-layout skills.
 *
 *   pnpm -s schem <project.json> tools [name]               tool names, or one tool's input schema
 *   pnpm -s schem <project.json> <tool> ['<json input>']    run one tool and print its JSON result
 *   pnpm -s schem <project.json> batch <steps.json | ->     run [{ "tool": "...", "input": {...} }, ...]
 *   pnpm -s schem <project.json> summary                    overview: parts, nets, checks, PCB state
 *   pnpm -s schem <project.json> export [dir]               Gerber zip, CPL, BOM and netlist into a folder
 *
 * The project file is created when missing and saved after every successful tool call. Part data
 * comes straight from JLCPCB / EasyEDA through the app's own API code, so no server is needed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type Json = Record<string, unknown>;

/* ---------- browser shims (before any app module loads) ---------- */

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, String(v)),
    removeItem: (k: string) => void memory.delete(k),
  },
});

function fail(message: string, code = 1): never {
  process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
  process.exit(code);
}

async function main() {
  const [projectArg, command, ...rest] = process.argv.slice(2);
  if (!projectArg || !command) {
    fail('usage: pnpm -s schem <project.json> <tool|tools|batch|summary|export> [json]', 2);
  }
  const projectPath = resolve(projectArg);

  // Route the app's relative /api calls to the in-process API (no dev server needed).
  const { api } = await import('../server/api');
  const upstream = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/')) return api.fetch(new Request(`http://local${url}`, init));
    return upstream(input, init);
  }) as typeof fetch;

  const { useEditor, emptyProject } = await import('../src/store/editor');
  const { TOOLS, runTool, validateInput, pcbPicture, throughHoleIds } = await import('../src/lib/webmcp');
  const { connectivity } = await import('../src/lib/actions');
  const { buildBom, bomToJlcpcbCsv } = await import('../src/lib/schematic/bom');
  const { formatNetlist } = await import('../src/lib/schematic/netlist');
  const { boardModel, checkPcb, fabricationFiles } = await import('../src/lib/pcb/actions');
  const { zip } = await import('../src/lib/zip');
  type Project = ReturnType<typeof useEditor.getState>['project'];

  const st = () => useEditor.getState();
  if (existsSync(projectPath)) {
    let p: Project;
    try {
      p = JSON.parse(readFileSync(projectPath, 'utf8'));
    } catch (err) {
      fail(`Cannot read ${projectPath}: ${(err as Error).message}`);
    }
    if (p.version !== 1 || !Array.isArray(p.components)) fail(`${projectPath} is not a schematic project file`);
    st().loadProject({ ...p, ports: p.ports ?? [], symbols: p.symbols ?? {} });
  } else {
    st().loadProject(emptyProject(basename(projectPath).replace(/(\.schematic)?\.json$/i, '')));
  }

  const save = () => {
    mkdirSync(dirname(projectPath), { recursive: true });
    const tmp = `${projectPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...st().project, updatedAt: Date.now() }, null, 1));
    renameSync(tmp, projectPath);
  };

  const exportTo = (dir: string, skip: ReadonlySet<string> = new Set()) => {
    const project = st().project;
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const write = (name: string, content: string | Uint8Array) => {
      writeFileSync(join(dir, name), content);
      files.push(join(dir, name));
    };
    const fab = fabricationFiles(project, skip);
    const hasBoard = !!project.pcb?.placements.length;
    if (hasBoard) {
      write(`${fab.base}-gerbers.zip`, zip(fab.gerbers));
      write(`${fab.base}-CPL.csv`, fab.cpl);
    }
    // With a board, the BOM lists what is placed on it (and assembled); otherwise the schematic.
    write(`${fab.base}-BOM.csv`, hasBoard ? fab.bom : bomToJlcpcbCsv(buildBom(project.components)));
    write(`${fab.base}.net.txt`, formatNetlist(connectivity(project)));
    return files;
  };

  const slug = basename(projectPath).replace(/(\.schematic)?\.json$/i, '');
  // Tools that touch browser UI behave differently on the command line.
  const overrides: Record<string, (input: Json) => Promise<unknown>> = {
    new_schematic: async (input) => {
      st().loadProject(emptyProject(input.name ? String(input.name) : st().project.name));
      return { ok: true, name: st().project.name };
    },
    pcb_export: async (input) => {
      const check = checkPcb(st().project);
      const errors = check.issues.filter((i) => i.severity === 'error').map((i) => i.message);
      const dir = join(dirname(projectPath), `${slug}-fab`);
      const skip = input.hand_solder_through_hole ? throughHoleIds() : new Set<string>();
      return { files: exportTo(dir, skip), drc_errors: errors, hand_soldered: st().project.components.filter((c) => skip.has(c.id)).map((c) => c.designator) };
    },
    pcb_render: async (input) => {
      const { svg, widthPx, heightPx } = pcbPicture(input);
      const { Resvg } = await import('@resvg/resvg-js');
      const dir = join(dirname(projectPath), `${slug}-renders`);
      mkdirSync(dir, { recursive: true });
      const net = input.highlight_net ? `-${String(input.highlight_net).replace(/[^\w]+/g, '_')}` : '';
      const file = join(dir, `pcb-${input.layers ?? 'both'}${net}.png`);
      writeFileSync(file, new Resvg(svg).render().asPng());
      return { file, width_px: widthPx, height_px: heightPx };
    },
  };
  const cliDescriptions: Record<string, string> = {
    new_schematic: 'Replace the project with an empty one (optionally named). Nothing is asked; the old content is gone from this file.',
    pcb_export:
      'Write the fabrication files to <project>-fab/ next to the project file: Gerber + drill zip, JLCPCB BOM and CPL (pick-and-place, y measured up from the bottom edge as JLCPCB expects) and a netlist. Returns the paths and any DRC errors. With hand_solder_through_hole, through-hole parts stay out of the BOM and CPL so JLCPCB does not charge for soldering them.',
    pcb_render:
      'Draw the board as a PNG in <project>-renders/ and return its path; open it with an image viewer (Claude Code’s Read tool shows it). Copper is top red, bottom blue, through-hole gold; pours, silkscreen, metal connector bodies (dashed orange), unrouted connections (dashed white), DRC markers (red errors, amber warnings) and millimetre rulers along the top and left edges are drawn too.',
  };
  const describe = (tool: (typeof TOOLS)[number]) => cliDescriptions[tool.name] ?? tool.description;
  // First sentence for the tool list; "e.g." and "i.e." don't end one.
  const firstSentence = (text: string) => /^.*?(?<!\be\.g|\bi\.e)\.(?=\s|$)/.exec(text)?.[0] ?? text;

  const run = async (name: string, input: Json) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool "${name}". Run "tools" to list them.`);
    const result = overrides[name] ? await overrides[name](validateInput(tool, input)) : await runTool(tool, input);
    if (!tool.annotations?.readOnlyHint) save();
    return result;
  };

  const parseJson = (text: string | undefined, what: string): unknown => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (err) {
      fail(`${what} is not valid JSON: ${(err as Error).message}`, 2);
    }
  };

  let output: unknown;
  switch (command) {
    case 'tools': {
      const tool = rest[0] ? TOOLS.find((t) => t.name === rest[0]) : undefined;
      if (rest[0] && !tool) fail(`Unknown tool "${rest[0]}"`);
      output = tool
        ? { name: tool.name, description: describe(tool), input: tool.inputSchema }
        : TOOLS.map((t) => ({ name: t.name, read_only: !!t.annotations?.readOnlyHint, description: firstSentence(describe(t)) }));
      break;
    }
    case 'batch': {
      const source = rest[0] === '-' || !rest[0] ? readFileSync(0, 'utf8') : readFileSync(resolve(rest[0]), 'utf8');
      const steps = parseJson(source, 'batch file');
      if (!Array.isArray(steps)) fail('batch input must be a JSON array of { "tool": "...", "input": {...} }', 2);
      const keepGoing = rest.includes('--keep-going');
      const results: { step: number; tool: string; ok: boolean; result?: unknown; error?: string }[] = [];
      for (const [i, step] of (steps as { tool: string; input?: Json }[]).entries()) {
        try {
          results.push({ step: i, tool: step.tool, ok: true, result: await run(step.tool, step.input ?? {}) });
        } catch (err) {
          results.push({ step: i, tool: step.tool, ok: false, error: (err as Error).message });
          if (!keepGoing) break;
        }
      }
      output = results;
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      break;
    }
    case 'summary': {
      const project = st().project;
      const conn = connectivity(project);
      const bom = buildBom(project.components);
      const pcb = project.pcb;
      let pcbSummary: unknown = null;
      if (pcb?.placements.length) {
        const { conn: pconn } = boardModel(project);
        const issues = checkPcb(project).issues;
        pcbSummary = {
          board_mm: [pcb.board.width, pcb.board.height],
          parts: pcb.placements.length,
          tracks: pcb.tracks.length,
          vias: pcb.vias.length,
          pours: (pcb.pours ?? []).map((p) => `${p.net}/${p.layer}`),
          unrouted: [...pconn.unrouted.values()].reduce((a, b) => a + b, 0),
          drc_errors: issues.filter((i) => i.severity === 'error').map((i) => i.message),
          drc_warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
        };
      }
      output = {
        file: projectPath,
        name: project.name,
        components: project.components.map((c) => `${c.designator} ${c.value}${c.lcsc ? ` ${c.lcsc} ${c.partClass ?? ''}` : ' (no LCSC part)'}`.trim()),
        nets: conn.nets.length,
        schematic_issues: conn.issues.map((i) => `${i.severity}: ${i.message}`),
        bom: { unique: bom.uniqueParts, by_type: bom.byClass, extended_setup_fee_usd: bom.setupFee },
        pcb: pcbSummary,
      };
      break;
    }
    case 'export': {
      const dir = resolve(rest[0] ?? join(dirname(projectPath), `${slug}-fab`));
      output = { files: exportTo(dir) };
      break;
    }
    default: {
      try {
        output = await run(command, parseJson(rest[0], 'tool input') as Json);
      } catch (err) {
        fail((err as Error).message);
      }
    }
  }
  // Exit only once the output is flushed (a pipe takes large outputs in chunks); exiting at all is
  // needed because pending autosave timers in the store would otherwise keep the process alive.
  process.stdout.write(JSON.stringify(output, null, 2) + '\n', () => process.exit(process.exitCode ?? 0));
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
