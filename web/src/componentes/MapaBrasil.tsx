import { useId, useMemo, useRef, useState, useEffect } from 'react';
import type { EstadoPanorama } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { pct } from '../formato.ts';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';
import { GEOMETRIA_UFS } from './mapa-brasil-geo.ts';

// Em telas de toque não há hover: tocar num estado abre um card (liderança de Presidente) em
// vez de navegar para a visão do estado. Tocar de novo no mesmo estado (ou fora) fecha o card.
const EH_TOQUE = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

// Mapa do Brasil por UF: andamento da totalização ou líder por estado.
//
// API
// ---
// <MapaBrasil
//   estados={panorama.estados}         // EstadoPanorama[] (shared/tipos.ts): pst 0-100 | null, lider: Candidato | null
//   rotuloLider="Presidente"            // nome do cargo mostrado no tooltip/legenda do modo 'lider'
//   modo="andamento"                    // 'andamento' (padrão) pinta por % de seções totalizadas
//                                       // 'lider' pinta pela cor do candidato que lidera em cada UF
//   corDoCandidato={(numero) => cor}    // obrigatório em modo 'lider'; undefined/"" -> estado cinza (sem cor atribuída)
//   selecionado={uf}                    // uf (sigla minúscula) com foco/seleção visual, opcional
//   onSelecionar={(uf) => ...}          // clique, Enter/Espaço ou toque num estado
//   verComoLista={() => ...}            // opcional: se informado, mostra um botão "Ver como lista" (alternativa
//                                       // acessível ao mapa; o pai decide o que fazer, ex.: trocar de aba)
// />
//
// O componente é de só leitura visual: não busca dados, não navega sozinho. Estados sem pst (null)
// e sem lider aparecem como "sem dados". Geometria em ./mapa-brasil-geo.ts (ver fonte/licença lá).

export type ModoMapa = 'andamento' | 'lider';

interface Props {
  estados: EstadoPanorama[];
  rotuloLider: string;
  modo?: ModoMapa;
  corDoCandidato?: (c: { numero: string; nome: string }) => string | undefined;
  selecionado?: string;
  onSelecionar: (uf: string) => void;
  verComoLista?: () => void;
}

// Escala sequencial de uma só cor (claro -> escuro), validada com o skill de dataviz
// (node scripts/validate_palette.js ... --ordinal): ALL CHECKS PASS nos dois temas.
// Não usa verde/amarelo/laranja/vermelho de propósito: essa escala evitaria parecer
// "bom/ruim" e colidiria com as cores dos candidatos (--s0..--s7 em estilos.css).
const FAIXAS = [
  { chave: 'vazio', rotulo: 'Sem dados', teste: (p: number | null) => p === null },
  { chave: 'f0', rotulo: '0%', teste: (p: number | null) => p === 0 },
  { chave: 'f1', rotulo: '1–29%', teste: (p: number | null) => p !== null && p > 0 && p < 30 },
  { chave: 'f2', rotulo: '30–69%', teste: (p: number | null) => p !== null && p >= 30 && p < 70 },
  { chave: 'f3', rotulo: '70–99%', teste: (p: number | null) => p !== null && p >= 70 && p < 100 },
  { chave: 'f4', rotulo: '100%', teste: (p: number | null) => p !== null && p >= 100 },
] as const;

function faixaDe(pst: number | null): (typeof FAIXAS)[number]['chave'] {
  for (const f of FAIXAS) if (f.teste(pst)) return f.chave;
  return 'vazio';
}

