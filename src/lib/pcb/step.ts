/*
 * STEP export (ISO 10303-21, AP214 "automotive design") of the assembled board, for enclosure
 * design. The board is a solid: the outline extruded to the board thickness, with round drill
 * holes as true cylinders and slots and cutouts as polygon openings. Each part is EasyEDA's own
 * STEP model, merged in once per model file and placed with an assembly instance for every part
 * that uses it, the same way the 3D view places the models. Parts without a model get a block.
 * The outer copper (pads, tracks, vias and pours, less the drill holes) and the silkscreen are
 * thin solids on both faces, so the board looks like the real one in a CAD program.
 *
 * Coordinates are millimetres with z up and y up (the editor's y flipped), the board's bottom face
 * at z = 0.
 */
import type { Vec } from '../schematic/types';
import type { PartStep } from '../../shared/parts';
import type { BoardModel, BoardPart } from './board';
import { boardOutline } from './geometry';
import { MIL } from './footprint';
import { fallbackHeight } from './model3d';
import { circlePolygon } from './outline';
import { mergeAreas, type FillArea } from './pour';
import { designatorLabel, labelStrokes, logoAreas, strokeFor, textItemStrokes, textStroke } from './silk';
import type { Pcb, Side } from './types';

export const BOARD_THICKNESS = 1.6;

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

/** STEP real: always with a decimal point. */
function real(v: number): string {
  const x = Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(12));
  const s = String(x).toUpperCase();
  return /[.E]/.test(s) ? s.replace(/^(-?\d+)E/, '$1.E') : `${s}.`;
}
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;
const ref = (id: number) => `#${id}`;
const list = (ids: number[]) => `(${ids.map(ref).join(',')})`;

/** Collects numbered entities; ids can be reserved before their text is known. */
export class StepFile {
  private texts: string[] = [];
  /** Data section chunks merged verbatim (model files), in order. */
  private chunks: { at: number; text: string }[] = [];
  next = 1;
  /** Points, directions and vectors are plain values: identical ones are written once. */
  private values = new Map<string, number>();

  add(text: string): number {
    const value = /^(CARTESIAN_POINT|DIRECTION|VECTOR)\(/.test(text);
    if (value) {
      const known = this.values.get(text);
      if (known !== undefined) return known;
    }
    const id = this.next++;
    this.texts[id] = text;
    if (value) this.values.set(text, id);
    return id;
  }
  reserve(): number {
    return this.next++;
  }
  set(id: number, text: string) {
    this.texts[id] = text;
  }
  /** Appends already-numbered entity lines (ids from `first` up to `last`). */
  merge(text: string, last: number) {
    this.chunks.push({ at: this.next, text });
    this.next = last + 1;
  }

  toString(name: string): string {
    const head = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Assembled PCB'),'2;1');",
      `FILE_NAME(${str(name)},${str(new Date().toISOString().slice(0, 19))},(''),(''),'Schematics','Schematics','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
    ];
    const body: string[] = [];
    let chunk = 0;
    for (let id = 1; id < this.next; id++) {
      while (chunk < this.chunks.length && this.chunks[chunk].at === id) body.push(this.chunks[chunk++].text);
      if (this.texts[id] !== undefined) body.push(`#${id}=${this.texts[id]};`);
    }
    while (chunk < this.chunks.length) body.push(this.chunks[chunk++].text);
    return [...head, ...body, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
}

/** Units, uncertainty and the product context every representation shares. */
function contexts(f: StepFile) {
  const app = f.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  f.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ref(app)})`);
  const mm = f.add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const rad = f.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const sr = f.add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = f.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${ref(mm)},'distance_accuracy_value','confusion accuracy')`);
  const ctx = f.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${ref(unc)}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${ref(mm)},${ref(rad)},${ref(sr)}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`,
  );
  const productContext = f.add(`PRODUCT_CONTEXT('',${ref(app)},'mechanical')`);
  const pdContext = f.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ref(app)},'design')`);
  return { ctx, productContext, pdContext };
}
type Contexts = ReturnType<typeof contexts>;

