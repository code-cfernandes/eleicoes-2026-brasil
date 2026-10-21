import { NOMES_UF } from '../../shared/ufs.ts';

// Textos em português dos avisos e da linha do tempo: formatação e frases prontas.

export const lugar = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();

// "ANDRE DO PRADO" -> "Andre do Prado": iniciais maiúsculas, partículas (da, de, do, dos, das, e) minúsculas
export const nomeProprio = (s: string) => s.toLowerCase()
  .replace(/(^|\s)(\p{L})/gu, (_m, esp: string, l: string) => esp + l.toUpperCase())
  .replace(/(?<=\s)(Da|De|Do|Das|Dos|E)(?=\s)/g, (p) => p.toLowerCase());
export const nome = (c: { nome: string }) => nomeProprio(c.nome);

export const decimal = (v: number, casas = 1) => v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas });
export const pct = (v: number) => `${decimal(v)}%`;
// ["A", "B", "C"] -> "A, B e C"
export const lista = (itens: string[]) => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
const HORA_BR = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
export const horaMinuto = (ms: number) => HORA_BR.format(ms);
export const doTurno = (turno: number) => (turno > 1 ? ` do ${turno}º turno` : '');

// 1.234.567 -> "1,2 milhão de votos"; 2.400.000 -> "2,4 milhões de votos"; 850.000 -> "850 mil votos"
export function quantidadeVotos(n: number): string {
  if (n >= 999_500) {
    const mi = Math.round(n / 100_000) / 10;
    return `${decimal(mi)} ${mi < 2 ? 'milhão' : 'milhões'} de votos`;
  }
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString('pt-BR')} mil votos`;
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? 'voto' : 'votos'}`;
}

export const inicioDaTotalizacao = (turno: number, instante: number) =>
  `A totalização${doTurno(turno)} para Presidente começou às ${horaMinuto(instante)}.`;

// Notícia final de conclusão (100% das seções) com o resultado: quem venceu (ou 2º turno) e os números
export interface CandConclusao { nome: string; votos: number; percentual: number; eleito: boolean; situacao: string }

export function conclusaoBrasil(d: { candidatos: CandConclusao[] }): string {
  const comVotos = d.candidatos.filter((c) => c.votos > 0);
  const [lider, vice] = comVotos;
  if (!lider) return 'Brasil concluiu a totalização para Presidente (100% das seções).';
  const eleito = d.candidatos.find((c) => c.eleito);
  const segundo = d.candidatos.filter((c) => /2º turno/i.test(c.situacao));
  if (eleito) {
    return `Brasil concluiu a totalização para Presidente: ${nome(eleito)} eleito com ${pct(eleito.percentual)} dos votos válidos (${quantidadeVotos(eleito.votos)}).`;
  }
  if (segundo.length >= 2) {
    return `Brasil concluiu a totalização para Presidente: haverá 2º turno entre ${lista(segundo.map(nome))}.`;
  }
  const parte = `${nome(lider)} lidera com ${pct(lider.percentual)} dos votos válidos (${quantidadeVotos(lider.votos)})`;
  return `Brasil concluiu a totalização para Presidente: ${parte}${vice ? `, à frente de ${nome(vice)} (${pct(vice.percentual)})` : ''}.`;
}

export function conclusaoUF(d: { candidatos: CandConclusao[]; uf: string }): string {
  const [lider, vice] = d.candidatos.filter((c) => c.votos > 0);
  if (!lider) return `${lugar(d.uf)} concluiu a totalização para Presidente (100% das seções).`;
  const parte = `${nome(lider)} lidera com ${pct(lider.percentual)} dos votos válidos (${quantidadeVotos(lider.votos)})`;
  return `${lugar(d.uf)} concluiu a totalização para Presidente: ${parte}${vice ? `, à frente de ${nome(vice)} (${pct(vice.percentual)})` : ''}.`;
}
