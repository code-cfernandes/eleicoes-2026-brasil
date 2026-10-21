import { Router, type Request, type Response } from 'express';
import { lerHistorico, obter, obterFoto } from '../servicos/resultados.ts';
import { comprimir, enviarPronto, params, type CorpoPronto } from './respostas.ts';
import type { Resultado } from '../../shared/tipos.ts';

// Uma disputa: resultado, evolução (histórico) e fotos dos candidatos
export const rotasResultados = Router();

// Corpo pronto por versão do resultado (o objeto muda a cada geração do TSE)
const corpos = new WeakMap<Resultado, CorpoPronto>();
function corpoPronto(d: Resultado) {
  let c = corpos.get(d);
  if (!c) corpos.set(d, (c = comprimir(d)));
  return c;
}

rotasResultados.get('/api/resultado', async (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, req.query.turno, res);
  if (!p) return;
  try {
    const d = await obter(p.uf, p.cargo, p.turno);
    enviarPronto(req, res, `"${p.turno}-${p.uf}-${p.cargo}-${d.instante ?? 0}"`, () => corpoPronto(d));
  } catch (err) {
    res.status(502).json({ erro: (err as Error).message });
  }
});

// ?por=hora (padrão): último snapshot de cada hora · ?por=todos: cada geração do TSE
// ?desde=<instante>: só o que veio depois do último ponto que o cliente já tem
rotasResultados.get('/api/historico', (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, req.query.turno, res);
  if (!p) return;
  const por = req.query.por === 'todos' ? 'todos' : 'hora';
  const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 50);
  const desde = Math.max(Number(req.query.desde) || 0, 0);
  // ?so=13,22: só esses candidatos (no máximo 50 números)
  const so = typeof req.query.so === 'string'
    ? req.query.so.split(',').filter((n) => /^\d{1,6}$/.test(n)).slice(0, 50)
    : undefined;
  res.json(lerHistorico(p.turno, p.uf, p.cargo, { por, top, desde, so }));
});

rotasResultados.get('/api/foto/:cargo/:uf/:sqcand', async (req: Request<{ cargo: string; uf: string; sqcand: string }>, res: Response) => {
  const p = params(req.params.uf, req.params.cargo, req.query.turno, res);
  if (!p) return;
  if (!/^\d{1,20}$/.test(req.params.sqcand)) {
    res.status(400).end();
    return;
  }
  try {
    const img = await obterFoto(p.uf, p.cargo, req.params.sqcand, p.turno);
    if (!img) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=86400, immutable').type('jpeg').send(img);
  } catch {
    res.status(502).end();
  }
});