/** A product with its definition; returns the product definition id. */
function product(f: StepFile, c: Contexts, name: string): number {
  const prod = f.add(`PRODUCT(${str(name)},${str(name)},'',(${ref(c.productContext)}))`);
  f.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${ref(prod)}))`);
  const formation = f.add(`PRODUCT_DEFINITION_FORMATION('','',${ref(prod)})`);
  return f.add(`PRODUCT_DEFINITION('design','',${ref(formation)},${ref(c.pdContext)})`);
}

function shapeDefinition(f: StepFile, pd: number, rep: number) {
  const pds = f.add(`PRODUCT_DEFINITION_SHAPE('','',${ref(pd)})`);
  f.add(`SHAPE_DEFINITION_REPRESENTATION(${ref(pds)},${ref(rep)})`);
}

const point = (f: StepFile, p: Vec3) => f.add(`CARTESIAN_POINT('',(${p.map(real).join(',')}))`);
const direction = (f: StepFile, d: Vec3) => f.add(`DIRECTION('',(${d.map(real).join(',')}))`);
const axis = (f: StepFile, at: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]) => f.add(`AXIS2_PLACEMENT_3D('',${ref(point(f, at))},${ref(direction(f, z))},${ref(direction(f, x))})`);

/* ---------- the board solid ---------- */

export type Opening = { kind: 'poly'; points: Vec[] } | { kind: 'circle'; center: Vec; r: number };

const area = (pts: Vec[]) => pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;
/** A ring without its closing point, wound counter-clockwise (y up) or clockwise. */
function wind(pts: Vec[], ccw: boolean): Vec[] {
  let ring = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts.slice();
  ring = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 1e-6);
  return area(ring) > 0 === ccw ? ring : ring.reverse();
}

/**
 * An extruded solid (z0 to z1) with polygon or round openings, as a manifold B-rep: planar top,
 * bottom and side faces, cylindrical walls for round openings. Every edge is used once in each
 * direction, so the shell is closed. Points are y-up. Returns the MANIFOLD_SOLID_BREP id.
 */
export function extrudedSolid(f: StepFile, name: string, outline: Vec[], openings: Opening[], z0: number, z1: number): number {
  const up: Vec3 = [0, 0, 1];
  const vertex = (p: Vec3) => f.add(`VERTEX_POINT('',${ref(point(f, p))})`);
  const line = (a: Vec3, b: Vec3) => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...d);
    return f.add(`LINE('',${ref(point(f, a))},${ref(f.add(`VECTOR('',${ref(direction(f, [d[0] / l, d[1] / l, d[2] / l]))},${real(l)})`))})`);
  };
  const edge = (v1: number, v2: number, curve: number) => f.add(`EDGE_CURVE('',${ref(v1)},${ref(v2)},${ref(curve)},.T.)`);
  const oriented = (e: number, sense: boolean) => f.add(`ORIENTED_EDGE('',*,*,${ref(e)},${sense ? '.T.' : '.F.'})`);
  const loop = (edges: number[]) => f.add(`EDGE_LOOP('',${list(edges)})`);
  const faces: number[] = [];
  const topBounds: number[] = [];
  const bottomBounds: number[] = [];

  // Planar rings: the outline counter-clockwise, polygon openings clockwise.
  const ring = (pts: Vec[], outer: boolean) => {
    const n = pts.length;
    const top = pts.map(([x, y]) => [x, y, z1] as Vec3);
    const bot = pts.map(([x, y]) => [x, y, z0] as Vec3);
    const vt = top.map(vertex);
    const vb = bot.map(vertex);
    const et = vt.map((v, i) => edge(v, vt[(i + 1) % n], line(top[i], top[(i + 1) % n])));
    const eb = vb.map((v, i) => edge(v, vb[(i + 1) % n], line(bot[i], bot[(i + 1) % n])));
    const ev = vb.map((v, i) => edge(v, vt[i], line(bot[i], top[i])));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d: Vec = [pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]];
      const l = Math.hypot(d[0], d[1]);
      // Outward for the counter-clockwise outline, into the opening for clockwise ones.
      const normal: Vec3 = [d[1] / l, -d[0] / l, 0];
      const plane = f.add(`PLANE('',${ref(axis(f, bot[i], normal, [d[0] / l, d[1] / l, 0]))})`);
      const bound = f.add(`FACE_OUTER_BOUND('',${ref(loop([oriented(eb[i], true), oriented(ev[j], true), oriented(et[i], false), oriented(ev[i], false)]))},.T.)`);
      faces.push(f.add(`ADVANCED_FACE('',(${ref(bound)}),${ref(plane)},.T.)`));
    }
    topBounds.push(f.add(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${ref(loop(et.map((e) => oriented(e, true))))},.T.)`));
    bottomBounds.push(f.add(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${ref(loop([...eb].reverse().map((e) => oriented(e, false))))},.T.)`));
  };

  // Round openings: a cylinder wall with one seam.
  const hole = (c: Vec, r: number) => {
    const vt = vertex([c[0] + r, c[1], z1]);
    const vb = vertex([c[0] + r, c[1], z0]);
    const circle = (z: number) => f.add(`CIRCLE('',${ref(axis(f, [c[0], c[1], z]))},${real(r)})`);
    const et = edge(vt, vt, circle(z1));
    const eb = edge(vb, vb, circle(z0));
    const seam = edge(vb, vt, line([c[0] + r, c[1], z0], [c[0] + r, c[1], z1]));
    const surface = f.add(`CYLINDRICAL_SURFACE('',${ref(axis(f, [c[0], c[1], z0]))},${real(r)})`);
    const bound = f.add(`FACE_OUTER_BOUND('',${ref(loop([oriented(eb, false), oriented(seam, true), oriented(et, true), oriented(seam, false)]))},.T.)`);
    // The wall faces the axis (out of the material), against the cylinder's own normal.
    faces.push(f.add(`ADVANCED_FACE('',(${ref(bound)}),${ref(surface)},.F.)`));
    topBounds.push(f.add(`FACE_BOUND('',${ref(loop([oriented(et, false)]))},.T.)`));
    bottomBounds.push(f.add(`FACE_BOUND('',${ref(loop([oriented(eb, true)]))},.T.)`));
  };

  ring(wind(outline, true), true);
  for (const o of openings) {
    if (o.kind === 'circle') hole(o.center, o.r);
    else ring(wind(o.points, false), false);
  }
  faces.push(f.add(`ADVANCED_FACE('',${list(topBounds)},${ref(f.add(`PLANE('',${ref(axis(f, [0, 0, z1], up))})`))},.T.)`));
  faces.push(f.add(`ADVANCED_FACE('',${list(bottomBounds)},${ref(f.add(`PLANE('',${ref(axis(f, [0, 0, z0], [0, 0, -1]))})`))},.T.)`));
  const shell = f.add(`CLOSED_SHELL('',${list(faces)})`);
  return f.add(`MANIFOLD_SOLID_BREP(${str(name)},${ref(shell)})`);
}

/** Gives a solid a colour other programs show. */
function colour(f: StepFile, ctx: number, solid: number, rgb: Vec3) {
  const c = f.add(`COLOUR_RGB('',${rgb.map(real).join(',')})`);
  const fill = f.add(`FILL_AREA_STYLE('',(${ref(f.add(`FILL_AREA_STYLE_COLOUR('',${ref(c)})`))}))`);
  const side = f.add(`SURFACE_SIDE_STYLE('',(${ref(f.add(`SURFACE_STYLE_FILL_AREA(${ref(fill)})`))}))`);
  const style = f.add(`PRESENTATION_STYLE_ASSIGNMENT((${ref(f.add(`SURFACE_STYLE_USAGE(.BOTH.,${ref(side)})`))}))`);
  const item = f.add(`STYLED_ITEM('color',(${ref(style)}),${ref(solid)})`);
  f.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${ref(item)}),${ref(ctx)})`);
}

