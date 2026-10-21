import { Router } from 'express';
import { config } from '../config/config.ts';
import { chavePublica, estatisticasPush } from '../servicos/notificacoes.ts';
import { arquivado, saudeTSE } from '../servicos/resultados.ts';
import { conexoesAbertas } from '../servicos/tempo-real.ts';
import { cargosDoTurno } from '../servicos/turnos.ts';
import type { ConfigPublica, SaudeDados, TurnoPublico } from '../../shared/tipos.ts';

// Configuração pública da tela e saúde do servidor
export const rotasSistema = Router();

rotasSistema.get('/api/config', (_req, res) => {
  // Só oferece cargos cuja eleição está configurada no .env (e, no 2º turno, que tiveram 2º turno)
  const turnos = config.turnos.map((t): TurnoPublico => ({
    numero: t.numero,
    nome: t.nome,
    inicioApuracao: t.inicioApuracao,
    finalizado: arquivado(t.numero),
    cargos: cargosDoTurno(t.numero),
  }));
  const atual = turnos.find((t) => t.numero === config.turnoAtual);
  const cfg: ConfigPublica = {
    intervaloMs: config.cacheMs,
    chavePush: chavePublica,
    turnos,
    turnoAtual: config.turnoAtual,
    inicioApuracao: atual?.inicioApuracao ?? null,
    turno: atual?.nome ?? '',
    finalizado: atual?.finalizado ?? false,
    cargos: atual?.cargos ?? [],
  };
  res.json(cfg);
});

rotasSistema.get('/api/saude', (_req, res) => {
  const dados: SaudeDados = { tse: saudeTSE(), coletaIntervaloMs: config.cacheMs, conexoesAoVivo: conexoesAbertas() };
  res.json({ ok: true, conexoes: conexoesAbertas(), push: estatisticasPush(), dados });
});
