/*
 * WebMCP: exposes the editor to in-browser AI agents as tools.
 *
 * Spec (W3C WebML CG draft, 2026): document.modelContext.registerTool(tool, { signal }),
 * where tool = { name, title?, description, inputSchema, execute(input, { signal }), annotations? }
 * and execute's resolved value is JSON-serialized for the agent. Earlier Chrome builds and the
 * MCP-B polyfill expose navigator.modelContext instead and expect MCP-style
 * { content: [{ type: 'text', text }] } results; both are supported.
 */
import { useEditor } from '../store/editor';
import { fetchPartDetail, fetchSearch } from './api';
import {
  attachPort,
  connectPins,
  connectivity,
  designatorPrefix,
  disconnectPin,
  findPin,
  markNoConnect,
  nextFreePosition,
  pinGridOffset,
  placePartAt,
  replacePart,
} from './actions';
import { bomToJlcpcbCsv, buildBom } from './schematic/bom';
import { worldPins } from './schematic/geometry';
import { parseSymbol } from './easyeda/symbol';
import { deleteItems, updateComponentItem } from './schematic/ops';
import { resolverFor, symbolFor } from './schematic/symbols';
import type { Component, Rotation } from './schematic/types';
import { fitView, newProject, reannotate } from './editing';
import { EXTENDED_SETUP_FEE, PART_CLASSES, splitPackageQuery, type PartClass, type SortKey } from '../shared/parts';
import { PASSIVES, PASSIVE_KINDS, type PassiveKind } from '../shared/passives';
import { assignPassive, noFeeSizes, placePassiveAt } from './passives';
import { BLOCKS, insertBlock } from './blocks';
import { addDecoupling } from './decoupling';
import { addCutout, addKeepout, addLogo, addMountingHoles, addPours, addText, addVias, autoroute, boardModel, boardNets, checkPcb, currentPcb, exportFabrication, removePcbItems, removePours, planeLayers, setBoardOutline, setLayerCount, exportStep, syncPcb, throughHoleParts, updateBoard, updateLabel, updateLogo, updatePlacement, updateText } from './pcb/actions';
import { designatorLabel, logoBox, silkTextBox, TEXT_SIZE } from './pcb/silk';
import { checklistReady, drilledHoles, jlcpcbChecklist, viaHoleConflict } from './pcb/jlcpcb';
import { supportedChar } from './pcb/font';
import { rasterizeInBrowser, traceBitmap, type Bitmap } from './pcb/logo';
import type { Box } from './pcb/geometry';
import { boardEdges, circlePolygon, cornerHolePositions, edgeDistance, insideBoard, rectOutline, selfIntersects } from './pcb/outline';
import { runDrc, shellAreas } from './pcb/drc';
import { renderPcbSvg } from './pcb/render';
import { fitPcbView } from './pcb/view';
import { DEFAULT_HOLE, copperLayers, type Side, type CopperLayer, type Pcb, type Pour, type SilkText } from './pcb/types';

type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

const st = () => useEditor.getState();

const pinRefSchema = (description: string) => ({
  type: 'string',
  description: `${description} Format "<designator>.<pin number or name>", e.g. "R1.2", "U1.VIN", "U2.PA9".`,
});

function componentInfo(c: Component, withPins = true) {
  const project = st().project;
  const conn = connectivity(project);
  const pins = withPins
    ? worldPins(c, symbolFor(project, c.symbolKey)).map((p) => ({
        number: p.pin.number,
        name: p.pin.name !== p.pin.number ? p.pin.name : undefined,
        x: p.at[0],
        y: p.at[1],
        net: conn.pinNet.get(`${c.id}:${p.pin.id}`) ?? null,
      }))
    : undefined;
  return {
    designator: c.designator,
    value: c.value,
    lcsc: c.lcsc ?? null,
    part_type: c.partClass ?? null,
    mpn: c.attrs['Manufacturer Part'] ?? null,
    package: c.attrs['Package'] ?? null,
    generic: c.generic ? `${c.generic.kind} ${c.generic.size}` : undefined,
    x: c.x,
    y: c.y,
    rotation: c.rotation,
    pins,
  };
}

const byDesignator = (d: string) => {
  const c = st().project.components.find((x) => x.designator.toLowerCase() === String(d).toLowerCase());
  if (!c) throw new Error(`No component with designator ${d}`);
  return c;
};

const asRotation = (r: unknown): Rotation | undefined => {
  if (r === undefined || r === null) return undefined;
  const n = ((Math.round(Number(r) / 90) * 90) % 360 + 360) % 360;
  return n as Rotation;
};

/** Component ids of the through-hole parts on the board. */
export function throughHoleIds(): Set<string> {
  return new Set(throughHoleParts(boardModel().board).map((c) => c.id));
}

/** The board picture pcb_render draws, from the tool's input. */
export function pcbPicture(input: Record<string, unknown>) {
  const { pcb, board, conn } = boardModel();
  if (!pcb.placements.length) throw new Error('The PCB is empty; run pcb_update first');
  const net = input.highlight_net === undefined ? null : String(input.highlight_net);
  if (net && !board.pads.some((p) => p.net === net)) throw new Error(`No pad is on net "${net}"`);
  return renderPcbSvg(pcb, board, conn, runDrc(board, pcb, conn), {
    layers: (input.layers as 'both' | 'top' | 'bottom' | undefined) ?? 'both',
    highlightNet: net,
    widthPx: input.width_px === undefined ? undefined : Number(input.width_px),
  });
}

const pointSchema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const outlineSchema = (description: string) => ({ type: 'array', items: pointSchema, minItems: 3, description: `${description} Closed polygon as [x, y] points in mm (the last point joins the first).` });
const rectSchema = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: `${description} Rectangle as [x1, y1, x2, y2] in mm.` });

/** A polygon from an `outline` or `rect` input (one of them), checked for shape. */
function areaInput(input: Record<string, unknown>, what: string, required = true): [number, number][] | null {
  if (input.outline !== undefined && input.rect !== undefined) throw new Error(`Give either outline or rect for the ${what}, not both`);
  if (input.rect !== undefined) {
    const r = input.rect as number[];
    if (r.length !== 4) throw new Error('rect must be [x1, y1, x2, y2]');
    if (Math.abs(r[2] - r[0]) < 0.1 || Math.abs(r[3] - r[1]) < 0.1) throw new Error(`The ${what} rectangle has no area`);
    return rectOutline(r[0], r[1], r[2], r[3]);
  }
  if (input.outline !== undefined) {
    const pts = (input.outline as number[][]).map((p) => {
      if (p.length !== 2) throw new Error(`Each outline point must be [x, y], got ${JSON.stringify(p)}`);
      return [p[0], p[1]] as [number, number];
    });
    if (pts.length < 3) throw new Error(`The ${what} outline needs at least 3 points`);
    if (selfIntersects(pts)) throw new Error(`The ${what} outline crosses itself; list the corners in order around the shape`);
    return pts;
  }
  if (required) throw new Error(`Give the ${what} as outline (points) or rect ([x1, y1, x2, y2])`);
  return null;
}

/** Silkscreen that would be cut off: corners of `box` outside the board. */
function offBoard(box: Box): boolean {
  const edges = boardEdges(currentPcb());
  return !([[box.x1, box.y1], [box.x2, box.y1], [box.x2, box.y2], [box.x1, box.y2]] as [number, number][]).every((p) => insideBoard(p, edges));
}

/** The given layers, refusing inner ones on a 2-layer board. */
function checkLayers(layers: CopperLayer[]): CopperLayer[] {
  const stack = copperLayers(currentPcb());
  const missing = layers.filter((l) => !stack.includes(l));
  if (missing.length) throw new Error(`The board has no ${missing.join(' or ')} layer; make it a 4-layer board with pcb_set_board { "layers": 4 } first`);
  return layers;
}

const sideOf = (v: unknown): Side | undefined => (v === 'top' || v === 'bottom' ? v : undefined);

/** Traces a rasterised image and places it as a logo; shared by the browser and the command line. */
export function placeTracedLogo(input: Record<string, unknown>, bitmap: Bitmap) {
  const { shapes, aspect } = traceBitmap(bitmap, { invert: !!input.invert, threshold: input.threshold === undefined ? undefined : Number(input.threshold) });
  const b = currentPcb().board;
  const width = Number(input.width);
  const logo = addLogo({
    name: input.name ? String(input.name) : 'logo',
    x: input.x === undefined ? b.x + b.width / 2 : Number(input.x),
    y: input.y === undefined ? b.y + b.height / 2 : Number(input.y),
    width,
    height: width * aspect,
    rotation: input.rotation === undefined ? 0 : Number(input.rotation),
    side: sideOf(input.side) ?? 'top',
    shapes,
  });
  const box = logoBox(logo);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    id: logo.id,
    width: logo.width,
    height: r(logo.height),
    bbox: { x1: r(box.x1), y1: r(box.y1), x2: r(box.x2), y2: r(box.y2) },
    shapes: shapes.length,
    warning: offBoard(box) ? 'Part of the logo is off the board and will be cut off; move it or make it smaller.' : undefined,
  };
}

