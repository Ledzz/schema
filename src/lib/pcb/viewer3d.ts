/*
 * three.js scene of the finished board. World units are millimetres, Z up, and Y = -board y so
 * the top view matches the 2D editor. The board is an extruded outline with its drill holes,
 * textured with the rendered faces; parts use EasyEDA's 3D models placed by their transform, or
 * grey blocks where a part has none.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Project } from '../schematic/types';
import { fetchPartModel } from '../api';
import { boardModel } from './actions';
import type { BoardModel } from './board';
import { boardOutline } from './geometry';
import { fallbackHeight, modelPlacement, parseEasyedaObj, type ParsedModel } from './model3d';
import { renderBoardFace } from './render';
import type { Pcb } from './types';

export const BOARD_THICKNESS = 1.6;
export type View3d = 'top' | 'bottom' | 'angle';

export interface LoadStatus {
  total: number;
  loaded: number;
  /** Designators shown as blocks because EasyEDA has no model for them. */
  missing: string[];
}

const parsedModels = new Map<string, Promise<ParsedModel | null>>();
function loadModel(lcsc: string): Promise<{ model: ParsedModel; transform: number[] } | null> {
  return fetchPartModel(lcsc).then(async (m) => {
    if (!m) return null;
    let parsed = parsedModels.get(lcsc);
    if (!parsed) {
      parsed = Promise.resolve(parseEasyedaObj(m.obj));
      parsedModels.set(lcsc, parsed);
    }
    const model = await parsed;
    return model && model.parts.length ? { model, transform: m.transform } : null;
  });
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Pins and other light grey surfaces read as metal; everything else as moulded plastic. */
function partMaterial(color: [number, number, number], opacity: number, cache: Map<string, THREE.Material>): THREE.Material {
  const key = `${color.join(',')}|${opacity}`;
  let m = cache.get(key);
  if (!m) {
    const [r, g, b] = color;
    const metal = Math.min(r, g, b) > 0.55 && Math.max(r, g, b) - Math.min(r, g, b) < 0.12;
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
      metalness: metal ? 0.75 : 0.05,
      roughness: metal ? 0.35 : 0.65,
      transparent: opacity < 1,
      opacity,
    });
    cache.set(key, m);
  }
  return m;
}

