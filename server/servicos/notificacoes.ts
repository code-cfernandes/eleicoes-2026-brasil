import type { PushSubscription } from 'web-push';
import { envNumero } from '../config/ambiente.ts';
import { lerEstadoAlerta, salvarEstadoAlerta } from '../dados/alertas.ts';
import {
  apagarAssinaturaNovidades, apagarDisputaSeguida, apagarInscricao, apagarSeOrfa, assinaNovidades,
  disputasComInscritos as disputasInscritas, disputasDoAparelho, disputasSeguidasPor, gravarAssinaturaNovidades,
  gravarDisputaSeguida, inscricaoExiste, inscritosEmNovidades, inscritosNaDisputa, salvarInscricao,
  totalDeInscricoes, transferirInscricao,
} from '../dados/inscricoes.ts';
import { detectar, ESTADO_INICIAL, type Aviso, type Deteccao } from '../dominio/deteccao.ts';
import { enfileirar, estatisticasEnvio, quandoExpirar } from '../integracoes/push.ts';
import type { EventoApuracao, Resultado } from '../../shared/tipos.ts';

// Notificações push: o aparelho inscreve-se em disputas e recebe avisos dos momentos que importam
// (início, marcos de apuração, troca na liderança, resultado definido), não de cada
// atualização do TSE. A detecção fica em dominio/deteccao.ts; o envio, em integracoes/push.ts.

export { chavePublica, inscricaoValida } from '../integracoes/push.ts';

// Avisos de disputa: urgência alta (o Android em repouso e o Chrome em segundo plano seguram as
// mensagens "normais" e elas venciam antes de chegar) e validade de 1h; o aviso novo da mesma
// disputa substitui o anterior (topic/tag), então não chega pilha de avisos velhos.
const TTL_DISPUTA_S = 60 * 60;
const TTL_NOVIDADES_S = 30 * 60;          // novidades são frequentes: urgência normal, validade curta
const MAX_DISPUTAS_POR_APARELHO = 30;
const MAX_INSCRICOES = envNumero('MAX_INSCRICOES', 50_000);

// Inscrição que o push service diz não existir mais (404/410): sai do banco
quandoExpirar((endpoint) => apagarInscricao(endpoint));

const gravavel = (s: PushSubscription) => ({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });

export type ErroInscricao = 'lotado' | 'muitas-disputas';

export function seguir(s: PushSubscription, uf: string, cargo: number): ErroInscricao | null {
  const nova = !inscricaoExiste(s.endpoint);
  if (nova && totalDeInscricoes() >= MAX_INSCRICOES) return 'lotado';
  if (!nova && disputasDoAparelho(s.endpoint) >= MAX_DISPUTAS_POR_APARELHO) return 'muitas-disputas';
  salvarInscricao(gravavel(s));
  gravarDisputaSeguida(s.endpoint, uf, cargo);
  return null;
}

export function deixarDeSeguir(endpoint: string, uf: string, cargo: number) {
  apagarDisputaSeguida(endpoint, uf, cargo);
  apagarSeOrfa(endpoint);
}

// --- Canal global de novidades (as mesmas para todos os aparelhos) ---
export function seguirNovidades(s: PushSubscription): ErroInscricao | null {
  const nova = !inscricaoExiste(s.endpoint);
  if (nova && totalDeInscricoes() >= MAX_INSCRICOES) return 'lotado';
  salvarInscricao(gravavel(s));
  gravarAssinaturaNovidades(s.endpoint);
  return null;
}

export function deixarNovidades(endpoint: string) {
  apagarAssinaturaNovidades(endpoint);
  apagarSeOrfa(endpoint);
}

export const segueNovidades = (endpoint: string) => assinaNovidades(endpoint);

// Navegador trocou a inscrição: as disputas seguidas e o canal de novidades passam para a nova
export const renovar = (antigo: string, nova: PushSubscription) => transferirInscricao(antigo, gravavel(nova));

export const disputasSeguidas = (endpoint: string) => disputasSeguidasPor(endpoint).map((d) => `${d.uf}:${d.cargo}`);

export const disputasComInscritos = (): [string, number][] => disputasInscritas().map((d) => [d.uf, d.cargo]);

// --- Avaliação: compara o resultado novo com o que já foi avisado (e grava o novo estado)
export function avaliar(d: Resultado): { aviso: Aviso | null; deteccoes: Deteccao[] } {
  const antes = lerEstadoAlerta(d.turno, d.uf, d.cargo) ?? ESTADO_INICIAL;
  const { estado, aviso, deteccoes } = detectar(d, antes, Date.now());
  if (JSON.stringify(estado) !== JSON.stringify(antes)) salvarEstadoAlerta(d.turno, d.uf, d.cargo, estado);
  return { aviso, deteccoes };
}

export function enviar(uf: string, cargo: number, aviso: Aviso) {
  const inscritos = inscritosNaDisputa(uf, cargo);
  if (!inscritos.length) return 0;
  const { urgente: _urgente, ...conteudo } = aviso;
  // Todo aviso de disputa é alta prioridade (ver TTL_DISPUTA_S); `urgente` fica só como informação
  return enfileirar(inscritos, JSON.stringify(conteudo), { topico: `${uf}${cargo}`, urgente: true, ttl: TTL_DISPUTA_S });
}

// Notícia nova na linha do tempo: avisa quem assina o canal global de novidades.
// tag fixa: a novidade nova substitui a anterior no aparelho (sem virar pilha de spam).
export function enviarNovidades(ev: EventoApuracao) {
  const inscritos = inscritosEmNovidades();
  if (!inscritos.length) return 0;
  const payload = JSON.stringify({ titulo: 'Novidades', corpo: ev.texto, url: `/?aba=novidades&turno=${ev.turno}`, tag: 'novidades' });
  return enfileirar(inscritos, payload, { topico: 'novidades', urgente: false, ttl: TTL_NOVIDADES_S });
}

export const estatisticasPush = () => ({ inscricoes: totalDeInscricoes(), ...estatisticasEnvio() });
