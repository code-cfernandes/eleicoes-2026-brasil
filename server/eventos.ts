import type { Request, Response } from 'express';
import { envNumero } from './config.ts';

// Server-Sent Events: cada aparelho mantém uma conexão aberta para a disputa que está vendo.
// O evento é só uma "campainha" (versão nova do TSE); os dados continuam vindo pelas rotas
// HTTP, que já têm cache, gzip, ETag e histórico incremental. Assim o custo de um aviso
// é escrever ~60 bytes por conexão, não serializar/comprimir o JSON N vezes.

const MAX_CONEXOES = envNumero('MAX_CONEXOES', 5000);
const PING_MS = 25_000;             // abaixo do timeout ocioso típico de proxies (60s)
const BUFFER_MAX = 64 * 1024;       // cliente que não consome nem isso está travado: derruba

const assinantes = new Map<string, Set<Response>>(); // "uf:cargo" -> conexões abertas
let total = 0;

function escrever(res: Response, msg: string) {
  if (res.writableLength > BUFFER_MAX) {
    res.destroy(); // dispara 'close', que limpa o registro
    return;
  }
  res.write(msg);
}

export function assinar(chave: string, req: Request, res: Response): boolean {
  if (total >= MAX_CONEXOES) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', // no-transform: o compression não bufferiza o stream
    'X-Accel-Buffering': 'no',                 // idem para nginx, se houver um na frente
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n'); // o navegador reconecta sozinho após 5s se cair

  let grupo = assinantes.get(chave);
  if (!grupo) assinantes.set(chave, (grupo = new Set()));
  grupo.add(res);
  total++;

  req.on('close', () => {
    grupo.delete(res);
    if (!grupo.size) assinantes.delete(chave);
    total--;
  });
  return true;
}

export function notificar(chave: string, dados: { instante: number | null; pst: number }) {
  const grupo = assinantes.get(chave);
  if (!grupo) return;
  // Quanto mais gente assistindo, mais tempo cada aparelho espalha a busca (~1 ms por conexão,
  // entre 0,5 e 10s): a rajada de requisições após o aviso fica com pico controlado.
  const espalharMs = Math.min(Math.max(total, 500), 10_000);
  const msg = `event: atualizacao\ndata: ${JSON.stringify({ ...dados, espalharMs })}\n\n`;
  for (const res of grupo) escrever(res, msg);
}

// Disputas com alguém assistindo agora: entram no coletor automaticamente
export const disputasAssistidas = (): [string, number][] =>
  [...assinantes.keys()].map((k) => {
    const [uf, cargo] = k.split(':');
    return [uf!, Number(cargo)];
  });

export const conexoesAbertas = () => total;

export function encerrarTodas() {
  for (const grupo of assinantes.values()) for (const res of grupo) res.end();
}

// Comentário SSE (ignorado pelo navegador): mantém proxies acordados e revela conexões mortas
setInterval(() => {
  for (const grupo of assinantes.values()) for (const res of grupo) escrever(res, ': ping\n\n');
}, PING_MS).unref();