// UFs pequenas demais para receber toque/clique direto no contorno no mapa inteiro:
// recebem um marcador fora da forma, ligado por uma linha guia ao centróide real.
// Offsets pensados para caber dentro do bbox natural do mapa (sem alargar a viewBox além
// do necessário) e para não colidir com siglas vizinhas (GO/TO/BA/MG) nem com outros
// marcadores. O DF usa a área vazia a sudoeste de GO (entre MT, MS e GO no mapa), longe
// de qualquer contorno ou rótulo.
const PEQUENAS_OFFSET: Record<string, { dx: number; dy: number }> = {
  df: { dx: -5.2, dy: 3.2 },
  // Leque do Nordeste: RN mais ao norte, PB/PE/AL/SE em degraus abaixo, todos deslocados
  // para a direita da costa para não se sobrepor entre si nem ao contorno de PE/BA.
  rn: { dx: 3.2, dy: -1.4 },
  pb: { dx: 4.2, dy: -0.1 },
  pe: { dx: 5.2, dy: 1.1 },
  al: { dx: 4.9, dy: 2.4 },
  se: { dx: 3.7, dy: 3.6 },
  es: { dx: 3.2, dy: 1.4 },
  rj: { dx: 2.5, dy: 3.2 },
};

// Raio do marcador (mesma unidade das coordenadas do mapa) + folga para o rótulo/linha guia:
// usado para calcular quanto a viewBox precisa crescer além do bbox puro da geometria.
const MARCADOR_RAIO = 1.3;
const MARCADOR_FOLGA = 0.6;

// UFs com área grande o bastante para o rótulo de sigla caber dentro do contorno
const SIGLA_DENTRO = new Set(['am', 'pa', 'mt', 'ms', 'go', 'ba', 'mg', 'sp', 'rs', 'to', 'pi', 'ma', 'ac', 'ro', 'rr', 'ap', 'pr', 'sc']);

