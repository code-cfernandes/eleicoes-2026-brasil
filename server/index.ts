import express, { type Request, type Response } from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { config, CARGOS } from './config.ts';
import { buscarResultado } from './tse.ts';
import { registrar, lerHistorico } from './historico.ts';
import { fechar } from './banco.ts';
import { obterFoto } from './fotos.ts';
import { assinar, conexoesAbertas, disputasAssistidas, encerrarTodas, notificar } from './eventos.ts';
import {
  avaliar, chavePublica, deixarDeSeguir, disputasComInscritos, disputasSeguidas, enviar,
  estatisticasPush, inscricaoValida, renovar, seguir,
} from './notificacoes.ts';
import type { ConfigPublica, EstadoPanorama, Panorama, Resultado, ResumoCargo, VisaoEstado } from '../shared/tipos.ts';

const app = express();
app.use(compression()); // JSON de deputados cai de ~250 kB para ~35 kB
const cache = new Map<string, { expira: number; promessa: Promise<Resultado> }>();
const versoes = new Map<string, number | null>(); // última geração do TSE vista por disputa

// Cache curto + dedupe: N visitantes simultâneos geram 1 requisição ao TSE por janela.
// Toda resposta nova do TSE vai para o histórico, venha do coletor ou de um visitante,
// e quem está com a disputa aberta recebe o aviso na hora (SSE).
function obter(uf: string, cargo: number): Promise<Resultado> {
  const chave = `${uf}:${cargo}`;
  const hit = cache.get(chave);
  if (hit && hit.expira > Date.now()) return hit.promessa;

  const promessa = buscarResultado(uf, cargo).then((d) => {
    try { registrar(uf, cargo, d); } catch (e) { console.error(`[histórico ${chave}]`, (e as Error).message); }
    if (versoes.has(chave) && versoes.get(chave) !== d.instante) notificar(chave, { instante: d.instante, pst: d.secoesTotalizadas });
    versoes.set(chave, d.instante);
    try {
      const aviso = avaliar(d);
      if (aviso) console.log(`[aviso ${chave}] ${aviso.corpo.split('\n')[0]} -> ${enviar(uf, cargo, aviso)} aparelho(s)`);
    } catch (e) { console.error(`[aviso ${chave}]`, (e as Error).message); }
    return d;
  }).catch((err: unknown) => {
    cache.delete(chave); // não guarda erro em cache
    throw err;
  });
  cache.set(chave, { expira: Date.now() + config.cacheMs, promessa });
  return promessa;
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

// Validação compartilhada pelas rotas: a UF precisa ter resultado para aquele cargo
function params(uf: unknown, cargo: unknown, res: Response): { uf: string; cargo: number } | null {
  const u = String(uf ?? 'br').toLowerCase();
  const c = Number(cargo ?? 1);
  if (!CARGOS[c]?.ufs.includes(u)) {
    res.status(400).json({ erro: 'uf ou cargo inválido' });
    return null;
  }
  return { uf: u, cargo: c };
}

app.get('/api/resultado', async (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, res);
  if (!p) return;
  try {
    const d = await obter(p.uf, p.cargo);
    // A versão é a geração do TSE: enquanto ela não muda, o navegador recebe 304 sem corpo.
    // no-cache = pode guardar, mas sempre pergunte antes de usar.
    res.set({ ETag: `"${p.uf}-${p.cargo}-${d.instante ?? 0}"`, 'Cache-Control': 'no-cache' });
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

// ?por=hora (padrão): último snapshot de cada hora · ?por=todos: cada geração do TSE
// ?desde=<instante>: só o que veio depois do último ponto que o cliente já tem
// Aba "Por estado": % apurado e líder de Presidente em cada UF (+ exterior).
// Lê pelo mesmo cache/dedupe de obter(): mil pessoas na aba = 28 consultas ao TSE a cada 30s.
// O corpo só é refeito quando alguma UF muda de versão; sem mudança, o navegador recebe 304.
const UFS_PANORAMA = CARGOS[1]!.ufs.filter((u) => u !== 'br');
let panoramaPronto: { chave: string; etag: string; json: Buffer; gzip: Buffer } | undefined;

app.get('/api/panorama', async (req: Request, res: Response) => {
  const pares = await Promise.allSettled(['br', ...UFS_PANORAMA].map((uf) => obter(uf, 1)));
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = resultados.map((r) => r?.instante ?? 'x').join(',');

  if (panoramaPronto?.chave !== chave) {
    const [br, ...ufs] = resultados;
    const corpo: Panorama = {
      brasil: { pst: br?.secoesTotalizadas ?? null, instante: br?.instante ?? null },
      estados: UFS_PANORAMA.map((uf, i): EstadoPanorama => {
        const r = ufs[i];
        const [primeiro, segundo] = (r?.candidatos ?? []).filter((c) => c.votos > 0);
        return {
          uf,
          pst: r ? r.secoesTotalizadas : null,
          instante: r?.instante ?? null,
          lider: primeiro ?? null,
          vantagem: primeiro && segundo ? primeiro.percentual - segundo.percentual : null,
        };
      }),
    };
    const json = Buffer.from(JSON.stringify(corpo));
    panoramaPronto = { chave, etag: `"pan-${createHash('sha1').update(chave).digest('base64url').slice(0, 16)}"`, json, gzip: gzipSync(json) };
  }

  res.set({ ETag: panoramaPronto.etag, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.vary('Accept-Encoding').type('json');
  if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(panoramaPronto.gzip);
  else res.send(panoramaPronto.json);
});

// Visão do estado: todos os cargos da UF com os mais votados (3 para Presidente, 5 nos demais).
// Mesmo cache de obter(); o corpo por UF só é refeito quando algum cargo muda de versão.
const TOP_ESTADO: Record<number, number> = { 1: 3 };
const visoesProntas = new Map<string, { chave: string; etag: string; json: Buffer; gzip: Buffer }>();

app.get('/api/estado', async (req: Request, res: Response) => {
  const uf = String(req.query.uf ?? '').toLowerCase();
  const cargos = Object.values(CARGOS).filter((c) => config.eleicao[c.eleicao] && c.ufs.includes(uf) && uf !== 'br');
  if (!cargos.length) {
    res.status(400).json({ erro: 'uf inválida' });
    return;
  }
  const pares = await Promise.allSettled(cargos.map((c) => obter(uf, c.codigo)));
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = resultados.map((r) => r?.instante ?? 'x').join(',');

  let pronto = visoesProntas.get(uf);
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
    pronto = { chave, etag: `"est-${uf}-${createHash('sha1').update(chave).digest('base64url').slice(0, 16)}"`, json, gzip: gzipSync(json) };
    visoesProntas.set(uf, pronto);
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

app.get('/api/historico', (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, res);
  if (!p) return;
  const por = req.query.por === 'todos' ? 'todos' : 'hora';
  const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 50);
  const desde = Math.max(Number(req.query.desde) || 0, 0);
  // ?so=13,22: só esses candidatos (no máximo 50 números)
  const so = typeof req.query.so === 'string'
    ? req.query.so.split(',').filter((n) => /^\d{1,6}$/.test(n)).slice(0, 50)
    : undefined;
  res.json(lerHistorico(p.uf, p.cargo, { por, top, desde, so }));
});

app.get('/api/foto/:cargo/:uf/:sqcand', async (req: Request<{ cargo: string; uf: string; sqcand: string }>, res: Response) => {
  const p = params(req.params.uf, req.params.cargo, res);
  if (!p) return;
  if (!/^\d{1,20}$/.test(req.params.sqcand)) {
    res.status(400).end();
    return;
  }
  try {
    const img = await obterFoto(p.uf, p.cargo, req.params.sqcand);
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
  const cfg: ConfigPublica = {
    intervaloMs: config.cacheMs,
    chavePush: chavePublica,
    turno: config.turno,
    inicioApuracao: config.inicioApuracao,
    // Só oferece cargos cuja eleição está configurada no .env
    cargos: Object.values(CARGOS).filter((c) => config.eleicao[c.eleicao]),
  };
  res.json(cfg);
});

// Conexão SSE de uma disputa: avisa quando o TSE publicar versão nova.
// Lotado (MAX_CONEXOES) -> 503 e o navegador segue no polling.
app.get('/api/eventos', (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, res);
  if (!p) return;
  if (!assinar(`${p.uf}:${p.cargo}`, req, res)) {
    res.status(503).json({ erro: 'Limite de conexões ao vivo atingido' });
    return;
  }
  void obter(p.uf, p.cargo).catch(() => {}); // começa a acompanhar a disputa já
});

// Notificações push: o aparelho segue/deixa de seguir disputas. O endpoint da inscrição
// funciona como identificador secreto do aparelho (só ele e o push service o conhecem).
const corpoJson = express.json({ limit: '4kb' });

app.post('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
  const p = params(req.body?.uf, req.body?.cargo, res);
  if (!p) return;
  if (!inscricaoValida(req.body?.inscricao)) {
    res.status(400).json({ erro: 'Inscrição de push inválida' });
    return;
  }
  const erro = seguir(req.body.inscricao, p.uf, p.cargo);
  if (erro === 'lotado') res.status(503).json({ erro: 'Limite de aparelhos inscritos atingido' });
  else if (erro) res.status(409).json({ erro: 'Você já segue o máximo de disputas neste aparelho' });
  else {
    void obter(p.uf, p.cargo).catch(() => {}); // garante o estado de alerta atualizado
    res.status(204).end();
  }
});

app.delete('/api/notificacoes', corpoJson, (req: Request, res: Response) => {
  const p = params(req.body?.uf, req.body?.cargo, res);
  if (!p) return;
  if (typeof req.body?.endpoint === 'string') deixarDeSeguir(req.body.endpoint, p.uf, p.cargo);
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
  res.json({ disputas: typeof req.body?.endpoint === 'string' ? disputasSeguidas(req.body.endpoint) : [] });
});

app.get('/api/saude', (_req, res) => {
  res.json({ ok: true, conexoes: conexoesAbertas(), push: estatisticasPush() });
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
  if (coletando) return; // rodada anterior ainda não terminou
  coletando = true;
  // MONITORAR (sempre) + o que alguém está assistindo agora (só enquanto houver alguém)
  // e o que algum aparelho segue por notificação (o aviso precisa sair mesmo com a tela fechada)
  const pares = new Map([...config.monitorar, ...disputasAssistidas(), ...disputasComInscritos()]
    .map((p) => [p.join(':'), p] as const));
  const fila = [...pares.values()];
  const trabalhador = async () => {
    for (let par = fila.shift(); par; par = fila.shift()) {
      const [uf, cargo] = par;
      await obter(uf, cargo).catch((e: Error) => console.error(`[coleta ${uf}:${cargo}]`, e.message));
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabalhador));
  coletando = false;
}

console.log(`Monitorando ${config.monitorar.length} disputa(s): ${config.monitorar.map((p) => p.join(':')).join(', ')}`);
void coletarTudo();
const coletor = setInterval(coletarTudo, config.cacheMs);

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