const roundPts = (pts: [number, number][]) => pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);

/** Explains an extended pick for a generic passive and names sizes that have a no-fee part. */
async function extendedNote(c: Component): Promise<string | undefined> {
  if (c.partClass !== 'extended' || !c.generic) return undefined;
  const { kind, size } = c.generic;
  const others = await noFeeSizes(kind, c.value, size);
  const alternatives = others.length
    ? `Basic/preferred parts exist in ${others.map((o) => `${o.size} (${o.lcsc})`).join(', ')}; switch with set_passive.`
    : 'Other sizes have none either.';
  return `Extended part ($${EXTENDED_SETUP_FEE} setup fee): no basic or preferred ${c.value} is in stock in ${size}. ${alternatives}`;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_parts',
    title: 'Search JLCPCB parts',
    description:
      'Search the JLCPCB/LCSC parts library (7M+ parts). Each result says whether it is a JLCPCB "basic" part (no assembly setup fee), "preferred" (promotional extended, fee waived) or "extended" ($3 setup fee per unique part). Prefer basic/preferred parts unless the design needs something else.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, MPN or LCSC number, e.g. "10k 0603", "AMS1117-3.3", "C25804".' },
        part_types: {
          type: 'array',
          items: { type: 'string', enum: PART_CLASSES },
          description: 'Restrict to these JLCPCB part types. Omit for all.',
        },
        in_stock_only: { type: 'boolean', description: 'Only parts JLCPCB has in stock (default true).' },
        sort: { type: 'string', enum: ['relevance', 'stock', 'price'], description: 'Result order (default relevance).' },
        package: { type: 'string', description: 'Exact package filter, e.g. "0603", "SOT-23-5".' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      const types = Array.isArray(input.part_types) ? (input.part_types as string[]).filter((t): t is PartClass => (PART_CLASSES as string[]).includes(t)) : [];
      const split = splitPackageQuery(String(input.query ?? ''));
      const query = {
        q: split.keyword,
        types,
        inStock: input.in_stock_only !== false,
        sort: (['relevance', 'stock', 'price'].includes(String(input.sort)) ? input.sort : 'relevance') as SortKey,
        packages: input.package ? [String(input.package)] : split.packages,
        page: 1,
        pageSize: Math.min(50, Math.max(1, Number(input.limit) || 10)),
      };
      const res = await fetchSearch(query);
      st().requestLibrary(String(input.query ?? ''));
      // An empty filtered search doesn't say whether the words or the filter were wrong.
      let hint: string | undefined;
      if (res.total === 0) {
        const unfiltered = types.length ? (await fetchSearch({ ...query, types: [], pageSize: 1 })).total : 0;
        hint = unfiltered
          ? `No ${types.join('/')} part matches these words, but ${unfiltered} other in-stock parts do; they are extended ($${EXTENDED_SETUP_FEE} setup fee each). The keyword search is literal, so a basic part may still exist under other words: try a common MPN family or the exact value and package.`
          : 'Nothing matches. Use fewer or more common keywords, an MPN family, or drop the package filter (JLCPCB calls USB-C connectors "Type-C").';
      }
      return {
        hint,
        total: res.total,
        parts: res.parts.map((p) => ({
          lcsc: p.lcsc,
          mpn: p.mpn,
          manufacturer: p.manufacturer,
          package: p.package,
          part_type: p.partClass,
          stock: p.stock,
          unit_price_usd: p.prices[0]?.price ?? null,
          description: p.description,
          category: [p.category, p.subcategory].filter(Boolean).join(' / '),
        })),
      };
    },
  },
  {
    name: 'get_part_details',
    title: 'Get part details',
    description: 'Full details for one LCSC part: JLCPCB part type, stock, price breaks, parameters, footprint and the schematic symbol pin list.',
    inputSchema: {
      type: 'object',
      properties: { lcsc: { type: 'string', description: 'LCSC part number, e.g. "C6186".' } },
      required: ['lcsc'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      const d = await fetchPartDetail(String(input.lcsc));
      const symbol = d.device?.symbol ? parseSymbol(d.device.symbol.dataStr, d.device.title) : null;
      return {
        lcsc: d.part?.lcsc ?? d.device?.lcsc,
        mpn: d.part?.mpn ?? d.device?.title,
        manufacturer: d.part?.manufacturer,
        part_type: d.part?.partClass ?? null,
        stock: d.part?.stock ?? null,
        prices: d.part?.prices ?? [],
        package: d.part?.package,
        footprint: d.device?.footprint?.title ?? null,
        description: d.part?.description,
        datasheet: d.part?.datasheet,
        parameters: Object.fromEntries((d.part?.attributes ?? []).map((a) => [a.name, a.value])),
        designator_prefix: designatorPrefix(d.device?.attributes['Designator']) || symbol?.prefix || null,
        units: symbol?.units.length ?? 0,
        pins: symbol?.units.flatMap((u) => u.pins.map((p) => ({ number: p.number, name: p.name }))) ?? [],
      };
    },
  },
  {
    name: 'place_part',
    title: 'Place part',
    description:
      'Place an LCSC part on the schematic. Coordinates use a 10-unit grid (y grows downwards); the position is nudged by up to 5 units so every pin lands on a multiple of 10. Omit x/y to place to the right of the existing drawing. Returns the designator and the absolute position of every pin.',
    inputSchema: {
      type: 'object',
      properties: {
        lcsc: { type: 'string', description: 'LCSC part number from search_parts.' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'integer', enum: [0, 90, 180, 270], description: 'Counter-clockwise rotation in degrees.' },
        designator: { type: 'string', description: 'Optional designator, e.g. "R5". Auto-assigned when omitted.' },
        value: { type: 'string', description: 'Optional value text shown on the schematic.' },
      },
      required: ['lcsc'],
    },
    execute: async (input) => {
      const c = await placePartAt(String(input.lcsc), {
        x: input.x === undefined ? undefined : Number(input.x),
        y: input.y === undefined ? undefined : Number(input.y),
        rotation: asRotation(input.rotation),
        designator: input.designator ? String(input.designator) : undefined,
        value: input.value ? String(input.value) : undefined,
      });
      st().setSelection([c.id]);
      return componentInfo(c);
    },
  },
  {
    name: 'place_passive',
    title: 'Place resistor / capacitor / …',
    description:
      'Place a generic passive by value and size; the cheapest-to-assemble in-stock JLCPCB part is matched automatically (basic first, then preferred, then extended). Values accept forms like "10k", "4k7", "100n", "0.1u", "10u 16V", "22uH"; LEDs take a colour, diodes a part number (e.g. "SS34").',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: PASSIVE_KINDS },
        value: { type: 'string' },
        size: { type: 'string', description: 'Imperial chip size ("0402", "0603", "0805", "1206") or diode package ("SOD-123", "SMA").' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'integer', enum: [0, 90, 180, 270] },
        designator: { type: 'string' },
      },
      required: ['kind', 'value'],
    },
    execute: async (input) => {
      const kind = input.kind as PassiveKind;
      if (!PASSIVE_KINDS.includes(kind)) throw new Error(`kind must be one of ${PASSIVE_KINDS.join(', ')}`);
      const size = input.size ? String(input.size) : PASSIVES[kind].defaultSize;
      const at: [number, number] = input.x !== undefined && input.y !== undefined ? [Number(input.x), Number(input.y)] : nextFreePosition();
      const { component, match } = await placePassiveAt(kind, String(input.value), size, at, asRotation(input.rotation), input.designator ? String(input.designator) : undefined);
      st().setSelection([component.id]);
      return {
        ...componentInfo(component),
        match_error: match?.error ?? (match?.candidates.length ? undefined : 'No in-stock JLCPCB part found; component left unassigned'),
        note: await extendedNote(component),
      };
    },
  },
  {
    name: 'set_passive',
    title: 'Change passive value / size',
    description: 'Change the value and/or size of placed generic passives (resistors, capacitors, …) and re-match their JLCPCB part.',
    inputSchema: {
      type: 'object',
      properties: {
        designators: { type: 'array', items: { type: 'string' }, minItems: 1 },
        value: { type: 'string' },
        size: { type: 'string' },
      },
      required: ['designators'],
    },
    execute: async (input) => {
      const list = (input.designators as string[]).map(byDesignator);
      const bad = list.filter((c) => !c.generic).map((c) => c.designator);
      if (bad.length) throw new Error(`${bad.join(', ')} are not generic passives; use replace_part instead`);
      await assignPassive(
        list.map((c) => c.id),
        { value: input.value === undefined ? undefined : String(input.value), size: input.size === undefined ? undefined : String(input.size) },
      );
      const updated = list.map((c) => st().project.components.find((x) => x.id === c.id)!);
      const notes = (
        await Promise.all(
          updated.map(async (c) => {
            const note = await extendedNote(c);
            return note ? `${c.designator}: ${note}` : null;
          }),
        )
      ).filter(Boolean);
      return { components: updated.map((c) => componentInfo(c, false)), notes: notes.length ? notes : undefined };
    },
  },
  {
    name: 'list_components',
    title: 'List components',
    description: 'Every component on the schematic with value, LCSC part, JLCPCB part type, position and pins (with the net each pin is on).',
    inputSchema: { type: 'object', properties: { include_pins: { type: 'boolean', description: 'Include pin lists (default true).' } } },
    annotations: { readOnlyHint: true },
    execute: async (input) => ({ components: st().project.components.map((c) => componentInfo(c, input.include_pins !== false)) }),
  },
  {
    name: 'connect_pins',
    title: 'Connect two pins',
    description: 'Draw an orthogonal wire between two pins. For power rails and long distances prefer add_net_label / add_power_flag on each pin instead of long wires.',
    inputSchema: {
      type: 'object',
      properties: { from: pinRefSchema('First pin.'), to: pinRefSchema('Second pin.') },
      required: ['from', 'to'],
    },
    execute: async (input) => connectPins(String(input.from), String(input.to)),
  },
  {
    name: 'add_net_label',
    title: 'Add net label',
    description: 'Attach a net label to a pin (short wire stub + label). Pins with the same label name are connected.',
    inputSchema: {
      type: 'object',
      properties: { pin: pinRefSchema('Pin to label.'), name: { type: 'string', description: 'Net name, e.g. "SDA", "EN".' } },
      required: ['pin', 'name'],
    },
    execute: async (input) => {
      const port = attachPort(String(input.pin), 'label', String(input.name));
      return { net: port.name, x: port.x, y: port.y };
    },
  },
  {
    name: 'add_power_flag',
    title: 'Add power or ground flag',
    description: 'Attach a power (e.g. "+3V3", "VCC", "+5V") or ground ("GND") flag to a pin. All flags with the same net name are connected.',
    inputSchema: {
      type: 'object',
      properties: {
        pin: pinRefSchema('Pin to connect.'),
        net: { type: 'string', description: 'Net name, e.g. "GND", "+3V3".' },
        style: { type: 'string', enum: ['power', 'ground'], description: 'Symbol style; defaults to ground for names containing GND.' },
      },
      required: ['pin', 'net'],
    },
    execute: async (input) => {
      const net = String(input.net);
      const style = input.style === 'power' || input.style === 'ground' ? input.style : /gnd|vss/i.test(net) ? 'ground' : 'power';
      const port = attachPort(String(input.pin), style, net);
      return { net: port.name, style, x: port.x, y: port.y };
    },
  },
  {
    name: 'mark_no_connect',
    title: 'Mark pin as not connected',
    description: 'Place a no-connect flag on a pin that is intentionally left unconnected (silences the design check).',
    inputSchema: { type: 'object', properties: { pin: pinRefSchema('Pin to mark.') }, required: ['pin'] },
    execute: async (input) => {
      markNoConnect(String(input.pin));
      return { ok: true };
    },
  },
  {
    name: 'insert_block',
    title: 'Insert circuit block',
    description: `Insert a proven sub-circuit with its parts, wiring, labels and power flags in one step (one undo step), to the right of the drawing unless x/y are given. Blocks: ${BLOCKS.map((b) => `${b.id} (${b.title}; params ${b.params.map((p) => `${p.key}="${p.default}"`).join(', ')})`).join('; ')}. Parameters left out take those defaults. Returns the designator of each part and the nets it uses; check the result with check_design and move the parts where they belong.`,
    inputSchema: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: BLOCKS.map((b) => b.id) },
        params: { type: 'object', description: 'Net names and values, e.g. {"VIN": "+5V", "VOUT": "+3V3"}.', additionalProperties: { type: 'string' } },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['block'],
    },
    execute: async (input) => {
      const params = Object.fromEntries(Object.entries((input.params as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]));
      const at: [number, number] | undefined = input.x !== undefined && input.y !== undefined ? [Number(input.x), Number(input.y)] : undefined;
      const r = await insertBlock(String(input.block), params, at);
      st().setSelection(r.ids);
      return { parts: r.parts, nets: r.nets };
    },
  },
  {
    name: 'add_decoupling',
    title: 'Add decoupling capacitors',
    description:
      'Add decoupling for an IC: 100 nF per supply pin (VDD, VCC, VIN…), 1 µF + 10 nF on analog supply pins (VDDA, AVCC) and a 10 µF bulk capacitor per rail, in a row under the part with rail and GND flags (one undo step). Capacitors on rails above 5 V get a voltage rating. Supply pins not yet on a named net need `rail` and are connected to it.',
    inputSchema: {
      type: 'object',
      properties: {
        designator: { type: 'string', description: 'The IC, e.g. "U2".' },
        rail: { type: 'string', description: 'Rail for supply pins not yet on a named net, e.g. "+3V3".' },
        value: { type: 'string', description: 'Capacitor per supply pin (default "100n").' },
        size: { type: 'string', description: 'Chip size for those capacitors (default "0603"); bulk capacitors are 0805.' },
        bulk: { type: 'boolean', description: 'Add a 10 µF bulk capacitor per rail (default true).' },
      },
      required: ['designator'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      const r = await addDecoupling(c.id, {
        rail: input.rail === undefined ? undefined : String(input.rail),
        value: input.value === undefined ? undefined : String(input.value),
        size: input.size === undefined ? undefined : String(input.size),
        bulk: input.bulk === undefined ? undefined : Boolean(input.bulk),
      });
      st().setSelection(r.ids);
      return { capacitors: r.caps.map((cap) => ({ designator: cap.designator, value: cap.value, rail: cap.rail, for_pin: cap.pin ?? 'bulk' })), connected_pins: r.connected.length ? r.connected : undefined };
    },
  },
  {
    name: 'disconnect_pin',
    title: 'Disconnect pin',
    description:
      'Undo connections at a pin: removes every wire that ends on it (including whole wires made by connect_pins, which also frees the pin at the other end), no-connect markers on it, and labels or flags left dangling by that. Returns what was removed and the pin’s net afterwards.',
    inputSchema: { type: 'object', properties: { pin: pinRefSchema('Pin to disconnect.') }, required: ['pin'] },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const removed = disconnectPin(String(input.pin));
      const p = findPin(String(input.pin));
      return { removed_wires: removed.wires, removed_labels: removed.labels, net: connectivity().pinNet.get(`${p.component.id}:${p.pin.id}`) ?? null };
    },
  },
  {
    name: 'update_component',
    title: 'Update component',
    description: 'Change a component’s value, designator, position or rotation. Wires attached to its pins follow it, as when dragging in the editor; check the returned pin nets afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        designator: { type: 'string', description: 'Current designator, e.g. "R1".' },
        value: { type: 'string' },
        new_designator: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'integer', enum: [0, 90, 180, 270] },
      },
      required: ['designator'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      const patch: Partial<Component> = {};
      if (typeof input.value === 'string') patch.value = input.value;
      if (typeof input.new_designator === 'string') patch.designator = input.new_designator;
      if (input.x !== undefined) patch.x = Number(input.x);
      if (input.y !== undefined) patch.y = Number(input.y);
      if (input.rotation !== undefined) patch.rotation = asRotation(input.rotation);
      if (patch.x !== undefined || patch.y !== undefined || patch.rotation !== undefined) {
        const [dx, dy] = pinGridOffset({ ...c, ...patch });
        patch.x = (patch.x ?? c.x) + dx;
        patch.y = (patch.y ?? c.y) + dy;
      }
      const project = st().project;
      const symbols = resolverFor(project);
      // Dragged wire ends can land on other wiring; refuse instead of silently joining nets.
      const before = connectivity(project).pinNet;
      const after = connectivity({ ...project, ...updateComponentItem(project, c.id, patch, symbols) });
      for (const net of after.nets) {
        const joined = new Set(net.members.map((m) => before.get(`${m.componentId}:${m.pinId}`)).filter(Boolean));
        if (joined.size > 1)
          throw new Error(
            `Not changed: the wires attached to ${c.designator} would join ${[...joined].join(' and ')} there. Choose another position or rotation, or delete its wires first and reconnect afterwards.`,
          );
      }
      st().commit((doc) => updateComponentItem(doc, c.id, patch, symbols));
      return componentInfo(st().project.components.find((x) => x.id === c.id)!);
    },
  },
  {
    name: 'replace_part',
    title: 'Replace part',
    description:
      'Swap the LCSC part used by a component (e.g. to move from an extended to a basic part). Keeps the designator, position and rotation. Warns when the new symbol numbers or places its pins differently, since wiring may then be wrong or loose.',
    inputSchema: {
      type: 'object',
      properties: { designator: { type: 'string' }, lcsc: { type: 'string' } },
      required: ['designator', 'lcsc'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      const wired = connectivity().pinNet;
      const before = worldPins(c, symbolFor(st().project, c.symbolKey));
      const updated = await replacePart(c.id, String(input.lcsc));
      if (!updated) return null;
      const after = worldPins(updated, symbolFor(st().project, updated.symbolKey));
      const named = (p: (typeof before)[number]) => p.pin.name && p.pin.name !== p.pin.number;
      const renamed: string[] = [];
      const loose: string[] = [];
      for (const b of before) {
        const a = after.find((p) => p.pin.number === b.pin.number);
        if (a && named(a) && named(b) && a.pin.name !== b.pin.name) renamed.push(`${b.pin.number} was ${b.pin.name}, now ${a.pin.name}`);
        if (wired.has(`${c.id}:${b.pin.id}`) && (!a || a.at[0] !== b.at[0] || a.at[1] !== b.at[1])) loose.push(b.pin.number);
      }
      const warnings = [
        renamed.length && `Pin numbering differs from the old symbol (${renamed.join('; ')}); address pins by name and check the connections.`,
        loose.length && `Wired pins ${loose.join(', ')} moved, so their wires no longer reach them; reconnect with disconnect_pin and the connect tools.`,
      ].filter(Boolean);
      return { ...componentInfo(updated), warnings: warnings.length ? warnings : undefined };
    },
  },
  {
    name: 'delete_components',
    title: 'Delete components',
    description: 'Delete components by designator. Wiring that only connected to them goes too: wires, labels, power flags and no-connect markers that no longer reach any other pin.',
    inputSchema: {
      type: 'object',
      properties: { designators: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['designators'],
    },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const list = (input.designators as string[]).map(byDesignator);
      const ids = new Set(list.map((c) => c.id));
      st().commit((doc) => deleteItems(doc, ids, resolverFor(st().project)));
      return { deleted: list.map((c) => c.designator) };
    },
  },
  {
    name: 'get_netlist',
    title: 'Get netlist',
    description: 'All nets with their connected pins, as currently drawn.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => ({
      nets: connectivity().nets.map((n) => ({ name: n.name, pins: n.members.map((m) => `${m.designator}.${m.pinNumber}${m.pinName && m.pinName !== m.pinNumber ? `(${m.pinName})` : ''}`) })),
    }),
  },
  {
    name: 'check_design',
    title: 'Check design (ERC)',
    description: 'Electrical rule check: unconnected pins, single-pin nets, nets with conflicting names, duplicate or unannotated designators.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const issues = connectivity().issues;
      return { ok: issues.filter((i) => i.severity === 'error').length === 0, issues: issues.map((i) => ({ severity: i.severity, message: i.message })) };
    },
  },
  {
    name: 'get_bom',
    title: 'Get BOM',
    description: `Bill of materials grouped by LCSC part with JLCPCB part types, stock and an estimate of extended-part setup fees ($${EXTENDED_SETUP_FEE} per unique extended part). parts_cost_usd is the total for all \`boards\` boards, not per board.`,
    inputSchema: {
      type: 'object',
      properties: {
        boards: { type: 'integer', minimum: 1, description: 'Number of boards for pricing (default 5).' },
        format: { type: 'string', enum: ['json', 'jlcpcb_csv'], description: 'json (default) or the CSV JLCPCB assembly accepts.' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const boards = Math.max(1, Number(input.boards) || 5);
      const bom = buildBom(st().project.components, boards);
      if (input.format === 'jlcpcb_csv') return { csv: bomToJlcpcbCsv(bom) };
      return {
        boards,
        unique_parts: bom.uniqueParts,
        total_parts: bom.totalParts,
        by_part_type: bom.byClass,
        extended_setup_fee_usd: bom.setupFee,
        parts_cost_usd: Math.round(bom.partsCost * 100) / 100,
        low_stock: bom.lowStock.map((l) => l.lcsc),
        lines: bom.lines.map((l) => ({
          designators: l.designators,
          value: l.value,
          lcsc: l.lcsc,
          part_type: l.partClass,
          quantity: l.quantity,
          footprint: l.footprint,
          stock: l.stock,
        })),
      };
    },
  },
  {
    name: 'annotate',
    title: 'Re-annotate designators',
    description: 'Renumber all designators by position (top-to-bottom, left-to-right).',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      reannotate();
      return { designators: st().project.components.map((c) => c.designator) };
    },
  },
  {
    name: 'focus_components',
    title: 'Show components',
    description: 'Select components and zoom the view to them so the user can see them. Pass no designators to fit the whole schematic.',
    inputSchema: { type: 'object', properties: { designators: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const list = Array.isArray(input.designators) ? (input.designators as string[]).map(byDesignator) : [];
      st().setSelection(list.map((c) => c.id));
      fitView(list.length ? list.map((c) => c.id) : undefined);
      return { focused: list.map((c) => c.designator) };
    },
  },
  {
    name: 'check_pin',
    title: 'Look up a pin',
    description: 'Position, direction and current net of a single pin.',
    inputSchema: { type: 'object', properties: { pin: pinRefSchema('Pin to look up.') }, required: ['pin'] },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const p = findPin(String(input.pin));
      const net = connectivity().pinNet.get(`${p.component.id}:${p.pin.id}`) ?? null;
      return { designator: p.component.designator, number: p.pin.number, name: p.pin.name, x: p.at[0], y: p.at[1], outward: [-p.dir[0], -p.dir[1]], net };
    },
  },
  {
    name: 'pcb_update',
    title: 'Update PCB from schematic',
    description:
      'Switch to the PCB editor and bring it in line with the schematic: loads each part’s JLCPCB footprint (built-in footprints for unmatched passives), adds new parts packed in schematic order and removes deleted ones. Existing positions and routing are kept.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      st().setMode('pcb');
      const r = await syncPcb();
      fitPcbView();
      return { added: r.added, removed: r.removed, without_footprint: r.missing };
    },
  },
  {
    name: 'pcb_get_state',
    title: 'Get PCB state',
    description:
      'Board outline (with `outline` and `cutouts` when the shape is custom), mounting holes, keepout areas, design rules, the total area of the parts’ bounding boxes, every placed part (position in mm, rotation, side, footprint, bounding box, metal_shell for connectors whose body must not cover other nets’ tracks), copper pours (id, zone outline when not the whole board, areas = separate copper regions; unconnected islands are already removed), unrouted connection counts per net (`unrouted`), and track/via counts. y grows downwards; the board origin is its top-left corner. With include_pads, each part also lists its pads (number, net, x, y) — useful for placing decoupling capacitors next to the right pins. With include_tracks, `routing` lists every track (net, layer, width, length, corner points) and via, so you can see where the router went.',
    inputSchema: {
      type: 'object',
      properties: {
        include_pads: { type: 'boolean', description: 'List every pad with its net and position (default false).' },
        include_tracks: { type: 'boolean', description: 'List every track and via with net and coordinates (default false).' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const { pcb, board, conn } = boardModel();
      const round = (v: number) => Math.round(v * 1000) / 1000;
      const partArea = board.parts.reduce((sum, p) => sum + (p.fp ? (p.box.x2 - p.box.x1) * (p.box.y2 - p.box.y1) : 0), 0);
      const shelled = new Set(shellAreas(board).map((a) => a.part.component.id));
      const length = (points: [number, number][]) => points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - points[i][0], q[1] - points[i][1]), 0);
      return {
        board: pcb.board,
        layers: copperLayers(pcb),
        planes: planeLayers(pcb).size ? Object.fromEntries(planeLayers(pcb)) : undefined,
        rules: pcb.rules,
        part_area_mm2: Math.round(partArea),
        parts: board.parts.map((p) => ({
          designator: p.component.designator,
          x: round(p.placement.x),
          y: round(p.placement.y),
          rotation: p.placement.rotation,
          side: p.placement.side,
          footprint: pcb.footprints[pcb.footprintOf[p.component.id] ?? '']?.title ?? null,
          bbox: p.fp ? { x1: round(p.box.x1), y1: round(p.box.y1), x2: round(p.box.x2), y2: round(p.box.y2) } : null,
          metal_shell: shelled.has(p.component.id) || undefined,
          label: p.fp ? (({ at, size, rotation, hidden }) => ({ x: round(at[0]), y: round(at[1]), size, rotation, hidden: hidden || undefined }))(designatorLabel(p)) : undefined,
          pads: input.include_pads ? p.pads.map((pad) => ({ number: pad.number, net: pad.net, x: round(pad.center[0]), y: round(pad.center[1]) })) : undefined,
        })),
        holes: pcb.holes?.length ? pcb.holes : undefined,
        keepouts: pcb.keepouts?.length ? pcb.keepouts : undefined,
        texts: pcb.texts?.length ? pcb.texts : undefined,
        logos: pcb.logos?.length ? pcb.logos.map(({ shapes: _shapes, ...l }) => ({ ...l, height: round(l.height) })) : undefined,
        pours: board.fills.map((f) => ({
          id: f.pour.id,
          net: f.pour.net,
          zone: f.pour.outline ? roundPts(f.pour.outline as [number, number][]) : undefined,
          layer: f.pour.layer,
          clearance: f.pour.clearance,
          connection: f.pour.connection,
          areas: f.areas.length,
          weak_thermals: f.thermals.filter((t) => t.spokes < 2).map((t) => `${t.designator}.${t.number}`),
        })),
        unrouted: Object.fromEntries([...conn.unrouted].filter(([, n]) => n > 0)),
        tracks: pcb.tracks.length,
        vias: pcb.vias.length,
        routing: input.include_tracks
          ? {
              tracks: pcb.tracks.map((t) => ({
                net: conn.itemNet.get(t.id) ?? t.net,
                layer: t.layer,
                width: t.width,
                length_mm: round(length(t.points)),
                points: t.points.map(([x, y]) => [round(x), round(y)]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]),
              })),
              vias: pcb.vias.map((v) => ({ net: conn.itemNet.get(v.id) ?? v.net, x: round(v.x), y: round(v.y) })),
            }
          : undefined,
      };
    },
  },
  {
    name: 'pcb_render',
    title: 'Render PCB',
    description:
      'Draw the board as a picture: copper (top red, bottom blue, through-hole gold), pours, silkscreen, metal connector bodies (dashed orange), unrouted connections (dashed white), DRC markers (red errors, amber warnings) and millimetre rulers along the top and left edges. Use it to check placement and routing by eye. Returns SVG markup here; the command line writes a PNG file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        layers: { type: 'string', enum: ['both', 'top', 'inner1', 'inner2', 'bottom'], description: 'Copper layers to draw: both (default, every layer, top over the rest) or one layer alone (inner layers on 4-layer boards).' },
        highlight_net: { type: 'string', description: 'Draw this net in white and fade the rest.' },
        width_px: { type: 'integer', minimum: 300, maximum: 4000, description: 'Picture width in pixels (default 1400).' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const { svg, widthPx, heightPx } = pcbPicture(input);
      return { svg, width_px: widthPx, height_px: heightPx };
    },
  },
  {
    name: 'pcb_set_board',
    title: 'Set board shape',
    description:
      'Set the board size in millimetres (a rectangle with optional corner radius), or give `outline` for a custom shape (an L, a notched or angled board, one that fits an enclosure); the corner radius rounds its corners too. Width/height go back to a rectangle. Parts outside the new shape show up in pcb_check. `layers` switches between 2 and 4 copper layers (top, inner1, inner2, bottom); going back to 2 deletes inner-layer tracks and pours.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', minimum: 5 },
        height: { type: 'number', minimum: 5 },
        corner_radius: { type: 'number', minimum: 0 },
        layers: { type: 'integer', enum: [2, 4], description: 'Copper layers (default 2). 4 adds two inner layers, usually a GND plane and a power plane.' },
        outline: outlineSchema('Custom board shape.'),
      },
    },
    execute: async (input) => {
      if (input.outline !== undefined && (input.width !== undefined || input.height !== undefined)) throw new Error('Give either outline or width/height, not both');
      if (input.outline !== undefined) setBoardOutline(areaInput(input, 'board'));
      const patch: Partial<Pcb['board']> = {};
      if (input.width !== undefined || input.height !== undefined) patch.outline = undefined;
      if (input.width !== undefined) patch.width = Number(input.width);
      if (input.height !== undefined) patch.height = Number(input.height);
      if (input.corner_radius !== undefined) patch.cornerRadius = Number(input.corner_radius);
      if (Object.keys(patch).length) updateBoard(patch);
      const removed = input.layers === undefined ? undefined : setLayerCount(Number(input.layers) as 2 | 4);
      return { board: currentPcb().board, removed: removed && (removed.removedTracks || removed.removedPours) ? { inner_tracks: removed.removedTracks, inner_pours: removed.removedPours } : undefined };
    },
  },
  {
    name: 'pcb_add_mounting_holes',
    title: 'Add mounting holes',
    description:
      'Drill non-plated mounting holes (default 3.2 mm for M3 screws) at the given points, or one in each corner with `corners`. Each hole has a copper-free ring (`keepout` diameter, default 6.4 mm for the screw head): no tracks, vias, pours or parts inside it, which the router and pcb_check respect. Place holes before routing.',
    inputSchema: {
      type: 'object',
      properties: {
        points: { type: 'array', items: pointSchema, minItems: 1, description: 'Hole centres as [x, y] in mm.' },
        corners: { type: 'boolean', description: 'One hole in each corner of the board’s bounding box.' },
        inset: { type: 'number', minimum: 1, description: 'With corners: distance from the edges to the hole centre (default keepout radius + 0.5 mm).' },
        diameter: { type: 'number', minimum: 0.5, maximum: 10, description: `Drill diameter in mm (default ${DEFAULT_HOLE.diameter}).` },
        keepout: { type: 'number', minimum: 0, maximum: 20, description: `Diameter of the copper-free ring in mm (default ${DEFAULT_HOLE.keepout}).` },
      },
    },
    execute: async (input) => {
      const diameter = input.diameter === undefined ? DEFAULT_HOLE.diameter : Number(input.diameter);
      const keepout = Math.max(diameter, input.keepout === undefined ? DEFAULT_HOLE.keepout : Number(input.keepout));
      const pcb = currentPcb();
      const inset = input.inset === undefined ? keepout / 2 + 0.5 : Number(input.inset);
      const points = [...((input.points as number[][] | undefined) ?? []).map(([x, y]) => [x, y] as [number, number]), ...(input.corners ? cornerHolePositions(pcb.board, inset) : [])];
      if (!points.length) throw new Error('Give points, or corners: true');
      const edges = boardEdges(pcb);
      const bad = points.filter((p) => !insideBoard(p, edges) || edgeDistance(p, edges) < diameter / 2 + 0.3);
      if (bad.length) throw new Error(`These holes would not fit inside the board (${diameter / 2 + 0.3} mm from every edge): ${bad.map((p) => `[${p.join(', ')}]`).join(', ')}`);
      const holes = addMountingHoles(points, diameter, keepout);
      const { issues } = checkPcb();
      const ids = new Set(holes.map((h) => h.id));
      const blocked = issues.filter((i) => i.refs?.some((r) => ids.has(r))).map((i) => i.message);
      return { holes, conflicts: blocked.length ? blocked : undefined };
    },
  },
  {
    name: 'pcb_add_keepout',
    title: 'Add keepout area',
    description:
      'Mark an area where copper must not go: under an antenna, a heat sink or a screw head, or a strip kept free along an edge. By default it keeps out tracks, vias and pours on both layers; set `parts` to keep parts out too. The router routes around it, pours leave it empty and pcb_check reports anything inside. Existing tracks are not moved: clear and re-route the nets that cross it.',
    inputSchema: {
      type: 'object',
      properties: {
        outline: outlineSchema('Keepout shape.'),
        rect: rectSchema('Keepout shape.'),
        layers: { type: 'array', items: { type: 'string', enum: ['top', 'inner1', 'inner2', 'bottom'] }, description: 'Default every copper layer of the board.' },
        tracks: { type: 'boolean', description: 'Keep tracks out (default true).' },
        vias: { type: 'boolean', description: 'Keep vias out (default true).' },
        pours: { type: 'boolean', description: 'Keep copper pours out (default true).' },
        parts: { type: 'boolean', description: 'Keep parts out (default false).' },
      },
    },
    execute: async (input) => {
      const outline = areaInput(input, 'keepout')!;
      const flags: Record<string, boolean> = {};
      for (const k of ['tracks', 'vias', 'pours', 'parts'] as const) if (input[k] !== undefined) flags[k] = Boolean(input[k]);
      const layers = Array.isArray(input.layers) && input.layers.length ? checkLayers(input.layers as CopperLayer[]) : undefined;
      const keepout = addKeepout(outline, { ...flags, ...(layers ? { layers } : {}) });
      const { issues } = checkPcb();
      const inside = issues.filter((i) => i.refs?.includes(keepout.id)).map((i) => i.message);
      return { keepout, conflicts: inside.length ? inside : undefined };
    },
  },
  {
    name: 'pcb_add_cutout',
    title: 'Add board cutout',
    description:
      'Mill an opening through the board (a slot for a cable or connector, a window for a sensor, a large round hole) given as outline, rect or circle. It goes on the outline (Edge_Cuts) layer; copper keeps the edge clearance from it. For screw holes use pcb_add_mounting_holes, which are drilled.',
    inputSchema: {
      type: 'object',
      properties: {
        outline: outlineSchema('Opening shape.'),
        rect: rectSchema('Opening shape.'),
        circle: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Round opening as [x, y, diameter] in mm.' },
      },
    },
    execute: async (input) => {
      let outline = areaInput(input, 'cutout', input.circle === undefined);
      if (input.circle !== undefined) {
        if (outline) throw new Error('Give one of outline, rect or circle');
        const [x, y, d] = input.circle as number[];
        if (!(d > 0.5)) throw new Error('The circle diameter must be over 0.5 mm');
        outline = circlePolygon([x, y], d / 2, 48).slice(0, -1) as [number, number][];
      }
      const edges = boardEdges(currentPcb());
      if (!outline!.every((p) => insideBoard(p, edges))) throw new Error('The cutout must lie inside the board outline; change the outline with pcb_set_board for a notch at the edge');
      return { cutout: { ...addCutout(outline!), outline: roundPts(outline!) } };
    },
  },
  {
    name: 'pcb_remove_features',
    title: 'Remove holes, keepouts, cutouts, pours, text or logos',
    description: 'Remove mounting holes, keepout areas, cutouts, copper pours, silkscreen text or logos by id (ids are in pcb_get_state).',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['ids'] },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const ids = new Set((input.ids as string[]).map(String));
      const removed = removePcbItems(ids);
      if (!removed) throw new Error('None of those ids is a mounting hole, keepout, cutout, pour, text or logo; see pcb_get_state');
      return { removed };
    },
  },
  {
    name: 'pcb_add_text',
    title: 'Add silkscreen text',
    description:
      'Print text on the board’s silkscreen: a board name and version, connector pin labels ("GND", "5V", "TX"), polarity marks or a URL. x/y is the centre of the text block; "\\n" starts a new line. Letters, digits and common punctuation (including ° µ Ω) are supported. JLCPCB prints text 1 mm or taller reliably (default 1.5 mm). Bottom-side text is mirrored so it reads correctly from below.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        x: { type: 'number' },
        y: { type: 'number' },
        size: { type: 'number', minimum: 0.5, maximum: 20, description: `Cap height in mm (default ${TEXT_SIZE}).` },
        rotation: { type: 'number', description: 'Degrees counter-clockwise (default 0).' },
        side: { type: 'string', enum: ['top', 'bottom'], description: 'Default top.' },
        stroke_width: { type: 'number', minimum: 0.1, maximum: 2, description: 'Line width in mm (default 15% of the size, at least JLCPCB’s 0.15 mm minimum).' },
      },
      required: ['text', 'x', 'y'],
    },
    execute: async (input) => {
      const value = String(input.text);
      const opts: Partial<SilkText> = { side: sideOf(input.side) ?? 'top' };
      if (input.size !== undefined) opts.size = Number(input.size);
      if (input.rotation !== undefined) opts.rotation = Number(input.rotation);
      if (input.stroke_width !== undefined) opts.stroke = Number(input.stroke_width);
      const t = addText(value, [Number(input.x), Number(input.y)], opts);
      const box = silkTextBox(t);
      const unsupported = [...new Set([...value].filter((ch) => !supportedChar(ch)))];
      const warnings = [
        ...(unsupported.length ? [`These characters print as "?": ${unsupported.join(' ')}`] : []),
        ...(offBoard(box) ? ['Part of the text is off the board and will be cut off.'] : []),
        ...(t.size < 1 ? ['Text under 1 mm may not be legible after printing.'] : []),
      ];
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return { id: t.id, bbox: { x1: r(box.x1), y1: r(box.y1), x2: r(box.x2), y2: r(box.y2) }, warnings: warnings.length ? warnings : undefined };
    },
  },
  {
    name: 'pcb_add_logo',
    title: 'Add a silkscreen logo',
    description:
      'Trace an image into silkscreen artwork: dark, opaque areas print (set invert for light artwork on a dark background). `image` is SVG markup, a data: URL or an image URL the page can load (on the command line also a PNG, JPEG or SVG file path). The logo is cropped to its artwork and scaled to `width` mm, keeping its aspect ratio; it is centred on x/y (default the board centre). Lines thinner than about 0.15 mm on the board may not print.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'SVG markup, data: URL or image URL (file path on the command line).' },
        width: { type: 'number', minimum: 1, maximum: 200, description: 'Width on the board in mm.' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'number' },
        side: { type: 'string', enum: ['top', 'bottom'], description: 'Default top.' },
        invert: { type: 'boolean', description: 'Trace light areas instead of dark ones.' },
        threshold: { type: 'number', minimum: 1, maximum: 254, description: 'Brightness (0–255) below which a pixel counts as dark (default 128).' },
        name: { type: 'string' },
      },
      required: ['image', 'width'],
    },
    execute: async (input) => placeTracedLogo(input, await rasterizeInBrowser(String(input.image))),
  },
  {
    name: 'pcb_update_silkscreen',
    title: 'Change silkscreen text or a logo',
    description: 'Move, resize, rotate, re-word or flip a silkscreen text or logo by id (from pcb_add_text, pcb_add_logo or pcb_get_state). For logos, size sets the width.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', minLength: 1 },
        x: { type: 'number' },
        y: { type: 'number' },
        size: { type: 'number', minimum: 0.5, maximum: 200 },
        rotation: { type: 'number' },
        side: { type: 'string', enum: ['top', 'bottom'] },
      },
      required: ['id'],
    },
    execute: async (input) => {
      const id = String(input.id);
      const pcb = currentPcb();
      const num = (k: string) => (input[k] === undefined ? undefined : Number(input[k]));
      const common = Object.fromEntries(Object.entries({ x: num('x'), y: num('y'), rotation: num('rotation'), side: sideOf(input.side) }).filter(([, v]) => v !== undefined));
      if (pcb.texts?.some((t) => t.id === id)) {
        updateText(id, { ...common, ...(input.text !== undefined ? { text: String(input.text) } : {}), ...(input.size !== undefined ? { size: Number(input.size) } : {}) });
        return currentPcb().texts!.find((t) => t.id === id);
      }
      if (pcb.logos?.some((l) => l.id === id)) {
        if (input.text !== undefined) throw new Error('A logo has no text; give size, x, y, rotation or side');
        updateLogo(id, { ...common, ...(input.size !== undefined ? { width: Number(input.size) } : {}) });
        const { shapes: _shapes, ...logo } = currentPcb().logos!.find((l) => l.id === id)!;
        return logo;
      }
      throw new Error(`No silkscreen text or logo with id ${id}; see pcb_get_state`);
    },
  },
  {
    name: 'pcb_set_designator',
    title: 'Move or style a designator',
    description:
      'Move a part’s printed designator (R1, U2 …) to x/y on the board, rotate or resize it, or hide it. The position is kept relative to the part, so it follows when the part moves. Use reset to go back to the default spot above the part. pcb_get_state lists each part’s current label position.',
    inputSchema: {
      type: 'object',
      properties: {
        designator: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'number', description: 'Degrees counter-clockwise as seen on the board.' },
        size: { type: 'number', minimum: 0.5, maximum: 5, description: 'Text height in mm (default 1, JLCPCB’s minimum for legible text).' },
        hidden: { type: 'boolean' },
        reset: { type: 'boolean' },
      },
      required: ['designator'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      const { board } = boardModel();
      const part = board.parts.find((p) => p.component.id === c.id);
      if (!part?.fp) throw new Error(`${c.designator} is not on the PCB (or has no footprint); run pcb_update first`);
      if ((input.x === undefined) !== (input.y === undefined)) throw new Error('Give both x and y to move the designator');
      if (input.reset) updateLabel(c.id, null);
      const patch: Parameters<typeof updateLabel>[1] = {};
      if (input.x !== undefined) patch.at = [Number(input.x), Number(input.y)];
      if (input.rotation !== undefined) patch.rotation = Number(input.rotation);
      if (input.size !== undefined) patch.size = Number(input.size);
      if (input.hidden !== undefined) patch.hidden = Boolean(input.hidden);
      if (Object.keys(patch).length) updateLabel(c.id, patch);
      const l = designatorLabel(boardModel().board.parts.find((p) => p.component.id === c.id)!);
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return { designator: c.designator, x: r(l.at[0]), y: r(l.at[1]), size: l.size, rotation: l.rotation, hidden: l.hidden };
    },
  },
  {
    name: 'pcb_move_part',
    title: 'Move a part on the PCB',
    description: 'Place a part at x/y (mm, footprint origin), with optional rotation (degrees CCW) and side ("top" or "bottom").',
    inputSchema: {
      type: 'object',
      properties: {
        designator: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        rotation: { type: 'number' },
        side: { type: 'string', enum: ['top', 'bottom'] },
      },
      required: ['designator'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      if (!currentPcb().placements.some((p) => p.componentId === c.id)) throw new Error(`${c.designator} is not on the PCB; run pcb_update first`);
      const patch: Record<string, unknown> = {};
      for (const k of ['x', 'y', 'rotation'] as const) if (input[k] !== undefined) patch[k] = Number(input[k]);
      if (input.side === 'top' || input.side === 'bottom') patch.side = input.side;
      updatePlacement(c.id, patch);
      return currentPcb().placements.find((p) => p.componentId === c.id);
    },
  },
  {
    name: 'pcb_autoroute',
    title: 'Auto-route PCB',
    description:
      'Route unrouted connections with the built-in grid router (shortest first) on the board’s layers. Supply and ground nets (GND, VCC, VIN, VM, +5V, +3V3 …) get the power track width, others the signal width. On a 4-layer board with inner planes (whole-board pours on inner1/inner2), each SMD pad of a plane net first gets a short stub and a via into its plane (`planes` in the result), and the router keeps off the plane layers. Optionally limit to one net, and set `width` to route a high-current net such as a motor output or sense-resistor connection wider. Check the result with pcb_check.',
    inputSchema: {
      type: 'object',
      properties: {
        net: { type: 'string', description: 'Only route this net.' },
        width: { type: 'number', minimum: 0.15, maximum: 3, description: 'Track width in mm for this run (default by net: 0.5 mm power, 0.25 mm signal).' },
      },
    },
    execute: async (input) => {
      const r = autoroute(input.net ? String(input.net) : undefined, input.width === undefined ? undefined : Number(input.width));
      return { routed: r.routed, failed: r.failed.map((f) => f.net), planes: r.planes || undefined, plane_failed: r.planeFailed.length ? r.planeFailed : undefined };
    },
  },
  {
    name: 'pcb_add_vias',
    title: 'Add vias',
    description:
      'Place vias of one net at the given points (mm), using the design-rule via size: thermal vias in a QFN exposed pad so the chip sheds heat into the bottom ground pour, or stitching vias that join the top and bottom pours. pcb_check warns about vias inside SMD pads; for thermal vias that is expected (ask JLCPCB to tent or fill them).',
    inputSchema: {
      type: 'object',
      properties: {
        net: { type: 'string', description: 'Net of the vias, e.g. "GND".' },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, minItems: 1, description: 'Via centres as [x, y] in mm.' },
      },
      required: ['net', 'points'],
    },
    execute: async (input) => {
      const net = String(input.net);
      const { board, pcb, conn } = boardModel();
      if (!board.pads.some((p) => p.net === net)) throw new Error(`No pad is on net "${net}"`);
      const points = (input.points as number[][]).map(([x, y]) => [x, y] as [number, number]);
      const edges = boardEdges(pcb);
      const outside = points.filter((p) => !insideBoard(p, edges));
      if (outside.length) throw new Error(`Points outside the board: ${outside.map((p) => p.join(',')).join('; ')}`);
      // Every new hole keeps JLCPCB's spacing from existing holes and from the other new ones.
      const holes = drilledHoles(pcb, board, conn);
      const crowded: string[] = [];
      for (const p of points) {
        const problem = viaHoleConflict(p, pcb.rules.viaDrill, holes);
        if (problem) crowded.push(`[${p.join(', ')}]: ${problem}`);
        holes.push({ center: p, d: pcb.rules.viaDrill, len: 0, kind: 'via', net, name: 'new via' });
      }
      if (crowded.length) throw new Error(`Vias too close to other holes (JLCPCB needs 0.2 mm between via holes, 0.45 mm to pad holes): ${crowded.join('; ')}`);
      return { added: addVias(points, net).length };
    },
  },
  {
    name: 'pcb_clear_routing',
    title: 'Remove PCB routing',
    description: 'Delete all tracks and vias, or only those of one net.',
    inputSchema: { type: 'object', properties: { net: { type: 'string' } } },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const { conn } = boardModel();
      const net = input.net ? String(input.net) : null;
      const keep = (id: string, own: string | null) => net !== null && (conn.itemNet.get(id) ?? own) !== net;
      st().commit((doc) => ({ ...doc, pcb: { ...currentPcb(), tracks: currentPcb().tracks.filter((t) => keep(t.id, t.net)), vias: currentPcb().vias.filter((v) => keep(v.id, v.net)) } }));
      return { tracks: currentPcb().tracks.length, vias: currentPcb().vias.length };
    },
  },
  {
    name: 'pcb_add_pour',
    title: 'Add copper pour',
    description:
      'Fill the board with copper on a net (usually GND) on one or both layers, keeping the clearance to other nets. Same-net pads join through thermal reliefs (or solidly). Replaces existing whole-board pours of that net on those layers. With `outline` or `rect` it pours only that area (a zone): zones add to the existing pours and take priority over whole-board pours of other nets, which flow around them. Pours count as connections for the ratsnest, so run pcb_get_state afterwards to see what is still unrouted.',
    inputSchema: {
      type: 'object',
      properties: {
        net: { type: 'string', description: 'Net to pour (default GND).' },
        layers: { type: 'array', items: { type: 'string', enum: ['top', 'inner1', 'inner2', 'bottom'] }, description: 'Default top and bottom. On a 4-layer board, a pour on inner1 or inner2 is a plane: the router leaves that layer to it and pcb_autoroute drops each SMD pad of the net into it through a via.' },
        clearance: { type: 'number', minimum: 0.1, description: 'Gap to other nets in mm (default 0.3).' },
        connection: { type: 'string', enum: ['thermal', 'solid'] },
        outline: outlineSchema('Pour only this area (a zone), e.g. a power plane under a regulator.'),
        rect: rectSchema('Pour only this area (a zone).'),
      },
    },
    execute: async (input) => {
      const net = input.net ? String(input.net) : 'GND';
      const zone = areaInput(input, 'pour zone', false);
      if (!boardNets().includes(net)) throw new Error(`No pad on the PCB is on net ${net}. Nets: ${boardNets().join(', ')}`);
      const layers = Array.isArray(input.layers) && input.layers.length ? checkLayers(input.layers as CopperLayer[]) : (['top', 'bottom'] as CopperLayer[]);
      const settings: Partial<Pour> = {};
      if (input.clearance !== undefined) settings.clearance = Number(input.clearance);
      if (input.connection === 'thermal' || input.connection === 'solid') settings.connection = input.connection;
      if (zone) settings.outline = zone;
      const pours = addPours(net, layers, settings);
      const { board, conn } = boardModel();
      return {
        pours: pours.map((p) => {
          const f = board.fills.find((x) => x.pour.id === p.id);
          return { id: p.id, layer: p.layer, areas: f?.areas.length ?? 0, weak_thermals: f?.thermals.filter((t) => t.spokes < 2).length ?? 0 };
        }),
        unrouted: Object.fromEntries([...conn.unrouted].filter(([, n]) => n > 0)),
      };
    },
  },
  {
    name: 'pcb_remove_pours',
    title: 'Remove copper pours',
    description: 'Remove all copper pours, or only those of one net.',
    inputSchema: { type: 'object', properties: { net: { type: 'string' } } },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const pours = currentPcb().pours ?? [];
      const ids = pours.filter((p) => !input.net || p.net === String(input.net)).map((p) => p.id);
      removePours(ids);
      return { removed: ids.length };
    },
  },
  {
    name: 'pcb_jlcpcb_check',
    title: 'JLCPCB manufacturing checklist',
    description:
      'Check the board against JLCPCB’s published limits for standard 2-layer boards and PCB assembly: board size, track width, copper spacing and edge clearance (measured on the actual copper), design rules, via and drill sizes, annular rings, hole spacing, non-plated holes and cutouts, silkscreen line width, text height and placement, and for assembly: library parts, board size, sides, package sizes and pin pitch, extended parts, stock and through-hole parts. Each item has status pass, warn (costs extra, may print poorly or needs standard PCBA), fail (JLCPCB cannot make it) or info. Run it before pcb_export.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'boolean', description: 'Include the assembly checks (default true).' },
        hand_solder_through_hole: { type: 'boolean', description: 'Through-hole parts are left out of assembly (default false).' },
        quantity: { type: 'integer', minimum: 1, description: 'Boards to order, for the stock check (default 5).' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      if (!currentPcb().placements.length) throw new Error('The PCB is empty; run pcb_update first');
      const items = jlcpcbChecklist(st().project, {
        assembly: input.assembly !== false,
        skip: input.hand_solder_through_hole ? throughHoleIds() : undefined,
        quantity: input.quantity === undefined ? undefined : Number(input.quantity),
      });
      return {
        ready: checklistReady(items),
        failed: items.filter((i) => i.status === 'fail').length,
        warnings: items.filter((i) => i.status === 'warn').length,
        items: items.map(({ group, title, status, value, limit, detail }) => ({ group, title, status, value, limit, detail })),
      };
    },
  },
  {
    name: 'pcb_check',
    title: 'PCB design rule check',
    description: 'DRC: copper clearance, shorts, unrouted connections, parts outside the board, vias in pads, overlapping parts, missing footprints.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const { issues } = checkPcb();
      st().setPcbIssues(issues);
      return { ok: !issues.some((i) => i.severity === 'error'), issues: issues.map((i) => ({ severity: i.severity, message: i.message, at: i.at })) };
    },
  },
  {
    name: 'pcb_export',
    title: 'Export fabrication files',
    description:
      'Download the JLCPCB-ready Gerber + drill zip, the CPL (pick-and-place) CSV and the BOM CSV to the user’s computer. With hand_solder_through_hole, through-hole parts (pin headers, most connectors) stay out of the BOM and CPL so JLCPCB doesn’t charge for soldering them.',
    inputSchema: {
      type: 'object',
      properties: { hand_solder_through_hole: { type: 'boolean', description: 'Leave through-hole parts out of the assembly files (default false).' } },
    },
    execute: async (input) => exportFabrication(input.hand_solder_through_hole ? throughHoleIds() : undefined),
  },
  {
    name: 'pcb_export_step',
    title: 'Export the board as STEP',
    description:
      'Download the assembled board as one STEP file (AP214) for enclosure design in FreeCAD, Fusion, SolidWorks and similar: the board solid with its outline, drill holes and cutouts, and every part’s EasyEDA STEP model placed as on the board (parts without a model become blocks). Fetches the models, so it takes a few seconds.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const r = await exportStep();
      return { file: r.file, models: r.models, blocks: r.blocks.length ? r.blocks : undefined, bytes: r.step.length };
    },
  },
  {
    name: 'new_schematic',
    title: 'Start a new schematic',
    description: 'Discard the current schematic (after the user confirms) and start an empty one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const { project } = st();
      const hasContent = project.components.length + project.wires.length > 0;
      if (hasContent && !window.confirm(`An AI agent wants to discard "${project.name}" and start a new schematic. Continue?`)) {
        throw new Error('The user declined starting a new schematic');
      }
      newProject(input.name ? String(input.name) : 'Untitled');
      return { ok: true, name: st().project.name };
    },
  },
];

