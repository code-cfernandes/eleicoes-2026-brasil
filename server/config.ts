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

// Um turno só existe se ao menos um código de eleição estiver definido. O turno "atual" é o
// último definido: é o único coletado do TSE; os anteriores ficam arquivados (só leitura).
// Os códigos vêm do ambiente ou, na falta dele, da descoberta automática (codigos.ts), que pode
// preenchê-los depois da subida: por isso `turnos` e `turnoAtual` são calculados a cada leitura.
export interface DefTurno {
  numero: number;
  nome: string;
  eleicao: Record<TipoEleicao, string | undefined>;
  /** Início da apuração (epoch ms), para a contagem regressiva */
  inicioApuracao: number | null;
}

const definicoes: DefTurno[] = [
  {
    numero: 1,
    nome: '1º turno',
    eleicao: { federal: env('ELEICAO_FEDERAL'), estadual: env('ELEICAO_ESTADUAL') },
    inicioApuracao: Date.parse(env('INICIO_APURACAO') ?? '2026-10-04T17:00:00-03:00') || null,
  },
  {
    numero: 2,
    nome: '2º turno',
    eleicao: { federal: env('ELEICAO_FEDERAL_2T'), estadual: env('ELEICAO_ESTADUAL_2T') },
    inicioApuracao: Date.parse(env('INICIO_APURACAO_2T') ?? '2026-10-25T17:00:00-03:00') || null,
  },
];
const definido = (t: DefTurno) => !!(t.eleicao.federal || t.eleicao.estadual);

export const config = {
  base: env('TSE_BASE') ?? 'https://resultados.tse.jus.br/oficial',
  ciclo: env('CICLO') ?? 'ele2026',
  /** Todos os turnos possíveis, com ou sem código (a descoberta preenche os que faltam) */
  definicoes,
  get turnos(): DefTurno[] { return definicoes.filter(definido); },
  get turnoAtual(): number { return definicoes.filter(definido).at(-1)?.numero ?? 1; },
  cacheMs: envNumero('CACHE_SEGUNDOS', 30) * 1000,
  port: envNumero('PORT', 3000),
  historicoDb: env('HISTORICO_DB') ?? 'data/eleicoes.db',
  fotosDir: env('FOTOS_DIR') ?? 'data/fotos',
  // Pares uf:cargo coletados em background para o histórico (só os que existem no turno atual).
  monitorar: expandirMonitorar(env('MONITORAR') ?? 'br:1,*:1,*:3'),
};

export const defTurno = (turno: number) => config.turnos.find((t) => t.numero === turno);
