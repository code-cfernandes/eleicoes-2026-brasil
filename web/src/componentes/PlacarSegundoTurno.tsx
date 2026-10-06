import { useEffect, useState } from 'react';
import type { Candidato, DisputaDoTurno } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { buscarDisputas } from '../api.ts';
import { pct, votos } from '../formato.ts';
import { corDoFinalista } from '../paleta.ts';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';

// Início no 2º turno: o card de Presidente vira um confronto (dois candidatos, barra de "cabo de
// guerra" com os votos válidos) e, embaixo, no mesmo card, as disputas de Governador dos estados
// que tiveram 2º turno. Os lados seguem a ordem do número do candidato (mesma regra das cores do
// app): uma virada muda a barra, não troca os candidatos de lugar.

const CHAVE_ESTADO_PREFERIDO = 'eleicoes2026:estado'; // a mesma do Início

function lerEstadoSalvo(): string | null {
  try {
    return localStorage.getItem(CHAVE_ESTADO_PREFERIDO);
  } catch {
    return null;
  }
}

const porNumero = (cands: Candidato[]) =>
  [...cands].sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));

// Lado fixo por partido em todos os confrontos do turno: o mesmo partido sempre do mesmo lado,
// para a leitura ser consistente entre Presidente e governadores. Nada de ordem ideológica: o par
// de Presidente é ancorado pelo número (menor à esquerda) e o resto se propaga pelos confrontos
// (o adversário de quem está à esquerda fica à direita). Em 2026: PT, PSD, Republicanos e PSDB à
// esquerda; PL, PP, União e MDB à direita. Sem como decidir (ciclo ou partido isolado), vale o número.
export type Lados = Map<string, 0 | 1>;
export function ladosPorPartido(disputas: { candidatos: Candidato[] }[]): Lados {
  const pares = disputas.map((d) => porNumero(d.candidatos.slice(0, 2))).filter((p) => p.length === 2) as [Candidato, Candidato][];
  const vizinhos = new Map<string, string[]>();
  for (const [a, b] of pares) {
    vizinhos.set(a.partido, [...(vizinhos.get(a.partido) ?? []), b.partido]);
    vizinhos.set(b.partido, [...(vizinhos.get(b.partido) ?? []), a.partido]);
  }
  const lados: Lados = new Map();
  for (const [esq, dir] of pares) { // a 1ª disputa é a de Presidente (a rota a devolve primeiro)
    if (lados.has(esq.partido) || lados.has(dir.partido)) continue;
    lados.set(esq.partido, 0);
    const fila = [esq.partido];
    for (let p = fila.shift(); p !== undefined; p = fila.shift()) {
      for (const v of vizinhos.get(p) ?? []) {
        if (!lados.has(v)) { lados.set(v, lados.get(p) === 0 ? 1 : 0); fila.push(v); }
      }
    }
  }
  return lados;
}

// Os dois finalistas na ordem esquerda/direita
export function ordenarConfronto(candidatos: Candidato[], lados?: Lados): [Candidato, Candidato] | null {
  const [a, b] = porNumero(candidatos.slice(0, 2));
  if (!a || !b) return null;
  const la = lados?.get(a.partido), lb = lados?.get(b.partido);
  if (la !== undefined && lb !== undefined && la === lb) return [a, b]; // ciclo: vale o número
  if (la === 1 || lb === 0) return [b, a];
  return [a, b];
}

// Cores: a do partido de cada finalista (paleta.ts, validada par a par); quem não estiver na lista
// (não deveria acontecer no 2º turno) cai numa série automática que não colida com a do outro.
function cores(a: Candidato, b: Candidato, cargo: number, uf: string): [string, string] {
  const fa = corDoFinalista(2, cargo, uf, a.numero), fb = corDoFinalista(2, cargo, uf, b.numero);
  const livres = ['var(--s0)', 'var(--s1)', 'var(--s2)'].filter((c) => c !== fa && c !== fb);
  const ca = fa ?? livres.shift()!;
  const cb = fb && fb !== ca ? fb : livres.find((c) => c !== ca)!;
  return [ca, cb];
}

// Barra dividida pelos votos válidos dos dois (somam 100%); antes dos votos, neutra ao meio
function BarraConfronto({ a, b, cor }: { a: Candidato; b: Candidato; cor: [string, string] }) {
  const vazio = a.votos + b.votos <= 0;
  const total = a.percentual + b.percentual;
  const parteA = !vazio && total > 0 ? (a.percentual / total) * 100 : 50;
  return (
    <div className={`confronto-barra${vazio ? ' confronto-barra-vazia' : ''}`} aria-hidden="true">
      <span style={{ width: `${parteA}%`, background: vazio ? undefined : cor[0] }} />
      <span style={{ width: `${100 - parteA}%`, background: vazio ? undefined : cor[1] }} />
      <i className="confronto-barra-meio" />
    </div>
  );
}

