import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { config, defTurno } from '../config/config.ts';
import { disputaExiste } from '../servicos/turnos.ts';

// Peças comuns às rotas: leitura e validação de parâmetros e o envio de respostas prontas
// (ETag, 304, gzip).

// ?turno=N (padrão: o turno atual). null = turno não configurado.
export function turnoDe(v: unknown): number | null {
  if (v === undefined || v === '') return config.turnoAtual;
  const n = Number(v);
  return defTurno(n) ? n : null;
}

// Validação compartilhada pelas rotas: a UF precisa ter resultado para aquele cargo no turno
export function params(uf: unknown, cargo: unknown, turno: unknown, res: Response): { uf: string; cargo: number; turno: number } | null {
  const u = String(uf ?? 'br').toLowerCase();
  const c = Number(cargo ?? 1);
  const t = turnoDe(turno);
  if (t === null || !disputaExiste(t, u, c)) {
    res.status(400).json({ erro: 'uf, cargo ou turno inválido' });
    return null;
  }
  return { uf: u, cargo: c, turno: t };
}

// JSON e gzip prontos: quando milhares de aparelhos buscam logo após um aviso, o servidor
// serializa/comprime uma vez por versão em vez de uma vez por aparelho.
export interface CorpoPronto { json: Buffer; gzip: Buffer }
export function comprimir(corpo: unknown): CorpoPronto {
  const json = Buffer.from(JSON.stringify(corpo));
  return { json, gzip: gzipSync(json) };
}

// Identificador curto de uma versão (para ETag), a partir das versões do TSE que a compõem
export const resumoDaVersao = (chave: string) => createHash('sha1').update(chave).digest('base64url').slice(0, 16);

// A versão (ETag) acompanha a geração do TSE: enquanto ela não muda, o navegador recebe 304 sem
// corpo. no-cache = pode guardar, mas sempre pergunte antes de usar. O corpo só é montado se for
// mesmo enviado.
export function enviarPronto(req: Request, res: Response, etag: string, corpo: () => CorpoPronto) {
  res.set({ ETag: etag, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  const c = corpo();
  res.vary('Accept-Encoding').type('json');
  // Content-Encoding já definido: o middleware compression não recomprime
  if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(c.gzip);
  else res.send(c.json);
}
