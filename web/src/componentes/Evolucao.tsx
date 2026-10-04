import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PontoHistorico } from '../../../shared/tipos.ts';
import { diaMes, horaMinuto, pct } from '../formato.ts';
import { corSerie, neutros, type Tema } from '../paleta.ts';

export type Granularidade = 'hora' | 'todos';

interface Serie { numero: string; nome: string; slot: number | undefined }

interface Props {
  historico: PontoHistorico[];
  /** numero -> posição na paleta; quem não está aqui vira linha de contexto (cinza) */
  slots: Map<string, number>;
  por: Granularidade;
  onPor: (p: Granularidade) => void;
  ativo: string | null;
  onDestacar: (numero: string | null) => void;
  onFixar: (numero: string) => void;
  tema: Tema;
}

type Linha = { rotulo: string; instante: number; pst: number } & Record<string, number | string>;

function rotular(p: PontoHistorico, por: Granularidade, variosDias: boolean) {
  const texto = por === 'hora' ? `${horaMinuto(p.hora).slice(0, 2)}h` : horaMinuto(p.instante);
  return variosDias ? `${diaMes(p.instante)} ${texto}` : texto;
}

function Dica({ active, payload, series, ativo }: {
  active?: boolean;
  payload?: { payload: Linha }[];
  series: Serie[];
  ativo: string | null;
}) {
  const linha = payload?.[0]?.payload;
  if (!active || !linha) return null;
  // Os 8 primeiros naquele momento, mais o destacado se estiver fora deles
  const ordenadas = series
    .filter((s) => typeof linha[s.numero] === 'number')
    .sort((a, b) => (linha[b.numero] as number) - (linha[a.numero] as number));
  const visiveis = ordenadas.filter((s, i) => i < 8 || s.numero === ativo);
  return (
    <div className="dica">
      <p>Posição às {horaMinuto(linha.instante)}, com {pct(linha.pst)} das seções</p>
      <ul>
        {visiveis.map((s) => (
          <li key={s.numero} className={s.numero === ativo ? 'dica-ativa' : ''}>
            <span className="ponto" data-slot={s.slot ?? 'contexto'} />
            <span>{s.nome}</span>
            <strong>{pct(linha[s.numero] as number)}</strong>
          </li>
        ))}
      </ul>
      {ordenadas.length > visiveis.length && <p className="dica-mais">e mais {ordenadas.length - visiveis.length}</p>}
    </div>
  );
}

