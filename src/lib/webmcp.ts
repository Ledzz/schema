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
  findPin,
  markNoConnect,
  nextFreePosition,
  placePartAt,
  replacePart,
} from './actions';
import { bomToJlcpcbCsv, buildBom } from './schematic/bom';
import { worldPins } from './schematic/geometry';
import { parseSymbol } from './easyeda/symbol';
import { deleteItems } from './schematic/ops';
import { symbolFor } from './schematic/symbols';
import type { Component, Rotation } from './schematic/types';
import { fitView, newProject, reannotate } from './editing';
import { EXTENDED_SETUP_FEE, PART_CLASSES, splitPackageQuery, type PartClass, type SortKey } from '../shared/parts';
import { PASSIVES, PASSIVE_KINDS, type PassiveKind } from '../shared/passives';
import { assignPassive, placePassiveAt } from './passives';
import { addPours, autoroute, boardModel, boardNets, checkPcb, currentPcb, exportFabrication, removePours, syncPcb, updateBoard, updatePlacement } from './pcb/actions';
import { fitPcbView } from './pcb/view';
import type { CopperLayer, Pcb, Pour } from './pcb/types';

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
      const res = await fetchSearch({
        q: split.keyword,
        types,
        inStock: input.in_stock_only !== false,
        sort: (['relevance', 'stock', 'price'].includes(String(input.sort)) ? input.sort : 'relevance') as SortKey,
        packages: input.package ? [String(input.package)] : split.packages,
        page: 1,
        pageSize: Math.min(50, Math.max(1, Number(input.limit) || 10)),
      });
      st().requestLibrary(String(input.query ?? ''));
      return {
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
      'Place an LCSC part on the schematic. Coordinates use a 10-unit grid (pins sit on multiples of 10, y grows downwards); omit x/y to place to the right of the existing drawing. Returns the designator and the absolute position of every pin.',
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
      return { ...componentInfo(component), match_error: match?.error ?? (match?.candidates.length ? undefined : 'No in-stock JLCPCB part found; component left unassigned') };
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
      return { components: list.map((c) => componentInfo(st().project.components.find((x) => x.id === c.id)!, false)) };
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
    name: 'update_component',
    title: 'Update component',
    description: 'Change a component’s value, designator, position or rotation.',
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
      st().updateComponent(c.id, patch);
      return componentInfo(st().project.components.find((x) => x.id === c.id)!);
    },
  },
  {
    name: 'replace_part',
    title: 'Replace part',
    description: 'Swap the LCSC part used by a component (e.g. to move from an extended to a basic part). Keeps position and rotation; wires may need reconnecting if pinouts differ.',
    inputSchema: {
      type: 'object',
      properties: { designator: { type: 'string' }, lcsc: { type: 'string' } },
      required: ['designator', 'lcsc'],
    },
    execute: async (input) => {
      const c = byDesignator(String(input.designator));
      const updated = await replacePart(c.id, String(input.lcsc));
      return updated ? componentInfo(updated) : null;
    },
  },
  {
    name: 'delete_components',
    title: 'Delete components',
    description: 'Delete components by designator. Wires, labels and power flags attached to them are left in place.',
    inputSchema: {
      type: 'object',
      properties: { designators: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['designators'],
    },
    annotations: { consequentialHint: true },
    execute: async (input) => {
      const list = (input.designators as string[]).map(byDesignator);
      const ids = new Set(list.map((c) => c.id));
      st().commit((doc) => deleteItems(doc, ids));
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
    description: `Bill of materials grouped by LCSC part with JLCPCB part types, stock and an estimate of extended-part setup fees ($${EXTENDED_SETUP_FEE} per unique extended part).`,
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
    description: 'Board outline, design rules, every placed part (position in mm, rotation, side, footprint, bounding box), nets with unrouted connection counts, and track/via counts. y grows downwards; the board origin is its top-left corner.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const { pcb, board, conn } = boardModel();
      const round = (v: number) => Math.round(v * 1000) / 1000;
      return {
        board: pcb.board,
        rules: pcb.rules,
        parts: board.parts.map((p) => ({
          designator: p.component.designator,
          x: round(p.placement.x),
          y: round(p.placement.y),
          rotation: p.placement.rotation,
          side: p.placement.side,
          footprint: pcb.footprints[pcb.footprintOf[p.component.id] ?? '']?.title ?? null,
          bbox: p.fp ? { x1: round(p.box.x1), y1: round(p.box.y1), x2: round(p.box.x2), y2: round(p.box.y2) } : null,
        })),
        pours: board.fills.map((f) => ({
          net: f.pour.net,
          layer: f.pour.layer,
          clearance: f.pour.clearance,
          connection: f.pour.connection,
          areas: f.areas.length,
          weak_thermals: f.thermals.filter((t) => t.spokes < 2).map((t) => `${t.designator}.${t.number}`),
        })),
        unrouted: Object.fromEntries([...conn.unrouted].filter(([, n]) => n > 0)),
        tracks: pcb.tracks.length,
        vias: pcb.vias.length,
      };
    },
  },
  {
    name: 'pcb_set_board',
    title: 'Set board size',
    description: 'Set the board outline size in millimetres (and optional corner radius).',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'number', minimum: 5 }, height: { type: 'number', minimum: 5 }, corner_radius: { type: 'number', minimum: 0 } },
    },
    execute: async (input) => {
      const patch: Partial<Pcb['board']> = {};
      if (input.width !== undefined) patch.width = Number(input.width);
      if (input.height !== undefined) patch.height = Number(input.height);
      if (input.corner_radius !== undefined) patch.cornerRadius = Number(input.corner_radius);
      updateBoard(patch);
      return { board: currentPcb().board };
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
    description: 'Route unrouted connections with the built-in two-layer grid router (shortest first; power nets use the wider power track width). Optionally limit to one net. Check the result with pcb_check.',
    inputSchema: { type: 'object', properties: { net: { type: 'string' } } },
    execute: async (input) => {
      const r = autoroute(input.net ? String(input.net) : undefined);
      return { routed: r.routed, failed: r.failed.map((f) => f.net) };
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
      'Fill the board with copper on a net (usually GND) on one or both layers, keeping the clearance to other nets. Same-net pads join through thermal reliefs (or solidly). Replaces existing pours of that net on those layers. Pours count as connections for the ratsnest, so run pcb_get_state afterwards to see what is still unrouted.',
    inputSchema: {
      type: 'object',
      properties: {
        net: { type: 'string', description: 'Net to pour (default GND).' },
        layers: { type: 'array', items: { type: 'string', enum: ['top', 'bottom'] }, description: 'Default both.' },
        clearance: { type: 'number', minimum: 0.1, description: 'Gap to other nets in mm (default 0.3).' },
        connection: { type: 'string', enum: ['thermal', 'solid'] },
      },
    },
    execute: async (input) => {
      const net = input.net ? String(input.net) : 'GND';
      if (!boardNets().includes(net)) throw new Error(`No pad on the PCB is on net ${net}. Nets: ${boardNets().join(', ')}`);
      const layers = Array.isArray(input.layers) && input.layers.length ? (input.layers as CopperLayer[]) : (['top', 'bottom'] as CopperLayer[]);
      const settings: Partial<Pour> = {};
      if (input.clearance !== undefined) settings.clearance = Number(input.clearance);
      if (input.connection === 'thermal' || input.connection === 'solid') settings.connection = input.connection;
      const pours = addPours(net, layers, settings);
      const { board, conn } = boardModel();
      return {
        pours: pours.map((p) => {
          const f = board.fills.find((x) => x.pour.id === p.id);
          return { layer: p.layer, areas: f?.areas.length ?? 0, weak_thermals: f?.thermals.filter((t) => t.spokes < 2).length ?? 0 };
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
    description: 'Download the JLCPCB-ready Gerber + drill zip, the CPL (pick-and-place) CSV and the BOM CSV to the user’s computer.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => exportFabrication(),
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

/** Runs a tool with logging; used by WebMCP and the in-app tool console. */
export async function runTool(tool: ToolDefinition, input: Record<string, unknown>): Promise<unknown> {
  try {
    const result = await tool.execute(input ?? {});
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
