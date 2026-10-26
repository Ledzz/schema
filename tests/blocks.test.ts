import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from '../src/store/editor';
import { attachPort, connectivity } from '../src/lib/actions';
import { insertBlock } from '../src/lib/blocks';
import { addDecoupling, planDecoupling, railVoltage, supplyPins } from '../src/lib/decoupling';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();

/** EasyEDA symbol with pins [number, name, x, y, rotation] around a 60×(n·10) body. */
function icSymbol(pins: [string, string, number, number, number][]): string {
  return [
    '["DOCTYPE","SYMBOL","1.1"]',
    '["PART","IC.1",{"BBOX":[-40,40,40,-40]}]',
    '["ATTR","d","","Designator","U?",false,false,null,null,0,"st1",0]',
    '["RECT","b",-30,30,30,-30,0,0,0,"st1",0]',
    ...pins.flatMap(([number, name, x, y, rot], i) => [
      `["PIN","p${i}",1,null,${x},${y},10,${rot},null,0,0,1]`,
      `["ATTR","n${i}","p${i}","NAME","${name}",false,true,0,0,0,"st1",0]`,
      `["ATTR","u${i}","p${i}","NUMBER","${number}",false,true,0,0,0,"st1",0]`,
    ]),
  ].join('\n');
}

const REGULATOR = icSymbol([
  ['3', 'VIN', -40, 10, 0],
  ['1', 'GND', 0, -40, 90],
  ['2', 'VOUT', 40, 10, 180],
  ['4', 'VOUT', 40, -10, 180],
]);
// A tact switch whose symbol lacks pin 4, so the button block fails part-way.
const BROKEN_SWITCH = icSymbol([
  ['1', 'A', -40, 10, 0],
  ['2', 'B', -40, -10, 0],
  ['3', 'C', 40, 10, 180],
]);

const detail = (lcsc: string, dataStr: string) => ({
  part: { lcsc, mpn: lcsc, partClass: 'basic', stock: 1000, prices: [], package: 'SOT-223', manufacturer: 'X', description: '' },
  device: { lcsc, title: lcsc, attributes: { Designator: 'U?' }, symbol: { title: lcsc, dataStr }, footprint: null, image: null },
});

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.startsWith('/api/parts/match')
      ? { canonical: null, candidates: [] }
      : url === '/api/parts/C6186'
        ? detail('C6186', REGULATOR)
        : url === '/api/parts/C318884'
          ? detail('C318884', BROKEN_SWITCH)
          : null;
    return { ok: body !== null, status: body ? 200 : 404, json: async () => body ?? { error: 'not found' } };
  });
  st().loadProject(project({}));
});
afterEach(() => vi.unstubAllGlobals());

/** Pins on a net, as "R1.2". */
const netPins = (name: string) =>
  connectivity()
    .nets.find((n) => n.name === name)
    ?.members.map((m) => `${m.designator}.${m.pinNumber}`)
    .sort() ?? [];

describe('circuit blocks', () => {
  it('inserts a regulator with its capacitors wired to the rails as one undo step', async () => {
    const r = await insertBlock('ldo-3v3', { VIN: '+12V' });
    expect(r.parts).toEqual({ U: 'U1', CIN: 'C1', COUT: 'C2' });
    expect(r.nets.sort()).toEqual(['+12V', '+3V3', 'GND']);
    // Upright capacitors: pin 2 is on top (the rail), pin 1 at the bottom (GND).
    expect(netPins('+12V')).toEqual(['C1.2', 'U1.3']);
    expect(netPins('+3V3')).toEqual(['C2.2', 'U1.2', 'U1.4']);
    expect(netPins('GND')).toEqual(['C1.1', 'C2.1', 'U1.1']);
    expect(connectivity().issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(st().past).toHaveLength(1);
    st().undo();
    expect(st().project.components).toEqual([]);
  });

  it('wires passives and labels the driving net', async () => {
    await insertBlock('led', { NET: 'STATUS' });
    expect(netPins('STATUS')).toEqual(['R1.1']);
    expect(netPins('GND')).toEqual(['LED1.1']);
    // R1's right pin runs to the LED's anode (pin 2) by a wire.
    const wired = connectivity().nets.find((n) => n.members.some((m) => m.designator === 'LED1' && m.pinNumber === '2'))!;
    expect(wired.members.map((m) => `${m.designator}.${m.pinNumber}`).sort()).toEqual(['LED1.2', 'R1.2']);
  });

  it('keeps nothing of a block that fails part-way', async () => {
    st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] }));
    await expect(insertBlock('button')).rejects.toThrow(/no pin "4"/);
    expect(st().project.components.map((c) => c.designator)).toEqual(['R1']);
    expect(st().project.wires).toEqual([]);
    expect(st().project.ports).toEqual([]);
    expect(st().past).toHaveLength(0);
  });

  it('refuses unknown blocks and parameters', async () => {
    await expect(insertBlock('nope')).rejects.toThrow(/Blocks: ldo-3v3/);
    await expect(insertBlock('led', { COLOUR: 'Red' })).rejects.toThrow(/Parameters: NET, COLOR, R/);
  });
});

