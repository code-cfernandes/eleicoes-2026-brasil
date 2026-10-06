// Popula um banco SEPARADO com uma apuração fictícia (17h–23h) para testar a tela.
// Uso: npm run simular  ->  HISTORICO_DB=data/simulado.db npm start
process.env.HISTORICO_DB = process.env.SIMULADO_DB ?? 'data/simulado.db';
const { registrar } = await import('../server/historico.ts');

const FICTICIOS: [string, string, number][] = [
  ['91', 'CANDIDATA A', 0.38], ['92', 'CANDIDATO B', 0.33], ['93', 'CANDIDATA C', 0.14],
  ['94', 'CANDIDATO D', 0.09], ['95', 'CANDIDATO E', 0.05], ['96', 'CANDIDATA F', 0.03],
];
const ELEITORES = 120_000_000;
const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const pad = (n: number) => String(n).padStart(2, '0');

let gravados = 0;
for (let min = 17 * 60; min <= 23 * 60; min += 7) {
  const pst = Math.min(100, ((min - 17 * 60) / 300) ** 0.6 * 100 + 0.5);
  // A disputa entre A e B vira ao longo da noite, para o gráfico ter o que mostrar
  const t = pst / 100;
  const pesos = FICTICIOS.map(([, , p], i) => p + (i === 0 ? -0.05 : i === 1 ? 0.05 : 0) * t + (Math.sin(min + i) * 0.004));
  const soma = pesos.reduce((a, b) => a + b);
  const total = Math.round(ELEITORES * 0.8 * t);
  const candidatos = FICTICIOS.map(([numero, nome], i) => ({
    numero, nome, partido: 'FIC', sqcand: '', foto: '', eleito: false, situacao: '',
    votos: Math.round((total * pesos[i]!) / soma),
    percentual: Math.round((pesos[i]! / soma) * 10000) / 100,
  })).sort((a, b) => b.votos - a.votos);

  const hg = `${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
  const [d, m, a] = hoje.split('/').map(Number) as [number, number, number];
  const ok = registrar({
    turno: 1,
    cargo: 1, nomeCargo: 'Presidente', uf: 'br', vagas: 1,
    atualizadoEm: `${hoje} ${hg}`,
    instante: Date.UTC(a, m - 1, d, Math.floor(min / 60) + 3, min % 60),
    secoesTotalizadas: Math.round(pst * 100) / 100,
    candidatos,
  });
  if (ok) gravados++;
}
console.log(`${gravados} snapshots fictícios gravados em ${process.env.HISTORICO_DB}`);
