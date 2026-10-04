import { config, CARGOS } from './config.js';

const pad = (n, len) => String(n).padStart(len, '0');

// Monta a URL do arquivo de resultado: /{ciclo}/{eleicao}/dados/{uf}/{uf}-c{cargo}-e{eleicao}-u.json
export function urlResultado(uf, cargo) {
  const tipo = CARGOS[cargo]?.eleicao;
  const cod = config.eleicao[tipo];
  if (!cod) throw new Error(`Código de eleição "${tipo}" não configurado no .env`);
  const e = pad(cod, 6);
  return `${config.base}/${config.ciclo}/${Number(cod)}/dados/${uf}/${uf}-c${pad(cargo, 4)}-e${e}-u.json`;
}

const num = (v) => Number(String(v ?? 0).replace(',', '.')) || 0;

// "dd/mm/aaaa" + "hh:mm:ss" no horário de Brasília (UTC-3) -> epoch ms
function instanteTSE(dg, hg) {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dg ?? '');
  const h = /^(\d{2}):(\d{2}):(\d{2})$/.exec(hg ?? '');
  if (!d || !h) return null;
  return Date.UTC(d[3], d[2] - 1, d[1], Number(h[1]) + 3, h[2], h[3]);
}

// ÚNICO ponto que conhece o formato do JSON do TSE.
// Se o leiaute mudar, só esta função precisa ser ajustada.
export function normalizar(json) {
  const cand =
    json.carg?.[0]?.agr?.flatMap((a) => a.par ?? []).flatMap((p) => p.cand ?? []) ?? // leiaute 2024/2026
    json.cand ?? []; // leiaute 2022 (dados-simplificados)

  return {
    atualizadoEm: [json.dg, json.hg].filter(Boolean).join(' '),
    instante: instanteTSE(json.dg, json.hg),
    secoesTotalizadas: num(json.s?.pst ?? json.pst),
    candidatos: cand
      .map((c) => ({
        numero: c.n,
        nome: c.nmu ?? c.nm,
        votos: num(c.vap),
        percentual: num(c.pvap),
        eleito: c.e === 's',
        situacao: c.st ?? '',
      }))
      .sort((a, b) => b.votos - a.votos),
  };
}

export async function buscarResultado(uf, cargo) {
  const res = await fetch(urlResultado(uf, cargo));
  if (!res.ok) throw new Error(`TSE respondeu ${res.status}`);
  return normalizar(await res.json());
}