describe('decoupling', () => {
  const MCU = icSymbol([
    ['1', 'VDD', -40, 10, 0],
    ['2', 'VSS', -40, -10, 0],
    ['3', 'VDDA', 40, 10, 180],
    ['4', 'PA0', 40, -10, 180],
    ['5', 'VDD', 0, 40, 270],
  ]);
  beforeEach(() => {
    const p = project({ components: [comp('u', 'mcu', 'U1', 0, 0)] });
    p.symbols = { ...p.symbols, mcu: { title: 'MCU', dataStr: MCU, source: 'easyeda' } };
    st().loadProject(p);
    attachPort('U1.1', 'power', '+3V3');
    attachPort('U1.5', 'power', '+3V3');
    attachPort('U1.2', 'ground', 'GND');
  });

  it('finds supply pins by name and skips grounds and signals', () => {
    const pins = supplyPins(st().project.components[0]);
    expect(pins.map((p) => [p.label, p.rail, p.analog])).toEqual([
      ['1 (VDD)', '+3V3', false],
      ['3 (VDDA)', null, true],
      ['5 (VDD)', '+3V3', false],
    ]);
  });

  it('asks for a rail when a supply pin is not connected yet', () => {
    expect(() => planDecoupling(st().project.components[0])).toThrow(/pins 3 \(VDDA\) aren't on a named supply net/);
  });

  it('adds 100 nF per pin, 1 µF + 10 nF on analog pins and bulk per rail', async () => {
    const before = st().past.length;
    const r = await addDecoupling('u', { rail: '+3V3' });
    expect(r.caps.map((c) => [c.value, c.size, c.pin ?? 'bulk'])).toEqual([
      ['100n', '0603', 'U1.1'],
      ['1u', '0603', 'U1.3'],
      ['10n', '0603', 'U1.3'],
      ['100n', '0603', 'U1.5'],
      ['10u', '0805', 'bulk'],
    ]);
    expect(r.connected).toEqual(['U1.3']);
    expect(netPins('+3V3')).toEqual(['C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'U1.1', 'U1.3', 'U1.5']);
    expect(netPins('GND')).toEqual(['C1.1', 'C2.1', 'C3.1', 'C4.1', 'C5.1', 'U1.2']);
    expect(st().past.length).toBe(before + 1);
    // The row sits below the part, clear of it.
    for (const c of st().project.components.filter((x) => x.designator.startsWith('C'))) expect(c.y).toBeGreaterThan(40);
  });

  it('rates capacitors on rails above 5 V', () => {
    expect(railVoltage('+3V3')).toBe(3.3);
    expect(railVoltage('+12V')).toBe(12);
    expect(railVoltage('VM')).toBeNull();
    st().loadProject(project({ components: [comp('u', 'mcu', 'U1', 0, 0)], symbols: { ...project({}).symbols, mcu: { title: 'MCU', dataStr: MCU, source: 'easyeda' } } }));
    const plan = planDecoupling(st().project.components[0], { rail: '+12V', bulk: false });
    expect(plan.caps.map((c) => c.value)).toEqual(['100n 25V', '1u 25V', '10n 25V', '100n 25V']);
  });
});
