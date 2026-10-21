import { CARGOS } from './cargos.ts';
import { lugar, nomeProprio, pct } from './textos.ts';
import type { Candidato, Resultado } from '../../shared/tipos.ts';

// Detecção dos momentos que importam numa disputa (início, marcos de apuração, troca na
// liderança, resultado definido), comparando o resultado novo com o que já foi avisado.
// Função pura: recebe o estado anterior e o horário, devolve o novo estado; quem chama grava.

const INTERVALO_VIRADA_MS = 15 * 60_000;  // no máximo um aviso de virada a cada 15 min por disputa
const PST_MIN_VIRADA = 5;                 // antes disso a liderança oscila demais

// Marcos de % de seções totalizadas (0 = "começou"). No 2º turno, com só dois candidatos, a
// apuração é rápida e a reta final pesa mais: marcos mais finos (10% e 95%).
const MARCOS_POR_TURNO: Record<number, number[]> = {
  1: [0, 25, 50, 75, 90, 100],
  2: [0, 10, 25, 50, 75, 90, 95, 100],
};
export const marcosDoTurno = (turno: number) => MARCOS_POR_TURNO[turno] ?? MARCOS_POR_TURNO[1]!;

/** O que já foi avisado numa disputa */
export interface EstadoAlerta { marco: number; lideres: string; definido: number; ultima_virada: number }
export const ESTADO_INICIAL: EstadoAlerta = { marco: -1, lideres: '', definido: 0, ultima_virada: 0 };

export interface Aviso { titulo: string; corpo: string; url: string; tag: string; urgente: boolean }
// O que a detecção encontrou, granular (a linha do tempo filtra e redige à parte).
// O push junta tudo num aviso só.
export type Deteccao =
  | { tipo: 'marco'; marco: number } // 0 = começou
  | { tipo: 'virada'; entrou: Candidato }
  | { tipo: 'definido'; eleitos: Candidato[]; segundoTurno: Candidato[] };

export function detectar(d: Resultado, antes: EstadoAlerta, agora: number): { estado: EstadoAlerta; aviso: Aviso | null; deteccoes: Deteccao[] } {
  const { turno, uf, cargo } = d;
  const cfg = CARGOS[cargo]!;
  const est = { ...antes };
  const cand = d.candidatos;
  const linhas: string[] = [];
  const deteccoes: Deteccao[] = [];
  let urgente = false;

  // Resultado definido: TSE marcou eleitos ou 2º turno
  const eleitos = cand.filter((c) => c.eleito);
  const segundo = cand.filter((c) => /2º turno/i.test(c.situacao));
  if (!est.definido && (eleitos.length || segundo.length)) {
    est.definido = 1;
    urgente = true;
    deteccoes.push({ tipo: 'definido', eleitos, segundoTurno: segundo });
    if (segundo.length >= 2) linhas.push(`Vai ter 2º turno: ${segundo.map((c) => nomeProprio(c.nome)).join(' e ')}.`);
    else if (cfg.proporcional) linhas.push(`${eleitos.length} eleitos já definidos.`);
    else linhas.push(`${eleitos.map((c) => nomeProprio(c.nome)).join(' e ')} ${eleitos.length > 1 ? 'eleitos' : 'eleito'}.`);
  }

  // Troca na liderança (cargos majoritários): quem ocupa as `vagas` primeiras posições
  const topo = cand.slice(0, d.vagas);
  const lideres = topo.map((c) => c.numero).sort().join(',');
  if (!cfg.proporcional && d.secoesTotalizadas > 0) {
    if (!est.lideres) est.lideres = lideres;
    else if (lideres !== est.lideres && !est.definido && d.secoesTotalizadas >= PST_MIN_VIRADA
      && agora - est.ultima_virada >= INTERVALO_VIRADA_MS) {
      const anteriores = new Set(est.lideres.split(','));
      const entrou = topo.find((c) => !anteriores.has(c.numero));
      if (entrou) {
        deteccoes.push({ tipo: 'virada', entrou });
        linhas.push(d.vagas === 1
          ? `Virada: ${nomeProprio(entrou.nome)} passou à frente.`
          : `${nomeProprio(entrou.nome)} entrou entre os ${d.vagas} primeiros.`);
      }
      est.lideres = lideres;
      est.ultima_virada = agora;
    }
  }

  // Marco da totalização: só o maior atingido (um salto de 20% para 55% avisa só os 50%)
  const marco = Math.max(-1, ...marcosDoTurno(turno).filter((m) => (m === 0 ? d.secoesTotalizadas > 0 : d.secoesTotalizadas >= m)));
  if (marco > est.marco) {
    est.marco = marco;
    deteccoes.push({ tipo: 'marco', marco });
    if (!linhas.length) {
      linhas.push(marco === 0 ? 'A totalização começou.' : marco === 100 ? 'Totalização concluída.' : `${marco}% das seções totalizadas.`);
    }
  }

  if (!linhas.length) return { estado: est, aviso: null, deteccoes };

  const placar = cand.slice(0, 3).filter((c) => c.votos > 0)
    .map((c) => `${nomeProprio(c.nome)} ${pct(c.percentual)}`).join(', ');
  const aviso: Aviso = {
    titulo: `${cfg.nome}, ${lugar(uf)}${turno > 1 ? ` (${turno}º turno)` : ''}`,
    corpo: [...linhas, placar && `${placar} (${pct(d.secoesTotalizadas)} totalizado)`].filter(Boolean).join('\n'),
    url: `/?cargo=${cargo}&uf=${uf}&turno=${turno}`,
    tag: `apuracao-${uf}-${cargo}`, // no aparelho, o aviso novo da disputa substitui o anterior
    urgente,
  };
  return { estado: est, aviso, deteccoes };
}
