import webpush, { type PushSubscription } from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db } from './banco.ts';
import { config, CARGOS, env, envNumero } from './config.ts';
import { NOMES_UF } from '../shared/ufs.ts';
import type { Candidato, EventoApuracao, Resultado } from '../shared/tipos.ts';

// Web Push: o aparelho inscreve-se em disputas e recebe avisos dos momentos que importam
// (início, marcos de apuração, troca na liderança, resultado definido), não de cada
// atualização do TSE.

const TTL_S = 30 * 60;                    // aviso velho não serve: o push service descarta após 30 min
const INTERVALO_VIRADA_MS = 15 * 60_000;  // no máximo um aviso de virada a cada 15 min por disputa
const PST_MIN_VIRADA = 5;                 // antes disso a liderança oscila demais
const MARCOS = [0, 25, 50, 75, 90, 100];  // 0 = "começou"
const CONCORRENCIA = 25;                  // envios simultâneos (cada um é uma requisição ao push service)
const MAX_DISPUTAS_POR_APARELHO = 30;
const MAX_INSCRICOES = envNumero('MAX_INSCRICOES', 50_000);

// --- Chaves VAPID: identificam este servidor nos push services. Precisam ser estáveis:
// se mudarem, todas as inscrições existentes deixam de funcionar. Ficam no volume.
function carregarVapid() {
  const publicKey = env('VAPID_PUBLICA'), privateKey = env('VAPID_PRIVADA');
  if (publicKey && privateKey) {
    return { publicKey, privateKey };
  }
  const arquivo = join(dirname(config.historicoDb), 'vapid.json');
  if (existsSync(arquivo)) return JSON.parse(readFileSync(arquivo, 'utf8')) as { publicKey: string; privateKey: string };
  const chaves = webpush.generateVAPIDKeys();
  writeFileSync(arquivo, JSON.stringify(chaves), { mode: 0o600 });
  console.log(`Chaves VAPID geradas em ${arquivo}`);
  return chaves;
}
const vapid = carregarVapid();
const contato = env('VAPID_CONTATO') ?? 'mailto:apuracao@example.com';
if (!env('VAPID_CONTATO')) console.warn('VAPID_CONTATO não definido: a Apple pode recusar pushes sem um contato real (mailto: ou https:)');
webpush.setVapidDetails(contato, vapid.publicKey, vapid.privateKey);
export const chavePublica = vapid.publicKey;