export function Evolucao({ historico, slots, por, onPor, ativo, onDestacar, onFixar, tema }: Props) {
  const { linhas, series } = useMemo(() => {
    const variosDias = new Set(historico.map((p) => diaMes(p.instante))).size > 1;
    const linhas: Linha[] = historico.map((p) => {
      const l: Linha = { rotulo: rotular(p, por, variosDias), instante: p.instante, pst: p.pst };
      for (const c of p.cand) l[c.numero] = c.percentual;
      return l;
    });
    const nomes = new Map(historico.flatMap((p) => p.cand.map((c) => [c.numero, c.nome] as const)));
    const series: Serie[] = [...nomes].map(([numero, nome]) => ({ numero, nome, slot: slots.get(numero) }));
    return { linhas, series };
  }, [historico, por, slots]);

  const n = neutros(tema);
  // Ordem de desenho: contexto embaixo, coloridas por cima, destacada no topo
  const ordemDesenho = [...series].sort((a, b) =>
    Number(a.numero === ativo) - Number(b.numero === ativo) || Number(a.slot !== undefined) - Number(b.slot !== undefined));
  const ultima = linhas.at(-1);
  // Legenda e tabela na ordem do placar atual (a cor continua presa ao candidato)
  const valorAtual = (s: Serie) => (typeof ultima?.[s.numero] === 'number' ? (ultima[s.numero] as number) : -1);
  const coloridas = series.filter((s) => s.slot !== undefined).sort((a, b) => valorAtual(b) - valorAtual(a));
  const contexto = series.length - coloridas.length;

  return (
    <section className="evolucao" aria-labelledby="evolucao-titulo">
      <header className="evolucao-cabecalho">
        <div>
          <h2 id="evolucao-titulo">Evolução da apuração</h2>
          <p>Percentual de votos válidos de cada candidato {por === 'hora' ? 'ao fim de cada hora' : 'a cada atualização do TSE'}.</p>
        </div>
        <div className="alternar" role="group" aria-label="Frequência dos pontos">
          <button type="button" aria-pressed={por === 'hora'} onClick={() => onPor('hora')}>Hora a hora</button>
          <button type="button" aria-pressed={por === 'todos'} onClick={() => onPor('todos')}>Cada atualização</button>
        </div>
      </header>

      {!historico.length ? (
        <p className="vazio">O gráfico aparece quando o TSE divulgar as primeiras seções totalizadas desta disputa.</p>
      ) : (
        <>
          <div className="grafico" role="img" aria-label="Gráfico de linhas: percentual de cada candidato ao longo da apuração. Os mesmos dados estão na tabela abaixo.">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={linhas} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid vertical={false} stroke={n.grade} />
                <XAxis dataKey="rotulo" tick={{ fill: n.eixo, fontSize: 12 }} tickLine={false} axisLine={{ stroke: n.grade }} minTickGap={16} />
                <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: n.eixo, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
                <Tooltip content={<Dica series={series} ativo={ativo} />} cursor={{ stroke: n.eixo, strokeDasharray: '3 3' }} isAnimationActive={false} />
                {ordemDesenho.map((s) => {
                  const destaque = ativo === s.numero;
                  const apagada = ativo !== null && !destaque;
                  return (
                    <Line
                      key={s.numero}
                      dataKey={s.numero}
                      name={s.nome}
                      type="linear"
                      stroke={corSerie(tema, s.slot)}
                      strokeWidth={destaque ? 3.5 : s.slot === undefined ? 1.25 : 2}
                      strokeOpacity={apagada ? 0.18 : 1}
                      dot={por === 'hora' && s.slot !== undefined ? { r: 3, strokeWidth: 0, fill: corSerie(tema, s.slot), fillOpacity: apagada ? 0.18 : 1 } : false}
                      activeDot={apagada ? false : { r: 5, strokeWidth: 2, stroke: 'var(--superficie)' }}
                      connectNulls
                      isAnimationActive={false}
                      onMouseEnter={() => onDestacar(s.numero)}
                      onMouseLeave={() => onDestacar(null)}
                      onClick={() => onFixar(s.numero)}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <ul className="legenda" aria-label="Legenda">
            {coloridas.map((s) => (
              <li key={s.numero}>
                <button
                  type="button"
                  aria-pressed={ativo === s.numero}
                  onMouseEnter={() => onDestacar(s.numero)}
                  onMouseLeave={() => onDestacar(null)}
                  onClick={() => onFixar(s.numero)}
                >
                  <span className="ponto" data-slot={s.slot} />
                  {s.nome}
                  {ultima && typeof ultima[s.numero] === 'number' && <span className="legenda-valor">{pct(ultima[s.numero] as number)}</span>}
                </button>
              </li>
            ))}
            {contexto > 0 && (
              <li className="legenda-contexto">
                <span className="ponto" data-slot="contexto" />
                {contexto === 1 ? '1 outro candidato' : `${contexto} outros candidatos`} em cinza
              </li>
            )}
          </ul>

          <details className="tabela">
            <summary>Ver os números em tabela</summary>
            <div className="tabela-rolagem">
              <table>
                <caption>{por === 'hora' ? 'Posição ao fim de cada hora' : 'Cada atualização do TSE'}, horário de Brasília</caption>
                <thead>
                  <tr>
                    <th scope="col">Hora</th>
                    <th scope="col">Seções</th>
                    {coloridas.map((s) => <th key={s.numero} scope="col"><span className="ponto" data-slot={s.slot} />{s.nome}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...linhas].reverse().map((l) => (
                    <tr key={l.instante}>
                      <th scope="row">{l.rotulo}</th>
                      <td>{pct(l.pst)}</td>
                      {coloridas.map((s) => <td key={s.numero}>{typeof l[s.numero] === 'number' ? pct(l[s.numero] as number) : '–'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
