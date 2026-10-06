import { db } from './banco.ts';
import { config } from './config.ts';
import type { TipoEleicao } from '../shared/tipos.ts';

// Descoberta automática dos códigos de eleição no TSE (comum/config/ele-c.json).
// - 1º turno: entre as eleições do ciclo com t="1", a federal é a que tem Presidente (cargo 1)
//   e a estadual a que tem Governador (cargo 3); havendo mais de uma, a "Ordinária".
// - 2º turno: o próprio TSE informa o código no campo `cdt2` da eleição do 1º turno
//   (2026: 6257 -> 6258, 6259 -> 6260), publicado logo depois do 1º turno.
// O ambiente sempre vence (ELEICAO_*); a descoberta só preenche o que está vazio e avisa no log
// quando o ambiente diverge do TSE. O que foi descoberto fica no banco: um restart sem TSE no ar
// continua sabendo os códigos.

const TIPOS: TipoEleicao[] = ['federal', 'estadual'];
const CARGO_DO_TIPO: Record<TipoEleicao, string> = { federal: '1', estadual: '3' };
const TEMPO_MAX_MS = 10_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS codigo_eleicao (
    turno  INTEGER NOT NULL,
    tipo   TEXT    NOT NULL,
    codigo TEXT    NOT NULL,
    PRIMARY KEY (turno, tipo)
  ) WITHOUT ROWID;
`);
const salvar = db.prepare(`INSERT INTO codigo_eleicao (turno, tipo, codigo) VALUES (?, ?, ?)
  ON CONFLICT (turno, tipo) DO UPDATE SET codigo = excluded.codigo`);

// Ambiente vazio + código já descoberto antes: usa o do banco (na carga do módulo, antes da coleta)
const doAmbiente = new Set<string>(); // "turno:tipo" definidos pelo ambiente
for (const d of config.definicoes) for (const t of TIPOS) if (d.eleicao[t]) doAmbiente.add(`${d.numero}:${t}`);
for (const r of db.prepare('SELECT turno, tipo, codigo FROM codigo_eleicao').all() as { turno: number; tipo: TipoEleicao; codigo: string }[]) {
  const d = config.definicoes.find((x) => x.numero === r.turno);
  if (d && !d.eleicao[r.tipo]) d.eleicao[r.tipo] = r.codigo;
}

interface EleicaoTSE { cd: string; cdt2?: string; t: string; nm: string; abr?: { cp?: { cd: string }[] }[] }
interface ConfigTSE { pl?: { c: string; e?: EleicaoTSE[] }[] }

const temCargo = (e: EleicaoTSE, cargo: string) => !!e.abr?.some((a) => a.cp?.some((c) => c.cd === cargo));
const mesmoCodigo = (a?: string, b?: string) => !!a && !!b && Number(a) === Number(b);

function preencher(turno: number, tipo: TipoEleicao, codigo: string) {
  const d = config.definicoes.find((x) => x.numero === turno);
  if (!d) return;
  if (doAmbiente.has(`${turno}:${tipo}`)) {
    if (!mesmoCodigo(d.eleicao[tipo], codigo)) {
      console.warn(`[codigos] ${turno}º turno ${tipo}: o ambiente diz ${d.eleicao[tipo]}, o TSE diz ${codigo}. Vale o do ambiente.`);
    }
    return;
  }
  if (!mesmoCodigo(d.eleicao[tipo], codigo)) console.log(`[codigos] ${turno}º turno ${tipo}: ${codigo} (descoberto no TSE)`);
  d.eleicao[tipo] = codigo;
  salvar.run(turno, tipo, codigo);
}

const faltaAlgum = () => config.definicoes.some((d) => TIPOS.some((t) => !d.eleicao[t]));
let conferido = false; // já houve uma tentativa com todos os códigos conhecidos (só para conferir)

// Ainda falta algum código: o coletor não pode se dar por encerrado (o 2º turno pode aparecer)
export const codigosPendentes = () => faltaAlgum();

// Chamada na subida e a cada rodada do coletor. Faltando código, lê a lista do TSE (~22 kB) a cada
// rodada até ele aparecer. Com tudo conhecido (ambiente ou banco), lê uma única vez, só para
// conferir divergências, e não insiste se o TSE falhar.
export async function descobrirCodigos(): Promise<void> {
  if (!faltaAlgum()) {
    if (conferido) return;
    conferido = true;
  }
  let lista: ConfigTSE;
  try {
    const res = await fetch(`${config.base}/comum/config/ele-c.json`, { signal: AbortSignal.timeout(TEMPO_MAX_MS) });
    if (!res.ok) throw new Error(`TSE respondeu ${res.status}`);
    lista = (await res.json()) as ConfigTSE;
  } catch (e) {
    console.error(`[codigos] não foi possível ler a lista de eleições do TSE (${(e as Error).message}); nova tentativa na próxima rodada`);
    return;
  }

  const eleicoes = (lista.pl ?? []).filter((p) => p.c === config.ciclo).flatMap((p) => p.e ?? []);
  const primeiro = config.definicoes.find((d) => d.numero === 1)!;
  for (const tipo of TIPOS) {
    // Eleição do 1º turno: a do código já conhecido; senão, a que tem o cargo característico
    const candidatas = eleicoes.filter((e) => e.t === '1' && temCargo(e, CARGO_DO_TIPO[tipo]));
    const e1 = primeiro.eleicao[tipo]
      ? eleicoes.find((e) => mesmoCodigo(e.cd, primeiro.eleicao[tipo]))
      : candidatas.length === 1 ? candidatas[0] : candidatas.find((e) => /ordin/i.test(e.nm));
    if (!e1) {
      console.warn(`[codigos] eleição ${tipo} do 1º turno não encontrada no TSE (ciclo ${config.ciclo})`);
      continue;
    }
    preencher(1, tipo, e1.cd);
    if (e1.cdt2) preencher(2, tipo, e1.cdt2);
  }
}
