import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';

// TSE falso do modo simulação (SIMULACAO=1): ensaio do 2º turno de ponta a ponta, sem atalhos no
// resto do código. O servidor aponta config.base para cá (127.0.0.1) e tudo funciona como no dia:
// descoberta dos códigos, 404 antes da publicação, arquivos zerados, cronômetro, apuração, avisos.
// - 1º turno, lista de eleições e fotos: repassados do TSE de verdade (cache em memória).
// - 2º turno: gerado a partir dos finalistas do 1º ("2º turno"), numa linha do tempo comprimida:
//     subida ............ 404 (o TSE ainda não publicou)
//     subida + 20s ...... arquivos zerados (finalistas com 0 voto)
//     inicioApuracao .... apuração começa (fim do cronômetro)
//     + duração ......... 100% em todas as disputas (cada uma no seu ritmo, algumas antes)
//   Um "arquivo novo" a cada SIMULACAO_GERACAO_SEGUNDOS, como as gerações do TSE.
// Resultados sorteados a cada execução (semente aleatória): Presidente sempre tem uma virada no
// meio da apuração; "Eleito" sai a partir de 95%, com margem final que não se inverte depois.

const sim = config.simulacao!;
const SEMENTE = randomBytes(8).toString('hex');
const PUBLICACAO_MS = 20_000;

// Número "aleatório" estável por chave nesta execução (0 a 1)
const sorte = (chave: string) => createHash('sha1').update(SEMENTE + chave).digest().readUInt32BE(0) / 2 ** 32;
const pad = (n: number | string, l = 2) => String(n).padStart(l, '0');
const decimal = (v: number) => v.toFixed(2).replace('.', ',');

// --- TSE de verdade, com cache (só respostas 200 ficam guardadas)
type Resposta = { status: number; tipo: string; corpo: Buffer };
const cacheReal = new Map<string, Promise<Resposta>>();
function doTseReal(caminho: string): Promise<Resposta> {
  let p = cacheReal.get(caminho);
  if (!p) {
    p = fetch(sim.baseReal + caminho, { signal: AbortSignal.timeout(15_000) }).then(async (r) => ({
      status: r.status, tipo: r.headers.get('content-type') ?? 'application/octet-stream', corpo: Buffer.from(await r.arrayBuffer()),
    }));
    cacheReal.set(caminho, p);
    p.then((r) => { if (r.status !== 200) cacheReal.delete(caminho); }, () => cacheReal.delete(caminho));
  }
  return p;
}

// Código do 2º turno -> código do 1º (campo cdt2 da lista de eleições do TSE)
let primeiroTurnoDe: Promise<Map<number, string>> | undefined;
function codigoDoPrimeiroTurno(cod: string): Promise<string | undefined> {
  primeiroTurnoDe ??= doTseReal('/comum/config/ele-c.json').then((r) => {
    const lista = JSON.parse(r.corpo.toString()) as { pl?: { e?: { cd: string; cdt2?: string }[] }[] };
    return new Map((lista.pl ?? []).flatMap((p) => p.e ?? []).filter((e) => e.cdt2).map((e) => [Number(e.cdt2), e.cd]));
  });
  primeiroTurnoDe.catch(() => { primeiroTurnoDe = undefined; });
  return primeiroTurnoDe.then((m) => m.get(Number(cod)));
}

// --- Linha do tempo de cada disputa
// Fração da apuração concluída (0 a 1) no instante t: cada disputa começa com um pequeno atraso e
// termina antes do fim (a de Presidente/Brasil termina por último, no fim da duração).
function fracao(chave: string, t: number) {
  const brasil = chave === 'br:1';
  const atraso = brasil ? 0.02 : 0.02 + sorte(`${chave}:atraso`) * 0.15;
  const fim = brasil ? 1 : 0.7 + sorte(`${chave}:fim`) * 0.28;
  const x = (t - sim.inicioApuracao) / sim.duracaoMs;
  return Math.min(1, Math.max(0, (x - atraso) / (fim - atraso)));
}
// % de seções: rápido no começo, devagar no fim (como a apuração real)
const secoes = (f: number) => Math.round(100 * (1 - (1 - f) ** 1.6) * 100) / 100;