export class BoardViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
  private controls: OrbitControls;
  private boardGroup = new THREE.Group();
  private partsGroup = new THREE.Group();
  private resize: ResizeObserver;
  private materials = new Map<string, THREE.Material>();
  private geometries = new Map<string, THREE.BufferGeometry[]>();
  private center = new THREE.Vector3();
  private size = 50;
  private generation = 0;
  private framed = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(40, -60, 120);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-60, 40, -80);
    this.scene.add(fill);
    this.scene.add(this.boardGroup, this.partsGroup);
    this.resize = new ResizeObserver(() => this.fitCanvas());
    this.resize.observe(host);
    this.fitCanvas();
    if (import.meta.env.DEV) (window as unknown as { __board3d?: BoardViewer }).__board3d = this;
  }

  /** World-space box of every placed part, for checking placement (dev tooling and tests). */
  partBoxes(): { designator: string; min: number[]; max: number[] }[] {
    return this.partsGroup.children.map((c) => {
      const box = new THREE.Box3().setFromObject(c);
      const r = (v: THREE.Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 100) / 100);
      return { designator: String(c.userData.designator), min: r(box.min), max: r(box.max) };
    });
  }

  /** Rebuilds the board and its parts; part models load in the background. */
  setProject(project: Project, onStatus: (s: LoadStatus) => void) {
    const generation = ++this.generation;
    const pcb = project.pcb;
    this.clear(this.boardGroup);
    this.clear(this.partsGroup);
    if (!pcb?.placements.length) {
      onStatus({ total: 0, loaded: 0, missing: [] });
      this.render();
      return;
    }
    const { board } = boardModel(project);
    this.buildBoard(pcb, board);
    const b = pcb.board;
    this.center.set(b.x + b.width / 2, -(b.y + b.height / 2), BOARD_THICKNESS / 2);
    this.size = Math.max(b.width, b.height);
    if (!this.framed) {
      this.framed = true;
      this.setView('angle');
    }
    const status: LoadStatus = { total: board.parts.length, loaded: 0, missing: [] };
    onStatus({ ...status });
    for (const part of board.parts) {
      const lcsc = part.component.lcsc;
      const done = (model: { model: ParsedModel; transform: number[] } | null) => {
        if (generation !== this.generation) return;
        if (model) this.addModel(part, model.model, model.transform, lcsc!);
        else {
          this.addBlock(part, pcb);
          if (part.fp) status.missing.push(part.component.designator);
        }
        status.loaded++;
        onStatus({ ...status, missing: [...status.missing] });
        this.render();
      };
      if (lcsc && part.fp) loadModel(lcsc).then(done, () => done(null));
      else done(null);
    }
    this.render();
  }

  setPartsVisible(visible: boolean) {
    this.partsGroup.visible = visible;
    this.render();
  }

  setView(view: View3d) {
    const d = (this.size * 1.25) / Math.tan(rad(this.camera.fov / 2));
    const c = this.center;
    // A hair off vertical keeps the Z-up orbit well defined and puts the board's top edge at the
    // top of the screen; from below that mirrors left and right, as a bottom view should.
    if (view === 'top') this.camera.position.set(c.x, c.y - d * 1e-3, c.z + d * 0.75);
    else if (view === 'bottom') this.camera.position.set(c.x, c.y + d * 1e-3, c.z - d * 0.75);
    else this.camera.position.set(c.x + d * 0.25, c.y - d * 0.55, c.z + d * 0.5);
    this.controls.target.copy(c);
    this.controls.update();
    this.render();
  }

  dispose() {
    this.generation++;
    this.resize.disconnect();
    this.controls.dispose();
    this.clear(this.boardGroup);
    this.clear(this.partsGroup);
    for (const list of this.geometries.values()) for (const g of list) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }

  private fitCanvas() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** Removes a group's children, disposing what belongs to them alone (not shared part meshes). */
  private clear(group: THREE.Group) {
    for (const child of [...group.children]) {
      child.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || o.userData.shared) return;
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m.dispose();
        }
      });
      group.remove(child);
    }
  }

  private buildBoard(pcb: Pcb, board: BoardModel) {
    const shape = new THREE.Shape(boardOutline(pcb.board).map(([x, y]) => new THREE.Vector2(x, -y)));
    const drill = (x: number, y: number, r: number) => {
      const hole = new THREE.Path();
      hole.absarc(x, -y, r, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    };
    for (const v of pcb.vias) drill(v.x, v.y, v.drill / 2);
    for (const h of pcb.holes ?? []) drill(h.x, h.y, h.diameter / 2);
    for (const c of pcb.board.cutouts ?? []) {
      if (c.outline.length < 3) continue;
      shape.holes.push(new THREE.Path(c.outline.map(([x, y]) => new THREE.Vector2(x, -y))));
    }
    for (const p of board.pads) {
      if (!p.hole) continue;
      const { center, w, h, rotation } = p.hole;
      if (Math.abs(w - h) < 1e-6) drill(center[0], center[1], w / 2);
      else {
        // Slot: a capsule along its long axis.
        const r = Math.min(w, h) / 2;
        const half = Math.max(w, h) / 2 - r;
        const a = rad(rotation) + (w >= h ? 0 : Math.PI / 2);
        const [dx, dy] = [Math.cos(a) * half, Math.sin(a) * half];
        const [cx, cy] = [center[0], -center[1]];
        const slot = new THREE.Path();
        slot.absarc(cx + dx, cy + dy, r, a - Math.PI / 2, a + Math.PI / 2, false);
        slot.absarc(cx - dx, cy - dy, r, a + Math.PI / 2, a + (3 * Math.PI) / 2, false);
        shape.holes.push(slot);
      }
    }
    const body = new THREE.ExtrudeGeometry(shape, { depth: BOARD_THICKNESS, bevelEnabled: false, curveSegments: 24 });
    const edge = new THREE.MeshStandardMaterial({ color: 0xc8b07a, roughness: 0.8 });
    const core = new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.7 });
    this.boardGroup.add(new THREE.Mesh(body, [core, edge]));
    for (const side of ['top', 'bottom'] as const) {
      const face = new THREE.Mesh(new THREE.ShapeGeometry(shape, 24), this.faceMaterial(pcb, board, side));
      face.position.z = side === 'top' ? BOARD_THICKNESS + 0.005 : -0.005;
      this.boardGroup.add(face);
    }
  }

  private faceMaterial(pcb: Pcb, board: BoardModel, side: 'top' | 'bottom'): THREE.Material {
    const b = pcb.board;
    const maxPx = Math.min(4096, this.renderer.capabilities.maxTextureSize);
    const { svg, widthPx, heightPx } = renderBoardFace(pcb, board, side, Math.min(maxPx, Math.round(b.width * 28)));
    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // Shape UVs are board millimetres (y up); map the board rectangle onto the image.
    texture.repeat.set(1 / b.width, 1 / b.height);
    texture.offset.set(-b.x / b.width, (b.y + b.height) / b.height);
    const image = new Image();
    image.onload = () => {
      canvas.getContext('2d')!.drawImage(image, 0, 0, widthPx, heightPx);
      texture.needsUpdate = true;
      this.render();
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55, metalness: 0.05, side: side === 'top' ? THREE.FrontSide : THREE.BackSide });
  }

  /** Places a group given in footprint coordinates (y up) the way the footprint is placed. */
  private place(part: BoardModel['parts'][number], content: THREE.Object3D) {
    const { x, y, rotation, side } = part.placement;
    const placed = new THREE.Group();
    placed.add(content);
    if (side === 'top') {
      placed.position.set(x, -y, BOARD_THICKNESS);
      placed.rotation.set(0, 0, rad(rotation));
    } else {
      // Bottom parts are mirrored in x, as in 2D: flip about Y, then rotate.
      placed.position.set(x, -y, 0);
      placed.rotation.set(0, Math.PI, rad(rotation), 'ZYX');
    }
    placed.userData.designator = part.component.designator;
    this.partsGroup.add(placed);
  }

  private addModel(part: BoardModel['parts'][number], model: ParsedModel, transform: number[], key: string) {
    let geoms = this.geometries.get(key);
    if (!geoms) {
      geoms = model.parts.map((p) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
        g.computeVertexNormals();
        return g;
      });
      this.geometries.set(key, geoms);
    }
    const p = modelPlacement(model, transform);
    const inner = new THREE.Group();
    model.parts.forEach((mp, i) => {
      const mesh = new THREE.Mesh(geoms![i], partMaterial(mp.color, mp.opacity, this.materials));
      mesh.userData.shared = true;
      inner.add(mesh);
    });
    inner.position.set(...p.center);
    const scaled = new THREE.Group();
    scaled.scale.set(...p.scale);
    scaled.add(inner);
    const oriented = new THREE.Group();
    oriented.rotation.set(...p.rotation);
    oriented.position.set(...p.offset);
    oriented.add(scaled);
    this.place(part, oriented);
  }

  /** Stand-in block over the footprint for parts without a model. */
  private addBlock(part: BoardModel['parts'][number], pcb: Pcb) {
    const bbox = part.fp?.bbox ?? { x1: -1, y1: -1, x2: 1, y2: 1 };
    const title = pcb.footprints[pcb.footprintOf[part.component.id] ?? '']?.title ?? '';
    const height = fallbackHeight(title);
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.2, bbox.x2 - bbox.x1), Math.max(0.2, bbox.y2 - bbox.y1), height),
      new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.7 }),
    );
    // Footprint bbox is y-down; the part's frame here is y-up.
    block.position.set((bbox.x1 + bbox.x2) / 2, -(bbox.y1 + bbox.y2) / 2, height / 2);
    this.place(part, block);
  }
}
