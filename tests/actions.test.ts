import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor, emptyProject } from '../src/store/editor';
import { attachPort, connectPins, connectivity, disconnectPin, pinGridOffset } from '../src/lib/actions';
import { TOOLS, runTool } from '../src/lib/webmcp';
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

describe('labels on wired pins', () => {
  it('names a net through a pin that is already wired, without touching other nets', () => {
    const p = useEditor.getState().project;
    useEditor.getState().loadProject({ ...p, components: [comp('a', 'U1', 0, 0), comp('b', 'U2', 150, 0)] });
    attachPort('U1.1', 'ground', 'GND');
    connectPins('U1.2', 'U2.2');
    attachPort('U1.2', 'label', 'SIG');
    attachPort('U2.2', 'label', 'SIG');
    expect(netSummary()).toEqual(['GND:1', 'SIG:2,2']);
    expect(connectivity().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('disconnecting pins', () => {
  it('removes the wire and the dangling flag, and leaves other nets alone', () => {
    const p = useEditor.getState().project;
    useEditor.getState().loadProject({ ...p, components: [comp('a', 'U1', 0, 0), comp('b', 'U2', 150, 0)] });
    attachPort('U1.1', 'ground', 'GND');
    connectPins('U1.2', 'U2.2');
    expect(disconnectPin('U2.2')).toEqual({ wires: 1, labels: [] });
    expect(netSummary()).toEqual(['GND:1']);
    expect(disconnectPin('U1.1')).toEqual({ wires: 1, labels: ['GND'] });
    expect(useEditor.getState().project.ports).toEqual([]);
  });
});

describe('pin grid', () => {
  it('nudges parts whose pins sit between grid lines', () => {
    // Two pins centred on the origin, 5 units either side of it.
    const pair = [
      '["DOCTYPE","SYMBOL","1.1"]',
      '["PART","U.1",{"BBOX":[-30,10,20,-10]}]',
      '["RECT","b",-20,10,20,-10,0,0,0,"st1",0]',
      ...[1, 2].flatMap((n) => [`["PIN","p${n}",1,null,-30,${n === 1 ? 5 : -5},10,0,null,0,0,1]`, `["ATTR","n${n}","p${n}","NUMBER","${n}",false,true,0,0,0,"st1",0]`]),
    ].join('\n');
    const p = useEditor.getState().project;
    useEditor.getState().loadProject({ ...p, symbols: { u: { title: 'U', dataStr: pair, source: 'easyeda' } } });
    const c = useEditor.getState().project.components[0];
    expect(pinGridOffset(c).map(Math.abs)).toEqual([0, 5]);
    expect(pinGridOffset({ ...c, rotation: 90 }).map(Math.abs)).toEqual([5, 0]);
  });
});

describe('design check', () => {
  it('reports two power flags on one net as a short', () => {
    attachPort('U1.1', 'ground', 'GND');
    const p = useEditor.getState().project;
    const gnd = p.ports[0];
    useEditor.getState().loadProject({ ...p, ports: [...p.ports, { ...gnd, id: 'vcc', kind: 'power', name: '+3V3' }] });
    expect(connectivity().issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual(['Power nets shorted together: +3V3, GND']);
  });
});

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const netSummary = () => connectivity().nets.map((n) => `${n.name}:${n.members.map((m) => m.pinNumber).join()}`).sort();

describe('tool input', () => {
  it('rejects unknown, missing and mistyped fields with a hint', async () => {
    await expect(runTool(tool('add_power_flag'), { pin: 'U1.1', name: 'GND' })).rejects.toThrow(
      'Unknown input "name" for add_power_flag. Valid inputs: pin, net, style.',
    );
    await expect(runTool(tool('add_power_flag'), { pin: 'U1.1' })).rejects.toThrow('Missing required input "net"');
    await expect(runTool(tool('update_component'), { designator: 'U1', x: '10' })).rejects.toThrow('must be a number, got "10"');
    await expect(runTool(tool('update_component'), { designator: 'U1', rotation: 45 })).rejects.toThrow('must be one of 0, 90, 180, 270');
  });
});

describe('moving parts with update_component', () => {
  it('keeps attached flags connected and never joins nets', async () => {
    attachPort('U1.1', 'ground', 'GND');
    attachPort('U1.3', 'power', '+5V');
    await runTool(tool('update_component'), { designator: 'U1', x: 100, y: 50 });
    expect(netSummary()).toEqual(['+5V:3', 'GND:1']);
    for (const rotation of [90, 180, 270, 0]) {
      await runTool(tool('update_component'), { designator: 'U1', rotation }).catch((err: Error) => expect(err.message).toMatch(/^Not changed/));
      expect(netSummary()).toEqual(['+5V:3', 'GND:1']);
    }
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