// % dos válidos do candidato de menor número. Termina em `final`; no começo pende para o lado
// contrário (`vies`), o que produz viradas. Presidente/Brasil: virada garantida.
function fatia(chave: string, f: number, t: number) {
  const brasil = chave === 'br:1';
  const lado = sorte(`${chave}:lado`) < 0.5 ? -1 : 1;
  const margem = brasil ? 0.8 + sorte(`${chave}:margem`) * 2.5 : 0.8 + sorte(`${chave}:margem`) * 8;
  const final = 50 + lado * margem;
  const vies = brasil ? -lado * (margem + 2 + sorte(`${chave}:vies`) * 3) : (sorte(`${chave}:vies`) - 0.5) * 12;
  const ruido = (sorte(`${chave}:${t}`) - 0.5) * 0.3 * (1 - f);
  return final + vies * (1 - f) ** 1.5 + ruido;
}

// "dd/mm/aaaa" e "hh:mm:ss" no horário de Brasília (UTC-3), como o TSE escreve
function dataHoraTSE(ms: number) {
  const d = new Date(ms - 3 * 3_600_000);
  return {
    dg: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    hg: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

interface CandTSE { n: string; vap?: string; pvap?: string; e?: string; st?: string }
interface JsonTSE {
  dg?: string; hg?: string;
  s?: { ts?: string; st?: string; pst?: string };
  e?: { te?: string; c?: string; a?: string };
  v?: { tv?: string; vv?: string; vb?: string; tvn?: string };
  carg?: { agr?: { par?: { cand?: CandTSE[] }[] }[] }[];
}
const num = (v?: string) => Number(String(v ?? 0).replace(',', '.')) || 0;

// Arquivo do 2º turno de uma disputa, a partir do arquivo do 1º turno (mesma UF e cargo)
function gerar(base: JsonTSE, uf: string, cargo: number): JsonTSE | null {
  const j = structuredClone(base);
  const cands = (j.carg?.[0]?.agr ?? []).flatMap((a) => a.par ?? []).flatMap((p) => p.cand ?? []);
  const finalistas = cands.filter((c) => /2º turno/i.test(c.st ?? '')).sort((a, b) => Number(a.n) - Number(b.n));
  if (finalistas.length < 2) return null; // essa disputa não tem 2º turno
  const [a, b] = finalistas as [CandTSE, CandTSE];

  const agora = Date.now();
  const comecou = agora >= sim.inicioApuracao;
  // Antes da apuração: o arquivo zerado, com o horário da publicação. Depois: uma geração nova
  // a cada geracaoMs (o instante só muda quando o "TSE" gera um arquivo novo).
  const instante = comecou ? Math.floor(agora / sim.geracaoMs) * sim.geracaoMs : sim.subida + PUBLICACAO_MS;
  const chave = `${uf}:${cargo}`;
  const f = comecou ? fracao(chave, instante) : 0;
  const pst = secoes(f);

  const eleitores = num(j.e?.te);
  const comparecimento = Math.round(eleitores * 0.79 * pst / 100);
  const validos = Math.round(comparecimento * 0.94);
  const brancos = Math.round(comparecimento * 0.025);
  const pctA = pst > 0 ? fatia(chave, f, instante) : 0;
  const votosA = Math.round(validos * pctA / 100);
  const votosB = validos - votosA;
  const definido = pst >= 95; // o TSE marca o eleito quando a diferença já não se inverte

  const marcar = (c: CandTSE, votos: number, venceu: boolean) => {
    c.vap = String(votos);
    c.pvap = decimal(validos > 0 ? (votos / validos) * 100 : 0);
    c.e = definido && venceu ? 's' : 'n';
    c.st = definido ? (venceu ? 'Eleito' : 'Não eleito') : '';
  };
  marcar(a, votosA, votosA >= votosB);
  marcar(b, votosB, votosB > votosA);
  // Só os dois finalistas ficam no arquivo
  for (const ag of j.carg?.[0]?.agr ?? []) for (const p of ag.par ?? []) p.cand = (p.cand ?? []).filter((c) => c === a || c === b);
  if (j.carg?.[0]) j.carg[0].agr = (j.carg[0].agr ?? []).map((ag) => ({ ...ag, par: (ag.par ?? []).filter((p) => p.cand?.length) })).filter((ag) => ag.par.length);

  Object.assign(j, dataHoraTSE(instante));
  j.s = { ...j.s, st: String(Math.round(num(j.s?.ts) * pst / 100)), pst: decimal(pst) };
  j.e = { ...j.e, c: String(comparecimento), a: String(Math.max(0, Math.round(eleitores * pst / 100) - comparecimento)) };
  j.v = { ...j.v, tv: String(comparecimento), vv: String(validos), vb: String(brancos), tvn: String(comparecimento - validos - brancos) };
  return j;
}

// --- Servidor
const app = express();

app.get('/comum/config/ele-c.json', async (_req, res) => {
  try {
    const r = await doTseReal('/comum/config/ele-c.json');
    res.status(r.status).type(r.tipo).send(r.corpo);
  } catch {
    res.status(502).end();
  }
});

app.get('/:ciclo/:cod/:pasta/:uf/:arquivo', async (req, res) => {
  const { ciclo, cod, pasta, uf, arquivo } = req.params;
  try {
    const cod1 = await codigoDoPrimeiroTurno(cod);
    if (!cod1) { // 1º turno (ou outra eleição): o TSE de verdade
      const r = await doTseReal(`/${ciclo}/${cod}/${pasta}/${uf}/${arquivo}`);
      res.status(r.status).type(r.tipo).send(r.corpo);
      return;
    }
    if (pasta === 'fotos') { // a foto do candidato é a mesma do 1º turno
      const r = await doTseReal(`/${ciclo}/${cod1}/fotos/${uf}/${arquivo}`);
      res.status(r.status).type(r.tipo).send(r.corpo);
      return;
    }
    const m = /^([a-z]{2})-c(\d{4})-e\d{6}-u\.json$/.exec(arquivo);
    if (pasta !== 'dados' || !m || Date.now() < sim.subida + PUBLICACAO_MS) {
      res.status(404).end(); // antes da "publicação", como o TSE de verdade
      return;
    }
    const cargo = Number(m[2]);
    const base = await doTseReal(`/${ciclo}/${cod1}/dados/${uf}/${uf}-c${pad(cargo, 4)}-e${pad(cod1, 6)}-u.json`);
    const gerado = base.status === 200 ? gerar(JSON.parse(base.corpo.toString()) as JsonTSE, uf, cargo) : null;
    if (!gerado) {
      res.status(404).end();
      return;
    }
    res.json(gerado);
  } catch {
    res.status(502).end();
  }
});

app.use((_req, res) => { res.status(404).end(); });

export function iniciarTseSimulado(): Promise<void> {
  const hora = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return new Promise((ok) => {
    app.listen(sim.porta, '127.0.0.1', () => {
      console.log(`[simulação] TSE falso em ${config.base} (1º turno, lista e fotos vêm de ${sim.baseReal})`);
      console.log(`[simulação] 2º turno publicado às ${hora(sim.subida + PUBLICACAO_MS)}, apuração das `
        + `${hora(sim.inicioApuracao)} às ${hora(sim.inicioApuracao + sim.duracaoMs)}, um arquivo novo a cada ${sim.geracaoMs / 1000}s`);
      ok();
    });
  });
}
