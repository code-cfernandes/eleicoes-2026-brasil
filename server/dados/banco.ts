import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/config.ts';

// Um único SQLite para histórico e notificações (arquivo no volume do Docker)
mkdirSync(dirname(config.historicoDb), { recursive: true });
export const db = new DatabaseSync(config.historicoDb);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);

export const fechar = () => db.close();

// Várias escritas como uma só: um restart no meio nunca deixa uma sem a outra
export function transacao<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
