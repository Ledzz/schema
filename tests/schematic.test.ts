import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/schematic/netlist';
import { alignItems, deleteItems, dragWire, moveItems, moveWirePoints, rotateItems } from '../src/lib/schematic/ops';
import { findItems } from '../src/lib/find';
import { resolverFor } from '../src/lib/schematic/symbols';
import { autoRoute, routePins, portRotationFor, simplify, wireVerticalFirst } from '../src/lib/schematic/route';
import { worldPins, toWorld } from '../src/lib/schematic/geometry';
import { nextDesignator, annotate } from '../src/lib/schematic/designators';
import { comp, project } from './fixtures';
import type { Vec } from '../src/lib/schematic/types';

const resolve = resolverFor(project({}));

describe('geometry', () => {
  it('rotates counter-clockwise on screen and mirrors before rotating', () => {
    expect(toWorld({ x: 100, y: 100, rotation: 90, mirror: false }, [20, 0])).toEqual([100, 80]);
    expect(toWorld({ x: 0, y: 0, rotation: 0, mirror: true }, [20, 5])).toEqual([-20, 5]);
  });

  it('places pins in world space', () => {
    const pins = worldPins(comp('r', 'res', 'R1', 100, 50, { rotation: 90 }), resolve('res'));
    expect(pins.map((p) => p.at)).toEqual([
      [100, 70],
      [100, 30],
    ]);
  });
});

describe('connectivity', () => {
  it('connects pins through wires and names nets from labels and power flags', () => {
    // R1 pins at (-20,0),(20,0); R2 at (80,0),(120,0)
    const p = project({
      components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 100, 0)],
      wires: [{ id: 'w1', points: [[20, 0], [80, 0]] }],
      ports: [
        { id: 'g', kind: 'ground', name: 'GND', x: -20, y: 0, rotation: 0 },
        { id: 'l', kind: 'label', name: 'MID', x: 50, y: 0, rotation: 0 },
      ],
    });
    const c = analyze(p, resolve);
    const names = c.nets.map((n) => [n.name, n.members.map((m) => `${m.designator}.${m.pinNumber}`)]);
    expect(names).toContainEqual(['MID', ['R1.2', 'R2.1']]);
    expect(names).toContainEqual(['GND', ['R1.1']]);
    expect(c.unconnected.map((u) => `${u.designator}.${u.pinNumber}`)).toEqual(['R2.2']);
  });

  it('joins same-named labels across the sheet', () => {
    const p = project({
      components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 0, 100)],
      ports: [
        { id: 'l1', kind: 'label', name: 'SDA', x: 20, y: 0, rotation: 0 },
        { id: 'l2', kind: 'label', name: 'SDA', x: 20, y: 100, rotation: 0 },
      ],
    });
    const sda = analyze(p, resolve).nets.find((n) => n.name === 'SDA');
    expect(sda?.members.map((m) => m.designator)).toEqual(['R1', 'R2']);
  });

  it('connects T-junctions but not pins lying mid-wire, and draws junction dots', () => {
    const p = project({
      components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 60, 40, { rotation: 90 })],
      // horizontal wire from R1.2 passes over R2's top pin end (60,20)? No: R2 pins at (60,60),(60,20)
      wires: [
        { id: 'w1', points: [[20, 0], [100, 0]] },
        { id: 'w2', points: [[60, 0], [60, 20]] },
      ],
    });
    const c = analyze(p, resolve);
    const net = c.nets.find((n) => n.members.some((m) => m.designator === 'R2'));
    expect(net?.members.map((m) => `${m.designator}.${m.pinNumber}`)).toEqual(['R1.2', 'R2.2']);
    expect(c.junctions).toEqual([{ at: [60, 0], sheet: 's1' }]);

    const midWire = project({
      components: [comp('a', 'res', 'R1', 0, 0)],
      wires: [{ id: 'w', points: [[-40, 0], [40, 0]] }],
    });
    // Both pin ends lie in the middle of the wire: still unconnected.
    expect(analyze(midWire, resolve).unconnected).toHaveLength(2);
  });

  it('reports duplicate and unannotated designators', () => {
    const p = project({ components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R1', 100, 0), comp('c', 'res', 'R?', 200, 0)] });
    const messages = analyze(p, resolve).issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(messages).toEqual(['Duplicate designator R1', 'R? is not annotated']);
  });
});

