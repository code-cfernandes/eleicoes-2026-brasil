import { envNumero } from '../config/ambiente.ts';
import { config, defTurno } from '../config/config.ts';
import { transacao } from '../dados/banco.ts';
import { resumoAtual, votosTotaisAte } from '../dados/historico.ts';
import {
  apagarEstadoNovidades, apagarTodasNovidades, existeNovidade, inserirNovidade, instanteDoUltimo, lerEstadoNovidades,
  lerNovidadesAnteriores, lerNovidadesDesde, maiorIdGravado, salvarEstadoNovidades, type LinhaNovidade,
} from '../dados/novidades.ts';
import { CARGOS } from '../dominio/cargos.ts';
import type { Deteccao } from '../dominio/deteccao.ts';
import { conclusaoBrasil, conclusaoUF, decimal, inicioDaTotalizacao, lista, lugar, nome, pct, quantidadeVotos } from '../dominio/textos.ts';
import { estaTudoConcluido } from './encerramento.ts';
import { enviarNovidades } from './notificacoes.ts';
import { CANAL_NOVIDADES, transmitir } from './tempo-real.ts';
import type { EventoApuracao, Resultado, TipoEvento } from '../../shared/tipos.ts';

// "O que está acontecendo agora": linha do tempo de eventos estatísticos da totalização.
// A detecção de marcos, viradas e resultados definidos é a mesma das notificações push
// (dominio/deteccao.ts devolve as detecções granulares); aqui só filtramos, redigimos e gravamos.
// Ritmo e diferença são calculados aqui, só para Presidente/Brasil.
//
// REGRAS DE VOLUME (alvo: ~60 a 120 eventos na noite inteira, legível como linha do tempo)
// - Presidente, Brasil: 'inicio' (0%), 'marco' em todos os marcos do turno, 'virada' (mesmo
//   throttle do push: ≥ 5% das seções, no máximo 1 a cada 15 min), 'definido'.
//   (marcos saltados não são inventados: de 20% para 55% sai só o de 50%, como no push)
// - Presidente, UF e exterior: só 'estado-concluido' (100% das seções). Marcos intermediários
//   de UF ficam de fora (MARCOS_UF vazio): 28 × 50% dobraria a linha do tempo sem informação nova.
//   'definido' por UF NÃO entra (o 2º turno de Presidente é nacional; o TSE repete a marcação
//   em todas as UFs), nem 'virada' por UF (o mapa já mostra o líder de cada estado).
// - Governador e Senador: 'virada' só com ≥ 20% das seções (antes disso oscila demais) e
//   'definido' (eleito ou 2º turno). Sem marcos e sem 'inicio' por UF.
// - Deputados: só 'definido', AGREGADO por cargo: no máximo 1 evento a cada 60 min (tempo do
//   TSE) listando as UFs que tiveram eleitos definidos desde o anterior; o primeiro sai na hora.
//   (se o TSE parar de gerar arquivos novos, o pendente sai após 10 min pelo relógio do servidor)
// - 'ritmo' (Presidente, Brasil): votos totalizados nos últimos ~30 min, no máximo 1 a cada
//   30 min, só com ≥ 10 mil votos novos e com snapshot base de no máximo 60 min atrás.
// - 'diferenca' (Presidente, Brasil): a diferença entre 1º e 2º (pontos percentuais dos votos
//   válidos) mudou ≥ 1 ponto desde o último evento desse tipo, com intervalo mínimo de 20 min
//   e só a partir de 5% das seções. Se a dupla 1º/2º muda (virada), a base recomeça em silêncio.
// Os intervalos usam o horário de geração do TSE (o "instante"), não o relógio do servidor.
// Só gera evento o que o servidor coleta: para a linha do tempo completa, MONITORAR deve
// incluir br:1,*:1,*:3,*:5 (e os deputados, se quiser o agregado).
//
// TURNOS: cada evento pertence a um turno (coluna turno; a tela lê um turno por vez). As chaves
// do 1º turno ficam como sempre foram; as dos seguintes ganham o prefixo "t2:" (ver ch()).
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

// Chave de evento/estado no turno: o 1º turno mantém as chaves antigas (base de produção)
export const ch = (turno: number, chave: string) => (turno === 1 ? chave : `t${turno}:${chave}`);

let ultimoId = maiorIdGravado();
let maiorInstante = 0; // relógio do TSE (maior geração vista), para os agregados pendentes
export const idMaisRecente = () => ultimoId;

// --- Gravação
// `chave` sem o prefixo do turno: gravarNovidade() aplica ch()
export interface Novo { chave: string; turno: number; instante: number; tipo: TipoEvento; uf: string; cargo: number; texto: string; final?: boolean }

