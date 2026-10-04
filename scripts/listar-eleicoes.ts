// Lista os pleitos/eleições publicados pelo TSE para preencher ELEICAO_* no .env
const base = process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial';
const res = await fetch(`${base}/comum/config/ele-c.json`);
const cfg = (await res.json()) as { pl: { c: string; dt: string; e: { cd: string; t: string; nm: string }[] }[] };
// Resumo: ciclo, data, código da eleição (vai no .env), turno e nome
for (const p of cfg.pl) for (const e of p.e) console.log(p.c, p.dt, e.cd.padStart(5), `${e.t}º turno`, e.nm);
