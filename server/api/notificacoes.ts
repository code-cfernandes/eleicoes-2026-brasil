import express, { Router, type Request, type Response } from 'express';
import { CARGOS } from '../dominio/cargos.ts';
import {
  deixarDeSeguir, deixarNovidades, disputasSeguidas, inscricaoValida, renovar, seguir, segueNovidades, seguirNovidades,
} from '../servicos/notificacoes.ts';
import { obter } from '../servicos/resultados.ts';
import { params } from './respostas.ts';

// Notificações push: o aparelho segue/deixa de seguir disputas. O endpoint da inscrição
// funciona como identificador secreto do aparelho (só ele e o push service o conhecem).
// A inscrição é por uf:cargo, sem turno: os avisos saem sempre do turno atual.
export const rotasNotificacoes = Router();
const corpoJson = express.json({ limit: '4kb' });

rotasNotificacoes.post('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
  const p = params(req.body?.uf, req.body?.cargo, undefined, res); // só disputas do turno atual
  if (!p) return;
  if (!inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  const erro = seguir(req.body.inscricao, p.uf, p.cargo);
  if (erro === 'lotado') res.status(503).json({ erro: 'Limite de aparelhos inscritos atingido' });
  else if (erro) res.status(409).json({ erro: 'Você já segue o máximo de disputas neste aparelho' });
  else {
    void obter(p.uf, p.cargo, p.turno).catch(() => {}); // garante o estado de alerta atualizado
    res.status(204).end();
  }
});

// Deixar de seguir aceita qualquer disputa válida, mesmo que não exista no turno atual
// (ex.: Senador seguido no 1º turno)
rotasNotificacoes.delete('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
  const uf = String(req.body?.uf ?? '').toLowerCase();
  const cargo = Number(req.body?.cargo);
  if (!CARGOS[cargo]?.ufs.includes(uf)) {
    res.status(400).json({ erro: 'uf ou cargo inválido' });
    return;
  }
  if (typeof req.body?.endpoint === 'string') deixarDeSeguir(req.body.endpoint, uf, cargo);
  res.status(204).end();
});

// Canal global de novidades (as mesmas para todos os aparelhos): o aparelho liga/desliga.
rotasNotificacoes.post('/api/notificacoes/novidades', corpoJson, (req: Request, res: Response) => {
  if (!inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  const erro = seguirNovidades(req.body.inscricao);
  if (erro === 'lotado') res.status(503).json({ erro: 'Limite de aparelhos inscritos atingido' });
  else res.status(204).end();
});

rotasNotificacoes.delete('/api/notificacoes/novidades', corpoJson, (req: Request, res: Response) => {
  if (typeof req.body?.endpoint === 'string') deixarNovidades(req.body.endpoint);
  res.status(204).end();
});

rotasNotificacoes.post('/api/notificacoes/renovar', corpoJson, (req: Request, res: Response) => {
  if (typeof req.body?.antigo !== 'string' || !inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  renovar(req.body.antigo, req.body.inscricao);
  res.status(204).end();
});

// POST (e não GET) para o endpoint não ir parar em logs de URL
rotasNotificacoes.post('/api/notificacoes/consultar', corpoJson, (req: Request, res: Response) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
  res.json({ disputas: endpoint ? disputasSeguidas(endpoint) : [], novidades: endpoint ? segueNovidades(endpoint) : false });
});
