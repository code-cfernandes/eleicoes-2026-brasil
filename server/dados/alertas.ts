import { db } from './banco.ts';
import type { EstadoAlerta } from '../dominio/deteccao.ts';

// O que já foi avisado em cada disputa (sobrevive a restart: ninguém recebe aviso repetido)

db.exec(`
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

const ler = db.prepare('SELECT marco, lideres, definido, ultima_virada FROM alerta_estado WHERE turno = ? AND uf = ? AND cargo = ?');
const salvar = db.prepare(`INSERT INTO alerta_estado (turno, uf, cargo, marco, lideres, definido, ultima_virada) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (turno, uf, cargo) DO UPDATE SET marco = excluded.marco, lideres = excluded.lideres,
    definido = excluded.definido, ultima_virada = excluded.ultima_virada`);

export const lerEstadoAlerta = (turno: number, uf: string, cargo: number) =>
  ler.get(turno, uf, cargo) as EstadoAlerta | undefined;

export const salvarEstadoAlerta = (turno: number, uf: string, cargo: number, e: EstadoAlerta) =>
  salvar.run(turno, uf, cargo, e.marco, e.lideres, e.definido, e.ultima_virada);
