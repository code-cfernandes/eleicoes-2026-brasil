// Lista os pleitos/eleições publicados pelo TSE para preencher ELEICAO_* no .env
const base = process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial';
const res = await fetch(`${base}/comum/config/ele-c.json`);
const cfg = (await res.json()) as { pl: { c: string; dt: string; e: { cd: string; cdt2?: string; t: string; nm: string }[] }[] };
// Resumo: ciclo, data, código da eleição, código do 2º turno (cdt2), turno e nome.
// O servidor descobre esses códigos sozinho; o .env só precisa deles para forçar um valor.
for (const p of cfg.pl) {
  for (const e of p.e) console.log(p.c, p.dt, e.cd.padStart(5), `2T:${(e.cdt2 || '—').padStart(5)}`, `${e.t}º turno`, e.nm);
}
