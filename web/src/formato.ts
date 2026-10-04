const TZ = 'America/Sao_Paulo';
const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const inteiro = new Intl.NumberFormat('pt-BR');

export const pct = (v: number) =>
  `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
export const votos = (v: number) => `${inteiro.format(v)} ${v === 1 ? 'voto' : 'votos'}`;
// Diferença entre percentuais se mede em pontos percentuais, não em "%"
export const pontos = (v: number) => {
  const n = v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return `${n} ${v === 1 ? 'ponto percentual' : 'pontos percentuais'}`;
};
export const horaMinuto = (ms: number) => hora.format(ms);
// Relógio do próprio aparelho (fuso de quem está vendo): para "verificado às"
const horaLocal = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const horaDoAparelho = (ms: number) => horaLocal.format(ms);
export const diaMes = (ms: number) => dia.format(ms);

// Arquivos zerados do TSE são publicados dias antes (e só mudam de novo quando a apuração começa):
// nesse caso "atualizou às HH:MM" engana. Mostra a data também quando o instante não é de hoje.
export const ehHoje = (ms: number) => diaMes(ms) === diaMes(Date.now());
// "às 20:13" quando é hoje; "em 02/10 às 20:13" quando não é (já com a preposição certa)
export const dataHora = (ms: number) => ehHoje(ms) ? `às ${horaMinuto(ms)}` : `em ${diaMes(ms)} às ${horaMinuto(ms)}`;

// Para a busca: "José" acha "JOSE"
export const semAcento = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
