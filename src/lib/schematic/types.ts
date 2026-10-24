import type { PartClass, PriceBreak } from '../../shared/parts';
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
}

export interface Wire {
  id: string;
  points: Vec[];
}

export type PortKind = 'label' | 'power' | 'ground' | 'noconnect';

/** Net labels, power/ground flags and no-connect markers. */
export interface NetPort {
  id: string;
  kind: PortKind;
  name: string;
  x: number;
  y: number;
  rotation: Rotation;
}

export interface StoredSymbol {
  title: string;
  dataStr: string;
  source: 'easyeda' | 'generic';
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
  symbols: Record<string, StoredSymbol>;
}

export type ItemRef = { type: 'component' | 'wire' | 'port'; id: string };
