import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

// Um único SQLite para histórico e notificações (arquivo no volume do Docker)
mkdirSync(dirname(config.historicoDb), { recursive: true });
// Simulação: cada execução começa do zero (só o simulacao.db; o banco real nunca entra aqui)
if (config.simulacao && config.historicoDb.endsWith('simulacao.db')) {
  for (const sufixo of ['', '-wal', '-shm']) rmSync(config.historicoDb + sufixo, { force: true });
}
export const db = new DatabaseSync(config.historicoDb);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);

export const fechar = () => db.close();
