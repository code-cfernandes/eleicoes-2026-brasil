import { db } from './banco.ts';
import type { PontoHistorico, RespostaHistorico, Resultado } from '../shared/tipos.ts';

// Um snapshot por geração do TSE (dg+hg); votos de cada candidato naquele instante.
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshot (
    id          INTEGER PRIMARY KEY,
    uf          TEXT    NOT NULL,
    cargo       INTEGER NOT NULL,
    tse_em      TEXT    NOT NULL,  -- "dd/mm/aaaa hh:mm:ss" como veio do TSE (horário de Brasília)
    instante    INTEGER NOT NULL,  -- mesmo horário em epoch ms
    coletado_em INTEGER NOT NULL,
    pst         REAL    NOT NULL,  -- % de seções totalizadas
    UNIQUE (uf, cargo, tse_em)
  );
  CREATE INDEX IF NOT EXISTS snapshot_disputa ON snapshot (uf, cargo, instante);

  CREATE TABLE IF NOT EXISTS voto (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot (id) ON DELETE CASCADE,
    numero      TEXT    NOT NULL,
    nome        TEXT    NOT NULL,
    votos       INTEGER NOT NULL,
    percentual  REAL    NOT NULL,
    PRIMARY KEY (snapshot_id, numero)
  ) WITHOUT ROWID;
`);

// Migração aditiva e idempotente (o banco de produção já existe): colunas novas são NULLABLE,
// snapshots antigos ficam com NULL. votos_totais (v.tv do TSE) alimenta o evento "ritmo".
const colunasSnapshot = new Set((db.prepare('PRAGMA table_info(snapshot)').all() as { name: string }[]).map((c) => c.name));
for (const [coluna, tipo] of [['votos_totais', 'INTEGER'], ['validos', 'INTEGER']] as const) {
  if (!colunasSnapshot.has(coluna)) db.exec(`ALTER TABLE snapshot ADD COLUMN ${coluna} ${tipo}`);
}

const inserirSnapshot = db.prepare(`
  INSERT OR IGNORE INTO snapshot (uf, cargo, tse_em, instante, coletado_em, pst, votos_totais, validos)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const inserirVoto = db.prepare(
  'INSERT INTO voto (snapshot_id, numero, nome, votos, percentual) VALUES (?, ?, ?, ?, ?)');

// Grava o resultado se for uma geração nova do TSE (UNIQUE descarta repetidos).
export function registrar(uf: string, cargo: number, d: Resultado): boolean {
  if (!d.instante) return false;
  db.exec('BEGIN');
  try {
    const r = inserirSnapshot.run(uf, cargo, d.atualizadoEm, d.instante, Date.now(), d.secoesTotalizadas,
      d.totais?.votosTotais ?? null, d.totais?.validos ?? null);
    if (r.changes) {
      for (const c of d.candidatos) inserirVoto.run(r.lastInsertRowid, c.numero, c.nome, c.votos, c.percentual);
    }
    db.exec('COMMIT');
    return r.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Votos totais do snapshot mais recente com instante <= `ate` (base do evento "ritmo")
const totaisAte = db.prepare(`
  SELECT instante, votos_totais AS votos FROM snapshot
  WHERE uf = ? AND cargo = ? AND instante <= ? AND votos_totais IS NOT NULL
  ORDER BY instante DESC LIMIT 1`);
export const votosTotaisAte = (uf: string, cargo: number, ate: number) =>
  totaisAte.get(uf, cargo, ate) as { instante: number; votos: number } | undefined;

// Resumo do estado atual de uma disputa (base dos balanços periódicos em novidades.ts)
export interface ResumoAtual {
  instante: number;
  pst: number;
  votosTotais: number | null;
  top: { numero: string; nome: string; votos: number; percentual: number }[];
}
const snapshotResumo = db.prepare('SELECT instante, pst, votos_totais AS votosTotais FROM snapshot WHERE id = ?');
const votosTop = db.prepare('SELECT numero, nome, votos, percentual FROM voto WHERE snapshot_id = ? ORDER BY votos DESC LIMIT 2');

export function resumoAtual(uf: string, cargo: number): ResumoAtual | null {
  const ultimo = maisRecente.get(uf, cargo) as { id: number } | undefined;
  if (!ultimo) return null;
  const s = snapshotResumo.get(ultimo.id) as { instante: number; pst: number; votosTotais: number | null } | undefined;
  if (!s) return null;
  const top = votosTop.all(ultimo.id) as ResumoAtual['top'];
  return { ...s, top };
}

// Hora "cheia" de Brasília (UTC-3, sem horário de verão) de cada snapshot.
const HORA = '((instante / 1000 - 10800) / 3600)';

const snapshots = db.prepare(`
  SELECT id, tse_em AS em, instante, pst, ${HORA} * 3600000 + 10800000 AS hora
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY ${HORA} ORDER BY instante DESC) AS ultimo_da_hora
    FROM snapshot
    WHERE uf = :uf AND cargo = :cargo AND pst > 0
  )
  WHERE (:todos OR ultimo_da_hora = 1) AND instante > :desde
  ORDER BY instante`);

const maisRecente = db.prepare(
  'SELECT id FROM snapshot WHERE uf = ? AND cargo = ? AND pst > 0 ORDER BY instante DESC LIMIT 1');

const votos = db.prepare(`
  SELECT snapshot_id, numero, nome, votos, percentual FROM voto
  WHERE snapshot_id IN (SELECT value FROM json_each(:ids))
    AND numero IN (SELECT value FROM json_each(:numeros))
  ORDER BY votos DESC`);

const topDoSnapshot = db.prepare(
  'SELECT numero FROM voto WHERE snapshot_id = ? ORDER BY votos DESC LIMIT ?');

// Evolução da disputa. por='hora' devolve o último snapshot de cada hora;
// por='todos' devolve cada geração do TSE. Só os `top` candidatos do snapshot
// mais recente vêm junto (deputados têm milhares de candidatos).
// Com `desde` (instante do último ponto que o cliente já tem) vêm só os pontos novos;
// no modo hora, o ponto da hora corrente volta sempre que é substituído por um mais novo.
type LinhaSnapshot = Omit<PontoHistorico, 'cand'> & { id: number };
type LinhaVoto = PontoHistorico['cand'][number] & { snapshot_id: number };

export function lerHistorico(
  uf: string, cargo: number,
  { por = 'hora', top = 10, desde = 0, so }: { por?: 'hora' | 'todos'; top?: number; desde?: number; so?: string[] } = {},
): RespostaHistorico {
  const ultimo = maisRecente.get(uf, cargo) as { id: number } | undefined;
  if (!ultimo) return { numeros: [], pontos: [] };

  // `so`: candidatos específicos (o cliente pede o passado de quem acabou de entrar no top)
  const numeros = so ?? (topDoSnapshot.all(ultimo.id, top) as { numero: string }[]).map((r) => r.numero);
  const pontos = snapshots.all({ uf, cargo, todos: por === 'todos' ? 1 : 0, desde }) as LinhaSnapshot[];
  if (!pontos.length) return { numeros, pontos: [] };

  const linhas = votos.all({ ids: JSON.stringify(pontos.map((p) => p.id)), numeros: JSON.stringify(numeros) }) as LinhaVoto[];
  const porSnapshot = Map.groupBy(linhas, (v) => v.snapshot_id);

  return {
    numeros,
    pontos: pontos.map(({ id, ...p }) => ({
      ...p,
      cand: (porSnapshot.get(id) ?? []).map(({ snapshot_id, ...c }) => c),
    })),
  };
}

