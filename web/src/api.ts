import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo?.erro ?? `HTTP ${r.status}`);
  return corpo as T;
}

export const buscarConfig = () => json<ConfigPublica>('/api/config');

export const buscarResultado = (uf: string, cargo: number, signal?: AbortSignal) =>
  json<Resultado>(`/api/resultado?uf=${uf}&cargo=${cargo}`, signal);

export const buscarHistorico = (uf: string, cargo: number, por: 'hora' | 'todos', top: number, signal?: AbortSignal) =>
  json<PontoHistorico[]>(`/api/historico?uf=${uf}&cargo=${cargo}&por=${por}&top=${top}`, signal);
