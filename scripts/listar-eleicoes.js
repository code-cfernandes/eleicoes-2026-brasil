// Lista os pleitos/eleições publicados pelo TSE para preencher ELEICAO_* no .env
const base = process.env.TSE_BASE ?? 'https://resultados.tse.jus.br/oficial';
const res = await fetch(`${base}/comum/config/ele-c.json`);
console.log(JSON.stringify(await res.json(), null, 2));
