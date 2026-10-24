import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor, emptyProject } from '../src/store/editor';
import { attachPort, connectPins, connectivity } from '../src/lib/actions';
import type { Component } from '../src/lib/schematic/types';

/** Three pins stacked on the left at 10-unit pitch, like a SOT-223 regulator. */
const TRIPLE = [
  '["DOCTYPE","SYMBOL","1.1"]',
  '["PART","U.1",{"BBOX":[-30,20,20,-20]}]',
  '["ATTR","d","","Designator","U?",false,false,null,null,0,"st1",0]',
  '["RECT","b",-20,20,20,-20,0,0,0,"st1",0]',
  ...[1, 2, 3].flatMap((n) => [
    `["PIN","p${n}",1,null,-30,${20 - n * 10},10,0,null,0,0,1]`,
    `["ATTR","n${n}","p${n}","NUMBER","${n}",false,true,0,0,0,"st1",0]`,
  ]),
].join('\n');

const comp = (id: string, designator: string, x: number, y: number): Component => ({
  id,
  symbolKey: 'u',
  unit: 0,
  designator,
  value: designator,
  x,
  y,
  rotation: 0,
  mirror: false,
  attrs: {},
});

beforeEach(() => {
  const p = emptyProject('t');
  p.symbols = { u: { title: 'U', dataStr: TRIPLE, source: 'easyeda' } };
  p.components = [comp('a', 'U1', 0, 0)];
  useEditor.getState().loadProject(p);
});

describe('attaching flags', () => {
  it('never shorts flags on adjacent pins', () => {
    attachPort('U1.3', 'power', '+5V');
    attachPort('U1.1', 'ground', 'GND');
    attachPort('U1.2', 'power', '+3V3');
    const conn = connectivity();
    expect(conn.issues.filter((i) => i.message.startsWith('Net has several names'))).toEqual([]);
    expect(conn.nets.map((n) => `${n.name}:${n.members.map((m) => m.pinNumber).join()}`).sort()).toEqual(['+3V3:2', '+5V:3', 'GND:1']);
  });
});

describe('connecting pins', () => {
  it('routes without touching other wiring', () => {
    const p = useEditor.getState().project;
    useEditor.getState().loadProject({ ...p, components: [comp('a', 'U1', 0, 0), comp('b', 'U2', 150, 0)] });
    attachPort('U1.1', 'ground', 'GND');
    connectPins('U1.2', 'U2.2');
    const conn = connectivity();
    const net = conn.nets.find((n) => n.members.some((m) => m.designator === 'U2'));
    expect(net?.members.map((m) => `${m.designator}.${m.pinNumber}`)).toEqual(['U1.2', 'U2.2']);
    expect(conn.nets.find((n) => n.name === 'GND')?.members).toHaveLength(1);
  });
});