/** The board's openings in y-up coordinates: drill holes, slots, cutouts and mounting holes. */
export function boardOpenings(pcb: Pcb, board: BoardModel): Opening[] {
  const flip = (p: Vec): Vec => [p[0], -p[1]];
  const out: Opening[] = [];
  for (const pad of board.pads) {
    const h = pad.hole;
    if (!h) continue;
    if (Math.abs(h.w - h.h) < 1e-6) out.push({ kind: 'circle', center: flip(h.center), r: h.w / 2 });
    else {
      // A slot: a stadium shape as a polygon.
      const r = Math.min(h.w, h.h) / 2;
      const half = Math.abs(h.w - h.h) / 2;
      const along = (h.w > h.h ? 0 : 90) + h.rotation;
      const pts: Vec[] = [];
      for (const [cx, start] of [[half, -90], [-half, 90]] as const)
        for (let k = 0; k <= 12; k++) {
          const a = ((start + (k * 180) / 12) * Math.PI) / 180;
          pts.push([cx + r * Math.cos(a), r * Math.sin(a)]);
        }
      const t = (along * Math.PI) / 180;
      out.push({ kind: 'poly', points: pts.map(([x, y]) => flip([h.center[0] + x * Math.cos(t) + y * Math.sin(t), h.center[1] - x * Math.sin(t) + y * Math.cos(t)])) });
    }
  }
  for (const h of pcb.holes ?? []) out.push({ kind: 'circle', center: flip([h.x, h.y]), r: h.diameter / 2 });
  for (const c of pcb.board.cutouts ?? []) if (c.outline.length >= 3) out.push({ kind: 'poly', points: c.outline.map(flip) });
  return out;
}