describe('editing operations', () => {
  const base = project({
    components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 100, 0)],
    wires: [{ id: 'w', points: [[20, 0], [80, 0]] }],
  });

  it('drags attached wire ends along and keeps them orthogonal', () => {
    const moved = moveItems(base, new Set(['b']), 0, 30, resolve);
    const w = moved.wires[0].points;
    expect(w[0]).toEqual([20, 0]);
    expect(w[w.length - 1]).toEqual([80, 30]);
    for (let i = 1; i < w.length; i++) expect(w[i][0] === w[i - 1][0] || w[i][1] === w[i - 1][1]).toBe(true);
    expect(analyze({ ...moved, ports: [] }, resolve).nets).toHaveLength(1);
  });

  it('moves whole wires when they are selected', () => {
    const moved = moveItems(base, new Set(['a', 'b', 'w']), 10, 10, resolve);
    expect(moved.wires[0].points).toEqual([
      [30, 10],
      [90, 10],
    ]);
  });

  it('drags the wire end on a net label or flag along with it', () => {
    const labelled = project({
      components: [comp('a', 'res', 'R1', 0, 0)],
      wires: [{ id: 'w', points: [[20, 0], [60, 0]] }],
      ports: [{ id: 'l', kind: 'label', name: 'SIG', x: 60, y: 0, rotation: 0 }],
    });
    const moved = moveItems(labelled, new Set(['l']), 20, 30, resolve);
    expect(moved.ports[0]).toMatchObject({ x: 80, y: 30 });
    const w = moved.wires[0].points;
    expect(w[0]).toEqual([20, 0]);
    expect(w.at(-1)).toEqual([80, 30]);
    for (let i = 1; i < w.length; i++) expect(w[i][0] === w[i - 1][0] || w[i][1] === w[i - 1][1]).toBe(true);
    expect(analyze(moved, resolve).nets.find((n) => n.name === 'SIG')?.members.map((m) => m.designator)).toEqual(['R1']);

    const turned = rotateItems(labelled, new Set(['l']), resolve);
    expect(turned.wires[0].points.at(-1)).toEqual([turned.ports[0].x, turned.ports[0].y]);
  });

  it('rotates a component in place and re-attaches its wire', () => {
    const rotated = rotateItems(base, new Set(['b']), resolve);
    expect(rotated.components[1].rotation).toBe(90);
    const end = rotated.wires[0].points.at(-1)!;
    const pins = worldPins(rotated.components[1], resolve('res')).map((p) => p.at);
    expect(pins).toContainEqual(end);
  });
});

describe('editing wires', () => {
  it('keeps segments orthogonal when vertices move', () => {
    // An L: drag its corner and both legs follow.
    expect(moveWirePoints([[0, 0], [50, 0], [50, 40]], new Set([1]), [10, 5])).toEqual([[0, 5], [60, 5], [60, 40]]);
    // The same with the start connected: it stays and the wire turns up to it.
    expect(moveWirePoints([[0, 0], [50, 0], [50, 40]], new Set([1]), [10, 5], [true, false])).toEqual([[0, 0], [0, 5], [60, 5], [60, 40]]);
    // A straight wire between two pins dragged sideways becomes a U.
    expect(moveWirePoints([[0, 0], [60, 0]], new Set([0, 1]), [0, 20], [true, true])).toEqual([[0, 0], [0, 20], [60, 20], [60, 0]]);
  });

  // R1 pins at (-20, 0) and (20, 0); R2 at (180, 0) and (220, 0).
  const base = project({
    components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 200, 0)],
    wires: [
      { id: 'w', points: [[20, 0], [100, 0], [100, 40], [180, 40], [180, 0]] },
      { id: 't', points: [[140, 40], [140, 80]] },
    ],
    ports: [{ id: 'l', kind: 'label', name: 'SIG', x: 160, y: 40, rotation: 0 }],
  });

  it('drags a segment sideways with what sits on it', () => {
    const after = dragWire(base, 'w', { segment: 2 }, [7, 20], resolve);
    expect(after.wires[0].points).toEqual([[20, 0], [100, 0], [100, 60], [180, 60], [180, 0]]);
    // The T-junction wire and the label on that segment come along.
    expect(after.wires[1].points[0]).toEqual([140, 60]);
    expect(after.ports[0]).toMatchObject({ x: 160, y: 60 });
    expect(analyze({ ...after, ports: [] }, resolve).nets.some((n) => n.members.length === 2)).toBe(true);
  });

  it('keeps an end on its pin when the first segment moves', () => {
    const after = dragWire(base, 'w', { segment: 0 }, [0, -30], resolve);
    expect(after.wires[0].points).toEqual([[20, 0], [20, -30], [100, -30], [100, 40], [180, 40], [180, 0]]);
  });

  it('moves a dragged end off its pin', () => {
    const after = dragWire(base, 'w', { vertex: 0 }, [-40, 0], resolve);
    expect(after.wires[0].points[0]).toEqual([-20, 0]);
  });

  it('keeps a moved wire on the pins of parts left behind', () => {
    const moved = moveItems(base, new Set(['w']), 0, 20, resolve);
    const pts = moved.wires[0].points;
    expect(pts[0]).toEqual([20, 0]);
    expect(pts[pts.length - 1]).toEqual([180, 0]);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
  });
});

