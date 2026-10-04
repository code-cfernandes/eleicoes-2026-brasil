import { db } from './banco.ts';
import { config, CARGOS, envNumero } from './config.ts';
import { resumoAtual, votosTotaisAte } from './historico.ts';
import { enviarNovidades, nomeProprio, type Deteccao } from './notificacoes.ts';
import { CANAL_NOVIDADES, transmitir } from './eventos.ts';
import { iaDisponivel, intervaloIaMs, redigir } from './ia.ts';
import { NOMES_UF } from '../shared/ufs.ts';
import type { EventoApuracao, Resultado, TipoEvento } from '../shared/tipos.ts';

// "O que está acontecendo agora": linha do tempo de eventos estatísticos da totalização.
// A detecção de marcos, viradas e resultados definidos é a mesma das notificações push
// (avaliar() em notificacoes.ts devolve as detecções granulares); aqui só filtramos,
// redigimos e gravamos. Ritmo e diferença são calculados aqui, só para Presidente/Brasil.
//
// REGRAS DE VOLUME (alvo: ~60 a 120 eventos na noite inteira, legível como linha do tempo)
// - Presidente, Brasil: 'inicio' (0%), 'marco' em todos os marcos (25, 50, 75, 90, 100%),
//   'virada' (mesmo throttle do push: ≥ 5% das seções, no máximo 1 a cada 15 min), 'definido'.
//   (marcos saltados não são inventados: de 20% para 55% sai só o de 50%, como no push)
// - Presidente, UF e exterior: só 'estado-concluido' (100% das seções). Marcos intermediários
//   de UF ficam de fora (MARCOS_UF vazio): 28 × 50% dobraria a linha do tempo sem informação nova.
//   'definido' por UF NÃO entra (o 2º turno de Presidente é nacional; o TSE repete a marcação
//   em todas as UFs), nem 'virada' por UF (o mapa já mostra o líder de cada estado).
// - Governador e Senador: 'virada' só com ≥ 20% das seções (antes disso oscila demais) e
//   'definido' (eleito ou 2º turno).
//   Sem marcos e sem 'inicio' por UF.
// - Deputados: só 'definido', AGREGADO por cargo: no máximo 1 evento a cada 60 min (tempo do
//   TSE) listando as UFs que tiveram eleitos definidos desde o anterior; o primeiro sai na hora.
//   (se o TSE parar de gerar arquivos novos, o pendente sai após 10 min pelo relógio do servidor)
// - 'ritmo' (Presidente, Brasil): votos totalizados nos últimos ~30 min, no máximo 1 a cada
//   30 min, só com ≥ 10 mil votos novos e com snapshot base de no máximo 60 min atrás.
// - 'diferenca' (Presidente, Brasil): a diferença entre 1º e 2º (pontos percentuais dos votos
//   válidos) mudou ≥ 0,5 ponto desde o último evento desse tipo, com intervalo mínimo de 10 min
//   e só a partir de 5% das seções. Se a dupla 1º/2º muda (virada), a base recomeça em silêncio.
// Os intervalos usam o horário de geração do TSE (o "instante"), não o relógio do servidor.
// Só gera evento o que o servidor coleta: para a linha do tempo completa, MONITORAR deve
// incluir br:1,*:1,*:3,*:5 (e os deputados, se quiser o agregado).
//
// IDEMPOTÊNCIA: cada evento tem uma chave única (ex.: "marco:br:1:50"); INSERT OR IGNORE
// descarta repetidos, e o estado de marcos/viradas/definido é o mesmo persistido do push
// (alerta_estado), então reiniciar o servidor não duplica nada.

const MARCOS_UF: number[] = [];
const PST_MIN_VIRADA_UF = 20;
const JANELA_RITMO_MS = 30 * 60_000;
const VOTOS_MIN_RITMO = 10_000;
const DIF_MIN_PP = 1;                       // 0,5 gerava eventos demais na simulação (149 na noite)
const INTERVALO_DIF_MS = 20 * 60_000;
const PST_MIN_DIF = 5;
const INTERVALO_DEP_MS = 60 * 60_000;      // tempo do TSE entre agregados de deputados
const ESPERA_MAX_DEP_MS = 10 * 60_000;     // relógio do servidor: pendente não fica parado para sempre
const NOTICIA_INTERVALO_MS = envNumero('NOTICIA_INTERVALO_MIN', 5) * 60_000; // balanço periódico