/* ---------- copper and silkscreen ---------- */

/** 1 oz copper; silkscreen ink is about 15 µm. */
const COPPER = 0.035;
const SILK = 0.015;
/** Outline detail kept in the model: finer arcs only make the file bigger. */
const DETAIL = 0.01;

/** An outer face's copper (y down): pads, tracks, vias and pour fills, less the drill holes. */
export function copperAreas(pcb: Pcb, board: BoardModel, side: Side): FillArea[] {
  const holes = [
    ...boardOpenings(pcb, board).map((o) => (o.kind === 'circle' ? circlePolygon([o.center[0], -o.center[1]], o.r) : o.points.map(([x, y]) => [x, -y] as Vec))),
    ...pcb.vias.map((v) => circlePolygon([v.x, v.y], v.drill / 2)),
  ];
  return mergeAreas({
    shapes: board.items.filter((it) => it.layers.includes(side)).map((it) => it.shape),
    areas: board.fills.filter((fl) => fl.pour.layer === side).flatMap((fl) => fl.areas),
    holes,
    tolerance: DETAIL,
  });
}

/** An outer face's silkscreen (y down): footprint drawings, designators, text and logos, on the board. */
export function silkAreas(pcb: Pcb, board: BoardModel, side: Side): FillArea[] {
  const layer = side === 'top' ? 'silkTop' : 'silkBottom';
  const strokes: { points: Vec[]; width: number }[] = [];
  const areas: FillArea[] = [];
  for (const part of board.parts) {
    for (const g of part.graphics) {
      if (g.layer !== layer) continue;
      if (g.filled) areas.push({ outer: g.points, holes: [] });
      else strokes.push({ points: g.points, width: g.width });
    }
    if (!part.fp) continue;
    const label = designatorLabel(part);
    if ((label.side === 'bottom' ? 'bottom' : 'top') === side) for (const st of labelStrokes(label)) strokes.push({ points: st, width: strokeFor(label.size) });
  }
  for (const t of pcb.texts ?? []) if (t.side === side) for (const st of textItemStrokes(t)) strokes.push({ points: st, width: textStroke(t) });
  for (const l of pcb.logos ?? []) if (l.side === side) areas.push(...logoAreas(l));
  return mergeAreas({ strokes, areas, clip: boardOutline(pcb.board), tolerance: DETAIL });
}

/** Areas (y down) as outlines and openings for extrudedSolid (y up), leaving out slivers. */
function areaSolids(areas: FillArea[]): { outer: Vec[]; holes: Opening[] }[] {
  const flip = (p: Vec): Vec => [p[0], -p[1]];
  return areas
    .filter((a) => a.outer.length >= 3 && Math.abs(area(a.outer)) > 1e-6)
    .map((a) => ({ outer: a.outer.map(flip), holes: a.holes.filter((h) => h.length >= 3 && Math.abs(area(h)) > 1e-6).map((h): Opening => ({ kind: 'poly', points: h.map(flip) })) }));
}