type ModelContextLike = {
  registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => void;
};

export interface WebMcpStatus {
  api: 'document.modelContext' | 'navigator.modelContext' | null;
  registered: string[];
  errors: string[];
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

const typeOf = (value: unknown) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

function checkValue(value: unknown, schema: JsonSchema): string | null {
  const type = schema.type as string | undefined;
  const wrongType =
    type === 'integer' ? !Number.isInteger(value) : type === 'number' ? !Number.isFinite(value) : type !== undefined && typeOf(value) !== type;
  if (wrongType) return `must be ${type === 'integer' || type === 'array' || type === 'object' ? 'an' : 'a'} ${type}, got ${JSON.stringify(value)}`;
  const options = schema.enum as unknown[] | undefined;
  if (options && !options.includes(value)) return `must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}, got ${JSON.stringify(value)}`;
  if (type === 'array' && schema.items) {
    for (const item of value as unknown[]) {
      const problem = checkValue(item, schema.items as JsonSchema);
      if (problem) return `has an item that ${problem}`;
    }
  }
  return null;
}

/**
 * Checks input against the tool's schema (top-level fields and array items), so a misspelt or
 * missing field fails with the list of valid ones instead of the tool acting on undefined.
 */
export function validateInput(tool: ToolDefinition, input: unknown): Record<string, unknown> {
  const value = input ?? {};
  if (typeOf(value) !== 'object') throw new Error(`${tool.name} expects a JSON object as input.`);
  const fields = value as Record<string, unknown>;
  const props = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const names = Object.keys(props);
  const hint = names.length ? `Valid inputs: ${names.join(', ')}.` : `${tool.name} takes no input.`;
  for (const key of Object.keys(fields)) if (!(key in props)) throw new Error(`Unknown input "${key}" for ${tool.name}. ${hint}`);
  for (const key of (tool.inputSchema.required as string[] | undefined) ?? [])
    if (fields[key] === undefined) throw new Error(`Missing required input "${key}" for ${tool.name}. ${hint}`);
  for (const [key, field] of Object.entries(fields)) {
    const problem = field === undefined ? null : checkValue(field, props[key]);
    if (problem) throw new Error(`Input "${key}" of ${tool.name} ${problem}.`);
  }
  return fields;
}

/** Runs a tool with logging; used by WebMCP and the in-app tool console. */
export async function runTool(tool: ToolDefinition, input: Record<string, unknown>): Promise<unknown> {
  try {
    const result = await tool.execute(validateInput(tool, input));
    st().logAgent({ tool: tool.name, input, ok: true, summary: summarize(result) });
    return result;
  } catch (err) {
    st().logAgent({ tool: tool.name, input, ok: false, summary: (err as Error).message });
    throw err;
  }
}

let registration: Promise<WebMcpStatus & { dispose: () => void }> | null = null;

/** Registers the tools once per page; later calls return the same registration. */
export function ensureWebMcp() {
  registration ??= registerWebMcp();
  return registration;
}

async function registerWebMcp(): Promise<WebMcpStatus & { dispose: () => void }> {
  const doc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  const nav = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  const ctx = doc?.registerTool ? doc : nav?.registerTool ? nav : null;
  const api: WebMcpStatus['api'] = ctx === doc && doc ? 'document.modelContext' : ctx ? 'navigator.modelContext' : null;
  const status: WebMcpStatus = { api, registered: [], errors: [] };
  const controller = new AbortController();
  if (!ctx) return { ...status, dispose: () => {} };

  for (const tool of TOOLS) {
    const execute = async (input: Record<string, unknown>) => {
      // Errors are returned rather than thrown: browsers report a thrown error to the agent only
      // as a generic failure, which hides hints such as the list of valid pins.
      let result: unknown;
      let isError = false;
      try {
        result = await runTool(tool, input);
      } catch (err) {
        result = { error: (err as Error).message };
        isError = true;
      }
      // Legacy navigator.modelContext / MCP-B expect MCP CallToolResult content.
      return api === 'navigator.modelContext' ? { content: [{ type: 'text', text: JSON.stringify(result) }], isError } : result;
    };
    try {
      await ctx.registerTool(
        { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, execute },
        { signal: controller.signal },
      );
      status.registered.push(tool.name);
    } catch (err) {
      status.errors.push(`${tool.name}: ${(err as Error).message}`);
    }
  }
  return {
    ...status,
    dispose: () => {
      controller.abort();
      if (ctx.unregisterTool) for (const name of status.registered) try { ctx.unregisterTool(name); } catch { /* already gone */ }
    },
  };
}