export function ConfrontoPresidente({ candidatos }: { candidatos: Candidato[] }) {
  // Presidente é a âncora dos lados: a ordem pelo número já é a de referência
  const par = ordenarConfronto(candidatos);
  if (!par) return null;
  const [a, b] = par;
  const cor = cores(a, b, 1, 'br');
  const temVotos = a.votos + b.votos > 0;
  const lado = (c: Candidato, i: number) => (
    <div className={`confronto-lado${i === 1 ? ' confronto-lado-direita' : ''}`}>
      <Foto c={c} />
      <div className="confronto-lado-texto">
        <strong>{c.nome}</strong>
        <span>{c.partido} · {c.numero}</span>
        {/* Texto na cor de texto (legível em qualquer tema); a cor do partido vai no marcador e na barra */}
        <span className="confronto-pct"><i className="marcador-cor" style={{ background: cor[i] }} aria-hidden="true" />{temVotos ? pct(c.percentual) : '–'}</span>
        {temVotos && <span className="confronto-votos">{votos(c.votos)}</span>}
      </div>
    </div>
  );
  return (
    <div className="confronto" aria-label={`${a.nome} ${pct(a.percentual)}, ${b.nome} ${pct(b.percentual)}`}>
      <div className="confronto-lados">{lado(a, 0)}{lado(b, 1)}</div>
      <BarraConfronto a={a} b={b} cor={cor} />
    </div>
  );
}

export function Governadores({ intervaloMs, onAbrir }: { intervaloMs: number; onAbrir: (uf: string) => void }) {
  const [disputas, setDisputas] = useState<DisputaDoTurno[]>();
  const [seuEstado] = useState(lerEstadoSalvo);

  // Polling no ritmo do backend; a rota responde 304 enquanto nenhuma das disputas muda
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try { setDisputas((await buscarDisputas(ctrl.signal)).disputas); } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [intervaloMs]);

  const lados = ladosPorPartido(disputas ?? []);
  const governadores = (disputas ?? []).filter((d) => d.cargo === 3)
    .sort((x, y) => (NOMES_UF[x.uf] ?? x.uf).localeCompare(NOMES_UF[y.uf] ?? y.uf, 'pt-BR'));
  if (!governadores.length) return null;

  return (
    <div className="governadores" aria-labelledby="governadores-titulo">
      <div className="inicio-bloco-cabecalho">
        <h3 id="governadores-titulo">Governadores</h3>
        <span className="governadores-qtd">{governadores.length} estados</span>
      </div>
      <ul className="governadores-lista">
        {governadores.map((d) => {
          const par = ordenarConfronto(d.candidatos, lados);
          if (!par) return null;
          const [a, b] = par;
          const cor = cores(a, b, d.cargo, d.uf);
          const temVotos = a.votos + b.votos > 0;
          const nomeUf = NOMES_UF[d.uf] ?? d.uf.toUpperCase();
          const descricao = temVotos
            ? `${nomeUf}: ${a.nome} ${pct(a.percentual)}, ${b.nome} ${pct(b.percentual)}, ${pct(d.pst)} totalizado. Abrir a disputa`
            : `${nomeUf}: ${a.nome} contra ${b.nome}, totalização ainda não começou. Abrir a disputa`;
          return (
            <li key={d.uf}>
              <button type="button" className={`governador${d.uf === seuEstado ? ' governador-seu' : ''}`}
                onClick={() => onAbrir(d.uf)} aria-label={descricao}>
                <span className="governador-uf"><Bandeira uf={d.uf} />{d.uf.toUpperCase()}</span>
                <span className="governador-confronto">
                  {/* Percentuais em cima, nomes embaixo: cada nome tem metade da largura inteira
                      (no celular, dividindo linha com o percentual, sobravam 4 letras) */}
                  {temVotos && (
                    <span className="governador-pcts">
                      <strong><i className="marcador-cor" style={{ background: cor[0] }} aria-hidden="true" />{pct(a.percentual)}</strong>
                      <strong>{pct(b.percentual)}<i className="marcador-cor marcador-cor-depois" style={{ background: cor[1] }} aria-hidden="true" /></strong>
                    </span>
                  )}
                  <BarraConfronto a={a} b={b} cor={cor} />
                  <span className="governador-nomes">
                    <span className="governador-nome">{a.nome}</span>
                    <span className="governador-nome governador-nome-direita">{b.nome}</span>
                  </span>
                </span>
                <span className="governador-pst">{temVotos || d.pst > 0 ? pct(d.pst).replace(/,\d+%$/, '%') : '–'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
