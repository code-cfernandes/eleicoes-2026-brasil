import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import type { PontoHistorico, Resultado } from '../shared/tipos.ts';

mkdirSync(dirname(config.historicoDb), { recursive: true });
const db = new DatabaseSync(config.historicoDb);

// Um snapshot por geração do TSE (dg+hg); votos de cada candidato naquele instante.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

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

const inserirSnapshot = db.prepare(`
  INSERT OR IGNORE INTO snapshot (uf, cargo, tse_em, instante, coletado_em, pst)
  VALUES (?, ?, ?, ?, ?, ?)`);
const inserirVoto = db.prepare(
  'INSERT INTO voto (snapshot_id, numero, nome, votos, percentual) VALUES (?, ?, ?, ?, ?)');

// Grava o resultado se for uma geração nova do TSE (UNIQUE descarta repetidos).
export function registrar(uf: string, cargo: number, d: Resultado): boolean {
  if (!d.instante) return false;
  db.exec('BEGIN');
  try {
    const r = inserirSnapshot.run(uf, cargo, d.atualizadoEm, d.instante, Date.now(), d.secoesTotalizadas);
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

// Hora "cheia" de Brasília (UTC-3, sem horário de verão) de cada snapshot.
const HORA = '((instante / 1000 - 10800) / 3600)';

const snapshots = db.prepare(`
  SELECT id, tse_em AS em, instante, pst, ${HORA} * 3600000 + 10800000 AS hora
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY ${HORA} ORDER BY instante DESC) AS ultimo_da_hora
    FROM snapshot
    WHERE uf = :uf AND cargo = :cargo AND pst > 0
  )
  WHERE :todos OR ultimo_da_hora = 1
  ORDER BY instante`);

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
type LinhaSnapshot = Omit<PontoHistorico, 'cand'> & { id: number };
type LinhaVoto = PontoHistorico['cand'][number] & { snapshot_id: number };

export function lerHistorico(
  uf: string, cargo: number, { por = 'hora', top = 10 }: { por?: 'hora' | 'todos'; top?: number } = {},
): PontoHistorico[] {
  const pontos = snapshots.all({ uf, cargo, todos: por === 'todos' ? 1 : 0 }) as LinhaSnapshot[];
  if (!pontos.length) return [];

  const numeros = (topDoSnapshot.all(pontos.at(-1)!.id, top) as { numero: string }[]).map((r) => r.numero);
  const linhas = votos.all({ ids: JSON.stringify(pontos.map((p) => p.id)), numeros: JSON.stringify(numeros) }) as LinhaVoto[];
  const porSnapshot = Map.groupBy(linhas, (v) => v.snapshot_id);

  return pontos.map(({ id, ...p }) => ({
    ...p,
    cand: (porSnapshot.get(id) ?? []).map(({ snapshot_id, ...c }) => c),
  }));
}

export const fechar = () => db.close();
