import { disputasGravadas, gravarDisputasDoTurno, turnosDescobertos } from '../dados/turnos.ts';
import { CARGOS } from '../dominio/cargos.ts';
import { config, defTurno } from '../config/config.ts';
import type { Cargo, Resultado } from '../../shared/tipos.ts';

// Quais disputas existem em cada turno.
// - 1º turno: todos os cargos cuja eleição está configurada no .env.
// - 2º turno: só as disputas que o TSE marcou com "2º turno" no turno anterior. Presidente é
//   nacional (vale para Brasil, todas as UFs e exterior); Governador, só nas UFs sem maioria absoluta.
// A descoberta lê o resultado do 1º turno uma única vez e fica gravada no banco: depois de um
// restart, a lista não depende do TSE responder.

const CARGOS_COM_2T = [1, 3]; // Presidente e Governador (Senado e deputados não têm 2º turno)

const descobertos = turnosDescobertos();
// turno -> cargo -> UFs com disputa
const disputas = disputasGravadas();

export function cargosDoTurno(turno: number): Cargo[] {
  const def = defTurno(turno);
  if (!def) return [];
  const configurados = Object.values(CARGOS).filter((c) => def.eleicao[c.eleicao]);
  if (turno === 1) return configurados;
  const porCargo = disputas.get(turno);
  return configurados.flatMap((c) => {
    const ufs = porCargo?.get(c.codigo);
    // Mantém a ordem de CARGOS[].ufs (br primeiro, exterior por último)
    return ufs?.length ? [{ ...c, ufs: c.ufs.filter((u) => ufs.includes(u)) }] : [];
  });
}

export const disputaExiste = (turno: number, uf: string, cargo: number) =>
  !!cargosDoTurno(turno).find((c) => c.codigo === cargo)?.ufs.includes(uf);

type Buscar = (uf: string, cargo: number, turno: number) => Promise<Resultado>;

// Chamada a cada rodada do coletor; só trabalha enquanto algum turno não foi descoberto.
// Qualquer falha ao ler o turno anterior: não grava nada parcial e tenta de novo depois.
export async function descobrirTurnos(buscar: Buscar) {
  for (const { numero: turno } of config.turnos) {
    if (turno === 1 || descobertos.has(turno)) continue;
    const anterior = turno - 1;
    const pares = cargosDoTurno(anterior)
      .filter((c) => CARGOS_COM_2T.includes(c.codigo))
      .flatMap((c) => (c.codigo === 1 ? [['br', 1] as const] : c.ufs.map((u) => [u, c.codigo] as const)));
    const resultados = await Promise.allSettled(pares.map(([uf, cargo]) => buscar(uf, cargo, anterior)));
    if (resultados.some((r) => r.status === 'rejected')) {
      console.error(`[turnos] não foi possível ler o ${anterior}º turno; nova tentativa na próxima rodada`);
      continue;
    }
    const porCargo = new Map<number, string[]>();
    for (const r of resultados) {
      const d = (r as PromiseFulfilledResult<Resultado>).value;
      if (!d.candidatos.some((c) => /2º turno/i.test(c.situacao))) continue;
      // Presidente: o 2º turno é nacional, então existe em todas as abrangências
      const ufs = d.cargo === 1 ? CARGOS[1]!.ufs : [d.uf];
      porCargo.set(d.cargo, [...(porCargo.get(d.cargo) ?? []), ...ufs]);
    }
    gravarDisputasDoTurno(turno, porCargo);
    disputas.set(turno, porCargo);
    descobertos.add(turno);
    const resumo = [...porCargo].map(([c, ufs]) => `${CARGOS[c]!.nome}: ${c === 1 ? 'nacional' : ufs.join(', ')}`).join(' · ');
    console.log(`[turnos] ${turno}º turno: ${resumo || 'nenhuma disputa'}`);
  }
}
