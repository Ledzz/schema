import type { Component, Project, StoredSymbol } from '../src/lib/schematic/types';

/** Synthetic two-pin symbol in EasyEDA Pro format: pins at x = ±20 (y-up), body ±10. */
export const RES_SYMBOL = [
  '["DOCTYPE","SYMBOL","1.1"]',
  '["HEAD",{"symbolType":2,"originX":0,"originY":0}]',
  '["LINESTYLE","st1",null,null,null,null]',
  '["PART","RES.1",{"BBOX":[-20,4,20,-4]}]',
  '["ATTR","e1","","Designator","R?",false,false,null,null,0,"st1",0]',
  '["RECT","e2",-10,4,10,-4,0,0,0,"st1",0]',
  '["PIN","e3",1,null,-20,0,10,0,null,0,0,1]',
  '["ATTR","e4","e3","NAME","1",false,false,0,0,0,"st1",0]',
  '["ATTR","e5","e3","NUMBER","1",false,true,0,0,0,"st1",0]',
  '["PIN","e6",1,null,20,0,10,180,null,0,0,1]',
  '["ATTR","e7","e6","NAME","2",false,false,0,0,0,"st1",0]',
  '["ATTR","e8","e6","NUMBER","2",false,true,0,0,0,"st1",0]',
].join('\r\n');

/** Synthetic regulator: VIN (left, y=+10), GND (bottom), VOUT (right). */
export const LDO_SYMBOL = [
  '["DOCTYPE","SYMBOL","1.1"]',
  '["PART","LDO.1",{"BBOX":[-30,-20,30,20]}]',
  '["ATTR","e1","","Designator","U?",false,false,null,null,0,"st1",0]',
  '["RECT","e2",-20,20,20,-20,0,0,0,"st1",0]',
  '["PIN","p1",1,null,-30,10,10,0,null,0,0,1]',
  '["ATTR","a1","p1","NAME","VIN",false,true,0,0,0,"st1",0]',
  '["ATTR","a2","p1","NUMBER","3",false,true,0,0,0,"st1",0]',
  '["PIN","p2",1,null,0,-30,10,90,null,0,0,1]',
  '["ATTR","a3","p2","NAME","GND",false,true,0,0,0,"st1",0]',
  '["ATTR","a4","p2","NUMBER","1",false,true,0,0,0,"st1",0]',
  '["PIN","p3",1,null,30,10,10,180,null,0,0,1]',
  '["ATTR","a5","p3","NAME","VOUT",false,true,0,0,0,"st1",0]',
  '["ATTR","a6","p3","NUMBER","2",false,true,0,0,0,"st1",0]',
].join('\n');

export const symbols: Record<string, StoredSymbol> = {
  res: { title: 'RES', dataStr: RES_SYMBOL, source: 'easyeda' },
  ldo: { title: 'LDO', dataStr: LDO_SYMBOL, source: 'easyeda' },
};

export function comp(id: string, symbolKey: string, designator: string, x: number, y: number, extra: Partial<Component> = {}): Component {
  return { id, symbolKey, unit: 0, designator, value: designator, x, y, rotation: 0, mirror: false, attrs: {}, ...extra };
}

export function project(partial: Partial<Project>): Project {
  return { version: 1, id: 'p', name: 'test', updatedAt: 0, components: [], wires: [], ports: [], symbols, ...partial };
}
