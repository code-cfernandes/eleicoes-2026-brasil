import type { Cargo, TipoEleicao } from '../shared/tipos.ts';

// Tudo que muda entre eleições/turnos fica aqui (via .env), nada hardcoded no resto do código.
export const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' ');

// Código do cargo no TSE -> eleição a que pertence e onde há resultado publicado
export const CARGOS: Record<number, Cargo> = {
  1: { codigo: 1, nome: 'Presidente', eleicao: 'federal', ufs: ['br', ...UFS], proporcional: false },
  3: { codigo: 3, nome: 'Governador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  5: { codigo: 5, nome: 'Senador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  6: { codigo: 6, nome: 'Deputado federal', eleicao: 'estadual', ufs: UFS, proporcional: true },
  7: { codigo: 7, nome: 'Deputado estadual', eleicao: 'estadual', ufs: UFS.filter((u) => u !== 'df'), proporcional: true },
  8: { codigo: 8, nome: 'Deputado distrital', eleicao: 'estadual', ufs: ['df'], proporcional: true },
};

// "br:1,sp:*,*:3" -> pares [uf, cargo]. "*" expande para todas as UFs/cargos válidos.
function expandirMonitorar(spec: string): [string, number][] {
  const pares = new Map<string, [string, number]>();
  for (const item of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [uf = '', cargo = ''] = item.split(':');
    const cargos = cargo === '*' ? Object.values(CARGOS) : [CARGOS[Number(cargo)]].filter((c) => c !== undefined);
    for (const c of cargos) {
      for (const u of uf === '*' ? c.ufs.filter((x) => x !== 'br') : [uf]) {
        if (c.ufs.includes(u)) pares.set(`${u}:${c.codigo}`, [u, c.codigo]);
      }
    }
  }
  return [...pares.values()];
}

export const config = {
  base: process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial',
  ciclo: process.env.CICLO ?? 'ele2026',
  turno: process.env.TURNO ?? '1º turno',
  eleicao: {
    federal: process.env.ELEICAO_FEDERAL,   // presidente
    estadual: process.env.ELEICAO_ESTADUAL, // governador, senador, deputados
  } satisfies Record<TipoEleicao, string | undefined>,
  cacheMs: Number(process.env.CACHE_SEGUNDOS ?? 30) * 1000,
  port: Number(process.env.PORT ?? 3000),
  historicoDb: process.env.HISTORICO_DB ?? 'data/eleicoes.db',
  fotosDir: process.env.FOTOS_DIR ?? 'data/fotos',
  // Pares uf:cargo coletados em background para o histórico.
  monitorar: expandirMonitorar(process.env.MONITORAR ?? 'br:1'),
};
