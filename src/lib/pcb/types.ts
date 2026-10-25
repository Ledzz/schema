import type { Vec } from '../schematic/types';

/** PCB units are millimetres, y grows downwards (screen convention). */

export type CopperLayer = 'top' | 'bottom';

export interface Placement {
  componentId: string;
  x: number;
  y: number;
  /** Counter-clockwise degrees as seen from the top. */
  rotation: number;
  side: CopperLayer;
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
  /** Custom outline, a closed polygon in mm; x/y/width/height are then its bounding box. */
  outline?: Vec[];
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
