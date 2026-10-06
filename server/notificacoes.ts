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

// Avisos de disputa: urgência alta (o Android em repouso e o Chrome em segundo plano seguram as
// mensagens "normais" e elas venciam antes de chegar) e validade de 1h; o aviso novo da mesma
// disputa substitui o anterior (topic/tag), então não chega pilha de avisos velhos.
const TTL_DISPUTA_S = 60 * 60;
const TTL_NOVIDADES_S = 30 * 60;          // novidades são frequentes: urgência normal, validade curta
const TTL_TESTE_S = 5 * 60;
const INTERVALO_VIRADA_MS = 15 * 60_000;  // no máximo um aviso de virada a cada 15 min por disputa
const PST_MIN_VIRADA = 5;                 // antes disso a liderança oscila demais
const INTERVALO_TESTE_MS = 20_000;        // botão "testar notificação": no máximo 1 a cada 20s por aparelho
// Marcos de % de seções totalizadas (0 = "começou"). No 2º turno, com só dois candidatos, a
// apuração é rápida e a reta final pesa mais: marcos mais finos (10% e 95%).
const MARCOS_POR_TURNO: Record<number, number[]> = {
  1: [0, 25, 50, 75, 90, 100],
  2: [0, 10, 25, 50, 75, 90, 95, 100],
};
export const marcosDoTurno = (turno: number) => MARCOS_POR_TURNO[turno] ?? MARCOS_POR_TURNO[1]!;
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
// Contato exigido pelos push services: "mailto:..." ou "https://...". Um e-mail puro (o jeito
// natural de preencher) vira mailto: sozinho. Valor inválido não pode derrubar o site: o
// web-push lança exceção na subida, e o container entrava em loop de reinício.
const CONTATO_PADRAO = 'mailto:apuracao@example.com';
function contatoVapid(): string {
  const bruto = env('VAPID_CONTATO');
  if (!bruto) {
    console.warn('VAPID_CONTATO não definido: a Apple pode recusar pushes sem um contato real (mailto: ou https:)');
    return CONTATO_PADRAO;
  }
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(bruto)) return `mailto:${bruto}`;
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(bruto) || /^https:\/\/\S+$/.test(bruto)) return bruto;
  console.error(`VAPID_CONTATO inválido ("${bruto}"): use um e-mail ou https://... Usando o contato padrão.`);
  return CONTATO_PADRAO;
}
try {
  webpush.setVapidDetails(contatoVapid(), vapid.publicKey, vapid.privateKey);
} catch (e) {
  // Ex.: VAPID_PUBLICA/VAPID_PRIVADA mal copiadas. O site segue no ar; só o push fica fora.
  console.error(`[push] desativado: configuração VAPID inválida (${(e as Error).message})`);
}
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
    turno         INTEGER NOT NULL DEFAULT 1,
    uf            TEXT    NOT NULL,
    cargo         INTEGER NOT NULL,
    marco         INTEGER NOT NULL DEFAULT -1,
    lideres       TEXT    NOT NULL DEFAULT '',
    definido      INTEGER NOT NULL DEFAULT 0,
    ultima_virada INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (turno, uf, cargo)
  ) WITHOUT ROWID;
`);

// Migração: alerta_estado antigo (sem turno, PK uf+cargo) vira o estado do 1º turno.
// A chave primária muda, então a tabela é recriada (idempotente: só roda sem a coluna).
// As inscrições (inscricao_disputa) seguem sem turno: quem segue Presidente/BR no 1º turno
// passa a receber os avisos do 2º, e os avisos só saem do turno atual.
if (!(db.prepare('PRAGMA table_info(alerta_estado)').all() as { name: string }[]).some((c) => c.name === 'turno')) {
  db.exec(`
    BEGIN;
    CREATE TABLE alerta_estado_turno (
      turno         INTEGER NOT NULL DEFAULT 1,
      uf            TEXT    NOT NULL,
      cargo         INTEGER NOT NULL,
      marco         INTEGER NOT NULL DEFAULT -1,
      lideres       TEXT    NOT NULL DEFAULT '',
      definido      INTEGER NOT NULL DEFAULT 0,
      ultima_virada INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (turno, uf, cargo)
    ) WITHOUT ROWID;
    INSERT INTO alerta_estado_turno (turno, uf, cargo, marco, lideres, definido, ultima_virada)
      SELECT 1, uf, cargo, marco, lideres, definido, ultima_virada FROM alerta_estado;
    DROP TABLE alerta_estado;
    ALTER TABLE alerta_estado_turno RENAME TO alerta_estado;
    COMMIT;
  `);
}

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
  porEndpoint: db.prepare('SELECT endpoint, p256dh, auth FROM inscricao WHERE endpoint = ?'),
  inscritos: db.prepare(`SELECT i.endpoint, i.p256dh, i.auth FROM inscricao i
    JOIN inscricao_disputa d USING (endpoint) WHERE d.uf = ? AND d.cargo = ?`),
  disputasComInscritos: db.prepare('SELECT DISTINCT uf, cargo FROM inscricao_disputa'),
  estado: db.prepare('SELECT marco, lideres, definido, ultima_virada FROM alerta_estado WHERE turno = ? AND uf = ? AND cargo = ?'),
  salvarEstado: db.prepare(`INSERT INTO alerta_estado (turno, uf, cargo, marco, lideres, definido, ultima_virada) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (turno, uf, cargo) DO UPDATE SET marco = excluded.marco, lideres = excluded.lideres,
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