/* ---------- placing parts ---------- */

const rx = (a: number): Mat3 => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a: number): Mat3 => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a: number): Mat3 => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (a: Mat3, b: Mat3): Mat3 => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])) as Mat3;
const apply = (m: Mat3, v: Vec3): Vec3 => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const deg = (d: number) => ((d || 0) * Math.PI) / 180;

export interface Placement3d {
  rotation: Mat3;
  translation: Vec3;
}

/** How a part's frame sits on the board (as the 3D view: bottom parts turned over about y). */
function partFrame(part: BoardPart): Placement3d {
  const { x, y, rotation, side } = part.placement;
  return side === 'top'
    ? { rotation: rz(deg(rotation)), translation: [x, -y, BOARD_THICKNESS] }
    : { rotation: mul(rz(deg(rotation)), ry(Math.PI)), translation: [x, -y, 0] };
}

/**
 * Where a part's STEP model goes: its box centred on the footprint origin with its bottom on the
 * board, then EasyEDA's rotation (Z, X, Y fields) and offset, then the part's own placement.
 * `box` is the model's extent in its own coordinates.
 */
export function modelPlacementStep(part: BoardPart, transform: number[], box: { min: Vec3; max: Vec3 }): Placement3d {
  const [, , , rzDeg, rxDeg, ryDeg, ox, oy, oz] = transform;
  const centre: Vec3 = [-(box.min[0] + box.max[0]) / 2, -(box.min[1] + box.max[1]) / 2, -box.min[2]];
  const model = mul(mul(rx(deg(rxDeg)), ry(deg(ryDeg))), rz(deg(rzDeg)));
  const frame = partFrame(part);
  const local = add3([(ox || 0) * MIL, (oy || 0) * MIL, (oz || 0) * MIL], apply(model, centre));
  return { rotation: mul(frame.rotation, model), translation: add3(frame.translation, apply(frame.rotation, local)) };
}

/* ---------- model files ---------- */

interface ParsedStep {
  entities: { id: number; body: string }[];
  /** Product definition and shape representation of the model's top product. */
  pd: number;
  rep: number;
  min: Vec3;
  max: Vec3;
}

