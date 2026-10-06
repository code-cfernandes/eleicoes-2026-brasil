import { dirname, join } from 'node:path';
import type { Cargo, TipoEleicao } from '../shared/tipos.ts';

// Tudo que muda entre eleições/turnos fica aqui (via variáveis de ambiente), nada hardcoded no resto do código.

// Variável vazia conta como não definida: no Portainer/compose é comum ficar "VAR=" em branco,
// e um "" virando 0 (intervalo, limite) seria desastroso.
export function env(nome: string): string | undefined {
  const v = process.env[nome]?.trim();
  return v ? v : undefined;
}
// Número positivo ou o padrão (nunca NaN/0 por engano)
export function envNumero(nome: string, padrao: number): number {
  const n = Number(env(nome));
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

export const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' ');

// Código do cargo no TSE -> eleição a que pertence e onde há resultado publicado
export const CARGOS: Record<number, Cargo> = {
  1: { codigo: 1, nome: 'Presidente', eleicao: 'federal', ufs: ['br', ...UFS, 'zz'], proporcional: false }, // zz = exterior
  3: { codigo: 3, nome: 'Governador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  5: { codigo: 5, nome: 'Senador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  6: { codigo: 6, nome: 'Deputado federal', eleicao: 'estadual', ufs: UFS, proporcional: true },
  7: { codigo: 7, nome: 'Deputado estadual', eleicao: 'estadual', ufs: UFS.filter((u) => u !== 'df'), proporcional: true },
  8: { codigo: 8, nome: 'Deputado distrital', eleicao: 'estadual', ufs: ['df'], proporcional: true },
};

// "br:1,sp:*,*:3" -> pares [uf, cargo]. "*" expande para todas as UFs/cargos válidos.
function expandirMonitorar(spec: string): [string, number][] {
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

// Um turno só existe se ao menos um código de eleição estiver definido. O turno "atual" é o
// último definido: é o único coletado do TSE; os anteriores ficam arquivados (só leitura).
// Os códigos vêm do ambiente ou, na falta dele, da descoberta automática (codigos.ts), que pode
// preenchê-los depois da subida: por isso `turnos` e `turnoAtual` são calculados a cada leitura.
export interface DefTurno {
  numero: number;
  nome: string;
  eleicao: Record<TipoEleicao, string | undefined>;
  /** Início da apuração (epoch ms), para a contagem regressiva */
  inicioApuracao: number | null;
}

// Modo simulação (SIMULACAO=1): ensaio do 2º turno com um TSE falso embutido (simulacao.ts).
// A apuração começa SIMULACAO_ESPERA_MIN depois da subida e dura SIMULACAO_DURACAO_MIN; banco
// próprio (simulacao.db, recriado a cada execução), IA desligada e tudo sinalizado como simulação.
const simulacaoLigada = /^(1|true|sim)$/i.test(env('SIMULACAO') ?? '');
const porta = envNumero('PORT', 3000);
const subida = Date.now();
const simulacao = simulacaoLigada ? {
  subida,
  /** Fim do cronômetro: começa a apuração simulada */
  inicioApuracao: subida + envNumero('SIMULACAO_ESPERA_MIN', 2) * 60_000,
  duracaoMs: envNumero('SIMULACAO_DURACAO_MIN', 15) * 60_000,
  /** Intervalo entre "gerações" de arquivos do TSE falso */
  geracaoMs: envNumero('SIMULACAO_GERACAO_SEGUNDOS', 20) * 1000,
  /** Porta interna do TSE falso (só 127.0.0.1) */
  porta: porta + 1,
  /** TSE de verdade: de onde vêm o 1º turno, a lista de eleições e as fotos */
  baseReal: env('TSE_BASE') ?? 'https://resultados.tse.jus.br/oficial',
} : null;
const historicoDb = env('HISTORICO_DB') ?? 'data/eleicoes.db';

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
    inicioApuracao: simulacao?.inicioApuracao ?? (Date.parse(env('INICIO_APURACAO_2T') ?? '2026-10-25T17:00:00-03:00') || null),
  },
];
const definido = (t: DefTurno) => !!(t.eleicao.federal || t.eleicao.estadual);

export const config = {
  base: simulacao ? `http://127.0.0.1:${simulacao.porta}` : (env('TSE_BASE') ?? 'https://resultados.tse.jus.br/oficial'),
  simulacao,
  ciclo: env('CICLO') ?? 'ele2026',
  /** Todos os turnos possíveis, com ou sem código (a descoberta preenche os que faltam) */
  definicoes,
  get turnos(): DefTurno[] { return definicoes.filter(definido); },
  get turnoAtual(): number { return definicoes.filter(definido).at(-1)?.numero ?? 1; },
  cacheMs: envNumero('CACHE_SEGUNDOS', 30) * 1000,
  port: porta,
  // Na simulação, um arquivo à parte na mesma pasta: o banco real nunca é tocado
  historicoDb: simulacao ? join(dirname(historicoDb), 'simulacao.db') : historicoDb,
  fotosDir: env('FOTOS_DIR') ?? 'data/fotos',
  // Pares uf:cargo coletados em background para o histórico (só os que existem no turno atual).
  monitorar: expandirMonitorar(env('MONITORAR') ?? 'br:1,*:1,*:3'),
};

export const defTurno = (turno: number) => config.turnos.find((t) => t.numero === turno);
