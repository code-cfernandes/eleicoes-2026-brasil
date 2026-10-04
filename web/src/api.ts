import type { ConfigPublica, Panorama, PontoHistorico, RespostaHistorico, Resultado, VisaoEstado } from '../../shared/tipos.ts';

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  // no-cache: o navegador revalida com If-None-Match; sem novidade, o servidor responde 304
  const r = await fetch(url, { signal, cache: 'no-cache' });
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo?.erro ?? `HTTP ${r.status}`);
  return corpo as T;
}

export const buscarConfig = () => json<ConfigPublica>('/api/config');

export const buscarPanorama = (signal?: AbortSignal) => json<Panorama>('/api/panorama', signal);

export const buscarEstado = (uf: string, signal?: AbortSignal) => json<VisaoEstado>(`/api/estado?uf=${uf}`, signal);

export const buscarResultado = (uf: string, cargo: number, signal?: AbortSignal) =>
  json<Resultado>(`/api/resultado?uf=${uf}&cargo=${cargo}`, signal);

export const buscarHistorico = (
  uf: string, cargo: number, por: 'hora' | 'todos', top: number, desde: number, signal?: AbortSignal, so?: string[],
) => json<RespostaHistorico>(
  `/api/historico?uf=${uf}&cargo=${cargo}&por=${por}&top=${top}&desde=${desde}${so ? `&so=${so.join(',')}` : ''}`, signal);

// Junta os pontos novos aos que já estão na tela. No modo hora, o ponto da hora
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
