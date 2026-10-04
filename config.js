// Tudo que muda entre eleições/turnos fica aqui (via .env), nada hardcoded no resto do código.
export const config = {
  base: process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial',
  ciclo: process.env.CICLO ?? 'ele2026',
  eleicao: {
    federal: process.env.ELEICAO_FEDERAL,   // presidente
    estadual: process.env.ELEICAO_ESTADUAL, // governador, senador, deputados
  },
  cacheMs: Number(process.env.CACHE_SEGUNDOS ?? 30) * 1000,
  port: Number(process.env.PORT ?? 3000),
  historicoDb: process.env.HISTORICO_DB ?? 'data/eleicoes.db',
  // Pares uf:cargo coletados em background para o histórico. Ex.: "br:1,sp:3,sp:5"
  monitorar: (process.env.MONITORAR ?? 'br:1')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [uf, cargo] = s.split(':'); return [uf.toLowerCase(), Number(cargo)]; }),
};

// Código do cargo no TSE -> qual eleição ele pertence
export const CARGOS = {
  1: { nome: 'Presidente', eleicao: 'federal' },
  3: { nome: 'Governador', eleicao: 'estadual' },
  5: { nome: 'Senador', eleicao: 'estadual' },
  6: { nome: 'Deputado federal', eleicao: 'estadual' },
  7: { nome: 'Deputado estadual', eleicao: 'estadual' },
};
