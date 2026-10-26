import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { connectivity } from '../src/lib/actions';
import { placeQuickItem, quickSuggestions, searchesLibrary } from '../src/lib/quickadd';
import { PASSIVES } from '../src/shared/passives';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();
// R1 with SDA on pin 1 and +3V3 on pin 2; U1 is an LCSC regulator.
const design = () =>
  project({
    components: [comp('a', 'res', 'R1', 0, 0), comp('u', 'ldo', 'U1', 200, 0, { value: 'AMS1117-3.3', lcsc: 'C6186', attrs: { 'Manufacturer Part': 'AMS1117-3.3' } })],
    wires: [
      { id: 'w1', points: [[-20, 0], [-40, 0]] },
      { id: 'w2', points: [[20, 0], [40, 0]] },
    ],
    ports: [
      { id: 'l', kind: 'label', name: 'SDA', x: -40, y: 0, rotation: 0 },
      { id: 'p', kind: 'power', name: '+3V3', x: 40, y: 0, rotation: 0 },
    ],
  });
const first = (q: string, onPin = false) => quickSuggestions(q, st().project, { onPin })[0];
const titles = (q: string) => quickSuggestions(q, st().project).map((s) => s.title);

describe('quick add suggestions', () => {
  beforeEach(() => st().loadProject(design()));

  it('reads passives by value, kind and size', () => {
    expect(first('10k').item).toEqual({ kind: 'passive', passive: 'resistor', value: '10kΩ', size: PASSIVES.resistor.defaultSize });
    // Not also a 10 kF capacitor.
    expect(titles('10k').filter((t) => t.startsWith('Capacitor'))).toEqual([]);
    expect(first('100n 0402').item).toMatchObject({ passive: 'capacitor', value: '100nF', size: '0402' });
    expect(first('10uF 16V 0805').item).toMatchObject({ passive: 'capacitor', value: '10uF 16V', size: '0805' });
    expect(first('22uH').item).toMatchObject({ passive: 'inductor', value: '22uH' });
    expect(first('LED green 0603').item).toMatchObject({ passive: 'led', value: 'Green', size: '0603' });
    expect(first('r 4k7').item).toMatchObject({ passive: 'resistor', value: '4.7kΩ' });
  });

  it('offers rails, ground, nets, parts in the design and blocks', () => {
    expect(first('3v3')).toMatchObject({ item: { kind: 'power', name: '+3V3' }, known: true });
    expect(first('12v').item).toEqual({ kind: 'power', name: '+12V' });
    expect(first('gnd').item).toEqual({ kind: 'ground', name: 'GND' });
    // A rail-like name is a flag first and a label second; with a suffix it is a signal.
    expect(titles('vbus').slice(0, 2)).toEqual(['Power flag VBUS', 'Net label vbus']);
    expect(first('VIN_SENSE').item).toEqual({ kind: 'label', name: 'VIN_SENSE' });
    expect(first('SD')).toMatchObject({ item: { kind: 'label', name: 'SD' } });
    expect(titles('SD')).toContain('Net label SDA');
    expect(first('ams1117').item).toEqual({ kind: 'same', componentId: 'u' });
    expect(titles('usb')).toContain('USB-C power input (5 V)');
    // Nothing typed: the design's rails, ground and recent parts.
    expect(titles('')).toEqual(['Power flag +3V3', 'Ground', 'Another AMS1117-3.3', 'Another R1']);
  });

  it('names the pin under the cursor first', () => {
    expect(first('SDA', true).item).toEqual({ kind: 'label', name: 'SDA' });
    expect(first('nc', true).item).toEqual({ kind: 'noconnect' });
    expect(first('nc').item.kind).not.toBe('noconnect');
  });

  it('searches JLCPCB only for words that are not values, rails or nets of the design', () => {
    const search = (q: string) => searchesLibrary(q, quickSuggestions(q, st().project));
    expect(search('AMS1117')).toBe(true);
    expect(search('SDA')).toBe(false);
    expect(search('10k')).toBe(false);
    expect(search('+3V3')).toBe(false);
    expect(search('ab')).toBe(false);
  });
});

describe('placing from quick add', () => {
  beforeEach(() => st().loadProject(design()));

  it('labels a pin, drops flags and copies parts', async () => {
    // U1 pin 3 (VIN, left side at (170, -10)) gets a label on a stub leading away from the part.
    const [label] = await placeQuickItem({ kind: 'label', name: 'VBUS' }, [170, -10], 'u:p1');
    const port = st().project.ports.find((p) => p.id === label)!;
    expect(port).toMatchObject({ kind: 'label', name: 'VBUS', y: -10 });
    expect(port.x).toBeLessThan(170);
    expect(connectivity().pinNet.get('u:p1')).toBe('VBUS');
    // A flag where nothing is.
    const [flag] = await placeQuickItem({ kind: 'ground', name: 'GND' }, [100, 100]);
    expect(st().project.ports.find((p) => p.id === flag)).toMatchObject({ kind: 'ground', x: 100, y: 100 });
    // Another copy of U1, with the next designator and its LCSC part.
    const [copy] = await placeQuickItem({ kind: 'same', componentId: 'u' }, [400, 0]);
    expect(st().project.components.find((c) => c.id === copy)).toMatchObject({ designator: 'U2', lcsc: 'C6186', value: 'AMS1117-3.3', symbolKey: 'ldo' });
  });
});
