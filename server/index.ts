import express, { type Request, type Response } from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { config, CARGOS, defTurno } from './config.ts';
import { buscarResultado, ErroTSE, saudeTSE } from './tse.ts';
import { cargosDoTurno, descobrirTurnos, disputaExiste } from './turnos.ts';
import { codigosPendentes, descobrirCodigos } from './codigos.ts';
import { iniciarTseSimulado } from './simulacao.ts';
import { registrar, lerHistorico } from './historico.ts';
import { fechar } from './banco.ts';
import { obterFoto } from './fotos.ts';
import { assinar, CANAL_NOVIDADES, conexoesAbertas, disputasAssistidas, encerrarTodas, notificar } from './eventos.ts';
import { backfillIA, estaTudoConcluido, gerarResumoPeriodico, idMaisRecente, lerNovidades, lerNovidadesAntes, marcarTudoConcluido, processar, pulsar, reconstruirHistorico, redigirComIA } from './novidades.ts';
import {
  avaliar, chavePublica, deixarDeSeguir, deixarNovidades, disputasComInscritos, disputasSeguidas, enviar, enviarTeste,
  estatisticasPush, inscricaoValida, renovar, seguir, segueNovidades, seguirNovidades,
} from './notificacoes.ts';
import type { ConfigPublica, DisputaDoTurno, EstadoPanorama, Panorama, RespostaDisputas, Resultado, ResumoCargo, SaudeDados, TurnoPublico, VisaoEstado } from '../shared/tipos.ts';

const app = express();
app.use(compression()); // JSON de deputados cai de ~250 kB para ~35 kB
const cache = new Map<string, { expira: number; promessa: Promise<Resultado> }>();
const versoes = new Map<string, number | null>(); // última geração do TSE vista por disputa

// Só o turno atual é coletado ao vivo. Turnos anteriores (e o atual, depois de encerrado) são
// arquivo: o resultado é buscado no TSE uma vez e servido do cache para sempre.
const arquivado = (turno: number) => turno !== config.turnoAtual || estaTudoConcluido();

// Uma disputa está concluída quando o TSE marcou o resultado (eleito/2º turno) com 100% das seções
function concluida(d: Resultado): boolean {
  if (d.secoesTotalizadas < 100) return false;
  return d.candidatos.some((c) => c.eleito) || d.candidatos.some((c) => /2º turno/i.test(c.situacao));
}

// Cache curto + dedupe: N visitantes simultâneos geram 1 requisição ao TSE por janela.
// Toda resposta nova do TSE vai para o histórico, venha do coletor ou de um visitante,
// e quem está com a disputa aberta recebe o aviso na hora (SSE).
function obter(uf: string, cargo: number, turno: number): Promise<Resultado> {
  const chave = `${turno}:${uf}:${cargo}`;
  const hit = cache.get(chave);
  // Encerrado/arquivado: serve o último resultado conhecido para sempre, sem nova consulta ao TSE
  if (hit && (arquivado(turno) || hit.expira > Date.now())) return hit.promessa;

  const promessa = buscarResultado(uf, cargo, turno).catch((err: unknown) => {
    if (turno > 1 && err instanceof ErroTSE && err.status === 404) return provisorio(uf, cargo, turno);
    throw err;
  }).then((d) => {
    if (d.instante === null && d.secoesTotalizadas === 0 && !d.totais) return d; // provisório: nada a registrar/avisar
    try { registrar(d); } catch (e) { console.error(`[histórico ${chave}]`, (e as Error).message); }
    // Turno anterior: só leitura (sem aviso ao vivo, push nem linha do tempo)
    if (turno !== config.turnoAtual) return d;
    if (versoes.has(chave) && versoes.get(chave) !== d.instante) notificar(chave, { instante: d.instante, pst: d.secoesTotalizadas });
    versoes.set(chave, d.instante);
    let deteccoes: ReturnType<typeof avaliar>['deteccoes'] = [];
    try {
      const r = avaliar(d);
      deteccoes = r.deteccoes;
      const aviso = r.aviso;
      if (aviso) console.log(`[aviso ${chave}] ${aviso.corpo.split('\n')[0]} -> ${enviar(uf, cargo, aviso)} aparelho(s)`);
    } catch (e) { console.error(`[aviso ${chave}]`, (e as Error).message); }
    // Linha do tempo: separada do push (uma falha aqui não afeta os avisos)
    try { processar(d, deteccoes); } catch (e) { console.error(`[novidades ${chave}]`, (e as Error).message); }
    return d;
  }).catch((err: unknown) => {
    cache.delete(chave); // não guarda erro em cache
    throw err;
  });
  cache.set(chave, { expira: arquivado(turno) ? Infinity : Date.now() + config.cacheMs, promessa });
  return promessa;
}