db.exec(`
  CREATE TABLE IF NOT EXISTS novidade (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chave     TEXT    NOT NULL UNIQUE,  -- dedupe: o mesmo fato nunca entra duas vezes
    instante  INTEGER NOT NULL,         -- geração do TSE que originou o evento (epoch ms)
    tipo      TEXT    NOT NULL,
    uf        TEXT    NOT NULL,
    cargo     INTEGER NOT NULL,
    texto     TEXT    NOT NULL,
    criado_em INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS novidade_tipo ON novidade (tipo, cargo, id);

  -- Estado auxiliar das regras (base da diferença, deputados pendentes), em JSON
  CREATE TABLE IF NOT EXISTS novidade_estado (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  ) WITHOUT ROWID;
`);

// Migração aditiva: 1 = texto já redigido pela IA (DeepSeek); 0 = frase-modelo ainda no lugar
const colunasNovidade = new Set((db.prepare('PRAGMA table_info(novidade)').all() as { name: string }[]).map((c) => c.name));
if (!colunasNovidade.has('ia')) db.exec('ALTER TABLE novidade ADD COLUMN ia INTEGER NOT NULL DEFAULT 0');

const sql = {
  inserir: db.prepare(`INSERT OR IGNORE INTO novidade (chave, instante, tipo, uf, cargo, texto, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  // Eventos "finais" (conclusão) já nascem com ia=1: são definitivos, não passam pela IA
  inserirFinal: db.prepare(`INSERT OR IGNORE INTO novidade (chave, instante, tipo, uf, cargo, texto, criado_em, ia)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`),
  ultimoId: db.prepare('SELECT coalesce(max(id), 0) AS id FROM novidade'),
  ultimoDoTipo: db.prepare('SELECT instante FROM novidade WHERE tipo = ? AND cargo = ? ORDER BY id DESC LIMIT 1'),
  ler: db.prepare(`SELECT id, instante, tipo, uf, cargo, texto, ia FROM novidade
    WHERE id > ? ORDER BY id DESC LIMIT ?`),
  lerAntes: db.prepare(`SELECT id, instante, tipo, uf, cargo, texto, ia FROM novidade
    WHERE id < ? ORDER BY id DESC LIMIT ?`),
  // Presidente/Brasil ainda com frase-modelo, do mais antigo para o mais novo (fila de redação).
  // 'progresso' fica de fora: já é um balanço factual e frequente, não precisa de IA.
  pendenteIA: db.prepare(`SELECT id, instante, tipo, uf, cargo, texto FROM novidade
    WHERE uf = 'br' AND cargo = 1 AND ia = 0 AND tipo != 'progresso' ORDER BY id LIMIT 1`),
  marcarIA: db.prepare('UPDATE novidade SET texto = ?, ia = 1 WHERE id = ?'),
  temTipo: db.prepare('SELECT count(*) AS n FROM novidade WHERE uf = ? AND cargo = ? AND tipo = ?'),
  estado: db.prepare('SELECT valor FROM novidade_estado WHERE chave = ?'),
  salvarEstado: db.prepare(`INSERT INTO novidade_estado (chave, valor) VALUES (?, ?)
    ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor`),
  apagarEstado: db.prepare('DELETE FROM novidade_estado WHERE chave = ?'),
};

let ultimoId = (sql.ultimoId.get() as { id: number }).id;
let maiorInstante = 0; // relógio do TSE (maior geração vista), para os agregados pendentes
export const idMaisRecente = () => ultimoId;

// --- Formatação (pt-BR)
const lugar = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();
const nome = (c: { nome: string }) => nomeProprio(c.nome);
const decimal = (v: number, casas = 1) => v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas });
const pct = (v: number) => `${decimal(v)}%`;
const lista = (itens: string[]) => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
const HORA_BR = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const horaMinuto = (ms: number) => HORA_BR.format(ms);

// 1.234.567 -> "1,2 milhão de votos"; 2.400.000 -> "2,4 milhões de votos"; 850.000 -> "850 mil votos"
export function quantidadeVotos(n: number): string {
  if (n >= 999_500) {
    const mi = Math.round(n / 100_000) / 10;
    return `${decimal(mi)} ${mi < 2 ? 'milhão' : 'milhões'} de votos`;
  }
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString('pt-BR')} mil votos`;
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? 'voto' : 'votos'}`;
}

// Notícia final de conclusão (100% das seções) com o resultado: quem venceu (ou 2º turno) e os números
interface CandConclusao { nome: string; votos: number; percentual: number; eleito: boolean; situacao: string }

function conclusaoBrasil(d: { candidatos: CandConclusao[] }): string {
  const comVotos = d.candidatos.filter((c) => c.votos > 0);
  const [lider, vice] = comVotos;
  if (!lider) return 'Brasil concluiu a totalização para Presidente (100% das seções).';
  const eleito = d.candidatos.find((c) => c.eleito);
  const segundo = d.candidatos.filter((c) => /2º turno/i.test(c.situacao));
  if (eleito) {
    return `Brasil concluiu a totalização para Presidente: ${nome(eleito)} eleito com ${pct(eleito.percentual)} dos votos válidos (${quantidadeVotos(eleito.votos)}).`;
  }
  if (segundo.length >= 2) {
    return `Brasil concluiu a totalização para Presidente: haverá 2º turno entre ${lista(segundo.map(nome))}.`;
  }
  const parte = `${nome(lider)} lidera com ${pct(lider.percentual)} dos votos válidos (${quantidadeVotos(lider.votos)})`;
  return `Brasil concluiu a totalização para Presidente: ${parte}${vice ? `, à frente de ${nome(vice)} (${pct(vice.percentual)})` : ''}.`;
}

function conclusaoUF(d: { candidatos: CandConclusao[]; uf: string }): string {
  const [lider, vice] = d.candidatos.filter((c) => c.votos > 0);
  if (!lider) return `${lugar(d.uf)} concluiu a totalização para Presidente (100% das seções).`;
  const parte = `${nome(lider)} lidera com ${pct(lider.percentual)} dos votos válidos (${quantidadeVotos(lider.votos)})`;
  return `${lugar(d.uf)} concluiu a totalização para Presidente: ${parte}${vice ? `, à frente de ${nome(vice)} (${pct(vice.percentual)})` : ''}.`;
}

// --- Gravação
interface Novo { chave: string; instante: number; tipo: TipoEvento; uf: string; cargo: number; texto: string; final?: boolean }

function gravar(e: Novo): EventoApuracao | null {
  const r = (e.final ? sql.inserirFinal : sql.inserir).run(e.chave, e.instante, e.tipo, e.uf, e.cargo, e.texto, Date.now());
  if (!r.changes) return null;
  const ev: EventoApuracao = { id: Number(r.lastInsertRowid), instante: e.instante, tipo: e.tipo, uf: e.uf, cargo: e.cargo, texto: e.texto };
  ultimoId = Math.max(ultimoId, ev.id);
  prontos.clear();
  return ev;
}

// Evento + estado auxiliar na mesma transação: um restart no meio nunca deixa um sem o outro
function transacao<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function lerEstado<T>(chave: string): T | undefined {
  const r = sql.estado.get(chave) as { valor: string } | undefined;
  return r ? (JSON.parse(r.valor) as T) : undefined;
}
const salvarEstado = (chave: string, valor: unknown) => sql.salvarEstado.run(chave, JSON.stringify(valor));

function publicar(evs: (EventoApuracao | null)[]) {
  for (const ev of evs) {
    if (!ev) continue;
    console.log(`[novidade ${ev.id}] ${ev.texto}`);
    transmitir(CANAL_NOVIDADES, 'novidade', ev);
    try { enviarNovidades(ev); } catch (e) { console.error('[novidades push]', (e as Error).message); }
  }
}

// --- Entrada: chamada a cada resultado novo do TSE, depois de avaliar() (push)
export function processar(d: Resultado, deteccoes: Deteccao[]) {
  const { uf, cargo } = d;
  const cfg = CARGOS[cargo];
  if (!cfg) return;
  const instante = d.instante ?? Date.now();
  maiorInstante = Math.max(maiorInstante, instante);
  const brasilPresidente = cargo === 1 && uf === 'br';
  const novos: Novo[] = [];
  const base = { instante, uf, cargo };

  for (const det of deteccoes) {
    if (det.tipo === 'marco' && cargo === 1) {
      if (brasilPresidente) {
        novos.push(det.marco === 0
          ? { ...base, chave: 'inicio:br:1', tipo: 'inicio', texto: `A totalização para Presidente começou às ${horaMinuto(instante)}.` }
          : det.marco === 100
            ? { ...base, chave: 'marco:br:1:100', tipo: 'marco', texto: conclusaoBrasil(d), final: true }
            : { ...base, chave: `marco:br:1:${det.marco}`, tipo: 'marco', texto: `Brasil passou de ${det.marco}% das seções totalizadas para Presidente.` });
      } else if (det.marco === 100) {
        novos.push({ ...base, chave: `concluido:${uf}:1`, tipo: 'estado-concluido', texto: conclusaoUF(d), final: true });
      } else if (MARCOS_UF.includes(det.marco)) {
        novos.push({ ...base, chave: `marco:${uf}:1:${det.marco}`, tipo: 'marco',
          texto: `${lugar(uf)} passou de ${det.marco}% das seções totalizadas para Presidente.` });
      }
    }

    const viradaConta = brasilPresidente || ((cargo === 3 || cargo === 5) && d.secoesTotalizadas >= PST_MIN_VIRADA_UF);
    // Depois da conclusão (100%) não há mais virada: a última notícia é a conclusão
    if (det.tipo === 'virada' && viradaConta && d.secoesTotalizadas < 100) {
      const quem = d.vagas === 1
        ? `${nome(det.entrou)} passou à frente`
        : `${nome(det.entrou)} passou a ocupar uma das ${d.vagas} primeiras posições`;
      novos.push({ ...base, chave: `virada:${uf}:${cargo}:${instante}`, tipo: 'virada',
        texto: `${cfg.nome}, ${lugar(uf)}: ${quem} (${pct(d.secoesTotalizadas)} das seções totalizadas).` });
    }

    if (det.tipo === 'definido' && !cfg.proporcional && (cargo !== 1 || uf === 'br')) {
      const { eleitos, segundoTurno } = det;
      const texto = segundoTurno.length >= 2
        ? `${cfg.nome}, ${lugar(uf)}: haverá 2º turno entre ${lista(segundoTurno.map(nome))}.`
        : `${cfg.nome}, ${lugar(uf)}: ${lista(eleitos.map(nome))} ${eleitos.length > 1 ? 'eleitos' : 'eleito'}.`;
      novos.push({ ...base, chave: `definido:${uf}:${cargo}`, tipo: 'definido', texto });
    }

    if (det.tipo === 'definido' && cfg.proporcional) {
      transacao(() => {
        const p = lerEstado<Pendente>(`dep-pendente:${cargo}`) ?? { ufs: [], instante: 0, desde: Date.now() };
        if (!p.ufs.includes(uf)) p.ufs.push(uf);
        p.instante = Math.max(p.instante, instante);
        salvarEstado(`dep-pendente:${cargo}`, p);
      });
      publicar([liberarDeputados(cargo)]);
    }
  }

  const gravados = novos.length ? transacao(() => novos.map(gravar)) : [];
  // Depois da conclusão, param o ritmo e a diferença (a conclusão já é a última notícia)
  if (brasilPresidente && d.secoesTotalizadas < 100) gravados.push(ritmo(d, instante), diferenca(d, instante));
  publicar(gravados);
}

// --- Deputados: agregado por cargo
interface Pendente { ufs: string[]; instante: number; desde: number }

function liberarDeputados(cargo: number): EventoApuracao | null {
  const chaveEst = `dep-pendente:${cargo}`;
  const p = lerEstado<Pendente>(chaveEst);
  if (!p?.ufs.length) return null;
  const anterior = sql.ultimoDoTipo.get('definido', cargo) as { instante: number } | undefined;
  const pode = !anterior || maiorInstante - anterior.instante >= INTERVALO_DEP_MS || Date.now() - p.desde >= ESPERA_MAX_DEP_MS;
  if (!pode) return null;
  const nomes = p.ufs.map(lugar);
  return transacao(() => {
    sql.apagarEstado.run(chaveEst);
    return gravar({
      chave: `definido:dep:${cargo}:${[...p.ufs].sort().join('-')}`,
      instante: Math.max(p.instante, anterior?.instante ?? 0),
      tipo: 'definido',
      uf: p.ufs.length === 1 ? p.ufs[0]! : 'br',
      cargo,
      texto: `${CARGOS[cargo]!.nome}, eleitos definidos: ${lista(nomes)}.`,
    });
  });
}

// Chamada a cada rodada do coletor: solta agregados de deputados que já esperaram o suficiente
export function pulsar() {
  try {
    publicar(Object.values(CARGOS).filter((c) => c.proporcional).map((c) => liberarDeputados(c.codigo)));
  } catch (e) {
    console.error('[novidades]', (e as Error).message);
  }
}

// --- Ritmo: votos totalizados no Brasil (Presidente) na última janela
function ritmo(d: Resultado, instante: number): EventoApuracao | null {
  const votos = d.totais?.votosTotais;
  if (!votos || d.secoesTotalizadas <= 0) return null;
  const anterior = sql.ultimoDoTipo.get('ritmo', 1) as { instante: number } | undefined;
  if (anterior && instante - anterior.instante < JANELA_RITMO_MS) return null;
  const base = votosTotaisAte('br', 1, instante - JANELA_RITMO_MS);
  if (!base || instante - base.instante > 2 * JANELA_RITMO_MS) return null;
  const delta = votos - base.votos;
  if (delta < VOTOS_MIN_RITMO) return null;
  const minutos = Math.round((instante - base.instante) / 60_000);
  return gravar({
    chave: `ritmo:br:1:${instante}`, instante, tipo: 'ritmo', uf: 'br', cargo: 1,
    texto: `+${quantidadeVotos(delta)} totalizados para Presidente nos últimos ${minutos} minutos.`,
  });
}

// --- Diferença entre 1º e 2º (Presidente, Brasil)
interface BaseDif { valor: number; instante: number; par: string }

function diferenca(d: Resultado, instante: number): EventoApuracao | null {
  if (d.secoesTotalizadas < PST_MIN_DIF) return null;
  const [a, b] = d.candidatos.filter((c) => c.votos > 0);
  if (!a || !b) return null;
  const valor = Math.round((a.percentual - b.percentual) * 100) / 100;
  const par = `${a.numero},${b.numero}`;
  const base = lerEstado<BaseDif>('diferenca:br:1');
  if (!base || base.par !== par) {
    salvarEstado('diferenca:br:1', { valor, instante, par } satisfies BaseDif);
    return null;
  }
  if (Math.abs(valor - base.valor) < DIF_MIN_PP || instante - base.instante < INTERVALO_DIF_MS) return null;
  return transacao(() => {
    salvarEstado('diferenca:br:1', { valor, instante, par } satisfies BaseDif);
    return gravar({
      chave: `diferenca:br:1:${instante}`, instante, tipo: 'diferenca', uf: 'br', cargo: 1,
      texto: `A diferença entre ${nome(a)} e ${nome(b)} para Presidente passou de ${decimal(base.valor)} para ${decimal(valor)} pontos percentuais.`,
    });
  });
}

// --- Leitura (GET /api/novidades): corpo pronto por (desde, limite) enquanto não há evento novo
const prontos = new Map<string, Buffer>();

interface LinhaNovidade { id: number; instante: number; tipo: TipoEvento; uf: string; cargo: number; texto: string; ia?: number }

export function lerNovidades(desde: number, limite: number): Buffer {
  const chave = `${desde}:${limite}`;
  let json = prontos.get(chave);
  if (!json) {
    const linhas = sql.ler.all(desde, limite) as unknown as LinhaNovidade[];
    const eventos: EventoApuracao[] = linhas.map(({ ia, ...e }) => ({ ...e, ...(ia ? { fonte: 'ia' as const } : {}) }));
    json = Buffer.from(JSON.stringify({ eventos }));
    if (prontos.size > 500) prontos.clear();
    prontos.set(chave, json);
  }
  return json;
}

// Página mais antiga do histórico (id < antes, mais recentes primeiro). Sem cache pronto:
// consultada raramente (botão "ver mais antigas"), e o texto pode mudar quando a IA reescreve.
export function lerNovidadesAntes(antes: number, limite: number): Buffer {
  const linhas = sql.lerAntes.all(antes, limite) as unknown as LinhaNovidade[];
  const eventos: EventoApuracao[] = linhas.map(({ ia, ...e }) => ({ ...e, ...(ia ? { fonte: 'ia' as const } : {}) }));
  return Buffer.from(JSON.stringify({ eventos }));
}

// --- Redação por IA (DeepSeek): reescreve, aos poucos, o texto dos eventos de Presidente/Brasil.
// A detecção continua determinística e a frase-modelo é gravada na hora (nunca fica vazio); a IA
// só substitui o texto depois. Sem chave ou em qualquer falha, a frase-modelo permanece.
// Dois ritmos: backfillIA() sobe e recalcula as antigas (1s entre chamadas); redigirComIA()
// cuida do que vai aparecendo, no ritmo de ~1 chamada por IA_INTERVALO_MIN.
let processandoIA = false;
let ultimaChamadaIA = 0;

function aplicarRedigida(p: LinhaNovidade, textoIA: string) {
  sql.marcarIA.run(textoIA, p.id);
  prontos.clear();
  const ev: EventoApuracao = { id: p.id, instante: p.instante, tipo: p.tipo, uf: p.uf, cargo: p.cargo, texto: textoIA, fonte: 'ia' };
  console.log(`[ia] ${textoIA}`);
  transmitir(CANAL_NOVIDADES, 'novidade', ev);
}

// Recalcula as notícias antigas que ainda têm frase-modelo (chamado uma vez na subida)
export async function backfillIA() {
  if (!iaDisponivel() || processandoIA) return;
  processandoIA = true;
  try {
    let n = 0;
    while (n < 200) {
      const p = sql.pendenteIA.get() as LinhaNovidade | undefined;
      if (!p) break;
      const textoIA = await redigir(p.texto);
      if (!textoIA) break; // falhou/limite: para o backfill, o throttle assume depois
      aplicarRedigida(p, textoIA);
      n++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error('[ia backfill]', (e as Error).message);
  } finally {
    processandoIA = false;
  }
}

export async function redigirComIA() {
  if (!iaDisponivel() || processandoIA || Date.now() - ultimaChamadaIA < intervaloIaMs()) return;
  ultimaChamadaIA = Date.now();
  processandoIA = true;
  try {
    const p = sql.pendenteIA.get() as LinhaNovidade | undefined;
    if (!p) return;
    const textoIA = await redigir(p.texto);
    if (!textoIA) return;
    aplicarRedigida(p, textoIA);
  } catch (e) {
    console.error('[ia]', (e as Error).message);
  } finally {
    processandoIA = false;
  }
}

// --- Balanço periódico de Presidente/Brasil: uma notícia a cada NOTICIA_INTERVALO_MIN
// capturando o andamento (% de seções, líder e o aumento percentual desde o último balanço).
// A primeira notícia (quando ainda não há "inicio") é o começo da totalização, com a hora.
let ultimaGeracaoPeriodica = 0;

export function gerarResumoPeriodico() {
  if (Date.now() - ultimaGeracaoPeriodica < NOTICIA_INTERVALO_MS) return;
  ultimaGeracaoPeriodica = Date.now();

  const r = resumoAtual('br', 1);
  if (!r || r.pst <= 0) return; // a totalização ainda não começou

  // Primeira notícia: o início, com a hora oficial (config) ou a do primeiro dado
  if (!(sql.temTipo.get('br', 1, 'inicio') as { n: number }).n) {
    const inicio = config.inicioApuracao ?? r.instante;
    publicar([gravar({
      chave: 'inicio:br:1', instante: inicio, tipo: 'inicio', uf: 'br', cargo: 1,
      texto: `A totalização para Presidente começou às ${horaMinuto(inicio)}.`,
    })]);
    return;
  }

  // Concluído (100%): o balanço periódico para — a conclusão já é a última notícia
  if (r.pst >= 100) return;

  // Balanço periódico: só quando o TSE publicou algo novo desde o último balanço
  const base = lerEstado<{ pst: number; instante: number }>('progresso:br:1');
  if (base && r.instante <= base.instante) return;
  const aumento = base ? r.pst - base.pst : 0;
  const lider = r.top[0];
  const trechos = [`Brasil: ${decimal(r.pst)}% das seções totalizadas`];
  if (base) trechos.push(aumento > 0 ? `+${decimal(aumento)} p.p. desde o último balanço` : 'sem mudança no percentual');
  if (lider) trechos.push(`${nome(lider)} lidera com ${decimal(lider.percentual)}%`);
  salvarEstado('progresso:br:1', { pst: r.pst, instante: r.instante });
  publicar([gravar({
    chave: `progresso:br:1:${r.instante}`, instante: r.instante, tipo: 'progresso', uf: 'br', cargo: 1,
    texto: `${trechos.join(', ')}.`,
  })]);
}

// --- Reconstrução do histórico: numa base que rodou numa versão sem a linha do tempo, os
// snapshots existem mas os eventos não. Roda UMA vez na subida: apaga as novidades (não o
// estado de alerta/push) e reconstrói início, marcos, conclusões e viradas a partir dos
// snapshots, em ordem cronológica. Só grava (não publica: nada de SSE/push) e não mexe em
// alerta_estado, então não há aviso repetido.
export function reconstruirHistorico() {
  if (lerEstado('reconstruido:1')) return;

  db.exec('DELETE FROM novidade');
  ultimoId = 0;
  prontos.clear();

  const disputas = db.prepare('SELECT DISTINCT uf, cargo FROM snapshot ORDER BY cargo, uf').all() as { uf: string; cargo: number }[];
  const snapsSql = db.prepare('SELECT id, instante, pst FROM snapshot WHERE uf = ? AND cargo = ? AND pst > 0 ORDER BY instante');
  const topSql = db.prepare('SELECT numero, nome, votos, percentual FROM voto WHERE snapshot_id = ? ORDER BY votos DESC LIMIT ?');

  for (const { uf, cargo } of disputas) {
    const cfg = CARGOS[cargo];
    if (!cfg) continue;
    const snaps = snapsSql.all(uf, cargo) as { id: number; instante: number; pst: number }[];
    if (!snaps.length) continue;

    const vagas = cargo === 5 ? 2 : 1;
    const brasil = cargo === 1 && uf === 'br';
    let inicioFeito = false;
    let marcoAtual = -1;
    let lideres: string | null = null;

    for (const s of snaps) {
      if (brasil && !inicioFeito) {
        inicioFeito = true;
        const inicio = config.inicioApuracao ?? s.instante;
        gravar({ chave: 'inicio:br:1', instante: inicio, tipo: 'inicio', uf: 'br', cargo: 1,
          texto: `A totalização para Presidente começou às ${horaMinuto(inicio)}.` });
      }

      if (brasil) {
        // Só o maior marco atingido por snapshot (um salto de 20% para 55% gera só o de 50%,
        // como na detecção em tempo real: marcos saltados não são inventados)
        const m = Math.max(-1, ...[25, 50, 75, 90, 100].filter((x) => s.pst >= x));
        if (m > marcoAtual) {
          marcoAtual = m;
          if (m === 100) {
            const cands = (topSql.all(s.id, 2) as { nome: string; votos: number; percentual: number }[])
              .map((c) => ({ nome: c.nome, votos: c.votos, percentual: c.percentual, eleito: false, situacao: '' }));
            gravar({ chave: 'marco:br:1:100', instante: s.instante, tipo: 'marco', uf: 'br', cargo: 1,
              texto: conclusaoBrasil({ candidatos: cands }), final: true });
          } else {
            gravar({ chave: `marco:br:1:${m}`, instante: s.instante, tipo: 'marco', uf: 'br', cargo: 1,
              texto: `Brasil passou de ${m}% das seções totalizadas para Presidente.` });
          }
        }
      }

      if (cargo === 1 && !brasil && uf !== 'zz' && s.pst >= 100) {
        const cands = (topSql.all(s.id, 2) as { nome: string; votos: number; percentual: number }[])
          .map((c) => ({ nome: c.nome, votos: c.votos, percentual: c.percentual, eleito: false, situacao: '' }));
        gravar({ chave: `concluido:${uf}:1`, instante: s.instante, tipo: 'estado-concluido', uf, cargo: 1,
          texto: conclusaoUF({ candidatos: cands, uf }), final: true });
        break;
      }

      if (!cfg.proporcional && s.pst >= 5) {
        const top = topSql.all(s.id, vagas) as { numero: string; nome: string }[];
        const atuais = top.map((c) => c.numero).sort().join(',');
        if (atuais && lideres !== null && lideres !== atuais) {
          const antes = new Set(lideres.split(','));
          const entrou = top.find((c) => !antes.has(c.numero));
          if (entrou) {
            const quem = vagas === 1 ? 'passou à frente' : `passou a ocupar uma das ${vagas} primeiras posições`;
            gravar({ chave: `virada:${uf}:${cargo}:${s.instante}`, instante: s.instante, tipo: 'virada', uf, cargo,
              texto: `${cfg.nome}, ${lugar(uf)}: ${nome(entrou)} ${quem} (${pct(s.pst)} das seções totalizadas).` });
          }
        }
        if (atuais) lideres = atuais;
      }
    }
  }

  salvarEstado('reconstruido:1', true);
  console.log(`[novidades] histórico reconstruído (${ultimoId} evento(s))`);
}
