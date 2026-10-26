import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { attachPort, connectPins, connectivity } from '../src/lib/actions';
import { deleteLibraryItem, partWarnings, placeCustomPart, saveFootprint, savePart, saveSymbol, setFootprint, setSymbol } from '../src/lib/library';
import { syncPcb } from '../src/lib/pcb/actions';
import { generateFootprint, packageSpec } from '../src/lib/pcb/ipc';
import { icSymbol, parsePinList } from '../src/lib/schematic/symbolgen';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();
const pins = (text: string) => parsePinList(text);

describe('custom parts', () => {
  beforeEach(() => st().loadProject(project({ components: [comp('r', 'res', 'R1', -100, 0)] })));

  it('pairs a symbol with a footprint, places it and puts it on the board', async () => {
    const symbol = saveSymbol('LDO X', icSymbol('LDO X', 'U', pins('1 VIN left\n2 GND bottom\n3 VOUT right'))).key;
    const footprint = saveFootprint('SOT-23 test', generateFootprint(packageSpec('SOT-23')));
    const part = savePart({ name: 'LDO X', symbolKey: symbol, footprintKey: footprint, prefix: 'U', value: '3.3 V', attrs: { 'Manufacturer Part': 'LDOX-33' } });
    expect(partWarnings(part)).toEqual([]);
    const u = placeCustomPart('ldo x', { x: 0, y: 0 });
    expect(u).toMatchObject({ designator: 'U1', value: '3.3 V', footprint: 'user:sot-23-test', attrs: { Footprint: 'SOT-23 test', 'Manufacturer Part': 'LDOX-33' } });
    // The board takes the part's own footprint; R1 has none.
    const report = await syncPcb();
    expect(report.missing).toEqual(['R1']);
    expect(st().project.pcb!.footprintOf[u.id]).toBe('user:sot-23-test');
    // Saving the footprint again updates the board's copy.
    saveFootprint('SOT-23 test', generateFootprint(packageSpec('SOT-23-5')));
    expect(st().project.pcb!.footprints['user:sot-23-test'].geom!.pads).toHaveLength(5);
    expect(() => deleteLibraryItem('footprint', 'user:sot-23-test')).toThrow(/Still used by U1, part LDO X/);
  });

  it('warns about pins without pads, and pads without pins', () => {
    const symbol = saveSymbol('Four', icSymbol('Four', 'U', pins('1 A\n2 B\n3 C\n9 D'))).key;
    const footprint = saveFootprint('SOIC', generateFootprint(packageSpec('SOIC-8')));
    expect(partWarnings({ symbolKey: symbol, footprintKey: footprint })).toEqual(['Pins without a pad: 9', 'Pads no pin connects: 4, 5, 6, 7, 8 (fine for mounting or thermal pads)']);
    expect(partWarnings({ symbolKey: symbol, footprintKey: null })).toEqual(['No footprint: the part cannot go on the board']);
    expect(() => saveSymbol('Bad', { ...icSymbol('Bad', 'U', pins('1 A')), units: [] })).toThrow(/at least one pin/);
  });

  it('moves label stubs with redrawn pins rather than jogging them into each other', () => {
    const key = saveSymbol('Sensor', icSymbol('Sensor', 'U', pins('1 SCL left\n6 SDA left\n3 ALERT right\n4 ADD0 right'))).key;
    savePart({ name: 'Sensor', symbolKey: key, footprintKey: null, prefix: 'U', value: 'Sensor', attrs: {} });
    placeCustomPart('Sensor', { x: 0, y: 0 });
    attachPort('U1.SCL', 'label', 'SCL');
    attachPort('U1.SDA', 'label', 'SDA');
    const shapes = () => st().project.wires.map((w) => w.points.length);
    const before = shapes();
    // A supply pin on top pushes the side pins down; both labels go with their pins.
    const r = saveSymbol('Sensor', icSymbol('Sensor', 'U', pins('1 SCL left\n6 SDA left\n3 ALERT right\n4 ADD0 right\n5 VDD top\n2 GND bottom')));
    expect(r.joined).toEqual([]);
    const nets = Object.fromEntries(connectivity().nets.map((n) => [n.name, n.members.map((m) => `${m.designator}.${m.pinNumber}`)]));
    expect(nets).toMatchObject({ SCL: ['U1.1'], SDA: ['U1.6'] });
    // Moved whole, without a jog.
    expect(shapes()).toEqual(before);
  });

  it('keeps wires on pins of the same number when a symbol is redrawn or swapped', () => {
    const key = saveSymbol('Amp', icSymbol('Amp', 'U', pins('1 IN left\n2 OUT right'))).key;
    savePart({ name: 'Amp', symbolKey: key, footprintKey: null, prefix: 'U', value: 'Amp', attrs: {} });
    placeCustomPart('Amp', { x: 0, y: 0 });
    connectPins('R1.2', 'U1.1');
    const net = () => connectivity().nets.find((n) => n.members.some((m) => m.designator === 'U1'))?.members.map((m) => `${m.designator}.${m.pinNumber}`);
    expect(net()).toEqual(['R1.2', 'U1.1']);
    // Pin 1 moves down a row when two pins are added above it on the left.
    saveSymbol('Amp', icSymbol('Amp', 'U', pins('3 EN left\n4 NC left\n1 IN left\n2 OUT right')));
    expect(net()).toEqual(['R1.2', 'U1.1']);
    // A different symbol for the same part: pin 1 is now on the right.
    const other = saveSymbol('Amp flipped', icSymbol('Amp flipped', 'U', pins('2 OUT left\n1 IN right'))).key;
    setSymbol([st().project.components.find((c) => c.designator === 'U1')!.id], other);
    expect(net()).toEqual(['R1.2', 'U1.1']);
    // A footprint chosen for a placed part, and back to the library's.
    const fp = saveFootprint('Two pads', generateFootprint(packageSpec('0603')));
    const r = st().project.components.find((c) => c.designator === 'R1')!;
    setFootprint([r.id], fp);
    expect(st().project.components.find((c) => c.id === r.id)).toMatchObject({ footprint: fp, attrs: { Footprint: 'Two pads' } });
    setFootprint([r.id], null);
    expect(st().project.components.find((c) => c.id === r.id)!.footprint).toBeUndefined();
  });
});