// O TSE só publica os arquivos do 2º turno perto do dia da eleição. Até lá, a disputa é montada
// com os finalistas do turno anterior (situação "2º turno"), zerados: a tela mostra o confronto
// e a contagem regressiva em vez de erro. O cache curto faz o servidor tentar o TSE de novo a cada
// rodada; quando o arquivo real aparecer, ele assume sozinho.
async function provisorio(uf: string, cargo: number, turno: number): Promise<Resultado> {
  const anterior = await obter(uf, cargo, turno - 1);
  return {
    ...anterior,
    turno,
    atualizadoEm: '',
    instante: null,
    secoesTotalizadas: 0,
    totais: undefined,
    candidatos: anterior.candidatos
      .filter((c) => /2º turno/i.test(c.situacao))
      .map((c) => ({ ...c, votos: 0, percentual: 0, eleito: false, situacao: '' })),
  };
}

// JSON e gzip prontos por versão: quando milhares de aparelhos buscam logo após um aviso,
// o servidor serializa/comprime uma vez em vez de uma vez por aparelho.
const corpos = new WeakMap<Resultado, { json: Buffer; gzip: Buffer }>();
function corpoPronto(d: Resultado) {
  let c = corpos.get(d);
  if (!c) {
    const json = Buffer.from(JSON.stringify(d));
    corpos.set(d, (c = { json, gzip: gzipSync(json) }));
  }
  return c;
}

// ?turno=N (padrão: o turno atual). null = turno não configurado.
function turnoDe(v: unknown): number | null {
  if (v === undefined || v === '') return config.turnoAtual;
  const n = Number(v);
  return defTurno(n) ? n : null;
}

// Validação compartilhada pelas rotas: a UF precisa ter resultado para aquele cargo no turno
function params(uf: unknown, cargo: unknown, turno: unknown, res: Response): { uf: string; cargo: number; turno: number } | null {
  const u = String(uf ?? 'br').toLowerCase();
  const c = Number(cargo ?? 1);
  const t = turnoDe(turno);
  if (t === null || !disputaExiste(t, u, c)) {
    res.status(400).json({ erro: 'uf, cargo ou turno inválido' });
    return null;
  }
  return { uf: u, cargo: c, turno: t };
}

app.get('/api/resultado', async (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, req.query.turno, res);
  if (!p) return;
  try {
    const d = await obter(p.uf, p.cargo, p.turno);
    // A versão é a geração do TSE: enquanto ela não muda, o navegador recebe 304 sem corpo.
    // no-cache = pode guardar, mas sempre pergunte antes de usar.
    res.set({ ETag: `"${p.turno}-${p.uf}-${p.cargo}-${d.instante ?? 0}"`, 'Cache-Control': 'no-cache' });
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    const c = corpoPronto(d);
    res.vary('Accept-Encoding').type('json');
    // Content-Encoding já definido: o middleware compression não recomprime
    if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(c.gzip);
    else res.send(c.json);
  } catch (err) {
    res.status(502).json({ erro: (err as Error).message });
  }
});