export function gravarNovidade(e: Novo): EventoApuracao | null {
  const id = inserirNovidade({ ...e, chave: ch(e.turno, e.chave) }, e.final);
  if (id === null) return null;
  const ev: EventoApuracao = { id, turno: e.turno, instante: e.instante, tipo: e.tipo, uf: e.uf, cargo: e.cargo, texto: e.texto };
  ultimoId = Math.max(ultimoId, ev.id);
  invalidarLeitura();
  return ev;
}

// Apaga a linha do tempo inteira (só a reconstrução usa; o estado de alerta/push não é tocado)
export function recomecarLinhaDoTempo() {
  apagarTodasNovidades();
  ultimoId = 0;
  invalidarLeitura();
}

function publicar(evs: (EventoApuracao | null)[]) {
  for (const ev of evs) {
    if (!ev) continue;
    console.log(`[novidade ${ev.id}] ${ev.texto}`);
    transmitir(CANAL_NOVIDADES, 'novidade', ev);
    try { enviarNovidades(ev); } catch (e) { console.error('[novidades push]', (e as Error).message); }
  }
}

// --- Entrada: chamada a cada resultado novo do TSE, depois da avaliação dos avisos (push)
export function processar(d: Resultado, deteccoes: Deteccao[]) {
  const { turno, uf, cargo } = d;
  const cfg = CARGOS[cargo];
  if (!cfg) return;
  const instante = d.instante ?? Date.now();
  maiorInstante = Math.max(maiorInstante, instante);
  const brasilPresidente = cargo === 1 && uf === 'br';
  const novos: Novo[] = [];
  const base = { turno, instante, uf, cargo };

  for (const det of deteccoes) {
    if (det.tipo === 'marco' && cargo === 1) {
      if (brasilPresidente) {
        novos.push(det.marco === 0
          ? { ...base, chave: 'inicio:br:1', tipo: 'inicio', texto: inicioDaTotalizacao(turno, instante) }
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
        // Deputados só existem no 1º turno
        const p = lerEstadoNovidades<Pendente>(`dep-pendente:${cargo}`) ?? { ufs: [], instante: 0, desde: Date.now() };
        if (!p.ufs.includes(uf)) p.ufs.push(uf);
        p.instante = Math.max(p.instante, instante);
        salvarEstadoNovidades(`dep-pendente:${cargo}`, p);
      });
      publicar([liberarDeputados(cargo)]);
    }
  }

  const gravados = novos.length ? transacao(() => novos.map(gravarNovidade)) : [];
  // Depois da conclusão, param o ritmo e a diferença (a conclusão já é a última notícia)
  if (brasilPresidente && d.secoesTotalizadas < 100) gravados.push(ritmo(d, instante), diferenca(d, instante));
  publicar(gravados);
}

// --- Deputados: agregado por cargo
interface Pendente { ufs: string[]; instante: number; desde: number }

