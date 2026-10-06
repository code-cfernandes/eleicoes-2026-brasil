import { config, CARGOS, defTurno } from './config.ts';
import type { Candidato, Resultado, SaudeDados, Totais } from '../shared/tipos.ts';

const pad = (n: string | number, len: number) => String(n).padStart(len, '0');

function codigoEleicao(cargo: number, turno: number): string {
  const tipo = CARGOS[cargo]?.eleicao;
  const cod = tipo && defTurno(turno)?.eleicao[tipo];
  if (!cod) throw new Error(`Código de eleição "${tipo}" do ${turno}º turno não configurado no .env`);
  return String(Number(cod));
}

// /{ciclo}/{eleicao}/dados/{uf}/{uf}-c{cargo}-e{eleicao}-u.json
export function urlResultado(uf: string, cargo: number, turno: number): string {
  const cod = codigoEleicao(cargo, turno);
  return `${config.base}/${config.ciclo}/${cod}/dados/${uf}/${uf}-c${pad(cargo, 4)}-e${pad(cod, 6)}-u.json`;
}

// Fotos de presidente só existem na pasta "br", mesmo no resultado por UF.
export const ufDaFoto = (uf: string, cargo: number) => (CARGOS[cargo]?.eleicao === 'federal' ? 'br' : uf);

// /{ciclo}/{eleicao}/fotos/{uf}/{sqcand}.jpeg
export const urlFoto = (uf: string, cargo: number, sqcand: string, turno: number) =>
  `${config.base}/${config.ciclo}/${codigoEleicao(cargo, turno)}/fotos/${ufDaFoto(uf, cargo)}/${sqcand}.jpeg`;

const num = (v: unknown) => Number(String(v ?? 0).replace(',', '.')) || 0;

// "dd/mm/aaaa" + "hh:mm:ss" no horário de Brasília (UTC-3) -> epoch ms
function instanteTSE(dg?: string, hg?: string): number | null {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dg ?? '');
  const h = /^(\d{2}):(\d{2}):(\d{2})$/.exec(hg ?? '');
  if (!d || !h) return null;
  return Date.UTC(+d[3]!, +d[2]! - 1, +d[1]!, +h[1]! + 3, +h[2]!, +h[3]!);
}

// Só o pedaço do JSON do TSE que usamos
interface CandTSE { n: string; sqcand?: string; nm?: string; nmu?: string; vap?: string; pvap?: string; e?: string; st?: string }
interface JsonTSE {
  dg?: string; hg?: string;
  s?: { pst?: string; ts?: string; st?: string };
  e?: { te?: string; c?: string; a?: string };
  v?: { tv?: string; vv?: string; vb?: string; tvn?: string };
  carg?: { nv?: string; agr?: { par?: { sg?: string; cand?: CandTSE[] }[] }[] }[];
}

// ÚNICO ponto que conhece o formato do JSON do TSE.
// Se o leiaute mudar, só esta função precisa ser ajustada.
export function normalizar(json: JsonTSE, uf: string, cargo: number, turno: number): Omit<Resultado, 'turno' | 'cargo' | 'nomeCargo' | 'uf'> {
  const carg = json.carg?.[0];
  const candidatos: Candidato[] = (carg?.agr ?? [])
    .flatMap((a) => a.par ?? [])
    .flatMap((p) => (p.cand ?? []).map((c) => ({
      numero: c.n,
      nome: c.nmu || c.nm || c.n,
      partido: p.sg ?? '',
      sqcand: c.sqcand ?? '',
      foto: c.sqcand ? `/api/foto/${cargo}/${uf}/${c.sqcand}?turno=${turno}` : '',
      votos: num(c.vap),
      percentual: num(c.pvap),
      // O TSE marca e="s" também em quem foi para o 2º turno: eleito é só quem não está nessa situação
      eleito: c.e === 's' && !/2º turno/i.test(c.st ?? ''),
      situacao: c.st ?? '',
    })))
    .sort((a, b) => b.votos - a.votos || a.nome.localeCompare(b.nome, 'pt-BR'));

  const totais: Totais = {
    secoes: num(json.s?.ts),
    secoesTotalizadas: num(json.s?.st),
    eleitores: num(json.e?.te),
    comparecimento: num(json.e?.c),
    abstencao: num(json.e?.a),
    votosTotais: num(json.v?.tv),
    validos: num(json.v?.vv),
    brancos: num(json.v?.vb),
    nulos: num(json.v?.tvn),
  };

  return {
    atualizadoEm: [json.dg, json.hg].filter(Boolean).join(' '),
    instante: instanteTSE(json.dg, json.hg),
    secoesTotalizadas: num(json.s?.pst),
    vagas: num(carg?.nv) || 1,
    candidatos,
    totais,
  };
}

// Resposta HTTP de erro do TSE (ex.: 404 = arquivo ainda não publicado)
export class ErroTSE extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`TSE respondeu ${status}`);
    this.status = status;
  }
}

// --- Saúde da coleta: medida aqui, no único ponto que fala com o TSE (rota /api/saude)
const JANELA_FALHAS_MS = 10 * 60_000;
const PESO_LATENCIA = 0.2; // média móvel exponencial: a última resposta pesa 20%
const saude = { ultimaRespostaOk: null as number | null, ultimaFalha: null as number | null, latenciaMediaMs: null as number | null };
const falhas: number[] = []; // instantes das falhas recentes (só os últimos 10 min)

function podarFalhas(agora: number) {
  while (falhas.length && falhas[0]! < agora - JANELA_FALHAS_MS) falhas.shift();
}

export function saudeTSE(): SaudeDados['tse'] {
  podarFalhas(Date.now());
  return {
    ...saude,
    latenciaMediaMs: saude.latenciaMediaMs === null ? null : Math.round(saude.latenciaMediaMs),
    falhasRecentes: falhas.length,
  };
}

export async function buscarResultado(uf: string, cargo: number, turno: number): Promise<Resultado> {
  const url = urlResultado(uf, cargo, turno); // erro de configuração não conta como falha do TSE
  const inicio = Date.now();
  let json: JsonTSE;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new ErroTSE(res.status);
    json = (await res.json()) as JsonTSE;
  } catch (err) {
    // 404 não é falha do TSE: o arquivo só ainda não foi publicado (ex.: 2º turno antes do dia)
    if (err instanceof ErroTSE && err.status === 404) throw err;
    const agora = Date.now();
    saude.ultimaFalha = agora;
    falhas.push(agora);
    podarFalhas(agora);
    throw err;
  }
  const agora = Date.now();
  const ms = agora - inicio;
  saude.ultimaRespostaOk = agora;
  saude.latenciaMediaMs = saude.latenciaMediaMs === null ? ms : saude.latenciaMediaMs + PESO_LATENCIA * (ms - saude.latenciaMediaMs);
  const d = normalizar(json, uf, cargo, turno);
  return { turno, cargo, nomeCargo: CARGOS[cargo]!.nome, uf, ...d };
}