// ViewBox calculada a partir do bbox real da geometria + a posição de cada marcador
// (centróide + offset + raio do marcador + folga), para nenhum marcador do leque do
// Nordeste (ou qualquer outro) ficar cortado pela borda do SVG em nenhuma largura de tela.
function calcularViewBox(): string {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const g of GEOMETRIA_UFS) {
    const nums = g.path.match(/-?\d+\.?\d*/g);
    if (!nums) continue;
    for (let i = 0; i < nums.length; i += 2) {
      const x = Number(nums[i]);
      const y = Number(nums[i + 1]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  for (const [sigla, offset] of Object.entries(PEQUENAS_OFFSET)) {
    const g = GEOMETRIA_UFS.find((u) => u.sigla === sigla);
    if (!g) continue;
    const mx = g.cx + offset.dx, my = g.cy + offset.dy;
    const r = MARCADOR_RAIO + MARCADOR_FOLGA;
    if (mx - r < minX) minX = mx - r; if (mx + r > maxX) maxX = mx + r;
    if (my - r < minY) minY = my - r; if (my + r > maxY) maxY = my + r;
  }
  const pad = 1;
  const x = minX - pad, y = minY - pad, w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2;
  return `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
}

const MAPA_VIEWBOX = calcularViewBox();

const ORDEM_TECLADO = [...GEOMETRIA_UFS].map((u) => u.sigla).sort((a, b) => {
  const geoA = GEOMETRIA_UFS.find((g) => g.sigla === a)!;
  const geoB = GEOMETRIA_UFS.find((g) => g.sigla === b)!;
  // ordena por linha (cy) e depois coluna (cx), para setas se comportarem como leitura
  if (Math.abs(geoA.cy - geoB.cy) > 1.5) return geoA.cy - geoB.cy;
  return geoA.cx - geoB.cx;
});

export function MapaBrasil({ estados, rotuloLider, modo = 'andamento', corDoCandidato, selecionado, onSelecionar, verComoLista }: Props) {
  const titleId = useId();
  const descId = useId();
  const [focoUf, setFocoUf] = useState<string | null>(null);
  const [dica, setDica] = useState<{ uf: string; x: number; y: number } | null>(null);
  const [cardUf, setCardUf] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Tocar fora do card fecha (tocar em outro estado é tratado pelo clique do próprio estado)
  useEffect(() => {
    if (!cardUf) return;
    const fechar = (ev: PointerEvent) => {
      const alvo = ev.target as HTMLElement | null;
      if (alvo && !alvo.closest('.mb-card') && !alvo.closest('.mb-uf')) setCardUf(null);
    };
    document.addEventListener('pointerdown', fechar);
    return () => document.removeEventListener('pointerdown', fechar);
  }, [cardUf]);

  const porUf = useMemo(() => new Map(estados.map((e) => [e.uf, e])), [estados]);

  // Legenda do modo 'lider': um item por candidato que lidera em ao menos 1 estado (a
  // identidade não pode depender só da cor do mapa), com o total de estados liderados,
  // ordenado do que mais lidera para o que menos lidera.
  const liderancas = useMemo(() => {
    if (modo !== 'lider') return [];
    const porNumero = new Map<string, { nome: string; numero: string; estados: number }>();
    for (const e of estados) {
      if (!e.lider) continue;
      const atual = porNumero.get(e.lider.numero);
      if (atual) atual.estados += 1;
      else porNumero.set(e.lider.numero, { nome: e.lider.nome, numero: e.lider.numero, estados: 1 });
    }
    return [...porNumero.values()].sort((a, b) => b.estados - a.estados || a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [estados, modo]);

  const ufAtivaParaFoco = focoUf ?? selecionado ?? ORDEM_TECLADO[0] ?? 'sp';

  function mover(dir: -1 | 1) {
    const i = ORDEM_TECLADO.indexOf(ufAtivaParaFoco);
    const prox = ORDEM_TECLADO[(i + dir + ORDEM_TECLADO.length) % ORDEM_TECLADO.length] ?? ufAtivaParaFoco;
    setFocoUf(prox);
    const el = svgRef.current?.querySelector<SVGElement>(`[data-uf="${prox}"]`);
    el?.focus();
  }

  function corFaixa(pst: number | null): string {
    return `var(--mapa-${faixaDe(pst)})`;
  }

  function corLider(e: EstadoPanorama | undefined): string {
    if (!e?.lider || !corDoCandidato) return 'var(--mapa-vazio)';
    const cor = corDoCandidato(e.lider);
    return cor || 'var(--mapa-sem-cor)';
  }

  function corDoEstado(uf: string): string {
    const e = porUf.get(uf);
    if (modo === 'lider') return corLider(e);
    return corFaixa(e?.pst ?? null);
  }

  function mostrarDica(uf: string, evt: React.MouseEvent | React.FocusEvent) {
    if (EH_TOQUE) return; // no toque, o card substitui o tooltip
    const container = (evt.currentTarget as SVGElement).closest('.mb-wrap') as HTMLElement | null;
    const rectContainer = container?.getBoundingClientRect();
    const rectAlvo = (evt.currentTarget as SVGElement).getBoundingClientRect();
    if (!rectContainer) return;
    setDica({ uf, x: rectAlvo.left + rectAlvo.width / 2 - rectContainer.left, y: rectAlvo.top - rectContainer.top });
  }

  const descricaoGeral = modo === 'lider'
    ? `Mapa do Brasil colorido pelo candidato a ${rotuloLider} que lidera em cada estado. Use Tab e as setas para navegar pelos estados; Enter ou Espaço para abrir o estado.`
    : 'Mapa do Brasil colorido pelo percentual de seções totalizadas em cada estado. Use Tab e as setas para navegar pelos estados; Enter ou Espaço para abrir o estado.';

  return (
    <div className="mb-wrap">
      <style>{`
        .mb-wrap {
          --mapa-vazio: var(--contexto);
          --mapa-sem-cor: var(--contexto);
          /* tema escuro (referência) */
          --mapa-f0: #2a5473;
          --mapa-f1: #356d99;
          --mapa-f2: #4f8fb8;
          --mapa-f3: #79b4d2;
          --mapa-f4: #aedcee;
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 10px;
          container-type: inline-size;
        }
        :root[data-tema="claro"] .mb-wrap {
          --mapa-f0: #8fb8d2;
          --mapa-f1: #6ea3c4;
          --mapa-f2: #4e86ae;
          --mapa-f3: #2a6490;
          --mapa-f4: #123850;
        }
        .mb-svg-area { position: relative; width: 100%; }
        .mb-svg { width: 100%; height: auto; display: block; max-height: 520px; margin: 0 auto; }
        .mb-uf {
          stroke: var(--superficie);
          stroke-width: 0.12;
          cursor: pointer;
          transition: filter 120ms ease, stroke-width 120ms ease;
        }
        .mb-uf:hover { filter: brightness(1.12); }
        .mb-uf:focus-visible { outline: none; }
        .mb-uf.mb-selecionado { stroke: var(--tinta); stroke-width: 0.3; }
        @media (prefers-reduced-motion: reduce) {
          .mb-uf { transition: none; }
        }
        .mb-sigla {
          font-size: 1.6px;
          font-weight: 700;
          fill: #fff;
          paint-order: stroke;
          stroke: rgb(0 0 0 / .35);
          stroke-width: 0.3px;
          pointer-events: none;
          text-anchor: middle;
          dominant-baseline: middle;
        }
        .mb-marcador {
          fill: var(--superficie);
          stroke: var(--linha);
          stroke-width: 0.15;
        }
        .mb-marcador-interno { pointer-events: none; }
        .mb-guia {
          stroke: var(--suave);
          stroke-width: 0.1;
          fill: none;
          opacity: .6;
          pointer-events: none;
        }
        .mb-rotulo-pequeno {
          font-size: 1.5px;
          font-weight: 700;
          fill: var(--tinta);
          pointer-events: none;
          text-anchor: middle;
          dominant-baseline: middle;
        }
        .mb-legenda {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px 14px;
          font-size: .8rem;
          color: var(--suave);
        }
        .mb-legenda-item { display: flex; align-items: center; gap: 5px; }
        .mb-legenda-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--linha); flex: none; }
        .mb-legenda-swatch-redonda { border-radius: 50%; }
        .mb-tooltip {
          position: absolute;
          transform: translate(-50%, calc(-100% - 10px));
          background: var(--superficie);
          border: 1px solid var(--linha);
          border-radius: var(--raio, 10px);
          box-shadow: 0 8px 24px rgb(0 0 0 / .18);
          padding: 10px 12px;
          min-width: 200px;
          max-width: 260px;
          pointer-events: none;
          z-index: 5;
        }
        .mb-tooltip-cabecalho { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--tinta); }
        .mb-tooltip-andamento { margin-top: 4px; font-size: .85rem; color: var(--suave); }
        .mb-tooltip-lider { margin-top: 8px; display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--linha); }
        .mb-tooltip-lider-nome { font-weight: 600; color: var(--tinta); font-size: .9rem; }
        .mb-tooltip-lider-pct { color: var(--suave); font-size: .82rem; }
        .mb-tooltip-sem-dados { margin-top: 4px; font-size: .85rem; color: var(--suave); }
        .mb-card {
          position: absolute;
          left: 10px; right: 10px; bottom: 10px;
          background: var(--superficie);
          border: 1px solid var(--linha);
          border-radius: var(--raio, 10px);
          box-shadow: 0 12px 32px rgb(0 0 0 / .28);
          padding: 12px 14px;
          z-index: 6;
        }
        .mb-card-fechar {
          position: absolute; top: 8px; right: 8px;
          border: 0; background: transparent; cursor: pointer;
          color: var(--suave); font-size: 1rem; line-height: 1; padding: 4px;
        }
        .mb-card-fechar:hover { color: var(--tinta); }
        .mb-card-cabecalho { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--tinta); padding-right: 1.5rem; }
        .mb-card-cabecalho .bandeira { width: 1.5rem; height: 1rem; }
        .mb-card-andamento { margin-top: 4px; font-size: .85rem; color: var(--suave); }
        .mb-card-lider { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
        .mb-card-lider .foto { width: 3rem; height: 3rem; }
        .mb-card-lider-texto { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
        .mb-card-lider-texto strong { font-weight: 600; color: var(--tinta); }
        .mb-card-lider-texto > span { color: var(--suave); font-size: .82rem; }
        .mb-card-lider-placar { font-variant-numeric: tabular-nums; }
        .mb-card-sem-dados { margin-top: 10px; font-size: .85rem; color: var(--suave); }
        .mb-card-ver {
          display: block; width: 100%; margin-top: 10px;
          font: inherit; font-size: .85rem; color: var(--segundo-turno);
          background: none; border: 1px solid var(--linha); border-radius: 8px;
          padding: 7px 10px; cursor: pointer;
        }
        .mb-card-ver:hover { background: var(--fundo); }
        .mb-lista-link {
          align-self: flex-start;
          font: inherit;
          font-size: .85rem;
          color: var(--segundo-turno);
          background: none;
          border: 1px solid var(--linha);
          border-radius: 8px;
          padding: 6px 10px;
          cursor: pointer;
        }
        .mb-lista-link:hover { background: var(--fundo); }
      `}</style>

      <div className="mb-svg-area">
        <svg
          ref={svgRef}
          className="mb-svg"
          viewBox={MAPA_VIEWBOX}
          role="group"
          aria-labelledby={titleId}
          aria-describedby={descId}
        >
          <title id={titleId}>Mapa do Brasil por estado</title>
          <desc id={descId}>{descricaoGeral}</desc>

          {/* Camada 1: contornos das UFs + siglas internas (ordem alfabética do módulo de geometria) */}
          {GEOMETRIA_UFS.map((g) => {
            const offset = PEQUENAS_OFFSET[g.sigla];
            const e = porUf.get(g.sigla);
            const nomeUf = NOMES_UF[g.sigla] ?? g.sigla.toUpperCase();
            const rotuloAria = modo === 'lider'
              ? `${nomeUf}: ${e?.lider ? `${e.lider.nome} lidera para ${rotuloLider} com ${pct(e.lider.percentual)}` : 'sem líder definido'}`
              : `${nomeUf}: ${e?.pst === null || e?.pst === undefined ? 'sem dados' : `${pct(e.pst)} das seções totalizadas`}`;
            const ehSelecionado = selecionado === g.sigla;
            return (
              <g key={g.sigla}>
                <path
                  data-uf={g.sigla}
                  className={`mb-uf${ehSelecionado ? ' mb-selecionado' : ''}`}
                  d={g.path}
                  fill={corDoEstado(g.sigla)}
                  tabIndex={ufAtivaParaFoco === g.sigla ? 0 : -1}
                  role="button"
                  aria-label={rotuloAria}
                  aria-pressed={ehSelecionado}
                  onMouseEnter={(evt) => mostrarDica(g.sigla, evt)}
                  onMouseLeave={() => setDica(null)}
                  onFocus={(evt) => { setFocoUf(g.sigla); if (!EH_TOQUE) mostrarDica(g.sigla, evt); }}
                  onBlur={() => setDica(null)}
                  onClick={() => {
                    if (EH_TOQUE) setCardUf((atual) => (atual === g.sigla ? null : g.sigla));
                    else onSelecionar(g.sigla);
                  }}
                  onKeyDown={(evt) => {
                    if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); onSelecionar(g.sigla); }
                    else if (evt.key === 'ArrowRight' || evt.key === 'ArrowDown') { evt.preventDefault(); mover(1); }
                    else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowUp') { evt.preventDefault(); mover(-1); }
                  }}
                />
                {!offset && SIGLA_DENTRO.has(g.sigla) && (
                  <text x={g.cx} y={g.cy} className="mb-sigla">{g.sigla.toUpperCase()}</text>
                )}
              </g>
            );
          })}

          {/* Camada 2: marcadores dos estados pequenos (linha guia + círculo + sigla), sempre por
              cima de todos os contornos (inclusive os desenhados depois na camada 1), para nunca
              ficarem tampados por uma UF vizinha maior. */}
          {GEOMETRIA_UFS.filter((g) => PEQUENAS_OFFSET[g.sigla]).map((g) => {
            const offset = PEQUENAS_OFFSET[g.sigla]!;
            const mx = g.cx + offset.dx, my = g.cy + offset.dy;
            return (
              <g key={`marcador-${g.sigla}`}>
                <line x1={g.cx} y1={g.cy} x2={mx} y2={my} className="mb-guia" />
                <circle
                  className="mb-marcador"
                  cx={mx}
                  cy={my}
                  r={MARCADOR_RAIO}
                  aria-hidden="true"
                  style={{ pointerEvents: 'none' }}
                />
                <text x={mx} y={my} className="mb-rotulo-pequeno mb-marcador-interno">
                  {g.sigla.toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>

        {dica && (() => {
          const e = porUf.get(dica.uf);
          const nomeUf = NOMES_UF[dica.uf] ?? dica.uf.toUpperCase();
          return (
            <div className="mb-tooltip" style={{ left: dica.x, top: dica.y }} role="status">
              <div className="mb-tooltip-cabecalho">
                <Bandeira uf={dica.uf} />
                <span>{nomeUf}</span>
              </div>
              <div className="mb-tooltip-andamento">
                {e?.pst === null || e?.pst === undefined ? 'Sem dados do TSE no momento' : `${pct(e.pst)} das seções totalizadas`}
              </div>
              {e?.lider ? (
                <div className="mb-tooltip-lider">
                  <Foto c={e.lider} />
                  <span>
                    <span className="mb-tooltip-lider-nome">{e.lider.nome}</span>{' '}
                    <span className="mb-tooltip-lider-pct">({pct(e.lider.percentual)})</span>
                  </span>
                </div>
              ) : (
                <div className="mb-tooltip-sem-dados">{rotuloLider}: aguardando totalização</div>
              )}
            </div>
          );
        })()}

        {cardUf && (() => {
          const e = porUf.get(cardUf);
          const nomeUf = NOMES_UF[cardUf] ?? cardUf.toUpperCase();
          const vantagem = e?.vantagem;
          return (
            <div className="mb-card" role="dialog" aria-label={`Liderança para ${rotuloLider} em ${nomeUf}`}>
              <button type="button" className="mb-card-fechar" aria-label="Fechar" onClick={() => setCardUf(null)}>✕</button>
              <div className="mb-card-cabecalho">
                <Bandeira uf={cardUf} />
                <span>{nomeUf}</span>
              </div>
              <div className="mb-card-andamento">
                {e?.pst === null || e?.pst === undefined ? 'Sem dados do TSE no momento' : `${pct(e.pst)} das seções totalizadas`}
              </div>
              {e?.lider ? (
                <div className="mb-card-lider">
                  <Foto c={e.lider} />
                  <span className="mb-card-lider-texto">
                    <strong>{e.lider.nome}</strong>
                    <span>{e.lider.partido}</span>
                    <span className="mb-card-lider-placar">
                      {pct(e.lider.percentual)}
                      {vantagem !== null && vantagem !== undefined && (
                        <> · {vantagem.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p. à frente</>
                      )}
                    </span>
                  </span>
                </div>
              ) : (
                <div className="mb-card-sem-dados">{rotuloLider}: aguardando totalização</div>
              )}
              <button type="button" className="mb-card-ver" onClick={() => onSelecionar(cardUf)}>
                Ver {nomeUf} completo
              </button>
            </div>
          );
        })()}
      </div>

      <div className="mb-legenda">
        {modo === 'andamento'
          ? FAIXAS.map((f) => (
              <span className="mb-legenda-item" key={f.chave}>
                <span className="mb-legenda-swatch" aria-hidden="true" style={{ background: `var(--mapa-${f.chave})` }} />
                {f.rotulo}
              </span>
            ))
          : (
            <>
              {liderancas.map((l) => (
                <span className="mb-legenda-item" key={l.numero}>
                  <span
                    className="mb-legenda-swatch mb-legenda-swatch-redonda"
                    aria-hidden="true"
                    style={{ background: corDoCandidato?.({ numero: l.numero, nome: l.nome }) || 'var(--mapa-sem-cor)' }}
                  />
                  {l.nome} · {l.estados} {l.estados === 1 ? 'estado' : 'estados'}
                </span>
              ))}
              <span className="mb-legenda-item">
                <span className="mb-legenda-swatch" aria-hidden="true" style={{ background: 'var(--mapa-sem-cor)' }} />
                Sem dados
              </span>
            </>
          )}
      </div>

      {verComoLista && (
        <button type="button" className="mb-lista-link" onClick={verComoLista}>
          Ver como lista
        </button>
      )}
    </div>
  );
}
