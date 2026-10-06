import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { ufDaFoto, urlFoto } from './tse.ts';

// Fotos oficiais do TSE com cache em disco: cada foto é baixada uma única vez,
// e a tela não depende do TSE para imagens já vistas.
const emAndamento = new Map<string, Promise<Buffer | null>>();
const ausentes = new Map<string, number>(); // chave -> expira (não martela o TSE com 404)

// O arquivo em disco não depende do turno (o sqcand do candidato é o mesmo); o turno só escolhe
// de qual eleição do TSE baixar quando a foto ainda não está no cache.
export function obterFoto(uf: string, cargo: number, sqcand: string, turno: number): Promise<Buffer | null> {
  const dir = join(config.fotosDir, config.ciclo, String(cargo), ufDaFoto(uf, cargo));
  const arquivo = join(dir, `${sqcand}.jpeg`);
  if ((ausentes.get(arquivo) ?? 0) > Date.now()) return Promise.resolve(null);

  const pendente = emAndamento.get(arquivo);
  if (pendente) return pendente;

  const promessa = readFile(arquivo).catch(async () => {
    const res = await fetch(urlFoto(uf, cargo, sqcand, turno), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      ausentes.set(arquivo, Date.now() + 10 * 60_000);
      return null;
    }
    const img = Buffer.from(await res.arrayBuffer());
    await mkdir(dir, { recursive: true });
    await writeFile(arquivo, img);
    return img;
  }).finally(() => emAndamento.delete(arquivo));

  emAndamento.set(arquivo, promessa);
  return promessa;
}
