import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { attachPort, connectPins, connectivity, nameNet, pinByKey, planAttach, renameNet } from '../src/lib/actions';
import { finishWireDraft, removeWirePoint, wireDraftTo } from '../src/lib/editing';
import { componentBox, worldPins } from '../src/lib/schematic/geometry';
import { resolverFor } from '../src/lib/schematic/symbols';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();
const pinKey = (id: string, number: string) => {
  const c = st().project.components.find((x) => x.id === id)!;
  const p = worldPins(c, resolverFor(st().project)(c.symbolKey)).find((x) => x.pin.number === number)!;
  return { key: `${id}:${p.pin.id}`, at: p.at };
};

beforeEach(() => {
  // R1 pins at (-20, 0) and (20, 0), R2 at (180, 0) and (220, 0), R3 in between at (80..120, 0).
  st().loadProject(project({ components: [comp('r1', 'res', 'R1', 0, 0), comp('r2', 'res', 'R2', 200, 0), comp('r3', 'res', 'R3', 100, 0)] }));
});

describe('wiring in the editor', () => {
  it('routes a wire from pin to pin around the part in between', () => {
    const a = pinKey('r1', '2');
    const b = pinKey('r2', '1');
    const r = wireDraftTo([a.at], b.at);
    expect(r.routed).toBe(true);
    expect(r.points[0]).toEqual(a.at);
    expect(r.points.at(-1)).toEqual(b.at);
    const body = componentBox(st().project.components[2], resolverFor(st().project)('res'));
    for (let i = 1; i < r.points.length; i++) {
      const [p, q] = [r.points[i - 1], r.points[i]];
      const crosses = p[1] === q[1] && p[1] > body.y1 && p[1] < body.y2 && Math.max(p[0], q[0]) > body.x1 && Math.min(p[0], q[0]) < body.x2;
      expect(crosses).toBe(false);
    }
    // Flipping the bend asks for a plain wire instead.
    expect(wireDraftTo([a.at], b.at, st().project, true)).toEqual({ points: [a.at, b.at], routed: false });
  });

  it('routes between opposite sides of a tall part', () => {
    // Pins at (-50, 0) and (50, 0) on a body 240 units tall.
    const TALL = [
      '["DOCTYPE","SYMBOL","1.1"]',
      '["PART","U.1",{"BBOX":[-50,120,50,-120]}]',
      '["RECT","b",-40,120,40,-120,0,0,0,"st1",0]',
      '["PIN","l",1,null,-50,0,10,0,null,0,0,1]',
      '["ATTR","ln","l","NUMBER","1",false,true,0,0,0,"st1",0]',
      '["PIN","r",1,null,50,0,10,180,null,0,0,1]',
      '["ATTR","rn","r","NUMBER","2",false,true,0,0,0,"st1",0]',
    ].join('\n');
    const p = project({ components: [comp('u', 'tall', 'U1', 0, 0)] });
    p.symbols = { ...p.symbols, tall: { title: 'TALL', dataStr: TALL, source: 'easyeda' } };
    st().loadProject(p);
    const r = wireDraftTo([[-50, 0]], [50, 0]);
    expect(r.routed).toBe(true);
    const body = componentBox(st().project.components[0], resolverFor(st().project)('tall'));
    for (let i = 1; i < r.points.length; i++) {
      const [a, b] = [r.points[i - 1], r.points[i]];
      const inside = (x: number, y: number) => x > body.x1 + 11 && x < body.x2 - 11 && y > body.y1 && y < body.y2;
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(inside(...mid)).toBe(false);
    }
  });

  it('leaves a pin along the pin when bending', () => {
    const a = pinKey('r1', '2');
    expect(wireDraftTo([a.at], [60, 40]).points).toEqual([a.at, [60, 0], [60, 40]]);
  });

  it('goes back to select after a wire started from a pin', () => {
    st().startWire(pinKey('r1', '1').at);
    expect(st().tool).toBe('wire');
    expect(removeWirePoint()).toBe(true);
    expect(st().tool).toBe('select');
    expect(removeWirePoint()).toBe(false);

    st().startWire([-20, 0]);
    st().setWireDraft([[-20, 0], [-40, 0]]);
    finishWireDraft();
    expect(st().tool).toBe('select');
    expect(st().project.wires).toHaveLength(1);
  });

  it('points a label on a left-hand pin away from the part', () => {
    const pin = pinByKey(pinKey('r1', '1').key)!;
    const plan = planAttach(st().project, pin, 'label', 'SIG')!;
    expect(plan.points[0]).toEqual([-20, 0]);
    expect(plan.port.x).toBeLessThan(-20);
    expect(plan.port.rotation).toBe(180);
  });

  it('offers the most used power net for a new power flag', () => {
    st().loadProject(project({ ports: [{ id: 'a', kind: 'power', name: '+3V3', x: 0, y: 0, rotation: 0 }, { id: 'b', kind: 'power', name: '+3V3', x: 50, y: 0, rotation: 0 }, { id: 'c', kind: 'power', name: '+5V', x: 90, y: 0, rotation: 0 }] }));
    st().startPort('power');
    expect(st().portTemplate.name).toBe('+3V3');
    st().setPortTemplate({ name: '+5V' });
    st().startPort('ground');
    st().startPort('power');
    expect(st().portTemplate.name).toBe('+5V');
  });
});

describe('naming nets', () => {
  it('renames every label and flag of a net together', () => {
    attachPort('R1.1', 'label', 'SIG');
    attachPort('R2.2', 'label', 'SIG');
    attachPort('R3.1', 'label', 'OTHER');
    expect(renameNet('SIG', 'DATA')).toEqual({ renamed: 2, merged: false });
    const data = connectivity().nets.find((n) => n.name === 'DATA')!;
    expect(data.members.map((m) => `${m.designator}.${m.pinNumber}`).sort()).toEqual(['R1.1', 'R2.2']);
    // Renaming onto a name in use joins the nets, and says so.
    expect(renameNet('DATA', 'OTHER')).toEqual({ renamed: 2, merged: true });
    expect(connectivity().nets.find((n) => n.name === 'OTHER')!.members).toHaveLength(3);
    expect(() => renameNet('NOPE', 'X')).toThrow(/No label or flag/);
  });

  it('names an unnamed net with a label on one of its pins', () => {
    const { wireId } = connectPins('R1.2', 'R3.1');
    nameNet(wireId, 'LINK');
    const link = connectivity().nets.find((n) => n.name === 'LINK')!;
    expect(link.members.map((m) => `${m.designator}.${m.pinNumber}`).sort()).toEqual(['R1.2', 'R3.1']);
  });
});
