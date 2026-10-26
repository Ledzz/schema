import type { PartClass, PriceBreak } from '../../shared/parts';
import type { PassiveKind } from '../../shared/passives';
import type { Pcb } from '../pcb/types';
import type { Vec } from '../easyeda/symbol';

export type { Vec };

/** Counter-clockwise rotation in degrees, as seen on screen. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Component {
  id: string;
  /** Key into Project.symbols. */
  symbolKey: string;
  /** Unit index for multi-unit symbols. */
  unit: number;
  designator: string;
  value: string;
  x: number;
  y: number;
  rotation: Rotation;
  mirror: boolean;
  lcsc?: string;
  partClass?: PartClass;
  stock?: number;
  prices?: PriceBreak[];
  /** Manufacturer, MPN, Package, Footprint, Datasheet, Description … */
  attrs: Record<string, string>;
  /** Set for generic passives placed by value and size; the LCSC part is matched from these. */
  generic?: { kind: PassiveKind; size: string };
  /** Sheet it is drawn on (the first sheet when absent). */
  sheet?: string;
}

export interface Wire {
  id: string;
  points: Vec[];
  sheet?: string;
}

/**
 * Net labels, power and ground flags and no-connect markers; `hier` is a hierarchical port, the
 * end of a net on a block's own sheet that leads out to the matching pin of the block.
 */
export type PortKind = 'label' | 'power' | 'ground' | 'noconnect' | 'hier';

/** Net labels, power/ground flags, hierarchical ports and no-connect markers. */
export interface NetPort {
  id: string;
  kind: PortKind;
  name: string;
  x: number;
  y: number;
  rotation: Rotation;
  sheet?: string;
}

/** A page of the schematic. Labels and power flags with the same name join across sheets. */
export interface Sheet {
  id: string;
  name: string;
}

/**
 * A hierarchical block: a box on one sheet standing for another sheet (`child`). It has a pin for
 * each hierarchical port on the child sheet, joining the net there to the net at the pin.
 */
export interface SheetBlock {
  id: string;
  /** The sheet the block is drawn on. */
  sheet?: string;
  child: string;
  x: number;
  y: number;
  width: number;
  /**
   * Its pins, top to bottom: the child sheet's hierarchical port names (kept in step by
   * syncBlocks). An empty name keeps the place of a removed port while wiring still ends there.
   */
  pins: string[];
}

export interface StoredSymbol {
  title: string;
  dataStr: string;
  source: 'easyeda' | 'generic' | 'builtin';
  pinCount?: number;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  updatedAt: number;
  components: Component[];
  wires: Wire[];
  ports: NetPort[];
  /** Sheets in order; a project without them has a single sheet. */
  sheets?: Sheet[];
  blocks?: SheetBlock[];
  symbols: Record<string, StoredSymbol>;
  pcb?: Pcb;
}

export type ItemRef = { type: 'component' | 'wire' | 'port'; id: string };
