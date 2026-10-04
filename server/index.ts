import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { config, CARGOS } from './config.ts';
import { buscarResultado } from './tse.ts';
import { registrar, lerHistorico, fechar } from './historico.ts';
import { obterFoto } from './fotos.ts';
import type { ConfigPublica, Resultado } from '../shared/tipos.ts';

const app = express();
const cache = new Map<string, { expira: number; promessa: Promise<Resultado> }>();

// Cache curto + dedupe: N visitantes simultâneos geram 1 requisição ao TSE por janela.
// Toda resposta nova do TSE vai para o histórico, venha do coletor ou de um visitante.
function obter(uf: string, cargo: number): Promise<Resultado> {
  const chave = `${uf}:${cargo}`;
  const hit = cache.get(chave);
  if (hit && hit.expira > Date.now()) return hit.promessa;

  const promessa = buscarResultado(uf, cargo).then((d) => {
    try { registrar(uf, cargo, d); } catch (e) { console.error(`[histórico ${chave}]`, (e as Error).message); }
    return d;
  }).catch((err: unknown) => {
    cache.delete(chave); // não guarda erro em cache
    throw err;
  });
  cache.set(chave, { expira: Date.now() + config.cacheMs, promessa });
  return promessa;
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
    res.json(await obter(p.uf, p.cargo));
  } catch (err) {
    res.status(502).json({ erro: (err as Error).message });
  }
});

// ?por=hora (padrão): último snapshot de cada hora · ?por=todos: cada geração do TSE
app.get('/api/historico', (req: Request, res: Response) => {
  const p = params(req.query.uf, req.query.cargo, res);
  if (!p) return;
  const por = req.query.por === 'todos' ? 'todos' : 'hora';
  const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 50);
  res.json(lerHistorico(p.uf, p.cargo, { por, top }));
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
    turno: config.turno,
    // Só oferece cargos cuja eleição está configurada no .env
    cargos: Object.values(CARGOS).filter((c) => config.eleicao[c.eleicao]),
  };
  res.json(cfg);
});

app.get('/api/saude', (_req, res) => {
  res.json({ ok: true });
});

app.use(express.static(fileURLToPath(new URL('../dist/web', import.meta.url))));

// Coletor em background: registra o avanço mesmo sem visitantes.
// Poucas requisições simultâneas, para não disparar dezenas de downloads de uma vez.
let coletando = false;
async function coletarTudo() {
  if (coletando) return; // rodada anterior ainda não terminou
  coletando = true;
  const fila = [...config.monitorar];
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
    servidor.close(() => { fechar(); process.exit(0); });
    servidor.closeAllConnections();
  });
}
