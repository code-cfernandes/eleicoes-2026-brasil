import { Router, type Request, type Response } from 'express';
import { idMaisRecente, lerNovidades, lerNovidadesAntes } from '../servicos/novidades.ts';
import { turnoDe } from './respostas.ts';

export const rotasNovidades = Router();

// "O que está acontecendo agora" (regras em servicos/novidades.ts). Mais recentes primeiro;
// ?desde=<id>: só eventos de id maior; ?antes=<id>: página mais antiga (id menor);
// ?limite= (padrão 30, máx. 100); ?turno= (padrão: o atual). Sem evento novo: 304.
rotasNovidades.get('/api/novidades', (req: Request, res: Response) => {
  const turno = turnoDe(req.query.turno);
  if (turno === null) {
    res.status(400).json({ erro: 'turno inválido' });
    return;
  }
  const desde = Math.max(Math.floor(Number(req.query.desde) || 0), 0);
  const antes = Math.max(Math.floor(Number(req.query.antes) || 0), 0);
  const limite = Math.min(Math.max(Math.floor(Number(req.query.limite) || 30), 1), 100);
  if (antes > 0) {
    res.type('json').send(lerNovidadesAntes(turno, antes, limite));
    return;
  }
  res.set({ ETag: `"nov-${turno}-${idMaisRecente()}"`, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.type('json').send(lerNovidades(turno, desde, limite)); // pequeno: o middleware compression comprime
});
