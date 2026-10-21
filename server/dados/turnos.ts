import { db, transacao } from './banco.ts';

// Disputas de cada turno a partir do 2º (descobertas pelo resultado do turno anterior) e quais
// turnos já foram descobertos: depois de um restart, a lista não depende do TSE responder.

db.exec(`
  CREATE TABLE IF NOT EXISTS turno_disputa (
    turno INTEGER NOT NULL,
    cargo INTEGER NOT NULL,
    uf    TEXT    NOT NULL,
    PRIMARY KEY (turno, cargo, uf)
  ) WITHOUT ROWID;
  -- Turnos cuja descoberta terminou (sem linha aqui, tenta de novo na próxima rodada do coletor)
  CREATE TABLE IF NOT EXISTS turno_descoberto (turno INTEGER PRIMARY KEY);
`);

const inserir = db.prepare('INSERT OR IGNORE INTO turno_disputa (turno, cargo, uf) VALUES (?, ?, ?)');
const marcar = db.prepare('INSERT OR IGNORE INTO turno_descoberto (turno) VALUES (?)');

export const turnosDescobertos = () =>
  new Set((db.prepare('SELECT turno FROM turno_descoberto').all() as { turno: number }[]).map((r) => r.turno));

// turno -> cargo -> UFs com disputa
export function disputasGravadas(): Map<number, Map<number, string[]>> {
  const disputas = new Map<number, Map<number, string[]>>();
  for (const { turno, cargo, uf } of db.prepare('SELECT turno, cargo, uf FROM turno_disputa ORDER BY turno, cargo, uf').all() as { turno: number; cargo: number; uf: string }[]) {
    if (!disputas.has(turno)) disputas.set(turno, new Map());
    const porCargo = disputas.get(turno)!;
    porCargo.set(cargo, [...(porCargo.get(cargo) ?? []), uf]);
  }
  return disputas;
}

// Tudo ou nada: as disputas do turno e a marca de "descoberto" entram juntas
export function gravarDisputasDoTurno(turno: number, porCargo: Map<number, string[]>) {
  transacao(() => {
    for (const [cargo, ufs] of porCargo) for (const uf of ufs) inserir.run(turno, cargo, uf);
    marcar.run(turno);
  });
}