// Navegador trocou a inscrição: as disputas seguidas e o canal de novidades passam para a nova
const transferir = db.prepare('UPDATE OR IGNORE inscricao_disputa SET endpoint = ? WHERE endpoint = ?');
const transferirNovidades = db.prepare('UPDATE OR IGNORE inscricao_novidades SET endpoint = ? WHERE endpoint = ?');
export function renovar(antigo: string, nova: PushSubscription) {
  db.exec('BEGIN');
  try {
    sql.salvar.run(nova.endpoint, nova.keys.p256dh, nova.keys.auth, Date.now());
    transferir.run(nova.endpoint, antigo);
    transferirNovidades.run(nova.endpoint, antigo);
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
  const { turno, uf, cargo } = d;
  const cfg = CARGOS[cargo]!;
  const antes = (sql.estado.get(turno, uf, cargo) as Estado | undefined) ?? { marco: -1, lideres: '', definido: 0, ultima_virada: 0 };
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
  const marco = Math.max(-1, ...marcosDoTurno(turno).filter((m) => (m === 0 ? d.secoesTotalizadas > 0 : d.secoesTotalizadas >= m)));
  if (marco > est.marco) {
    est.marco = marco;
    deteccoes.push({ tipo: 'marco', marco });
    if (!linhas.length) {
      linhas.push(marco === 0 ? 'A totalização começou.' : marco === 100 ? 'Totalização concluída.' : `${marco}% das seções totalizadas.`);
    }
  }

  if (JSON.stringify(est) !== JSON.stringify(antes)) {
    sql.salvarEstado.run(turno, uf, cargo, est.marco, est.lideres, est.definido, est.ultima_virada);
  }
  if (!linhas.length) return { aviso: null, deteccoes };

  const placar = cand.slice(0, 3).filter((c) => c.votos > 0)
    .map((c) => `${nomeProprio(c.nome)} ${pctBR(c.percentual)}`).join(', ');
  const aviso: Aviso = {
    titulo: `${cfg.nome}, ${NOMES_UF[uf] ?? uf.toUpperCase()}${turno > 1 ? ` (${turno}º turno)` : ''}`,
    corpo: [...linhas, placar && `${placar} (${pctBR(d.secoesTotalizadas)} totalizado)`].filter(Boolean).join('\n'),
    url: `/?cargo=${cargo}&uf=${uf}&turno=${turno}`,
    tag: `apuracao-${uf}-${cargo}`, // no aparelho, o aviso novo da disputa substitui o anterior
    urgente,
  };
  return { aviso, deteccoes };
}

// --- Envio: fila com concorrência limitada; inscrições mortas (404/410) são apagadas
type Envio = { inscricao: PushSubscription; payload: string; topico: string; urgente: boolean; ttl: number };
const fila: Envio[] = [];
let ativos = 0;
const contadores = { enviados: 0, falhas: 0, expirados: 0 };

// Diagnóstico por serviço de push (GET /api/saude): onde os envios falham e com qual erro.
// O corpo do erro do push service traz só o motivo (ex.: {"reason":"BadJwtToken"} da Apple).
type Servico = 'apple' | 'google' | 'mozilla' | 'microsoft' | 'outro';
interface ContagemServico { enviados: number; falhas: number; expirados: number; ultimoErro?: { status: number | null; motivo: string; em: number } }
const porServico = new Map<Servico, ContagemServico>();
function servico(endpoint: string): Servico {
  const host = (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
  if (host.endsWith('push.apple.com')) return 'apple';
  if (host.endsWith('googleapis.com')) return 'google';
  if (host.endsWith('mozilla.com')) return 'mozilla';
  if (host.endsWith('notify.windows.com')) return 'microsoft';
  return 'outro';
}
function contar(endpoint: string, tipo: 'enviados' | 'falhas' | 'expirados', erro?: ErroPush) {
  const s = servico(endpoint);
  const c = porServico.get(s) ?? { enviados: 0, falhas: 0, expirados: 0 };
  c[tipo]++;
  contadores[tipo]++;
  if (erro) c.ultimoErro = { status: erro.statusCode ?? null, motivo: String(erro.body || erro.message || '').trim().slice(0, 160), em: Date.now() };
  porServico.set(s, c);
}
type ErroPush = { statusCode?: number; body?: string; message?: string };

function bombear() {
  while (ativos < CONCORRENCIA && fila.length) {
    const e = fila.shift()!;
    ativos++;
    webpush.sendNotification(e.inscricao, e.payload, {
      TTL: e.ttl,
      urgency: e.urgente ? 'high' : 'normal',
      topic: e.topico, // aviso da mesma disputa ainda não entregue é substituído pelo novo
      timeout: 10_000,
    })
      .then(() => { contar(e.inscricao.endpoint, 'enviados'); })
      .catch((err: ErroPush) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          contar(e.inscricao.endpoint, 'expirados');
          sql.apagar.run(e.inscricao.endpoint);
        } else {
          contar(e.inscricao.endpoint, 'falhas', err);
          console.error(`[push ${servico(e.inscricao.endpoint)}] ${err.statusCode ?? ''} ${err.body ?? err.message ?? err}`.trim());
        }
      })
      .finally(() => { ativos--; bombear(); });
  }
}

