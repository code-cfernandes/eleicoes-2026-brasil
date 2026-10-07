import { config } from '../config/config.ts';
import { registrar } from '../dados/historico.ts';
import { buscarResultado, ErroTSE } from '../integracoes/tse.ts';
import { avaliar, enviar } from './notificacoes.ts';
import { estaTudoConcluido } from './encerramento.ts';
import { processar } from './novidades.ts';
import { notificar } from './tempo-real.ts';
import type { Resultado } from '../../shared/tipos.ts';

// Resultado de cada disputa (turno:uf:cargo), com cache curto e dedupe: N visitantes
// simultâneos geram 1 requisição ao TSE por janela. Toda resposta nova do TSE vai para o
// histórico, venha do coletor ou de um visitante; quem está com a disputa aberta recebe o aviso
// na hora (SSE), e os avisos de push e a linha do tempo são avaliados aqui.

// Leituras que as rotas usam direto: a evolução gravada, as fotos (com cache em disco) e a saúde
// das consultas ao TSE
export { lerHistorico } from '../dados/historico.ts';
export { obterFoto } from '../integracoes/fotos.ts';
export { saudeTSE } from '../integracoes/tse.ts';

const cache = new Map<string, { expira: number; promessa: Promise<Resultado> }>();
const versoes = new Map<string, number | null>(); // última geração do TSE vista por disputa

// Só o turno atual é coletado ao vivo. Turnos anteriores (e o atual, depois de encerrado) são
// arquivo: o resultado é buscado no TSE uma vez e servido do cache para sempre.
export const arquivado = (turno: number) => turno !== config.turnoAtual || estaTudoConcluido();

// Uma disputa está concluída quando o TSE marcou o resultado (eleito/2º turno) com 100% das seções
export function concluida(d: Resultado): boolean {
  if (d.secoesTotalizadas < 100) return false;
  return d.candidatos.some((c) => c.eleito) || d.candidatos.some((c) => /2º turno/i.test(c.situacao));
}

export function obter(uf: string, cargo: number, turno: number): Promise<Resultado> {
  const chave = `${turno}:${uf}:${cargo}`;
  const hit = cache.get(chave);
  // Encerrado/arquivado: serve o último resultado conhecido para sempre, sem nova consulta ao TSE
  if (hit && (arquivado(turno) || hit.expira > Date.now())) return hit.promessa;

  const promessa = buscarResultado(uf, cargo, turno).catch((err: unknown) => {
    if (turno > 1 && err instanceof ErroTSE && err.status === 404) return provisorio(uf, cargo, turno);
    throw err;
  }).then((d) => {
    if (d.instante === null && d.secoesTotalizadas === 0 && !d.totais) return d; // provisório: nada a registrar/avisar
    try { registrar(d); } catch (e) { console.error(`[histórico ${chave}]`, (e as Error).message); }
    // Turno anterior: só leitura (sem aviso ao vivo, push nem linha do tempo)
    if (turno !== config.turnoAtual) return d;
    if (versoes.has(chave) && versoes.get(chave) !== d.instante) notificar(chave, { instante: d.instante, pst: d.secoesTotalizadas });
    versoes.set(chave, d.instante);
    let deteccoes: ReturnType<typeof avaliar>['deteccoes'] = [];
    try {
      const r = avaliar(d);
      deteccoes = r.deteccoes;
      const aviso = r.aviso;
      if (aviso) console.log(`[aviso ${chave}] ${aviso.corpo.split('\n')[0]} -> ${enviar(uf, cargo, aviso)} aparelho(s)`);
    } catch (e) { console.error(`[aviso ${chave}]`, (e as Error).message); }
    // Linha do tempo: separada do push (uma falha aqui não afeta os avisos)
    try { processar(d, deteccoes); } catch (e) { console.error(`[novidades ${chave}]`, (e as Error).message); }
    return d;
  }).catch((err: unknown) => {
    cache.delete(chave); // não guarda erro em cache
    throw err;
  });
  cache.set(chave, { expira: arquivado(turno) ? Infinity : Date.now() + config.cacheMs, promessa });
  return promessa;
}

// O TSE só publica os arquivos do 2º turno perto do dia da eleição. Até lá, a disputa é montada
// com os finalistas do turno anterior (situação "2º turno"), zerados: a tela mostra o confronto
// e a contagem regressiva em vez de erro. O cache curto faz o servidor tentar o TSE de novo a cada
// rodada; quando o arquivo real aparecer, ele assume sozinho.
async function provisorio(uf: string, cargo: number, turno: number): Promise<Resultado> {
  const anterior = await obter(uf, cargo, turno - 1);
  return {
    ...anterior,
    turno,
    atualizadoEm: '',
    instante: null,
    secoesTotalizadas: 0,
    totais: undefined,
    candidatos: anterior.candidatos
      .filter((c) => /2º turno/i.test(c.situacao))
      .map((c) => ({ ...c, votos: 0, percentual: 0, eleito: false, situacao: '' })),
  };
}