// Mapa/lista "Por estado": % totalizado e líder de cada UF para o cargo pedido
// (?cargo=1 Presidente, padrão, com exterior; 3 Governador; 5 Senador). `brasil` vem sempre de br:1.
// Lê pelo mesmo cache/dedupe de obter(): mil pessoas na aba = 28 consultas ao TSE a cada 30s.
// O corpo de cada cargo só é refeito quando alguma UF muda de versão; sem mudança, 304.
// ?turno=: no 2º turno, Governador só lista as UFs que tiveram 2º turno.
const CARGOS_PANORAMA = [1, 3, 5];
const panoramasProntos = new Map<string, { chave: string; etag: string; json: Buffer; gzip: Buffer }>();

app.get('/api/panorama', async (req: Request, res: Response) => {
  const cargo = Number(req.query.cargo ?? 1);
  const turno = turnoDe(req.query.turno);
  const cargoTurno = turno === null ? undefined : cargosDoTurno(turno).find((c) => c.codigo === cargo);
  if (turno === null || !CARGOS_PANORAMA.includes(cargo) || !cargoTurno) {
    res.status(400).json({ erro: 'cargo inválido para o turno (use 1, 3 ou 5)' });
    return;
  }
  const ufs = cargoTurno.ufs.filter((u) => u !== 'br' && (cargo === 1 || u !== 'zz'));
  const brasil = disputaExiste(turno, 'br', 1) ? obter('br', 1, turno) : Promise.resolve(null);
  const [brPar, ...pares] = await Promise.allSettled([brasil, ...ufs.map((uf) => obter(uf, cargo, turno))]);
  const br = brPar?.status === 'fulfilled' ? brPar.value : null;
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = [br, ...resultados].map((r) => r?.instante ?? 'x').join(',');

  let pronto = panoramasProntos.get(`${turno}:${cargo}`);
  if (pronto?.chave !== chave) {
    const corpo: Panorama = {
      cargo,
      brasil: { pst: br?.secoesTotalizadas ?? null, instante: br?.instante ?? null, ...(br?.totais && { totais: br.totais }) },
      estados: ufs.map((uf, i): EstadoPanorama => {
        const r = resultados[i];
        const [primeiro, segundo, terceiro] = (r?.candidatos ?? []).filter((c) => c.votos > 0);
        const vagas = r?.vagas ?? 1;
        return {
          uf,
          pst: r ? r.secoesTotalizadas : null,
          instante: r?.instante ?? null,
          lider: primeiro ?? null,
          segundo: vagas > 1 ? segundo : undefined,
          // Vaga única: vantagem do 1º sobre o 2º. Senado (2 vagas): margem da última vaga (2º sobre o 3º).
          vantagem: vagas > 1
            ? (segundo && terceiro ? segundo.percentual - terceiro.percentual : null)
            : (primeiro && segundo ? primeiro.percentual - segundo.percentual : null),
          secoesTotalizadas: r?.totais?.secoesTotalizadas,
          secoes: r?.totais?.secoes,
        };
      }),
    };
    const json = Buffer.from(JSON.stringify(corpo));
    pronto = { chave, etag: `"pan-${turno}-${cargo}-${createHash('sha1').update(chave).digest('base64url').slice(0, 16)}"`, json, gzip: gzipSync(json) };
    panoramasProntos.set(`${turno}:${cargo}`, pronto);
  }

  res.set({ ETag: pronto.etag, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.vary('Accept-Encoding').type('json');
  if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(pronto.gzip);
  else res.send(pronto.json);
});

// "O que está acontecendo agora" (regras em novidades.ts). Mais recentes primeiro;
// ?desde=<id>: só eventos de id maior; ?antes=<id>: página mais antiga (id menor);
// ?limite= (padrão 30, máx. 100); ?turno= (padrão: o atual). Sem evento novo: 304.
app.get('/api/novidades', (req: Request, res: Response) => {
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

// Visão do estado: todos os cargos da UF com os mais votados (3 para Presidente, 5 nos demais).
// Mesmo cache de obter(); o corpo por UF só é refeito quando algum cargo muda de versão.
const TOP_ESTADO: Record<number, number> = { 1: 3 };
const visoesProntas = new Map<string, { chave: string; etag: string; json: Buffer; gzip: Buffer }>();

// No 2º turno, um estado pode não ter disputa nenhuma (Governador decidido no 1º): cargos vazio.
app.get('/api/estado', async (req: Request, res: Response) => {
  const uf = String(req.query.uf ?? '').toLowerCase();
  const turno = turnoDe(req.query.turno);
  if (turno === null || uf === 'br' || !CARGOS[1]!.ufs.includes(uf)) {
    res.status(400).json({ erro: 'uf ou turno inválido' });
    return;
  }
  const cargos = cargosDoTurno(turno).filter((c) => c.ufs.includes(uf));
  const pares = await Promise.allSettled(cargos.map((c) => obter(uf, c.codigo, turno)));
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = resultados.map((r) => r?.instante ?? 'x').join(',');

  let pronto = visoesProntas.get(`${turno}:${uf}`);
  if (pronto?.chave !== chave) {
    const corpo: VisaoEstado = {
      uf,
      cargos: cargos.map((c, i): ResumoCargo => {
        const r = resultados[i];
        return {
          cargo: c.codigo,
          nome: c.nome,
          proporcional: c.proporcional,
          vagas: r?.vagas ?? 1,
          pst: r ? r.secoesTotalizadas : null,
          instante: r?.instante ?? null,
          total: r?.candidatos.length ?? 0,
          candidatos: (r?.candidatos ?? []).filter((x) => x.votos > 0).slice(0, TOP_ESTADO[c.codigo] ?? 5),
        };
      }),
    };
    const json = Buffer.from(JSON.stringify(corpo));
    pronto = { chave, etag: `"est-${turno}-${uf}-${createHash('sha1').update(chave).digest('base64url').slice(0, 16)}"`, json, gzip: gzipSync(json) };
    visoesProntas.set(`${turno}:${uf}`, pronto);
  }

  res.set({ ETag: pronto.etag, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.vary('Accept-Encoding').type('json');
  if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(pronto.gzip);
  else res.send(pronto.json);
});

// O que se vota no turno, por disputa, com os candidatos (no 2º turno, os dois finalistas), mesmo
// antes de haver votos. Para a tela de espera do 2º turno. Só disputas majoritárias e só no nível
// que decide: Presidente no Brasil ('br'), Governador/Senador por UF. Mesmo cache de obter().
// Também alimenta o placar dos governadores no Início durante a apuração: sem mudança, 304.
app.get('/api/disputas', async (req: Request, res: Response) => {
  const turno = turnoDe(req.query.turno);
  if (turno === null) {
    res.status(400).json({ erro: 'turno inválido' });
    return;
  }
  const pares = cargosDoTurno(turno).filter((c) => !c.proporcional)
    .flatMap((c) => (c.ufs.includes('br') ? ['br'] : c.ufs).map((uf) => ({ cargo: c, uf })));
  const resultados = await Promise.allSettled(pares.map((p) => obter(p.uf, p.cargo.codigo, turno)));
  const corpo: RespostaDisputas = {
    turno,
    disputas: pares.flatMap(({ cargo, uf }, i): DisputaDoTurno[] => {
      const r = resultados[i]!;
      if (r.status !== 'fulfilled') return [];
      // Vaga única no 2º turno: os dois primeiros bastam (no 1º turno viria a lista toda)
      const candidatos = turno > 1 ? r.value.candidatos.slice(0, 2) : r.value.candidatos;
      return [{ cargo: cargo.codigo, nome: cargo.nome, uf, pst: r.value.secoesTotalizadas, instante: r.value.instante, candidatos }];
    }),
  };
  const versao = corpo.disputas.map((d) => `${d.uf}${d.cargo}:${d.instante ?? 0}`).join(',');
  res.set({ ETag: `"disp-${turno}-${createHash('sha1').update(versao).digest('base64url').slice(0, 16)}"`, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.json(corpo);
});

// ?por=hora (padrão): último snapshot de cada hora · ?por=todos: cada geração do TSE
// ?desde=<instante>: só o que veio depois do último ponto que o cliente já tem
app.get('/api/historico', (req: Request, res: Response) => {
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

app.get('/api/foto/:cargo/:uf/:sqcand', async (req: Request<{ cargo: string; uf: string; sqcand: string }>, res: Response) => {
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

app.get('/api/config', (_req, res) => {
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
    simulacao: !!config.simulacao,
    inicioApuracao: atual?.inicioApuracao ?? null,
    turno: atual?.nome ?? '',
    finalizado: atual?.finalizado ?? false,
    cargos: atual?.cargos ?? [],
  };
  res.json(cfg);
});

// Conexão SSE de uma disputa: avisa quando o TSE publicar versão nova.
// Lotado (MAX_CONEXOES) -> 503 e o navegador segue no polling.
// ?canal=novidades: canal global da linha do tempo ("event: novidade" com o EventoApuracao novo).
app.get('/api/eventos', (req: Request, res: Response) => {
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

// Notificações push: o aparelho segue/deixa de seguir disputas. O endpoint da inscrição
// funciona como identificador secreto do aparelho (só ele e o push service o conhecem).
// A inscrição é por uf:cargo, sem turno: os avisos saem sempre do turno atual.
const corpoJson = express.json({ limit: '4kb' });

app.post('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
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
app.delete('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
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
app.post('/api/notificacoes/novidades', corpoJson, (req: Request, res: Response) => {
  if (!inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  const erro = seguirNovidades(req.body.inscricao);
  if (erro === 'lotado') res.status(503).json({ erro: 'Limite de aparelhos inscritos atingido' });
  else res.status(204).end();
});

app.delete('/api/notificacoes/novidades', corpoJson, (req: Request, res: Response) => {
  if (typeof req.body?.endpoint === 'string') deixarNovidades(req.body.endpoint);
  res.status(204).end();
});

app.post('/api/notificacoes/renovar', corpoJson, (req: Request, res: Response) => {
  if (typeof req.body?.antigo !== 'string' || !inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  renovar(req.body.antigo, req.body.inscricao);
  res.status(204).end();
});

// POST (e não GET) para o endpoint não ir parar em logs de URL
app.post('/api/notificacoes/consultar', corpoJson, (req: Request, res: Response) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
  res.json({ disputas: endpoint ? disputasSeguidas(endpoint) : [], novidades: endpoint ? segueNovidades(endpoint) : false });
});

// Notificação de teste só para o aparelho que pediu (POST para o endpoint não ir para logs de URL).
// 200 com { ok, servico, status?, motivo? }: o que o push service respondeu.
// Só no modo simulação: em produção o botão não aparece e a rota não existe.
app.post('/api/notificacoes/teste', corpoJson, async (req: Request, res: Response) => {
  if (!config.simulacao) {
    res.status(404).json({ erro: 'Disponível só no modo simulação' });
    return;
  }
  if (typeof req.body?.endpoint !== 'string') {
    res.status(400).json({ erro: 'endpoint ausente' });
    return;
  }
  const r = await enviarTeste(req.body.endpoint);
  if (r === 'desconhecido') res.status(404).json({ erro: 'Este aparelho não está inscrito' });
  else if (r === 'aguarde') res.status(429).json({ erro: 'Aguarde alguns segundos para testar de novo' });
  else res.json(r);
});

app.get('/api/saude', (_req, res) => {
  const dados: SaudeDados = { tse: saudeTSE(), coletaIntervaloMs: config.cacheMs, conexoesAoVivo: conexoesAbertas() };
  res.json({ ok: true, conexoes: conexoesAbertas(), push: estatisticasPush(), dados });
});

// Arquivos do Vite têm hash no nome: cache de 1 ano. index.html sempre revalida.
app.use(express.static(fileURLToPath(new URL('../dist/web', import.meta.url)), {
  setHeaders: (res, caminho) => res.setHeader('Cache-Control',
    caminho.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));

// Coletor em background: registra o avanço mesmo sem visitantes.
// Poucas requisições simultâneas, para não disparar dezenas de downloads de uma vez.
let coletando = false;
async function coletarTudo() {
  if (coletando || estaTudoConcluido()) return;
  coletando = true;
  // Códigos de eleição que faltam (ex.: 2º turno publicado pelo TSE depois da subida). Se aparecer
  // um turno novo, ele já vira o atual nesta mesma rodada.
  await descobrirCodigos();
  const turno = config.turnoAtual;
  // Quais disputas existem no 2º turno (lê o 1º turno uma vez; depois fica no banco)
  try { await descobrirTurnos(obter); } catch (e) { console.error('[turnos]', (e as Error).message); }
  // MONITORAR (sempre) + o que alguém está assistindo agora (só enquanto houver alguém)
  // e o que algum aparelho segue por notificação (o aviso precisa sair mesmo com a tela fechada).
  // Só o que existe no turno atual (ex.: deputados e Senado não têm 2º turno).
  const pares = new Map([...config.monitorar, ...disputasAssistidas(turno), ...disputasComInscritos()]
    .filter(([uf, cargo]) => disputaExiste(turno, uf, cargo))
    .map((p) => [p.join(':'), p] as const));
  const fila = [...pares.values()];
  const resultados: (Resultado | null)[] = [];
  const trabalhador = async () => {
    for (let par = fila.shift(); par; par = fila.shift()) {
      const [uf, cargo] = par;
      try {
        resultados.push(await obter(uf, cargo, turno));
      } catch (e) {
        console.error(`[coleta ${uf}:${cargo}]`, (e as Error).message);
        resultados.push(null);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabalhador));
  pulsar(); // agregados de deputados que já esperaram o suficiente
  coletando = false;

  // Todas as disputas coletadas fecharam (100% + resultado definido)? Então não há mais o que
  // buscar: encerra as consultas ao TSE e passa a servir da base/histórico que já existe.
  // Com código pendente não encerra: o próximo turno ainda pode aparecer na lista do TSE.
  if (resultados.length && resultados.every((r) => r && concluida(r)) && !codigosPendentes()) {
    marcarTudoConcluido();
    clearInterval(coletor);
    console.log('[coleta] totalização concluída — consultas ao TSE encerradas');
  }
}

// Simulação: o TSE falso precisa estar no ar antes de qualquer consulta (a descoberta abaixo já usa)
if (config.simulacao) await iniciarTseSimulado();
// Na subida, antes de tudo: descobre os códigos que o ambiente não define (limite de 10s; se o TSE
// não responder, segue com o que tem e o coletor tenta de novo a cada rodada)
await descobrirCodigos();
console.log(`Códigos: ${config.turnos.map((t) => `${t.nome} federal ${t.eleicao.federal ?? '—'} / estadual ${t.eleicao.estadual ?? '—'}`).join(' · ')}`);
console.log(`Turno atual: ${config.turnoAtual}º · monitorando ${config.monitorar.map((p) => p.join(':')).join(', ')}`);
// Reconstrói a linha do tempo a partir dos snapshots (uma vez, antes de coletar de novo)
reconstruirHistorico();
void coletarTudo();
const coletor = setInterval(coletarTudo, config.cacheMs);

// Redação por IA (DeepSeek): roda em intervalo próprio, fora do coletor (uma chamada lenta
// não segura a coleta do TSE). O throttle real fica dentro de redigirComIA. Na subida, backfillIA
// recalcula as notícias antigas que ainda estão com frase-modelo.
void backfillIA();
setInterval(() => { void redigirComIA(); }, config.cacheMs);

// Balanço periódico de Presidente/Brasil (a cada NOTICIA_INTERVALO_MIN): gera a notícia de
// "começou às HH:MM" quando não há nenhuma ainda e, depois, o andamento com o aumento percentual.
gerarResumoPeriodico();
setInterval(() => { gerarResumoPeriodico(); }, config.cacheMs);

const servidor = app.listen(config.port, () => console.log(`http://localhost:${config.port}`));

// docker stop manda SIGTERM: fecha o SQLite limpo (checkpoint do WAL)
for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    clearInterval(coletor);
    encerrarTodas(); // navegadores reconectam sozinhos na próxima instância
    servidor.close(() => { fechar(); process.exit(0); });
    servidor.closeAllConnections();
  });
}
