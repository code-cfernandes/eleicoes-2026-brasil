import { corSerie, MAX_SERIES, type Tema } from './paleta.ts';

// Cores de partido: cada candidato na cor oficial do seu partido.
// - Hue: registro de cores de partidos da Wikipédia (Module:Political party, o mesmo dos mapas
//   eleitorais). UP: vermelho (o registro tem preto, que não identifica nada num gráfico).
// - Luminosidade e croma ajustados por tema em OKLCH e validados um a um (faixa, croma mínimo e
//   contraste com o fundo) com o validador do guia de dataviz. As 9 cores do 2º turno foram
//   validadas também par a par em cada confronto (paleta.ts, FINALISTAS_2T).
// - "PARTIDO:variante" = cor secundária oficial, usada quando a principal colide na disputa.
// Fonte única: as variáveis CSS --partido-* são geradas daqui (instalarCoresDePartido).
const PARTIDOS: Record<string, readonly [claro: string, escuro: string]> = {
  "PT": ["#d50323", "#f12b36"],
  "PL": ["#1263b4", "#3782d5"],
  "UP": ["#d71920", "#de2427"],
  "PSTU": ["#c4122d", "#d8303e"],
  "PCO": ["#bb0000", "#d93226"],
  "PSOL": ["#e2202a", "#e2202a"],
  "MDB": ["#238743", "#3d9c58"],
  "PSD": ["#c78106", "#cb8307"],
  "DC": ["#015f9d", "#317fc0"],
  "NOVO": ["#e86601", "#e86601"],
  "REPUBLICANOS": ["#1076cc", "#308ce4"],
  "PSDB": ["#027cf6", "#0080ff"],
  "UNIÃO": ["#079ac7", "#07a3d4"],
  "MISSÃO": ["#ba8907", "#ba8907"],
  "PP": ["#25539c", "#4473c0"],
  "PSB": ["#b28d00", "#b28d00"],
  "DEMOCRATA": ["#1c5696", "#447cbf"],
  "AGIR": ["#2670cb", "#307ad5"],
  "PDT": ["#c21e56", "#d33363"],
  "AVANTE": ["#039393", "#039393"],
  "PODE": ["#159b22", "#2da933"],
  "PCB": ["#f00201", "#ff0000"],
  "MOBILIZA": ["#ea2402", "#ec2300"],
  "REDE": ["#059583", "#09a18d"],
  "PRD": ["#008000", "#259322"],
  "PRTB": ["#079b29", "#23af39"],
  "SOLIDARIEDADE": ["#d07a08", "#d07a08"],
  "CIDADANIA": ["#e40587", "#ec008c"],
  "PV": ["#056804", "#3b9036"],
  "REPUBLICANOS:verde": ["#0f9249", "#34a85d"],
  "PSDB:amarelo": ["#b78a08", "#bb8d09"],
};
const SECUNDARIA: Record<string, string> = { REPUBLICANOS: 'REPUBLICANOS:verde', PSDB: 'PSDB:amarelo' };

const slug = (chave: string) => chave.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-');
const variavel = (chave: string) => `var(--partido-${slug(chave)})`;
const sigla = (partido: string | undefined) => (partido ?? '').trim().toUpperCase();

// Variáveis CSS dos dois temas (o escuro é o :root padrão; o claro entra com data-tema="claro")
export function instalarCoresDePartido() {
  if (typeof document === 'undefined' || document.getElementById('cores-de-partido')) return;
  const bloco = (i: 0 | 1) => Object.entries(PARTIDOS).map(([k, v]) => `--partido-${slug(k)}:${v[i]};`).join('');
  const estilo = document.createElement('style');
  estilo.id = 'cores-de-partido';
  estilo.textContent = `:root{${bloco(1)}}:root[data-tema="claro"]{${bloco(0)}}`;
  document.head.append(estilo);
}

/** Cor do partido (variável CSS), sem checar colisão: para o mapa, onde cada estado tem um líder */
export function corDoPartido(partido: string | undefined): string | undefined {
  return PARTIDOS[sigla(partido)] ? variavel(sigla(partido)) : undefined;
}

