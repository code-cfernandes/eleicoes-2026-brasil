import type { ConfigPublica, Panorama, PontoHistorico, RespostaDisputas, RespostaHistorico, Resultado, VisaoEstado } from '../../shared/tipos.ts';

// Turno em exibição: toda rota de dados recebe ?turno=. O App define o turno antes de renderizar
// e remonta o conteúdo quando ele muda (key), então cada componente já busca no turno certo.
// Sem turno definido, o servidor usa o turno atual.
let turnoEmVista: number | undefined;
export const definirTurno = (turno: number | undefined) => { turnoEmVista = turno; };
export const turnoDaTela = () => turnoEmVista;
export const comTurno = (url: string) =>
  turnoEmVista ? `${url}${url.includes('?') ? '&' : '?'}turno=${turnoEmVista}` : url;

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  // no-cache: o navegador revalida com If-None-Match; sem novidade, o servidor responde 304
  const r = await fetch(comTurno(url), { signal, cache: 'no-cache' });
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo?.erro ?? `HTTP ${r.status}`);
  return corpo as T;
}

// Relógio do servidor: o cronômetro e a virada para a tela de resultados não podem depender do
// relógio do aparelho (um PC atrasado ficaria na contagem com a apuração já correndo). O desvio
// sai do cabeçalho Date do /api/config (precisão de 1s); abaixo de 2s, vale o relógio local.
let desvioRelogio = 0;
export const agora = () => Date.now() + desvioRelogio;

export async function buscarConfig(): Promise<ConfigPublica> {
  const r = await fetch('/api/config', { cache: 'no-store' });
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo?.erro ?? `HTTP ${r.status}`);
  const doServidor = Date.parse(r.headers.get('Date') ?? '');
  if (doServidor) {
    const desvio = doServidor + 500 - Date.now(); // +500: o cabeçalho trunca no segundo
    desvioRelogio = Math.abs(desvio) > 2000 ? desvio : 0;
  }
  return corpo as ConfigPublica;
}

export const buscarPanorama = (signal?: AbortSignal, cargo?: number) =>
  json<Panorama>(`/api/panorama${cargo ? `?cargo=${cargo}` : ''}`, signal);

export const buscarDisputas = (signal?: AbortSignal) => json<RespostaDisputas>('/api/disputas', signal);

export const buscarEstado = (uf: string, signal?: AbortSignal) => json<VisaoEstado>(`/api/estado?uf=${uf}`, signal);

export const buscarResultado = (uf: string, cargo: number, signal?: AbortSignal) =>
  json<Resultado>(`/api/resultado?uf=${uf}&cargo=${cargo}`, signal);

export const buscarHistorico = (
  uf: string, cargo: number, por: 'hora' | 'todos', top: number, desde: number, signal?: AbortSignal, so?: string[],
) => json<RespostaHistorico>(
  `/api/historico?uf=${uf}&cargo=${cargo}&por=${por}&top=${top}&desde=${desde}${so ? `&so=${so.join(',')}` : ''}`, signal);

// Junta os pontos novos aos que já estão na tela. No modo faixa (10 min), o ponto da faixa
// corrente é substituído pelo mais novo (mesma chave `hora`).
export function mesclarHistorico(atual: PontoHistorico[], novos: PontoHistorico[], por: 'hora' | 'todos') {
  if (!novos.length) return atual;
  const chave = (p: PontoHistorico) => (por === 'hora' ? p.hora : p.instante);
  const pontos = new Map(atual.map((p) => [chave(p), p]));
  for (const p of novos) pontos.set(chave(p), p);
  return [...pontos.values()].sort((a, b) => a.instante - b.instante);
}

// Acrescenta o passado de candidatos que entraram agora no gráfico aos pontos existentes
// e tira quem saiu, sem baixar de novo o histórico de todo mundo.
export function ajustarCandidatos(
  pontos: PontoHistorico[], passado: PontoHistorico[], por: 'hora' | 'todos', acompanhados: Set<string>,
) {
  const chave = (p: PontoHistorico) => (por === 'hora' ? p.hora : p.instante);
  const extras = new Map(passado.map((p) => [chave(p), p.cand]));
  return pontos.map((p) => {
    const ja = new Set(p.cand.map((c) => c.numero));
    const cand = [...p.cand, ...(extras.get(chave(p)) ?? []).filter((c) => !ja.has(c.numero))]
      .filter((c) => acompanhados.has(c.numero));
    return { ...p, cand };
  });
}
