import { describe, expect, it } from 'vitest';
import { genericSymbol, parseSymbol, threePointArc } from '../src/lib/easyeda/symbol';
import { parseFootprint } from '../src/lib/easyeda/footprint';
import { LDO_SYMBOL, RES_SYMBOL } from './fixtures';

describe('parseSymbol', () => {
  it('flips y, keeps pin connection points and points pins at the body', () => {
    const s = parseSymbol(LDO_SYMBOL, 'LDO');
    expect(s.prefix).toBe('U');
    const [vin, gnd, vout] = s.units[0].pins;
    expect(vin).toMatchObject({ number: '3', name: 'VIN', x: -30, y: -10, dir: [1, 0] });
    // GND sits below the body and points up (towards -y on screen).
    expect(gnd).toMatchObject({ number: '1', name: 'GND', x: 0, y: 30, dir: [0, -1] });
    expect(vout).toMatchObject({ name: 'VOUT', x: 30, y: -10, dir: [-1, 0] });
    expect(s.units[0].shapes[0]).toEqual({ kind: 'rect', x: -20, y: -20, w: 40, h: 40, r: 0 });
  });

  it('respects pin name/number visibility flags', () => {
    const s = parseSymbol(RES_SYMBOL);
    const pin = s.units[0].pins[0];
    expect(pin.showName).toBe(false);
    expect(pin.showNumber).toBe(true);
    expect(s.prefix).toBe('R');
  });

  it('splits multi-unit symbols at PART records', () => {
    const two = `${LDO_SYMBOL}\n["PART","LDO.2",{"BBOX":[0,0,1,1]}]\n["PIN","q1",1,null,0,0,10,0,null,0,0,1]`;
    const s = parseSymbol(two);
    expect(s.units).toHaveLength(2);
    expect(s.units[1].pins).toHaveLength(1);
  });

  it('ignores malformed lines', () => {
    const s = parseSymbol('not json\n["PIN"\n["RECT","e",0,0,10,10,0,0,0,"st",0]');
    expect(s.units[0].shapes).toHaveLength(1);
  });

  it('builds a generic fallback with counter-clockwise pin numbering', () => {
    const s = genericSymbol('X', 4);
    const pins = s.units[0].pins;
    expect(pins.map((p) => [p.number, p.x])).toEqual([
      ['1', -40],
      ['2', -40],
      ['3', 40],
      ['4', 40],
    ]);
    expect(pins[2].y).toBeGreaterThan(pins[3].y);
  });

  it('draws three-point arcs through the middle point', () => {
    expect(threePointArc([-10, 0], [0, -10], [10, 0])).toMatch(/^M-10 0A10 10 0 0 1 10 0$/);
  });
});

describe('parseFootprint', () => {
  it('reads copper pads and silkscreen paths', () => {
    const fp = parseFootprint(
      [
        '["DOCTYPE","FOOTPRINT","1.8"]',
        '["PAD","e1",0,"",1,"1",-30,0,0,null,["RECT",30,34,0],[],0,0,90,1,0]',
        '["PAD","e2",0,"",12,"2",30,0,0,["ROUND",12,12],["ELLIPSE",30,30],[],0,0,90,1,0]',
        '["POLY","e3",0,"",3,6,[-50,20,"L",50,20],0]',
        '["POLY","e4",0,"",13,6,["CIRCLE",0,0,5],0]',
        '["POLY","e5",0,"",5,6,[0,0,"L",1,1],0]',
      ].join('\n'),
    );
    expect(fp.pads).toHaveLength(2);
    expect(fp.pads[1]).toMatchObject({ number: '2', throughHole: true, shape: 'ellipse', hole: { w: 12, h: 12 } });
    expect(fp.shapes.map((s) => s.layer)).toEqual(['silk', 'outline']);
    expect(fp.shapes[0].d).toBe('M-50 -20L50 -20');
  });
});
