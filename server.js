import express from 'express';
import { config, CARGOS } from './config.js';
import { buscarResultado } from './tse.js';
import { registrar, lerHistorico, fechar } from './historico.js';

const app = express();
const cache = new Map(); // chave -> { expira, promessa }

// Cache curto + dedupe: N visitantes simultâneos geram 1 requisição ao TSE por janela.
// Toda resposta nova do TSE vai para o histórico, venha do coletor ou de um visitante.
function obter(uf, cargo) {
  const chave = `${uf}:${cargo}`;
  const hit = cache.get(chave);
  if (hit && hit.expira > Date.now()) return hit.promessa;

  const promessa = buscarResultado(uf, cargo).then((d) => {
    try { registrar(uf, cargo, d); } catch (e) { console.error(`[histórico ${chave}]`, e.message); }
    return d;
  }).catch((err) => {
    cache.delete(chave); // não guarda erro em cache
    throw err;
  });
  cache.set(chave, { expira: Date.now() + config.cacheMs, promessa });
  return promessa;
}

// Validação compartilhada pelas rotas
function params(req, res) {
  const uf = String(req.query.uf ?? 'br').toLowerCase();
  const cargo = Number(req.query.cargo ?? 1);
  if (!/^[a-z]{2}$/.test(uf) || !CARGOS[cargo]) {
    res.status(400).json({ erro: 'uf ou cargo inválido' });
    return null;
  }
  return { uf, cargo };
}

app.get('/api/resultado', async (req, res) => {
  const p = params(req, res);
  if (!p) return;
  try {
    res.json({ cargo: CARGOS[p.cargo].nome, uf: p.uf, ...(await obter(p.uf, p.cargo)) });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// ?por=hora (padrão): último snapshot de cada hora · ?por=todos: cada geração do TSE
app.get('/api/historico', (req, res) => {
  const p = params(req, res);
  if (!p) return;
  const por = req.query.por === 'todos' ? 'todos' : 'hora';
  const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 50);
  res.json(lerHistorico(p.uf, p.cargo, { por, top }));
});

app.get('/api/saude', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (_req, res) => res.json({ intervaloMs: config.cacheMs, cargos: CARGOS }));
app.use(express.static('public'));

// Coletor em background: registra o avanço mesmo sem visitantes
const coletarTudo = () =>
  config.monitorar.forEach(([uf, cargo]) =>
    obter(uf, cargo).catch((e) => console.error(`[coleta ${uf}:${cargo}]`, e.message)));

coletarTudo();
const coletor = setInterval(coletarTudo, config.cacheMs);

const servidor = app.listen(config.port, () => console.log(`http://localhost:${config.port}`));

// docker stop manda SIGTERM: fecha o SQLite limpo (checkpoint do WAL)
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    clearInterval(coletor);
    servidor.close(() => { fechar(); process.exit(0); });
  });
}