describe('deleting parts', () => {
  // R1 pins at (-20, 0) and (20, 0); R2 at (80, 0) and (120, 0); R3 at (-20, 100) and (20, 100).
  const base = project({
    components: [comp('r1', 'res', 'R1', 0, 0), comp('r2', 'res', 'R2', 100, 0), comp('r3', 'res', 'R3', 0, 100)],
    wires: [
      { id: 'between', points: [[20, 0], [80, 0]] },
      { id: 'stub1', points: [[-20, 0], [-40, 0]] },
      { id: 'stub2', points: [[-40, 0], [-40, 20]] },
      { id: 'loose', points: [[200, 200], [220, 200]] },
    ],
    ports: [
      { id: 'sig', kind: 'label', name: 'SIG', x: -40, y: 20, rotation: 270 },
      { id: 'vcc', kind: 'power', name: 'VCC', x: -20, y: 100, rotation: 0 },
      { id: 'nc', kind: 'noconnect', name: '', x: 20, y: 100, rotation: 0 },
    ],
  });

  it('removes the wiring that only connected to them', () => {
    const after = deleteItems(base, new Set(['r1', 'r3']), resolve);
    expect(after.components.map((c) => c.id)).toEqual(['r2']);
    // The wire to R2 still leads somewhere; the unrelated loose wire was never touched.
    expect(after.wires.map((w) => w.id)).toEqual(['between', 'loose']);
    expect(after.ports).toEqual([]);
  });

  it('leaves wiring alone without symbols to find the pins', () => {
    const after = deleteItems(base, new Set(['r1', 'r3']));
    expect(after.wires).toHaveLength(4);
    expect(after.ports).toHaveLength(3);
  });
});

describe('drawing wires', () => {
  it('leaves a pin along the pin, then turns at each corner', () => {
    expect(wireVerticalFirst([[0, 0]], [30, 40], [1, 0])).toBe(false);
    expect(wireVerticalFirst([[0, 0]], [30, 40], [0, 1])).toBe(true);
    expect(wireVerticalFirst([[0, 0], [30, 0]], [60, 40], null)).toBe(true);
    expect(wireVerticalFirst([[0, 0], [0, 30]], [40, 60], null)).toBe(false);
    // Nothing to go by: along the longer distance first.
    expect(wireVerticalFirst([[0, 0]], [10, 40], null)).toBe(true);
    expect(wireVerticalFirst([[0, 0]], [30, 40], [1, 0], true)).toBe(true);
  });
});