// --- Só enviamos para push services conhecidos: sem isso, qualquer um poderia cadastrar
// uma URL arbitrária e usar o servidor para disparar requisições a terceiros.
const HOSTS_PUSH = [
  /(^|\.)fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,   // Chrome, Edge, Android
  /(^|\.)push\.services\.mozilla\.com$/,                            // Firefox
  /(^|\.)push\.apple\.com$/,                                        // Safari / iOS
  /(^|\.)notify\.windows\.com$/,                                    // Edge legado / Windows
];
const HOSTS_EXTRA = (env('PUSH_HOSTS_EXTRA') ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export function inscricaoValida(x: unknown): x is PushSubscription {
  const s = x as PushSubscription | undefined;
  if (typeof s?.endpoint !== 'string' || s.endpoint.length > 1000) return false;
  if (!/^[\w-]{80,100}$/.test(s.keys?.p256dh ?? '') || !/^[\w-]{16,30}$/.test(s.keys?.auth ?? '')) return false;
  try {
    const url = new URL(s.endpoint);
    return url.protocol === 'https:' && (HOSTS_PUSH.some((re) => re.test(url.hostname)) || HOSTS_EXTRA.includes(url.host));
  } catch {
    return false;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS inscricao (
    endpoint  TEXT PRIMARY KEY,
    p256dh    TEXT    NOT NULL,
    auth      TEXT    NOT NULL,
    criada_em INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS inscricao_disputa (
    endpoint TEXT    NOT NULL REFERENCES inscricao (endpoint) ON DELETE CASCADE,
    uf       TEXT    NOT NULL,
    cargo    INTEGER NOT NULL,
    PRIMARY KEY (endpoint, uf, cargo)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS inscricao_por_disputa ON inscricao_disputa (uf, cargo);

  -- Quem assina o canal global de novidades (as "notícias" são as mesmas para todos os aparelhos)
  CREATE TABLE IF NOT EXISTS inscricao_novidades (
    endpoint TEXT PRIMARY KEY REFERENCES inscricao (endpoint) ON DELETE CASCADE
  ) WITHOUT ROWID;

  -- O que já foi avisado em cada disputa (sobrevive a restart: ninguém recebe aviso repetido)
  CREATE TABLE IF NOT EXISTS alerta_estado (
    uf            TEXT    NOT NULL,
    cargo         INTEGER NOT NULL,
    marco         INTEGER NOT NULL DEFAULT -1,
    lideres       TEXT    NOT NULL DEFAULT '',
    definido      INTEGER NOT NULL DEFAULT 0,
    ultima_virada INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (uf, cargo)
  ) WITHOUT ROWID;
`);

const sql = {
  totalInscricoes: db.prepare('SELECT count(*) AS n FROM inscricao'),
  existe: db.prepare('SELECT 1 FROM inscricao WHERE endpoint = ?'),
  salvar: db.prepare(`INSERT INTO inscricao (endpoint, p256dh, auth, criada_em) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`),
  contarDisputas: db.prepare('SELECT count(*) AS n FROM inscricao_disputa WHERE endpoint = ?'),
  seguir: db.prepare('INSERT OR IGNORE INTO inscricao_disputa (endpoint, uf, cargo) VALUES (?, ?, ?)'),
  deixar: db.prepare('DELETE FROM inscricao_disputa WHERE endpoint = ? AND uf = ? AND cargo = ?'),
  apagar: db.prepare('DELETE FROM inscricao WHERE endpoint = ?'),
  apagarSemDisputas: db.prepare('DELETE FROM inscricao WHERE endpoint = ? AND NOT EXISTS (SELECT 1 FROM inscricao_disputa WHERE endpoint = ?)'),
  apagarOrfao: db.prepare(`DELETE FROM inscricao WHERE endpoint = ?
    AND NOT EXISTS (SELECT 1 FROM inscricao_disputa WHERE endpoint = ?)
    AND NOT EXISTS (SELECT 1 FROM inscricao_novidades WHERE endpoint = ?)`),
  seguirNovidades: db.prepare('INSERT OR IGNORE INTO inscricao_novidades (endpoint) VALUES (?)'),
  deixarNovidades: db.prepare('DELETE FROM inscricao_novidades WHERE endpoint = ?'),
  segueNovidades: db.prepare('SELECT 1 FROM inscricao_novidades WHERE endpoint = ?'),
  inscritosNovidades: db.prepare('SELECT i.endpoint, i.p256dh, i.auth FROM inscricao i JOIN inscricao_novidades n USING (endpoint)'),
  disputasDe: db.prepare('SELECT uf, cargo FROM inscricao_disputa WHERE endpoint = ? ORDER BY cargo, uf'),
  inscritos: db.prepare(`SELECT i.endpoint, i.p256dh, i.auth FROM inscricao i
    JOIN inscricao_disputa d USING (endpoint) WHERE d.uf = ? AND d.cargo = ?`),
  disputasComInscritos: db.prepare('SELECT DISTINCT uf, cargo FROM inscricao_disputa'),
  estado: db.prepare('SELECT marco, lideres, definido, ultima_virada FROM alerta_estado WHERE uf = ? AND cargo = ?'),
  salvarEstado: db.prepare(`INSERT INTO alerta_estado (uf, cargo, marco, lideres, definido, ultima_virada) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (uf, cargo) DO UPDATE SET marco = excluded.marco, lideres = excluded.lideres,
      definido = excluded.definido, ultima_virada = excluded.ultima_virada`),
};

export type ErroInscricao = 'lotado' | 'muitas-disputas';

export function seguir(s: PushSubscription, uf: string, cargo: number): ErroInscricao | null {
  const nova = !sql.existe.get(s.endpoint);
  if (nova && (sql.totalInscricoes.get() as { n: number }).n >= MAX_INSCRICOES) return 'lotado';
  if (!nova && (sql.contarDisputas.get(s.endpoint) as { n: number }).n >= MAX_DISPUTAS_POR_APARELHO) return 'muitas-disputas';
  sql.salvar.run(s.endpoint, s.keys.p256dh, s.keys.auth, Date.now());
  sql.seguir.run(s.endpoint, uf, cargo);
  return null;
}

export function deixarDeSeguir(endpoint: string, uf: string, cargo: number) {
  sql.deixar.run(endpoint, uf, cargo);
  sql.apagarOrfao.run(endpoint, endpoint, endpoint); // sem disputa nem novidade, a inscrição não serve para nada
}

// --- Canal global de novidades (as mesmas para todos os aparelhos) ---
export function seguirNovidades(s: PushSubscription): ErroInscricao | null {
  const nova = !sql.existe.get(s.endpoint);
  if (nova && (sql.totalInscricoes.get() as { n: number }).n >= MAX_INSCRICOES) return 'lotado';
  sql.salvar.run(s.endpoint, s.keys.p256dh, s.keys.auth, Date.now());
  sql.seguirNovidades.run(s.endpoint);
  return null;
}

export function deixarNovidades(endpoint: string) {
  sql.deixarNovidades.run(endpoint);
  sql.apagarOrfao.run(endpoint, endpoint, endpoint);
}

export const segueNovidades = (endpoint: string) => !!sql.segueNovidades.get(endpoint);

// Navegador trocou a inscrição: as disputas seguidas passam para a nova
const transferir = db.prepare('UPDATE OR IGNORE inscricao_disputa SET endpoint = ? WHERE endpoint = ?');
export function renovar(antigo: string, nova: PushSubscription) {
  db.exec('BEGIN');
  try {
    sql.salvar.run(nova.endpoint, nova.keys.p256dh, nova.keys.auth, Date.now());
    transferir.run(nova.endpoint, antigo);
    if (antigo !== nova.endpoint) sql.apagar.run(antigo);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const disputasSeguidas = (endpoint: string) =>
  (sql.disputasDe.all(endpoint) as { uf: string; cargo: number }[]).map((d) => `${d.uf}:${d.cargo}`);

export const disputasComInscritos = (): [string, number][] =>
  (sql.disputasComInscritos.all() as { uf: string; cargo: number }[]).map((d) => [d.uf, d.cargo]);

// --- Detecção: compara o resultado novo com o que já foi avisado
interface Estado { marco: number; lideres: string; definido: number; ultima_virada: number }
export interface Aviso { titulo: string; corpo: string; url: string; tag: string; urgente: boolean }
// O que a detecção encontrou, granular (a linha do tempo de novidades.ts filtra e redige à parte).
// O push continua juntando tudo num aviso só, exatamente como antes.
export type Deteccao =
  | { tipo: 'marco'; marco: number } // 0 = começou
  | { tipo: 'virada'; entrou: Candidato }
  | { tipo: 'definido'; eleitos: Candidato[]; segundoTurno: Candidato[] };

const pctBR = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
// "ANDRE DO PRADO" -> "Andre do Prado": iniciais maiúsculas, partículas (da, de, do, dos, das, e) minúsculas
export const nomeProprio = (s: string) => s.toLowerCase()
  .replace(/(^|\s)(\p{L})/gu, (_m, esp: string, l: string) => esp + l.toUpperCase())
  .replace(/(?<=\s)(Da|De|Do|Das|Dos|E)(?=\s)/g, (p) => p.toLowerCase());

export function avaliar(d: Resultado): { aviso: Aviso | null; deteccoes: Deteccao[] } {
  const { uf, cargo } = d;
  const cfg = CARGOS[cargo]!;
  const antes = (sql.estado.get(uf, cargo) as Estado | undefined) ?? { marco: -1, lideres: '', definido: 0, ultima_virada: 0 };
  const est = { ...antes };
  const cand = d.candidatos;
  const linhas: string[] = [];
  const deteccoes: Deteccao[] = [];
  let urgente = false;

  // Resultado definido: TSE marcou eleitos ou 2º turno
  const eleitos = cand.filter((c) => c.eleito);
  const segundo = cand.filter((c) => /2º turno/i.test(c.situacao));
  if (!est.definido && (eleitos.length || segundo.length)) {
    est.definido = 1;
    urgente = true;
    deteccoes.push({ tipo: 'definido', eleitos, segundoTurno: segundo });
    if (segundo.length >= 2) linhas.push(`Vai ter 2º turno: ${segundo.map((c) => nomeProprio(c.nome)).join(' e ')}.`);
    else if (cfg.proporcional) linhas.push(`${eleitos.length} eleitos já definidos.`);
    else linhas.push(`${eleitos.map((c) => nomeProprio(c.nome)).join(' e ')} ${eleitos.length > 1 ? 'eleitos' : 'eleito'}.`);
  }

  // Troca na liderança (cargos majoritários): quem ocupa as `vagas` primeiras posições
  const topo = cand.slice(0, d.vagas);
  const lideres = topo.map((c) => c.numero).sort().join(',');
  if (!cfg.proporcional && d.secoesTotalizadas > 0) {
    if (!est.lideres) est.lideres = lideres;
    else if (lideres !== est.lideres && !est.definido && d.secoesTotalizadas >= PST_MIN_VIRADA
      && Date.now() - est.ultima_virada >= INTERVALO_VIRADA_MS) {
      const anteriores = new Set(est.lideres.split(','));
      const entrou = topo.find((c) => !anteriores.has(c.numero));
      if (entrou) {
        deteccoes.push({ tipo: 'virada', entrou });
        linhas.push(d.vagas === 1
          ? `Virada: ${nomeProprio(entrou.nome)} passou à frente.`
          : `${nomeProprio(entrou.nome)} entrou entre os ${d.vagas} primeiros.`);
      }
      est.lideres = lideres;
      est.ultima_virada = Date.now();
    }
  }

  // Marco da totalização: só o maior atingido (um salto de 20% para 55% avisa só os 50%)
  const marco = Math.max(-1, ...MARCOS.filter((m) => (m === 0 ? d.secoesTotalizadas > 0 : d.secoesTotalizadas >= m)));
  if (marco > est.marco) {
    est.marco = marco;
    deteccoes.push({ tipo: 'marco', marco });
    if (!linhas.length) {
      linhas.push(marco === 0 ? 'A totalização começou.' : marco === 100 ? 'Totalização concluída.' : `${marco}% das seções totalizadas.`);
    }
  }

  if (JSON.stringify(est) !== JSON.stringify(antes)) {
    sql.salvarEstado.run(uf, cargo, est.marco, est.lideres, est.definido, est.ultima_virada);
  }
  if (!linhas.length) return { aviso: null, deteccoes };

  const placar = cand.slice(0, 3).filter((c) => c.votos > 0)
    .map((c) => `${nomeProprio(c.nome)} ${pctBR(c.percentual)}`).join(', ');
  const aviso: Aviso = {
    titulo: `${cfg.nome}, ${NOMES_UF[uf] ?? uf.toUpperCase()}`,
    corpo: [...linhas, placar && `${placar} (${pctBR(d.secoesTotalizadas)} totalizado)`].filter(Boolean).join('\n'),
    url: `/?cargo=${cargo}&uf=${uf}`,
    tag: `apuracao-${uf}-${cargo}`, // no aparelho, o aviso novo da disputa substitui o anterior
    urgente,
  };
  return { aviso, deteccoes };
}

// --- Envio: fila com concorrência limitada; inscrições mortas (404/410) são apagadas
type Envio = { inscricao: PushSubscription; payload: string; topico: string; urgente: boolean };
const fila: Envio[] = [];
let ativos = 0;
const contadores = { enviados: 0, falhas: 0, expirados: 0 };

function bombear() {
  while (ativos < CONCORRENCIA && fila.length) {
    const e = fila.shift()!;
    ativos++;
    webpush.sendNotification(e.inscricao, e.payload, {
      TTL: TTL_S,
      urgency: e.urgente ? 'high' : 'normal',
      topic: e.topico, // aviso da mesma disputa ainda não entregue é substituído pelo novo
      timeout: 10_000,
    })
      .then(() => { contadores.enviados++; })
      .catch((err: { statusCode?: number; body?: string; message?: string }) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          contadores.expirados++;
          sql.apagar.run(e.inscricao.endpoint);
        } else {
          contadores.falhas++;
          console.error(`[push] ${err.statusCode ?? ''} ${err.body ?? err.message ?? err}`.trim());
        }
      })
      .finally(() => { ativos--; bombear(); });
  }
}

export function enviar(uf: string, cargo: number, aviso: Aviso) {
  const inscritos = sql.inscritos.all(uf, cargo) as { endpoint: string; p256dh: string; auth: string }[];
  if (!inscritos.length) return 0;
  const { urgente, ...conteudo } = aviso;
  const payload = JSON.stringify(conteudo);
  for (const i of inscritos) {
    fila.push({ inscricao: { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload, topico: `${uf}${cargo}`, urgente });
  }
  bombear();
  return inscritos.length;
}

// Notícia nova na linha do tempo: avisa quem assina o canal global de novidades.
// tag fixa: a novidade nova substitui a anterior no aparelho (sem virar pilha de spam).
export function enviarNovidades(ev: EventoApuracao) {
  const inscritos = sql.inscritosNovidades.all() as { endpoint: string; p256dh: string; auth: string }[];
  if (!inscritos.length) return 0;
  const payload = JSON.stringify({ titulo: 'Novidades', corpo: ev.texto, url: '/?aba=novidades', tag: 'novidades' });
  for (const i of inscritos) {
    fila.push({ inscricao: { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload, topico: 'novidades', urgente: false });
  }
  bombear();
  return inscritos.length;
}

export const estatisticasPush = () => ({
  inscricoes: (sql.totalInscricoes.get() as { n: number }).n,
  naFila: fila.length + ativos,
  ...contadores,
});
