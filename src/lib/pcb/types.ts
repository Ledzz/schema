import type { Vec } from '../schematic/types';

/** PCB units are millimetres, y grows downwards (screen convention). */

/** A face of the board: where parts, silkscreen, mask and paste are. */
export type Side = 'top' | 'bottom';

/** Copper layers from top to bottom; the inner ones exist only on 4-layer boards. */
export type CopperLayer = 'top' | 'inner1' | 'inner2' | 'bottom';

export const LAYER_STACKS = {
  2: ['top', 'bottom'],
  4: ['top', 'inner1', 'inner2', 'bottom'],
} as const satisfies Record<number, readonly CopperLayer[]>;

/** The board's copper layers, top to bottom. */
export const copperLayers = (pcb: Pick<Pcb, 'board'>): CopperLayer[] => [...LAYER_STACKS[pcb.board.layers ?? 2]];

export const isInner = (l: CopperLayer) => l === 'inner1' || l === 'inner2';

/** The board side a layer belongs to; inner layers count as top for new silkscreen. */
export const sideOfLayer = (l: CopperLayer): Side => (l === 'bottom' ? 'bottom' : 'top');

export const LAYER_NAMES: Record<CopperLayer, string> = { top: 'Top', inner1: 'Inner 1', inner2: 'Inner 2', bottom: 'Bottom' };

export interface Placement {
  componentId: string;
  x: number;
  y: number;
  /** Counter-clockwise degrees as seen from the top. */
  rotation: number;
  side: Side;
  /** Designator overrides; without them it sits centred above the part, 1 mm high. */
  label?: DesignatorLabel;
}

/** Where and how a part's designator is printed. Missing fields keep the default. */
export interface DesignatorLabel {
  /** Centre in the footprint's own frame, so the label follows the part when it moves or turns. */
  x?: number;
  y?: number;
  /** Degrees counter-clockwise as seen on the board (not relative to the part). */
  rotation?: number;
  /** Text height in mm. */
  size?: number;
  hidden?: boolean;
}

/** Free silkscreen text. */
export interface SilkText {
  id: string;
  text: string;
  /** Centre of the text block, mm. */
  x: number;
  y: number;
  /** Cap height in mm. */
  size: number;
  /** Degrees counter-clockwise. */
  rotation: number;
  side: Side;
  /** Line width in mm (default from the size). */
  stroke?: number;
}

/** Silkscreen artwork traced from an image. */
export interface SilkLogo {
  id: string;
  name: string;
  /** Centre, mm. */
  x: number;
  y: number;
  /** Size on the board in mm; height keeps the image's aspect ratio. */
  width: number;
  height: number;
  rotation: number;
  side: Side;
  /** Filled shapes in a unit frame: centred on 0, 1 wide. */
  shapes: { outer: Vec[]; holes: Vec[][] }[];
}

export interface Track {
  id: string;
  layer: CopperLayer;
  width: number;
  points: Vec[];
  net: string | null;
}

export interface Via {
  id: string;
  x: number;
  y: number;
  diameter: number;
  drill: number;
  net: string | null;
}

/** Copper pour (zone) filled with one net on one layer. */
export interface Pour {
  id: string;
  net: string;
  layer: CopperLayer;
  /** Zone outline in mm; null fills the whole board. */
  outline: Vec[] | null;
  /** Gap to copper of other nets. */
  clearance: number;
  /** How same-net pads join the pour. */
  connection: 'thermal' | 'solid';
  thermalGap: number;
  spokeWidth: number;
  /** Copper narrower than this is removed. */
  minWidth: number;
}

export const DEFAULT_POUR: Omit<Pour, 'id' | 'net' | 'layer'> = {
  outline: null,
  clearance: 0.3,
  connection: 'thermal',
  thermalGap: 0.3,
  spokeWidth: 0.35,
  minWidth: 0.2,
};

export interface Board {
  /** Bounding box of the board (the board itself without a custom outline). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rounds the rectangle's corners, or every corner of a custom outline. */
  cornerRadius: number;
  /** Copper layer count (default 2). */
  layers?: 2 | 4;
  /** Custom outline, a closed polygon in mm; x/y/width/height are then its bounding box. */
  outline?: Vec[];
  /**
   * Arcs in the custom outline: the bulge of the edge from outline[i] to outline[i + 1] (tan of a
   * quarter of its sweep, as in DXF; 0 for a straight edge). A corner radius leaves arcs alone.
   */
  outlineBulges?: number[];
  /** Openings milled through the board. */
  cutouts?: Cutout[];
}

export interface Cutout {
  id: string;
  outline: Vec[];
}

/** Non-plated mounting hole with a ring kept free of copper and parts (screw head, standoff). */
export interface MountingHole {
  id: string;
  x: number;
  y: number;
  diameter: number;
  /** Diameter of the copper- and part-free ring around it. */
  keepout: number;
}

/** Area that tracks, vias, pours or parts must stay out of, on one or both copper layers. */
export interface Keepout {
  id: string;
  outline: Vec[];
  layers: CopperLayer[];
  tracks: boolean;
  vias: boolean;
  pours: boolean;
  parts: boolean;
}

/** M3 screw: 3.2 mm hole, 6.4 mm free ring for the head or a standoff. */
export const DEFAULT_HOLE = { diameter: 3.2, keepout: 6.4 };

export interface DesignRules {
  clearance: number;
  trackWidth: number;
  powerTrackWidth: number;
  minTrackWidth: number;
  viaDiameter: number;
  viaDrill: number;
  /** Solder mask opening around pads. */
  maskExpansion: number;
}

export interface StoredFootprint {
  title: string;
  dataStr: string;
  source: 'easyeda' | 'builtin';
}

export interface Pcb {
  board: Board;
  rules: DesignRules;
  placements: Placement[];
  tracks: Track[];
  vias: Via[];
  pours?: Pour[];
  holes?: MountingHole[];
  keepouts?: Keepout[];
  texts?: SilkText[];
  logos?: SilkLogo[];
  /** Footprint documents keyed like "lcsc:C25804" or "builtin:0603". */
  footprints: Record<string, StoredFootprint>;
  /** componentId -> footprint key (null: no footprint available). */
  footprintOf: Record<string, string | null>;
  /** componentId -> part signature at the last sync, to detect schematic changes. */
  signatures?: Record<string, string>;
}

export const DEFAULT_RULES: DesignRules = {
  clearance: 0.2,
  trackWidth: 0.25,
  powerTrackWidth: 0.5,
  minTrackWidth: 0.15,
  viaDiameter: 0.6,
  viaDrill: 0.3,
  maskExpansion: 0.05,
};

export function emptyPcb(): Pcb {
  return {
    board: { x: 0, y: 0, width: 50, height: 40, cornerRadius: 1 },
    rules: { ...DEFAULT_RULES },
    placements: [],
    tracks: [],
    vias: [],
    footprints: {},
    footprintOf: {},
  };
}