// --- Distância entre cores: a mesma conta do validador do guia de dataviz (OKLab ΔE ×100;
// daltonismo simulado com Machado, Oliveira & Fernandes 2009, severidade 1,0)
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
} as const;
const linear = (h: string) => [1, 3, 5].map((i) => {
  const c = parseInt(h.slice(i, i + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}) as [number, number, number];
function oklab([r, g, b]: [number, number, number]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function simular(rgb: [number, number, number], tipo: keyof typeof MACHADO): [number, number, number] {
  const M = MACHADO[tipo], c = (v: number) => Math.max(0, Math.min(1, v));
  return [0, 1, 2].map((i) => c(M[i]![0] * rgb[0] + M[i]![1] * rgb[1] + M[i]![2] * rgb[2])) as [number, number, number];
}
function distancia(a: string, b: string, tipo?: keyof typeof MACHADO) {
  const la = linear(a), lb = linear(b);
  const [x, y] = [oklab(tipo ? simular(la, tipo) : la), oklab(tipo ? simular(lb, tipo) : lb)];
  return 100 * Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
}
// Distinguíveis: visão normal >= 15 e daltonismo (pior de protan/deutan) >= 8 — os mínimos do guia
const distinguiveis = (a: string, b: string) =>
  distancia(a, b) >= 15 && Math.min(distancia(a, b, 'protan'), distancia(a, b, 'deutan')) >= 8;

// Reserva (quem não pode ficar com a cor do partido): primeiro as cores que nenhum partido grande
// usa; azul e vermelho, que lembram PL e PT, por último. Índices da paleta padrão (paleta.ts).
const ORDEM_RESERVA = [6, 4, 2, 3, 5, 1, 0, 7]; // roxo, rosa, verde, âmbar, verde-escuro, laranja, azul, vermelho

/**
 * Cores dos candidatos de uma disputa. `candidatos` vem em ordem de prioridade: a dos votos.
 * Partidos de cores parecidas (vários vermelhos, vários azuis) não cabem todos numa disputa sem se
 * confundir, e alguém fica sem a cor do partido: que seja quem tem menos votos.
 * 1. Cada um recebe a cor do partido; se ela se confunde com uma já usada (visão normal ou
 *    daltonismo, mínimos do guia de dataviz), a secundária oficial; se as duas colidem, espera.
 * 2. Quem esperou recebe a primeira cor livre da reserva.
 * Duas passadas: um candidato sem cor livre não toma, da reserva, uma cor que colidiria com o
 * partido de alguém mais abaixo. A cor só muda se dois candidatos de cores parecidas trocarem de
 * posição entre si (ex.: PSOL passa o PT): quem fica à frente mantém a cor do partido.
 */
export function coresDaDisputa(tema: Tema, candidatos: { numero: string; partido?: string }[]): Map<string, string> {
  const i = tema === 'claro' ? 0 : 1;
  const usadas: string[] = [];
  const cores = new Map<string, string>();
  const livre = (hex: string) => usadas.every((u) => distinguiveis(u, hex));
  const esperando: string[] = [];
  for (const c of candidatos) {
    const p = sigla(c.partido);
    const opcoes = [p, SECUNDARIA[p]].filter((k): k is string => !!k && !!PARTIDOS[k]);
    const doPartido = opcoes.find((k) => livre(PARTIDOS[k]![i]));
    if (!doPartido) { esperando.push(c.numero); continue; }
    usadas.push(PARTIDOS[doPartido]![i]);
    cores.set(c.numero, variavel(doPartido));
  }
  const reserva = ORDEM_RESERVA.filter((s) => s < MAX_SERIES).map((s) => corSerie(tema, s));
  for (const numero of esperando) {
    const cor = reserva.find(livre) ?? reserva.find((r) => !usadas.includes(r)) ?? reserva[0]!;
    usadas.push(cor);
    cores.set(numero, cor);
  }
  return cores;
}
