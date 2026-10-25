import { describe, expect, it } from 'vitest';
import { PASSIVE_SYMBOLS, attributeMatches, formatSi, parsePassiveValue, sameColour, searchKeyword } from '../src/shared/passives';
import { parseSymbol } from '../src/lib/easyeda/symbol';

describe('passive values', () => {
  it.each([
    ['10k', 10_000, '10kΩ'],
    ['4k7', 4_700, '4.7kΩ'],
    ['4.7K', 4_700, '4.7kΩ'],
    ['100R', 100, '100Ω'],
    ['100', 100, '100Ω'],
    ['0R', 0, '0Ω'],
    ['4R7', 4.7, '4.7Ω'],
    ['1M', 1e6, '1MΩ'],
    ['10mΩ', 0.01, '10mΩ'],
    ['2.2 kohm', 2200, '2.2kΩ'],
  ])('resistor %s', (text, si, canonical) => {
    const v = parsePassiveValue('resistor', text);
    expect(v?.si).toBeCloseTo(si);
    expect(v?.canonical).toBe(canonical);
  });

  it.each([
    ['100n', 100e-9, '100nF'],
    ['0.1u', 100e-9, '100nF'],
    ['0.1µF', 100e-9, '100nF'],
    ['4u7', 4.7e-6, '4.7uF'],
    ['22p', 22e-12, '22pF'],
    ['1000pF', 1e-9, '1nF'],
    ['10uF 16V', 10e-6, '10uF 16V'],
  ])('capacitor %s', (text, si, canonical) => {
    const v = parsePassiveValue('capacitor', text);
    expect(v?.si).toBeCloseTo(si, 15);
    expect(v?.canonical).toBe(canonical);
  });

  it('reads inductors, LEDs and diodes', () => {
    expect(parsePassiveValue('inductor', '4.7u')?.canonical).toBe('4.7uH');
    expect(parsePassiveValue('inductor', '100nH')?.canonical).toBe('100nH');
    expect(parsePassiveValue('led', 'green')?.canonical).toBe('Green');
    expect(parsePassiveValue('diode', 'ss34')?.canonical).toBe('SS34');
  });

  it('rejects ambiguous or malformed values', () => {
    expect(parsePassiveValue('capacitor', '100')).toBeNull();
    expect(parsePassiveValue('resistor', 'abc')).toBeNull();
    expect(parsePassiveValue('inductor', '')).toBeNull();
  });

  it('extracts voltage and tolerance', () => {
    expect(parsePassiveValue('capacitor', '10u 25V')).toMatchObject({ voltage: 25 });
    expect(parsePassiveValue('resistor', '10k 1%')).toMatchObject({ tolerance: 1, canonical: '10kΩ 1%' });
  });

  it('builds search keywords and compares attribute values', () => {
    const v = parsePassiveValue('capacitor', '10u 16V')!;
    expect(searchKeyword('capacitor', v)).toBe('10uF');
    expect(attributeMatches('capacitor', v, '10uF')).toBe(true);
    expect(attributeMatches('capacitor', v, '1uF')).toBe(false);
    expect(attributeMatches('ferrite', parsePassiveValue('ferrite', '600R')!, '600Ω@100MHz')).toBe(true);
    expect(attributeMatches('led', parsePassiveValue('led', 'green')!, 'Emerald Green')).toBe(true);
    expect(sameColour('Emerald Green', 'Green')).toBe(true);
    expect(sameColour('Warm White', 'White')).toBe(true);
    expect(sameColour('Yellow-Green', 'Green')).toBe(false);
    expect(sameColour('Red/Green', 'Red')).toBe(false);
    expect(searchKeyword('led', parsePassiveValue('led', 'red')!)).toBe('LED');
  });

  it('formats SI values', () => {
    expect(formatSi('capacitor', 2.2e-9)).toBe('2.2nF');
    expect(formatSi('inductor', 1e-3)).toBe('1mH');
    expect(formatSi('resistor', 5100)).toBe('5.1kΩ');
  });
});

describe('built-in symbols', () => {
  it('parse into two-pin symbols with pin 1 on the cathode for diodes', () => {
    for (const [kind, dataStr] of Object.entries(PASSIVE_SYMBOLS)) {
      const s = parseSymbol(dataStr, kind);
      expect(s.units[0].pins.map((p) => p.number).sort()).toEqual(['1', '2']);
      expect(s.units[0].pins.every((p) => !p.showNumber && !p.showName)).toBe(true);
    }
    const diode = parseSymbol(PASSIVE_SYMBOLS.diode);
    expect(diode.units[0].pins.find((p) => p.number === '1')?.x).toBe(20);
    // Diodes and LEDs can be wired by pin name: pin 1 is the cathode.
    for (const kind of ['diode', 'led'] as const) {
      expect(parseSymbol(PASSIVE_SYMBOLS[kind]).units[0].pins.map((p) => `${p.number}=${p.name}`).sort()).toEqual(['1=K', '2=A']);
    }
  });
});
