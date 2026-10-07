import { Router, type Request, type Response } from 'express';
import { obter } from '../servicos/resultados.ts';
import { assinar, CANAL_NOVIDADES } from '../servicos/tempo-real.ts';
import { params } from './respostas.ts';

export const rotasEventos = Router();

// Conexão SSE de uma disputa: avisa quando o TSE publicar versão nova.
// Lotado (MAX_CONEXOES) -> 503 e o navegador segue no polling.
// ?canal=novidades: canal global da linha do tempo ("event: novidade" com o EventoApuracao novo).
rotasEventos.get('/api/eventos', (req: Request, res: Response) => {
  if (req.query.canal === CANAL_NOVIDADES) {
    if (!assinar(CANAL_NOVIDADES, req, res)) res.status(503).json({ erro: 'Limite de conexões ao vivo atingido' });
    return;
  }
  const p = params(req.query.uf, req.query.cargo, req.query.turno, res);
  if (!p) return;
  if (!assinar(`${p.turno}:${p.uf}:${p.cargo}`, req, res)) {
    res.status(503).json({ erro: 'Limite de conexões ao vivo atingido' });
    return;
  }
  void obter(p.uf, p.cargo, p.turno).catch(() => {}); // começa a acompanhar a disputa já
});
