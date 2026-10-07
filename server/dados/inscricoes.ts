import { db, transacao } from './banco.ts';

// Aparelhos inscritos em notificações push: as disputas que cada um segue e quem assina o canal
// global de novidades. O endpoint da inscrição identifica o aparelho.

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
`);

/** Inscrição de push gravada (o formato que o web-push precisa vem de `chavesDe`) */
export interface InscricaoGravada { endpoint: string; p256dh: string; auth: string }

const sql = {
  total: db.prepare('SELECT count(*) AS n FROM inscricao'),
  existe: db.prepare('SELECT 1 FROM inscricao WHERE endpoint = ?'),
  salvar: db.prepare(`INSERT INTO inscricao (endpoint, p256dh, auth, criada_em) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`),
  contarDisputas: db.prepare('SELECT count(*) AS n FROM inscricao_disputa WHERE endpoint = ?'),
  seguir: db.prepare('INSERT OR IGNORE INTO inscricao_disputa (endpoint, uf, cargo) VALUES (?, ?, ?)'),
  deixar: db.prepare('DELETE FROM inscricao_disputa WHERE endpoint = ? AND uf = ? AND cargo = ?'),
  apagar: db.prepare('DELETE FROM inscricao WHERE endpoint = ?'),
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
  transferir: db.prepare('UPDATE OR IGNORE inscricao_disputa SET endpoint = ? WHERE endpoint = ?'),
  transferirNovidades: db.prepare('UPDATE OR IGNORE inscricao_novidades SET endpoint = ? WHERE endpoint = ?'),
};

export const totalDeInscricoes = () => (sql.total.get() as { n: number }).n;
export const inscricaoExiste = (endpoint: string) => !!sql.existe.get(endpoint);
export const disputasDoAparelho = (endpoint: string) => (sql.contarDisputas.get(endpoint) as { n: number }).n;

export const salvarInscricao = (i: InscricaoGravada) => sql.salvar.run(i.endpoint, i.p256dh, i.auth, Date.now());
export const gravarDisputaSeguida = (endpoint: string, uf: string, cargo: number) => sql.seguir.run(endpoint, uf, cargo);
export const apagarDisputaSeguida = (endpoint: string, uf: string, cargo: number) => sql.deixar.run(endpoint, uf, cargo);
export const apagarInscricao = (endpoint: string) => sql.apagar.run(endpoint);
// Sem disputa nem novidade, a inscrição não serve para nada
export const apagarSeOrfa = (endpoint: string) => sql.apagarOrfao.run(endpoint, endpoint, endpoint);

export const gravarAssinaturaNovidades = (endpoint: string) => sql.seguirNovidades.run(endpoint);
export const apagarAssinaturaNovidades = (endpoint: string) => sql.deixarNovidades.run(endpoint);
export const assinaNovidades = (endpoint: string) => !!sql.segueNovidades.get(endpoint);

export const inscritosNaDisputa = (uf: string, cargo: number) => sql.inscritos.all(uf, cargo) as unknown as InscricaoGravada[];
export const inscritosEmNovidades = () => sql.inscritosNovidades.all() as unknown as InscricaoGravada[];

export const disputasSeguidasPor = (endpoint: string) => sql.disputasDe.all(endpoint) as { uf: string; cargo: number }[];
export const disputasComInscritos = () => sql.disputasComInscritos.all() as { uf: string; cargo: number }[];

// Navegador trocou a inscrição: as disputas seguidas e o canal de novidades passam para a nova
export function transferirInscricao(antigo: string, nova: InscricaoGravada) {
  transacao(() => {
    salvarInscricao(nova);
    sql.transferir.run(nova.endpoint, antigo);
    sql.transferirNovidades.run(nova.endpoint, antigo);
    if (antigo !== nova.endpoint) apagarInscricao(antigo);
  });
}
