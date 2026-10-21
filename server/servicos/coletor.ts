import { config } from '../config/config.ts';
import { codigosPendentes, descobrirCodigos } from './codigos.ts';
import { disputasComInscritos } from './notificacoes.ts';
import { estaTudoConcluido, marcarTudoConcluido } from './encerramento.ts';
import { gerarResumoPeriodico, pulsar } from './novidades.ts';
import { reconstruirHistorico } from './reconstrucao.ts';
import { backfillIA, redigirComIA } from './redacao-ia.ts';
import { concluida, obter } from './resultados.ts';
import { disputasAssistidas } from './tempo-real.ts';
import { descobrirTurnos, disputaExiste } from './turnos.ts';
import type { Resultado } from '../../shared/tipos.ts';

// Tarefas periódicas do servidor: o coletor do TSE, a redação por IA e o balanço periódico.

// Coletor em background: registra o avanço mesmo sem visitantes.
// Poucas requisições simultâneas, para não disparar dezenas de downloads de uma vez.
let coletando = false;
let coletor: ReturnType<typeof setInterval> | undefined;
const outrosTimers: ReturnType<typeof setInterval>[] = [];

async function coletarTudo() {
  if (coletando || estaTudoConcluido()) return;
  coletando = true;
  // Códigos de eleição que faltam (ex.: 2º turno publicado pelo TSE depois da subida). Se aparecer
  // um turno novo, ele já vira o atual nesta mesma rodada.
  await descobrirCodigos();
  const turno = config.turnoAtual;
  // Quais disputas existem no 2º turno (lê o 1º turno uma vez; depois fica no banco)
  try { await descobrirTurnos(obter); } catch (e) { console.error('[turnos]', (e as Error).message); }
  // MONITORAR (sempre) + o que alguém está assistindo agora (só enquanto houver alguém)
  // e o que algum aparelho segue por notificação (o aviso precisa sair mesmo com a tela fechada).
  // Só o que existe no turno atual (ex.: deputados e Senado não têm 2º turno).
  const pares = new Map([...config.monitorar, ...disputasAssistidas(turno), ...disputasComInscritos()]
    .filter(([uf, cargo]) => disputaExiste(turno, uf, cargo))
    .map((p) => [p.join(':'), p] as const));
  const fila = [...pares.values()];
  const resultados: (Resultado | null)[] = [];
  const trabalhador = async () => {
    for (let par = fila.shift(); par; par = fila.shift()) {
      const [uf, cargo] = par;
      try {
        resultados.push(await obter(uf, cargo, turno));
      } catch (e) {
        console.error(`[coleta ${uf}:${cargo}]`, (e as Error).message);
        resultados.push(null);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabalhador));
  pulsar(); // agregados de deputados que já esperaram o suficiente
  coletando = false;

  // Todas as disputas coletadas fecharam (100% + resultado definido)? Então não há mais o que
  // buscar: encerra as consultas ao TSE e passa a servir da base/histórico que já existe.
  // Com código pendente não encerra: o próximo turno ainda pode aparecer na lista do TSE.
  if (resultados.length && resultados.every((r) => r && concluida(r)) && !codigosPendentes()) {
    marcarTudoConcluido();
    clearInterval(coletor);
    console.log('[coleta] totalização concluída — consultas ao TSE encerradas');
  }
}

export function iniciarTarefas() {
  // Reconstrói a linha do tempo a partir dos snapshots (uma vez, antes de coletar de novo)
  reconstruirHistorico();
  void coletarTudo();
  coletor = setInterval(coletarTudo, config.cacheMs);

  // Redação por IA (DeepSeek): roda em intervalo próprio, fora do coletor (uma chamada lenta
  // não segura a coleta do TSE). O throttle real fica dentro de redigirComIA. Na subida, backfillIA
  // recalcula as notícias antigas que ainda estão com frase-modelo.
  void backfillIA();
  outrosTimers.push(setInterval(() => { void redigirComIA(); }, config.cacheMs));

  // Balanço periódico de Presidente/Brasil (a cada NOTICIA_INTERVALO_MIN): gera a notícia de
  // "começou às HH:MM" quando não há nenhuma ainda e, depois, o andamento com o aumento percentual.
  gerarResumoPeriodico();
  outrosTimers.push(setInterval(() => { gerarResumoPeriodico(); }, config.cacheMs));
}

export function pararTarefas() {
  clearInterval(coletor);
  for (const t of outrosTimers) clearInterval(t);
}
