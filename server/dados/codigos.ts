import { db } from './banco.ts';
import type { TipoEleicao } from '../../shared/tipos.ts';

// Códigos de eleição descobertos no TSE (os definidos pelo ambiente não entram aqui)

db.exec(`
  CREATE TABLE IF NOT EXISTS codigo_eleicao (
    turno  INTEGER NOT NULL,
    tipo   TEXT    NOT NULL,
    codigo TEXT    NOT NULL,
    PRIMARY KEY (turno, tipo)
  ) WITHOUT ROWID;
`);
const salvar = db.prepare(`INSERT INTO codigo_eleicao (turno, tipo, codigo) VALUES (?, ?, ?)
  ON CONFLICT (turno, tipo) DO UPDATE SET codigo = excluded.codigo`);

export const codigosGravados = () =>
  db.prepare('SELECT turno, tipo, codigo FROM codigo_eleicao').all() as { turno: number; tipo: TipoEleicao; codigo: string }[];

export const salvarCodigo = (turno: number, tipo: TipoEleicao, codigo: string) => salvar.run(turno, tipo, codigo);