export function enviar(uf: string, cargo: number, aviso: Aviso) {
  const inscritos = sql.inscritos.all(uf, cargo) as { endpoint: string; p256dh: string; auth: string }[];
  if (!inscritos.length) return 0;
  const { urgente: _urgente, ...conteudo } = aviso;
  const payload = JSON.stringify(conteudo);
  for (const i of inscritos) {
    // Todo aviso de disputa é alta prioridade (ver TTL_DISPUTA_S); `urgente` fica só como informação
    fila.push({ inscricao: { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload, topico: `${uf}${cargo}`, urgente: true, ttl: TTL_DISPUTA_S });
  }
  bombear();
  return inscritos.length;
}

// Notícia nova na linha do tempo: avisa quem assina o canal global de novidades.
// tag fixa: a novidade nova substitui a anterior no aparelho (sem virar pilha de spam).
export function enviarNovidades(ev: EventoApuracao) {
  const inscritos = sql.inscritosNovidades.all() as { endpoint: string; p256dh: string; auth: string }[];
  if (!inscritos.length) return 0;
  const payload = JSON.stringify({ titulo: 'Novidades', corpo: ev.texto, url: `/?aba=novidades&turno=${ev.turno}`, tag: 'novidades' });
  for (const i of inscritos) {
    fila.push({ inscricao: { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload, topico: 'novidades', urgente: false, ttl: TTL_NOVIDADES_S });
  }
  bombear();
  return inscritos.length;
}

// Botão "testar notificação": envia na hora (fora da fila) só para este aparelho e devolve o que o
// push service respondeu, para a tela dizer se o problema é no envio ou no aparelho.
// Só aparelhos já inscritos: o servidor nunca dispara para uma URL qualquer.
const ultimosTestes = new Map<string, number>();
export type ResultadoTeste =
  | { ok: true; servico: Servico }
  | { ok: false; servico: Servico; status: number | null; motivo: string }
  | 'desconhecido' | 'aguarde';

export async function enviarTeste(endpoint: string): Promise<ResultadoTeste> {
  const i = sql.porEndpoint.get(endpoint) as { endpoint: string; p256dh: string; auth: string } | undefined;
  if (!i) return 'desconhecido';
  const agora = Date.now();
  if (agora - (ultimosTestes.get(endpoint) ?? 0) < INTERVALO_TESTE_MS) return 'aguarde';
  if (ultimosTestes.size > 10_000) ultimosTestes.clear();
  ultimosTestes.set(endpoint, agora);
  const payload = JSON.stringify({
    titulo: 'Teste de notificação',
    corpo: 'Tudo certo: este aparelho recebe os avisos da apuração.',
    url: '/',
    tag: 'teste',
  });
  try {
    await webpush.sendNotification({ endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload,
      { TTL: TTL_TESTE_S, urgency: 'high', timeout: 10_000 });
    contar(endpoint, 'enviados');
    return { ok: true, servico: servico(endpoint) };
  } catch (e) {
    const err = e as ErroPush;
    const expirada = err.statusCode === 404 || err.statusCode === 410;
    contar(endpoint, expirada ? 'expirados' : 'falhas', err);
    if (expirada) sql.apagar.run(endpoint);
    return { ok: false, servico: servico(endpoint), status: err.statusCode ?? null, motivo: String(err.body || err.message || '').trim().slice(0, 160) };
  }
}

export const estatisticasPush = () => ({
  inscricoes: (sql.totalInscricoes.get() as { n: number }).n,
  naFila: fila.length + ativos,
  ...contadores,
  porServico: Object.fromEntries(porServico),
});