/** Splits a STEP file's DATA section into entities and finds its top product and extent. */
export function parseStep(text: string): ParsedStep {
  const start = text.indexOf('DATA;');
  const end = text.lastIndexOf('ENDSEC;');
  const data = text.slice(start + 5, end);
  const entities: { id: number; body: string }[] = [];
  const byId = new Map<number, string>();
  const re = /#(\d+)\s*=\s*((?:[^;']|'(?:[^']|'')*')*);/g;
  for (let m = re.exec(data); m; m = re.exec(data)) {
    const id = Number(m[1]);
    const body = m[2].trim();
    entities.push({ id, body });
    byId.set(id, body);
  }
  const refsOf = (body: string) => [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  // Products used inside the file's own assembly are not the top one.
  const children = new Set<number>();
  for (const { body } of entities) if (body.startsWith('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) children.add(refsOf(body)[1]);
  let pd = -1;
  let rep = -1;
  for (const { body } of entities) {
    if (!body.startsWith('SHAPE_DEFINITION_REPRESENTATION')) continue;
    const [pds, r] = refsOf(body);
    const pdsBody = byId.get(pds) ?? '';
    const candidate = refsOf(pdsBody)[0];
    if (!pdsBody.startsWith('PRODUCT_DEFINITION_SHAPE') || children.has(candidate)) continue;
    pd = candidate;
    rep = r;
    if (/BREP/.test(byId.get(r) ?? '')) break;
  }
  if (pd < 0) throw new Error('The model has no product with a shape');
  // Extent from the vertices (control points of curves can lie far outside the part).
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { body } of entities) {
    if (!body.startsWith('VERTEX_POINT')) continue;
    const p = /\(\s*([-\d.Ee+]+)\s*,\s*([-\d.Ee+]+)\s*,\s*([-\d.Ee+]+)\s*\)/.exec(byId.get(refsOf(body)[0]) ?? '');
    if (!p) continue;
    for (let k = 0; k < 3; k++) {
      const v = Number(p[k + 1]);
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('The model has no vertices');
  return { entities, pd, rep, min, max };
}

/**
 * Copies a parsed model into `f` with its ids shifted, adding an origin placement to its shape
 * representation for the assembly transform. Returns the new ids of its product definition,
 * representation and origin.
 */
function mergeModel(f: StepFile, model: ParsedStep): { pd: number; rep: number; origin: number } {
  // (A loop, not Math.min(...ids): big models have more ids than a call can take arguments.)
  const first = model.entities.reduce((m, e) => Math.min(m, e.id), Infinity);
  const offset = f.next - first;
  const shift = (body: string) => body.replace(/'(?:[^']|'')*'|#(\d+)/g, (m, id) => (id ? `#${Number(id) + offset}` : m));
  let last = f.next - 1;
  const origin = model.entities.reduce((m, e) => Math.max(m, e.id), 0) + offset + 1;
  const lines: string[] = [];
  for (const { id, body } of model.entities) {
    let text = shift(body);
    // Add the origin to the representation's items: ABSR('', (items), context).
    if (id === model.rep) text = text.replace(/^(\w+\s*\(\s*'(?:[^']|'')*'\s*,\s*\()/, `$1#${origin},`);
    lines.push(`#${id + offset}=${text};`);
    last = Math.max(last, id + offset);
  }
  f.merge(lines.join('\n'), last);
  // The id named in the representation above is the next one free.
  if (f.reserve() !== origin) throw new Error('Model ids out of order');
  const at = f.add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const z = f.add(`DIRECTION('',(0.,0.,1.))`);
  const x = f.add(`DIRECTION('',(1.,0.,0.))`);
  f.set(origin, `AXIS2_PLACEMENT_3D('',${ref(at)},${ref(z)},${ref(x)})`);
  return { pd: model.pd + offset, rep: model.rep + offset, origin };
}

/* ---------- the assembly ---------- */

export interface StepInput {
  pcb: Pcb;
  board: BoardModel;
  name: string;
  /** STEP models by component id (parts without one get a block). */
  models: Map<string, PartStep>;
}

export interface StepResult {
  step: string;
  /** Designators that got a block instead of a model. */
  blocks: string[];
  /** Distinct model files included. */
  models: number;
}

/** Writes the assembled board as one STEP file. */
export function boardStep({ pcb, board, name, models }: StepInput): StepResult {
  const f = new StepFile();
  const c = contexts(f);

  /** An assembly: a product whose representation lists where its children are placed. */
  type Assembly = { pd: number; rep: number; items: number[]; label: string };
  const assembly = (label: string): Assembly => {
    const pd = product(f, c, label);
    const rep = f.reserve();
    shapeDefinition(f, pd, rep);
    return { pd, rep, items: [axis(f, [0, 0, 0])], label };
  };
  const finish = (a: Assembly) => f.set(a.rep, `SHAPE_REPRESENTATION(${str(a.label)},${list(a.items)},${ref(c.ctx)})`);
  const top = assembly(name);

  /** Places a child product's representation in an assembly (the top one by default). */
  const instance = (label: string, child: { pd: number; rep: number; origin: number }, at: Placement3d, parent: Assembly = top) => {
    const zAxis = apply(at.rotation, [0, 0, 1]);
    const xAxis = apply(at.rotation, [1, 0, 0]);
    const placed = axis(f, at.translation, zAxis, xAxis);
    parent.items.push(placed);
    const transform = f.add(`ITEM_DEFINED_TRANSFORMATION('','',${ref(child.origin)},${ref(placed)})`);
    const relation = f.add(
      `(REPRESENTATION_RELATIONSHIP('','',${ref(child.rep)},${ref(parent.rep)})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${ref(transform)})SHAPE_REPRESENTATION_RELATIONSHIP())`,
    );
    const usage = f.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${str(label)},${str(label)},'',${ref(parent.pd)},${ref(child.pd)},$)`);
    const shape = f.add(`PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',${ref(usage)})`);
    f.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${ref(relation)},${ref(shape)})`);
  };
  const identity: Placement3d = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0] };

  /** A product holding one coloured solid: the board, a stand-in block, a piece of copper or silkscreen. */
  const solidProduct = (label: string, build: () => number, rgb: Vec3) => {
    const pd = product(f, c, label);
    const solid = build();
    const origin = axis(f, [0, 0, 0]);
    const rep = f.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(label)},(${ref(solid)},${ref(origin)}),${ref(c.ctx)})`);
    shapeDefinition(f, pd, rep);
    colour(f, c.ctx, solid, rgb);
    return { pd, rep, origin };
  };

  // The board.
  const outline = boardOutline(pcb.board).map(([x, y]) => [x, -y] as Vec);
  const pcbSolid = solidProduct('PCB', () => extrudedSolid(f, 'PCB', outline, boardOpenings(pcb, board), 0, BOARD_THICKNESS), [0.08, 0.33, 0.17]);
  instance('PCB', pcbSolid, identity);

  // Copper and silkscreen on both faces: a sub-assembly per layer with a solid per piece, since
  // CAD programs show the colour of a part's solid more reliably than of solids within one part.
  const T = BOARD_THICKNESS;
  const layer = (label: string, areas: FillArea[], z0: number, z1: number, rgb: Vec3) => {
    if (areas.length === 0) return;
    const group = assembly(label);
    areaSolids(areas).forEach((a, i) => {
      const piece = `${label} ${i + 1}`;
      instance(piece, solidProduct(piece, () => extrudedSolid(f, piece, a.outer, a.holes, z0, z1), rgb), identity, group);
    });
    finish(group);
    instance(label, { pd: group.pd, rep: group.rep, origin: group.items[0] }, identity);
  };
  for (const side of ['top', 'bottom'] as const) {
    const name = side === 'top' ? 'Top' : 'Bottom';
    layer(`${name} copper`, copperAreas(pcb, board, side), ...(side === 'top' ? [T, T + COPPER] : [-COPPER, 0]) as [number, number], [0.8, 0.62, 0.25]);
    layer(`${name} silkscreen`, silkAreas(pcb, board, side), ...(side === 'top' ? [T + COPPER, T + COPPER + SILK] : [-COPPER - SILK, -COPPER]) as [number, number], [0.95, 0.95, 0.95]);
  }

  // Parts: each model file once, an instance per part.
  const merged = new Map<string, { pd: number; rep: number; origin: number; box: { min: Vec3; max: Vec3 } }>();
  const blocks: string[] = [];
  for (const part of board.parts) {
    if (!part.fp || part.component.attrs['Add into BOM'] === 'no') continue;
    const model = models.get(part.component.id);
    let placedModel = false;
    if (model) {
      let m = merged.get(model.file);
      if (!m) {
        try {
          const parsed = parseStep(model.step);
          m = { ...mergeModel(f, parsed), box: { min: parsed.min, max: parsed.max } };
          merged.set(model.file, m);
        } catch {
          m = undefined;
        }
      }
      if (m) {
        instance(part.component.designator, m, modelPlacementStep(part, model.transform, m.box));
        placedModel = true;
      }
    }
    if (!placedModel) {
      // A block the size of the footprint, as in the 3D view.
      const bb = part.fp.bbox;
      const height = fallbackHeight(pcb.footprints[pcb.footprintOf[part.component.id] ?? '']?.title ?? '');
      const rect: Vec[] = [
        [bb.x1, -bb.y1],
        [bb.x2, -bb.y1],
        [bb.x2, -bb.y2],
        [bb.x1, -bb.y2],
      ];
      const block = solidProduct(`${part.component.designator} (no model)`, () => extrudedSolid(f, part.component.designator, rect, [], 0, height), [0.25, 0.25, 0.28]);
      instance(part.component.designator, block, partFrame(part));
      blocks.push(part.component.designator);
    }
  }

  finish(top);
  return { step: f.toString(`${name}.step`), blocks, models: merged.size };
}
