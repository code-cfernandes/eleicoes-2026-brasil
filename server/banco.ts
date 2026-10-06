import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

// Um único SQLite para histórico e notificações (arquivo no volume do Docker)
mkdirSync(dirname(config.historicoDb), { recursive: true });
export const db = new DatabaseSync(config.historicoDb);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);

export const fechar = () => db.close();
