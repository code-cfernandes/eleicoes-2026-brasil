import type { Cargo, TipoEleicao } from '../shared/tipos.ts';

// Tudo que muda entre eleições/turnos fica aqui (via variáveis de ambiente), nada hardcoded no resto do código.

// Variável vazia conta como não definida: no Portainer/compose é comum ficar "VAR=" em branco,
// e um "" virando 0 (intervalo, limite) seria desastroso.
export function env(nome: string): string | undefined {
  const v = process.env[nome]?.trim();
  return v ? v : undefined;
}
// Número positivo ou o padrão (nunca NaN/0 por engano)
export function envNumero(nome: string, padrao: number): number {
  const n = Number(env(nome));
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

export const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' ');

// Código do cargo no TSE -> eleição a que pertence e onde há resultado publicado
export const CARGOS: Record<number, Cargo> = {
  1: { codigo: 1, nome: 'Presidente', eleicao: 'federal', ufs: ['br', ...UFS, 'zz'], proporcional: false }, // zz = exterior
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
  base: env('TSE_BASE') ?? 'https://resultados.tse.jus.br/oficial',
  ciclo: env('CICLO') ?? 'ele2026',
  turno: env('TURNO') ?? '1º turno',
  eleicao: {
    federal: env('ELEICAO_FEDERAL'),   // presidente
    estadual: env('ELEICAO_ESTADUAL'), // governador, senador, deputados
  } satisfies Record<TipoEleicao, string | undefined>,
  cacheMs: envNumero('CACHE_SEGUNDOS', 30) * 1000,
  port: envNumero('PORT', 3000),
  historicoDb: env('HISTORICO_DB') ?? 'data/eleicoes.db',
  fotosDir: env('FOTOS_DIR') ?? 'data/fotos',
  // Pares uf:cargo coletados em background para o histórico.
  monitorar: expandirMonitorar(env('MONITORAR') ?? 'br:1'),
};