function liberarDeputados(cargo: number): EventoApuracao | null {
  const chaveEst = `dep-pendente:${cargo}`;
  const p = lerEstadoNovidades<Pendente>(chaveEst);
  if (!p?.ufs.length) return null;
  const anterior = instanteDoUltimo(1, 'definido', cargo);
  const pode = anterior === undefined || maiorInstante - anterior >= INTERVALO_DEP_MS || Date.now() - p.desde >= ESPERA_MAX_DEP_MS;
  if (!pode) return null;
  const nomes = p.ufs.map(lugar);
  return transacao(() => {
    apagarEstadoNovidades(chaveEst);
    return gravarNovidade({
      chave: `definido:dep:${cargo}:${[...p.ufs].sort().join('-')}`,
      turno: 1,
      instante: Math.max(p.instante, anterior ?? 0),
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
  const anterior = instanteDoUltimo(d.turno, 'ritmo', 1);
  if (anterior !== undefined && instante - anterior < JANELA_RITMO_MS) return null;
  const base = votosTotaisAte(d.turno, 'br', 1, instante - JANELA_RITMO_MS);
  if (!base || instante - base.instante > 2 * JANELA_RITMO_MS) return null;
  const delta = votos - base.votos;
  if (delta < VOTOS_MIN_RITMO) return null;
  const minutos = Math.round((instante - base.instante) / 60_000);
  return gravarNovidade({
    chave: `ritmo:br:1:${instante}`, turno: d.turno, instante, tipo: 'ritmo', uf: 'br', cargo: 1,
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
  const chaveEst = ch(d.turno, 'diferenca:br:1');
  const base = lerEstadoNovidades<BaseDif>(chaveEst);
  if (!base || base.par !== par) {
    salvarEstadoNovidades(chaveEst, { valor, instante, par } satisfies BaseDif);
    return null;
  }
  if (Math.abs(valor - base.valor) < DIF_MIN_PP || instante - base.instante < INTERVALO_DIF_MS) return null;
  return transacao(() => {
    salvarEstadoNovidades(chaveEst, { valor, instante, par } satisfies BaseDif);
    return gravarNovidade({
      chave: `diferenca:br:1:${instante}`, turno: d.turno, instante, tipo: 'diferenca', uf: 'br', cargo: 1,
      texto: `A diferença entre ${nome(a)} e ${nome(b)} para Presidente passou de ${decimal(base.valor)} para ${decimal(valor)} pontos percentuais.`,
    });
  });
}

// --- Leitura (GET /api/novidades): corpo pronto por (turno, desde, limite) enquanto não há evento novo
const prontos = new Map<string, Buffer>();
// Evento novo ou texto reescrito pela IA: os corpos prontos ficam velhos
export const invalidarLeitura = () => prontos.clear();

export const paraEvento = ({ ia, ...e }: LinhaNovidade): EventoApuracao => ({ ...e, ...(ia ? { fonte: 'ia' as const } : {}) });

export function lerNovidades(turno: number, desde: number, limite: number): Buffer {
  const chave = `${turno}:${desde}:${limite}`;
  let json = prontos.get(chave);
  if (!json) {
    json = Buffer.from(JSON.stringify({ eventos: lerNovidadesDesde(turno, desde, limite).map(paraEvento) }));
    if (prontos.size > 500) prontos.clear();
    prontos.set(chave, json);
  }
  return json;
}

// Página mais antiga do histórico (id < antes, mais recentes primeiro). Sem cache pronto:
// consultada raramente (botão "ver mais antigas"), e o texto pode mudar quando a IA reescreve.
export function lerNovidadesAntes(turno: number, antes: number, limite: number): Buffer {
  return Buffer.from(JSON.stringify({ eventos: lerNovidadesAnteriores(turno, antes, limite).map(paraEvento) }));
}

// --- Balanço periódico de Presidente/Brasil: uma notícia a cada NOTICIA_INTERVALO_MIN
// capturando o andamento (% de seções, líder e o aumento percentual desde o último balanço).
// A primeira notícia (quando ainda não há "inicio") é o começo da totalização, com a hora.
let ultimaGeracaoPeriodica = 0;

export function gerarResumoPeriodico() {
  if (estaTudoConcluido() || Date.now() - ultimaGeracaoPeriodica < NOTICIA_INTERVALO_MS) return;
  ultimaGeracaoPeriodica = Date.now();

  const turno = config.turnoAtual;
  const r = resumoAtual(turno, 'br', 1);
  if (!r || r.pst <= 0) return; // a totalização ainda não começou (ou o turno não tem Presidente)

  // Primeira notícia: o início, com a hora oficial (config) ou a do primeiro dado
  if (!existeNovidade(turno, 'br', 1, 'inicio')) {
    const inicio = defTurno(turno)?.inicioApuracao ?? r.instante;
    publicar([gravarNovidade({
      chave: 'inicio:br:1', turno, instante: inicio, tipo: 'inicio', uf: 'br', cargo: 1,
      texto: inicioDaTotalizacao(turno, inicio),
    })]);
    return;
  }

  // Concluído (100%): o balanço periódico para — a conclusão já é a última notícia
  if (r.pst >= 100) return;

  // Balanço periódico: só quando o TSE publicou algo novo desde o último balanço
  const chaveEst = ch(turno, 'progresso:br:1');
  const base = lerEstadoNovidades<{ pst: number; instante: number }>(chaveEst);
  if (base && r.instante <= base.instante) return;
  const aumento = base ? r.pst - base.pst : 0;
  const lider = r.top[0];
  const trechos = [`Brasil: ${decimal(r.pst)}% das seções totalizadas`];
  if (base) trechos.push(aumento > 0 ? `+${decimal(aumento)} p.p. desde o último balanço` : 'sem mudança no percentual');
  if (lider) trechos.push(`${nome(lider)} lidera com ${decimal(lider.percentual)}%`);
  salvarEstadoNovidades(chaveEst, { pst: r.pst, instante: r.instante });
  publicar([gravarNovidade({
    chave: `progresso:br:1:${r.instante}`, turno, instante: r.instante, tipo: 'progresso', uf: 'br', cargo: 1,
    texto: `${trechos.join(', ')}.`,
  })]);
}
