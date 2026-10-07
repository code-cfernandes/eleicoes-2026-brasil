import type { DefTurno } from '../types/index.ts';
import { env, envNumero, expandirMonitorar } from '../utils/index.ts';

// Tudo que muda entre eleições/turnos fica aqui (via variáveis de ambiente), nada hardcoded no resto do código.

const definicoes: DefTurno[] = [
  {
    numero: 1,
    nome: '1º turno',
    eleicao: { federal: env('ELEICAO_FEDERAL'), estadual: env('ELEICAO_ESTADUAL') },
    inicioApuracao: Date.parse(env('INICIO_APURACAO') ?? '2026-10-04T17:00:00-03:00') || null,
  },
  {
    numero: 2,
    nome: '2º turno',
    eleicao: { federal: env('ELEICAO_FEDERAL_2T'), estadual: env('ELEICAO_ESTADUAL_2T') },
    inicioApuracao: Date.parse(env('INICIO_APURACAO_2T') ?? '2026-10-25T17:00:00-03:00') || null,
  },
];
const definido = (t: DefTurno) => !!(t.eleicao.federal || t.eleicao.estadual);

export const config = {
  base: env('TSE_BASE') ?? 'https://resultados.tse.jus.br/oficial',
  ciclo: env('CICLO') ?? 'ele2026',
  /** Todos os turnos possíveis, com ou sem código (a descoberta preenche os que faltam) */
  definicoes,
  get turnos(): DefTurno[] { return definicoes.filter(definido); },
  get turnoAtual(): number { return definicoes.filter(definido).at(-1)?.numero ?? 1; },
  cacheMs: envNumero('CACHE_SEGUNDOS', 30) * 1000,
  port: envNumero('PORT', 3000),
  historicoDb: env('HISTORICO_DB') ?? 'data/eleicoes.db',
  fotosDir: env('FOTOS_DIR') ?? 'data/fotos',
  // Pares uf:cargo coletados em background para o histórico (só os que existem no turno atual).
  monitorar: expandirMonitorar(env('MONITORAR') ?? 'br:1,*:1,*:3'),
};

export const defTurno = (turno: number) => config.turnos.find((t) => t.numero === turno);
