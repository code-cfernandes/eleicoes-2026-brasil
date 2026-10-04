const TZ = 'America/Sao_Paulo';
const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const inteiro = new Intl.NumberFormat('pt-BR');

export const pct = (v: number) =>
  `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
export const votos = (v: number) => `${inteiro.format(v)} ${v === 1 ? 'voto' : 'votos'}`;
export const horaMinuto = (ms: number) => hora.format(ms);
export const diaMes = (ms: number) => dia.format(ms);

// Para a busca: "José" acha "JOSE"
export const semAcento = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
