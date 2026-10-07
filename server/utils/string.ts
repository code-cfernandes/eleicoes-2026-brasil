import { CARGOS } from '../types/cargos.ts';

// "br:1,sp:*,*:3" -> pares [uf, cargo]. "*" expande para todas as UFs/cargos válidos.
export function expandirMonitorar(spec: string): [string, number][] {
  const pares = new Map<string, [string, number]>();
  for (const item of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [uf = '', cargo = ''] = item.split(':');
    const cargos = cargo === '*' ? Object.values(CARGOS) : [CARGOS[Number(cargo)]].filter((c) => c !== undefined);
    for (const c of cargos) {
      for (const u of uf === '*' ? c.ufs.filter((x) => x !== 'br') : [uf]) {
        if (c.ufs.includes(u)) pares.set(`${u}:${c.codigo}`, [u, c.codigo]);
      }
    }
  }
  return [...pares.values()];
}