describe('routing', () => {
  it('connects facing pins with a straight wire', () => {
    expect(routePins({ at: [20, 0], dir: [-1, 0] }, { at: [80, 0], dir: [1, 0] })).toEqual([
      [20, 0],
      [80, 0],
    ]);
  });

  it('produces orthogonal routes otherwise', () => {
    const pts = routePins({ at: [20, 0], dir: [-1, 0] }, { at: [80, 50], dir: [0, 1] });
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
    expect(pts[0]).toEqual([20, 0]);
    expect(pts.at(-1)).toEqual([80, 50]);
  });

  it('routes around component bodies and avoids other connection points', () => {
    // Pin on the left side of a body that spans x 0..40, target to the right of the body.
    const body = { x1: 0, y1: -20, x2: 40, y2: 20 };
    const route = autoRoute({ at: [0, 0], dir: [1, 0] }, { at: [100, 0], dir: [1, 0] }, { boxes: [body], points: [[40, 0]], segments: [] });
    expect(route).not.toBeNull();
    const pts = route!;
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([100, 0]);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      // No segment passes through the body interior.
      const midX = (a[0] + b[0]) / 2;
      const midY = (a[1] + b[1]) / 2;
      expect(midX > body.x1 && midX < body.x2 && midY > body.y1 && midY < body.y2).toBe(false);
    }
  });

  it('simplifies collinear points', () => {
    expect(simplify([[0, 0], [10, 0], [20, 0], [20, 0], [20, 10]] as Vec[])).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
    ]);
  });

  it('orients ports along a direction', () => {
    expect(portRotationFor('label', [-1, 0])).toBe(180);
    expect(portRotationFor('power', [0, -1])).toBe(0);
    expect(portRotationFor('ground', [1, 0])).toBe(90);
  });
});

describe('designators', () => {
  it('fills the lowest gap', () => {
    expect(nextDesignator('R', [{ designator: 'R1' }, { designator: 'R3' }, { designator: 'C2' }])).toBe('R2');
  });

  it('annotates by position', () => {
    const names = annotate([comp('a', 'res', 'R7', 100, 0), comp('b', 'res', 'R2', 0, 0), comp('c', 'res', 'R9', 0, 200)]);
    expect([...names.entries()]).toEqual([
      ['b', 'R1'],
      ['a', 'R2'],
      ['c', 'R3'],
    ]);
  });
});

describe('find', () => {
  const p = project({
    components: [comp('a', 'res', 'R1', 0, 0, { value: '10kΩ', lcsc: 'C25804' }), comp('b', 'res', 'R12', 100, 0, { value: '1kΩ' }), comp('c', 'res', 'U1', 200, 0, { value: 'STM32F030', attrs: { 'Manufacturer Part': 'STM32F030C6T6TR' } })],
    ports: [{ id: 'l', kind: 'label', name: 'R1_SENSE', x: -20, y: 0, rotation: 0 }],
  });
  const conn = analyze(p, resolve);

  it('puts exact designators first, then prefixes, then other fields and nets', () => {
    expect(findItems(p, conn, 'r1').map((r) => r.label)).toEqual(['R1', 'R12', 'R1_SENSE']);
    expect(findItems(p, conn, 'c25804').map((r) => r.label)).toEqual(['R1']);
    expect(findItems(p, conn, 'stm32')[0]).toMatchObject({ kind: 'part', label: 'U1' });
    expect(findItems(p, conn, 'sense')[0]).toMatchObject({ kind: 'net', label: 'R1_SENSE', ids: ['l'] });
    expect(findItems(p, conn, '   ')).toEqual([]);
  });
});

describe('align and distribute', () => {
  const p = project({ components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 100, 40), comp('c', 'res', 'R3', 300, 90)] });
  const ids = new Set(['a', 'b', 'c']);

  it('aligns tops on the grid and spaces centres evenly', () => {
    expect(alignItems(p, ids, 'top', resolve).components.map((c) => c.y)).toEqual([0, 0, 0]);
    expect(alignItems(p, ids, 'left', resolve).components.map((c) => c.x)).toEqual([0, 0, 0]);
    // Centres at 0, 100 and 300: the middle one goes to 150.
    expect(alignItems(p, ids, 'distribute-x', resolve).components.map((c) => c.x)).toEqual([0, 150, 300]);
    // Too few items: nothing moves.
    expect(alignItems(p, new Set(['a', 'b']), 'distribute-y', resolve)).toBe(p);
  });
});
