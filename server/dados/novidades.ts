import { db } from './banco.ts';
import type { TipoEvento } from '../../shared/tipos.ts';

// Linha do tempo ("O que está acontecendo agora"): os eventos gravados e o estado auxiliar das
// regras (base da diferença, deputados pendentes, balanço periódico), em JSON.

db.exec(`
  CREATE TABLE IF NOT EXISTS novidade (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chave     TEXT    NOT NULL UNIQUE,  -- dedupe: o mesmo fato nunca entra duas vezes
    instante  INTEGER NOT NULL,         -- geração do TSE que originou o evento (epoch ms)
    tipo      TEXT    NOT NULL,
    uf        TEXT    NOT NULL,
    cargo     INTEGER NOT NULL,
    texto     TEXT    NOT NULL,
    criado_em INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS novidade_tipo ON novidade (tipo, cargo, id);

  CREATE TABLE IF NOT EXISTS novidade_estado (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  ) WITHOUT ROWID;
`);

// Migração aditiva: 1 = texto já redigido pela IA (DeepSeek); 0 = frase-modelo ainda no lugar
const colunasNovidade = new Set((db.prepare('PRAGMA table_info(novidade)').all() as { name: string }[]).map((c) => c.name));
if (!colunasNovidade.has('ia')) db.exec('ALTER TABLE novidade ADD COLUMN ia INTEGER NOT NULL DEFAULT 0');
// Turno do evento: tudo o que já existia é do 1º turno
if (!colunasNovidade.has('turno')) db.exec('ALTER TABLE novidade ADD COLUMN turno INTEGER NOT NULL DEFAULT 1');
db.exec('CREATE INDEX IF NOT EXISTS novidade_turno ON novidade (turno, id)');

/** Evento como está na tabela (ia = 1 quando o texto foi redigido pela IA) */
export interface LinhaNovidade { id: number; turno: number; instante: number; tipo: TipoEvento; uf: string; cargo: number; texto: string; ia?: number }

const sql = {
  inserir: db.prepare(`INSERT OR IGNORE INTO novidade (chave, turno, instante, tipo, uf, cargo, texto, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  // Eventos "finais" (conclusão) já nascem com ia=1: são definitivos, não passam pela IA
  inserirFinal: db.prepare(`INSERT OR IGNORE INTO novidade (chave, turno, instante, tipo, uf, cargo, texto, criado_em, ia)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`),
  ultimoId: db.prepare('SELECT coalesce(max(id), 0) AS id FROM novidade'),
  ultimoDoTipo: db.prepare('SELECT instante FROM novidade WHERE turno = ? AND tipo = ? AND cargo = ? ORDER BY id DESC LIMIT 1'),
  ler: db.prepare(`SELECT id, turno, instante, tipo, uf, cargo, texto, ia FROM novidade
    WHERE turno = ? AND id > ? ORDER BY id DESC LIMIT ?`),
  lerAntes: db.prepare(`SELECT id, turno, instante, tipo, uf, cargo, texto, ia FROM novidade
    WHERE turno = ? AND id < ? ORDER BY id DESC LIMIT ?`),
  // Presidente/Brasil ainda com frase-modelo, do mais antigo para o mais novo (fila de redação).
  // 'progresso' fica de fora: já é um balanço factual e frequente, não precisa de IA.
  pendenteIA: db.prepare(`SELECT id, turno, instante, tipo, uf, cargo, texto FROM novidade
    WHERE uf = 'br' AND cargo = 1 AND ia = 0 AND tipo != 'progresso' ORDER BY id LIMIT 1`),
  marcarIA: db.prepare('UPDATE novidade SET texto = ?, ia = 1 WHERE id = ?'),
  temTipo: db.prepare('SELECT count(*) AS n FROM novidade WHERE turno = ? AND uf = ? AND cargo = ? AND tipo = ?'),
  estado: db.prepare('SELECT valor FROM novidade_estado WHERE chave = ?'),
  salvarEstado: db.prepare(`INSERT INTO novidade_estado (chave, valor) VALUES (?, ?)
    ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor`),
  apagarEstado: db.prepare('DELETE FROM novidade_estado WHERE chave = ?'),
};

/** Grava um evento; devolve o id, ou null se a chave já existia (o mesmo fato nunca entra duas vezes) */
export function inserirNovidade(e: { chave: string; turno: number; instante: number; tipo: TipoEvento; uf: string; cargo: number; texto: string }, final = false): number | null {
  const r = (final ? sql.inserirFinal : sql.inserir).run(e.chave, e.turno, e.instante, e.tipo, e.uf, e.cargo, e.texto, Date.now());
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export const maiorIdGravado = () => (sql.ultimoId.get() as { id: number }).id;
export const instanteDoUltimo = (turno: number, tipo: TipoEvento, cargo: number) =>
  (sql.ultimoDoTipo.get(turno, tipo, cargo) as { instante: number } | undefined)?.instante;
export const lerNovidadesDesde = (turno: number, desde: number, limite: number) => sql.ler.all(turno, desde, limite) as unknown as LinhaNovidade[];
export const lerNovidadesAnteriores = (turno: number, antes: number, limite: number) => sql.lerAntes.all(turno, antes, limite) as unknown as LinhaNovidade[];
export const proximaParaRedigir = () => sql.pendenteIA.get() as LinhaNovidade | undefined;
export const gravarTextoRedigido = (id: number, texto: string) => sql.marcarIA.run(texto, id);
export const existeNovidade = (turno: number, uf: string, cargo: number, tipo: TipoEvento) =>
  (sql.temTipo.get(turno, uf, cargo, tipo) as { n: number }).n > 0;
export const apagarTodasNovidades = () => db.exec('DELETE FROM novidade');

export function lerEstadoNovidades<T>(chave: string): T | undefined {
  const r = sql.estado.get(chave) as { valor: string } | undefined;
  return r ? (JSON.parse(r.valor) as T) : undefined;
}
export const salvarEstadoNovidades = (chave: string, valor: unknown) => sql.salvarEstado.run(chave, JSON.stringify(valor));
export const apagarEstadoNovidades = (chave: string) => sql.apagarEstado.run(chave);
