import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Candidato, ConfigPublica, EstadoPanorama, Panorama, PontoHistorico, Resultado, VisaoEstado } from '../../../shared/tipos.ts';
import { NOMES_UF, REGIOES } from '../../../shared/ufs.ts';
import { agora as relogio, ajustarCandidatos, buscarEstado, buscarHistorico, buscarPanorama, buscarResultado, comTurno, mesclarHistorico, turnoDaTela } from '../api.ts';
import { dataHora, pct, votos } from '../formato.ts';
import { Avisos } from './Avisos.tsx';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';
import { Evolucao } from './Evolucao.tsx';
import { MapaMini } from './MapaMini.tsx';
import { Novidades } from './Novidades.tsx';
import { MAX_SERIES, corDoFinalista, type Tema } from '../paleta.ts';
import { coresDaDisputa } from '../cores.ts';
import { ResumoLideranca } from './ResumoLideranca.tsx';
import { ConfrontoPresidente, Governadores } from './PlacarSegundoTurno.tsx';

// Página inicial: o que a maioria quer saber em poucos segundos, sem precisar escolher
// cargo e local primeiro. Ordem: contagem regressiva (só antes da totalização) → indicadores
// → Presidente + Mapa (lado a lado no desktop) → Evolução + Novidades (lado a lado no desktop)
// → Seu estado (compacto) → Pelo país.

const CHAVE_ESTADO_PREFERIDO = 'eleicoes2026:estado';
const nome = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();

function lerEstadoSalvo(): string | null {
  try {
    return localStorage.getItem(CHAVE_ESTADO_PREFERIDO);
  } catch {
    return null;
  }
}
function salvarEstado(uf: string | null) {
  try {
    if (uf) localStorage.setItem(CHAVE_ESTADO_PREFERIDO, uf);
    else localStorage.removeItem(CHAVE_ESTADO_PREFERIDO);
  } catch { /* modo privado ou localStorage indisponível: segue sem lembrar */ }
}

// Formato compacto "68,4 mi" para votos grandes
function votosCompacto(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mi`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mil`;
  return v.toLocaleString('pt-BR');
}

// Conta regressiva até o início da totalização, atualizada a cada minuto
function useContagem(inicioApuracao: number | null) {
  const [agora, setAgora] = useState(relogio);
  useEffect(() => {
    if (inicioApuracao === null || agora >= inicioApuracao) return;
    const t = setInterval(() => setAgora(relogio()), 30_000);
    return () => clearInterval(t);
  }, [inicioApuracao, agora]);
  if (inicioApuracao === null || agora >= inicioApuracao) return null;
  const faltamMin = Math.max(0, Math.round((inicioApuracao - agora) / 60_000));
  // Mais de 2 dias: em dias (ex.: 2º turno visto semanas antes)
  if (faltamMin >= 48 * 60) return `${Math.floor(faltamMin / (24 * 60))} dias`;
  const h = Math.floor(faltamMin / 60);
  const m = faltamMin % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}min` : ''}` : `${m}min`;
}

interface PropsInicio {
  cfg: ConfigPublica | undefined;
  tema: Tema;
  onAbrirDisputa: (cargo: number, uf: string) => void;
  onAbrirEstado: (uf: string) => void;
  onAbrirPorEstado: () => void;
  onAbrirMapa: () => void;
  onAbrirNovidades: () => void;
}

export function Inicio({ cfg, tema, onAbrirDisputa, onAbrirEstado, onAbrirPorEstado, onAbrirMapa, onAbrirNovidades }: PropsInicio) {
  const faltam = useContagem(cfg?.inicioApuracao ?? null);
  // O relógio do aparelho diz quando a totalização deveria começar, mas o dado real do TSE
  // manda: se as seções já começaram a ser totalizadas, a contagem some mesmo que o relógio
  // ainda não tenha batido 17h (ex.: adiantada no servidor de testes).
  const [apuracaoComecouDados, setApuracaoComecouDados] = useState(false);
  const mostrarContagem = faltam !== null && !apuracaoComecouDados;

  const [resultado, setResultado] = useState<Resultado>();
  const [historico, setHistorico] = useState<PontoHistorico[]>([]);
  const [panorama, setPanorama] = useState<Panorama>();
  const [erro, setErro] = useState<string>();
  const [aoVivo, setAoVivo] = useState(false);
  const [verificadoEm, setVerificadoEm] = useState<number>();
  const [encerrado, setEncerrado] = useState(cfg?.finalizado ?? false);

  const intervaloMs = cfg?.intervaloMs ?? 30_000;
  // 2º turno: o card de Presidente vira confronto e ganha os governadores (o Início remonta ao trocar de turno)
  const segundoTurno = (turnoDaTela() ?? 1) > 1;
  const temGovernador = !!cfg?.cargos.some((c) => c.codigo === 3);
  // Turno encerrado (ou anterior): os números não mudam mais; sem conexão ao vivo nem polling
  const finalizado = cfg?.finalizado ?? false;

  // Placar nacional de Presidente, com SSE (mesmo padrão de App.tsx) + histórico para o gráfico
  useEffect(() => {
    const ctrl = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const depois = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
    };
    let versao: number | null | undefined;
    let pontosHist: PontoHistorico[] = [];
    let acompanhados = new Set<string>();
    let vivo = false;
    let seguranca: ReturnType<typeof setTimeout> | undefined;
    let rodando = false, deNovo = false;

    const carregar = async () => {
      if (rodando) { deNovo = true; return; }
      rodando = true;
      clearTimeout(seguranca);
      try {
        const r = await buscarResultado('br', 1, ctrl.signal);
        if (r.instante !== versao) {
          setResultado(r);
          try {
            const desde = pontosHist.at(-1)?.instante ?? 0;
            const h = await buscarHistorico('br', 1, 'hora', 30, desde, ctrl.signal);
            pontosHist = mesclarHistorico(pontosHist, h.pontos, 'hora');
            const novatos = desde ? h.numeros.filter((n) => !acompanhados.has(n)) : [];
            const passado = novatos.length ? (await buscarHistorico('br', 1, 'hora', 30, 0, ctrl.signal, novatos)).pontos : [];
            acompanhados = new Set(h.numeros);
            pontosHist = ajustarCandidatos(pontosHist, passado, 'hora', acompanhados);
            setHistorico(pontosHist);
            versao = r.instante;
          } catch (e) {
            if (ctrl.signal.aborted) throw e;
          }
        }
        setErro(undefined);
        setVerificadoEm(Date.now());
      } catch (e) {
        if (!ctrl.signal.aborted) setErro((e as Error).message);
      } finally {
        rodando = false;
      }
      if (ctrl.signal.aborted) return;
      if (deNovo) { deNovo = false; void carregar(); return; }
      if (finalizado && versao !== undefined) return;
      seguranca = setTimeout(carregar, vivo ? 120_000 : intervaloMs);
    };

    let fonte: EventSource | undefined;
    let jaAbriu = false;
    const conectar = () => {
      fonte = new EventSource(comTurno('/api/eventos?uf=br&cargo=1'));
      fonte.onopen = () => {
        vivo = true; setAoVivo(true);
        if (jaAbriu) void carregar();
        jaAbriu = true;
      };
      fonte.addEventListener('atualizacao', (ev) => {
        const { instante, espalharMs } = JSON.parse((ev as MessageEvent<string>).data) as { instante: number | null; espalharMs?: number };
        if (instante !== versao) depois(() => void carregar(), Math.random() * (espalharMs ?? 2_000));
      });
      fonte.addEventListener('finalizado', () => setEncerrado(true));
      fonte.onerror = () => {
        vivo = false; setAoVivo(false);
        if (fonte?.readyState === EventSource.CLOSED && !ctrl.signal.aborted) depois(conectar, 60_000);
        clearTimeout(seguranca);
        seguranca = setTimeout(carregar, intervaloMs);
      };
    };

    const aoVoltar = () => { if (!document.hidden) void carregar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    void carregar();
    if (!finalizado) conectar();
    return () => {
      ctrl.abort();
      fonte?.close();
      clearTimeout(seguranca);
      timers.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [intervaloMs, finalizado]);

  // Panorama nacional (para indicador "Estados concluídos" e a grade "Pelo país")
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try { setPanorama(await buscarPanorama(ctrl.signal)); } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [intervaloMs]);

  const candidatos = resultado?.candidatos ?? [];
  const apuracaoComecou = (resultado?.secoesTotalizadas ?? 0) > 0 && candidatos.some((c) => c.votos > 0);
  // Antes da totalização, um confronto de poucos nomes (2º turno) já aparece, zerado
  const top3 = apuracaoComecou || candidatos.length > 3 ? candidatos.filter((c) => c.votos > 0).slice(0, 3) : candidatos;

  useEffect(() => { setApuracaoComecouDados(apuracaoComecou); }, [apuracaoComecou]);

  const slots = useMemo(() => {
    const top = candidatos.filter((c) => c.votos > 0).slice(0, MAX_SERIES);
    const fonte = top.length ? top : (historico.at(-1)?.cand ?? []).slice(0, MAX_SERIES);
    return new Map([...fonte].map((c) => c.numero)
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
      .map((n, i) => [n, i] as const));
  }, [candidatos, historico]);
  // Cores do gráfico: finalista do 2º turno > cor do partido sem colisão (mesma regra da disputa)
  const coresDosCandidatos = useMemo(() => coresDaDisputa(tema, candidatos.filter((c) => slots.has(c.numero))), [tema, slots, candidatos]);
  const corDe = useCallback((n: string) => corDoFinalista(turnoDaTela(), 1, 'br', n) ?? coresDosCandidatos.get(n), [coresDosCandidatos]);

  const estadosSemExterior = (panorama?.estados ?? []).filter((e) => e.uf !== 'zz');
  const concluidos = estadosSemExterior.filter((e) => (e.pst ?? 0) >= 100).length;

  return (
    <div className="inicio">
      {mostrarContagem && (
        <section className="inicio-contagem" aria-live="polite">
          <p>
            A totalização{cfg?.turno && cfg.turno !== '1º turno' ? ` do ${cfg.turno}` : ''} começa{' '}
            {cfg?.inicioApuracao ? dataHora(cfg.inicioApuracao) : 'às 17h'} (horário de Brasília)
            {faltam && <>, faltam <strong>{faltam}</strong></>}.
          </p>
          {cfg && <Avisos uf="br" cargo={1} chave={cfg.chavePush} proporcional={false} />}
        </section>
      )}

      {erro && !resultado && (
        <p className="status status-erro" role="status">Sem conexão com os resultados ({erro}).</p>
      )}

      <Indicadores resultado={resultado} panorama={panorama} concluidos={concluidos} totalEstados={estadosSemExterior.length} />

      <div className="inicio-grade-2col">
        <section className="inicio-bloco inicio-placar" aria-labelledby="inicio-placar-titulo">
          <div className="inicio-bloco-cabecalho">
            <h2 id="inicio-placar-titulo">Presidente, Brasil</h2>
            <span className="inicio-status">
              {erro
                ? 'Sem conexão'
                : resultado
                  ? encerrado || finalizado
                    ? 'Encerrado'
                    : aoVivo ? <><span className="ao-vivo" aria-hidden="true" />Ao vivo</> : `Atualizado ${dataHora(resultado.instante ?? Date.now())}`
                  : 'Carregando…'}
            </span>
          </div>

          {/* % e barra de seções já aparecem no indicador "Seções totalizadas" logo acima:
              aqui, repetir seria redundante. Nas telas de disputa (fora do Início) continua. */}

          {resultado && !apuracaoComecou && (
            <p className="resumo resumo-espera">A totalização ainda não começou nesta disputa.</p>
          )}

          {resultado && apuracaoComecou && (
            <ResumoLideranca candidatos={candidatos} vagas={1} proporcional={false} />
          )}

          {segundoTurno && <ConfrontoPresidente candidatos={candidatos} />}

          {!segundoTurno && top3.length > 0 && (
            <ol className="inicio-top3" aria-label="Os 3 mais votados">
              {top3.map((c) => (
                <li key={c.numero} className="inicio-top3-item">
                  <Foto c={c} />
                  <span className="inicio-top3-texto">
                    <strong>{c.nome}</strong>
                    <span>{c.partido}</span>
                  </span>
                  <span className="inicio-top3-placar">
                    <span className="inicio-top3-pct">{pct(c.percentual)}</span>
                    <span className="inicio-top3-votos">{votos(c.votos)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}

          {resultado && (
            <button type="button" className="estado-cargo-todos" onClick={() => onAbrirDisputa(1, 'br')}>
              {segundoTurno ? 'Ver a disputa completa' : `Ver todos os ${candidatos.length} candidatos`}
            </button>
          )}

          {segundoTurno && temGovernador && (
            <Governadores intervaloMs={intervaloMs} onAbrir={(uf) => onAbrirDisputa(3, uf)} />
          )}
        </section>

        <MapaMini intervaloMs={intervaloMs} onAbrirEstado={onAbrirEstado} onAbrirMapa={onAbrirMapa}
          cargos={cfg?.cargos.map((c) => c.codigo)} />
      </div>

      <div className="inicio-grade-2col">
        <Evolucao historico={historico} slots={slots}
          corDe={corDe}
          por="hora" onPor={() => {}}
          ativo={null} onDestacar={() => {}} onFixar={() => {}}
          tema={tema} referencia50 compacto />

        <Novidades intervaloMs={intervaloMs} compacto limite={6} onVerTodas={onAbrirNovidades} />
      </div>

      <SeuEstado intervaloMs={intervaloMs} onAbrirEstado={onAbrirEstado} />
      <PeloPais panorama={panorama} onAbrirEstado={onAbrirEstado} onAbrirPorEstado={onAbrirPorEstado} />
    </div>
  );
}

// Linha de indicadores: Seções totalizadas, Votos totalizados, Estados concluídos.
// Antes da totalização os totais vêm zerados: mostra "–" em vez de "0,0 mi" enganoso.
function Indicadores({ resultado, panorama, concluidos, totalEstados }: {
  resultado: Resultado | undefined; panorama: Panorama | undefined; concluidos: number; totalEstados: number;
}) {
  const totais = resultado?.totais;
  const temDados = !!totais && totais.votosTotais > 0;
  const pstBrasil = panorama?.brasil.pst ?? resultado?.secoesTotalizadas ?? null;
  // "N de M seções": usa o campo exato do TSE (totais.secoesTotalizadas). Só recorre ao
  // cálculo pelo percentual quando esse campo vier 0 mas o % já indica totalização em
  // andamento — inconsistência vista apenas no simulador de teste, não no TSE real.
  const secoesContadas = !totais ? null
    : totais.secoesTotalizadas > 0 ? totais.secoesTotalizadas
    : pstBrasil !== null && pstBrasil > 0 ? Math.round((pstBrasil / 100) * totais.secoes)
    : totais.secoesTotalizadas;

  return (
    <div className="inicio-indicadores">
      <div className="indicador indicador-grande">
        <span className="indicador-rotulo">Seções totalizadas</span>
        <strong className="indicador-valor">{pstBrasil === null ? '–' : pct(pstBrasil)}</strong>
        {totais && secoesContadas !== null && (
          <>
            <div className="trilho" aria-hidden="true"><div style={{ width: `${pstBrasil ?? 0}%` }} /></div>
            <span className="indicador-detalhe">{secoesContadas.toLocaleString('pt-BR')} de {totais.secoes.toLocaleString('pt-BR')} seções</span>
          </>
        )}
      </div>
      <div className="indicador-linha">
        <div className="indicador">
          <span className="indicador-rotulo">Votos totalizados</span>
          <strong className="indicador-valor">{temDados ? votosCompacto(totais.votosTotais) : '–'}</strong>
          {temDados && <span className="indicador-detalhe">{totais.votosTotais.toLocaleString('pt-BR')}</span>}
        </div>
        <div className="indicador">
          <span className="indicador-rotulo">Comparecimento</span>
          <strong className="indicador-valor">{temDados && totais.eleitores > 0 ? pct((totais.comparecimento / totais.eleitores) * 100) : '–'}</strong>
          {temDados && <span className="indicador-detalhe">{totais.comparecimento.toLocaleString('pt-BR')} eleitores</span>}
        </div>
        <div className="indicador">
          <span className="indicador-rotulo">Estados concluídos</span>
          <strong className="indicador-valor">{panorama ? `${concluidos} / ${totalEstados}` : '–'}</strong>
          {panorama && (
            <div className="trilho" aria-hidden="true"><div style={{ width: `${totalEstados ? (concluidos / totalEstados) * 100 : 0}%` }} /></div>
          )}
        </div>
      </div>
    </div>
  );
}

// "Seu estado": seletor compacto (não ocupa a tela toda com 27 botões de cara)
function SeuEstado({ intervaloMs, onAbrirEstado }: { intervaloMs: number; onAbrirEstado: (uf: string) => void }) {
  const [uf, setUf] = useState<string | null>(() => lerEstadoSalvo());
  const [escolhendo, setEscolhendo] = useState(false);
  const [dados, setDados] = useState<VisaoEstado>();

  useEffect(() => {
    if (!uf) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try { setDados(await buscarEstado(uf, ctrl.signal)); } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [uf, intervaloMs]);

  const escolher = (u: string) => { setUf(u); salvarEstado(u); setDados(undefined); setEscolhendo(false); };
  const trocar = () => { setEscolhendo(true); };

  if (!uf || escolhendo) {
    return (
      <section className="inicio-bloco inicio-seu-estado" aria-labelledby="inicio-seu-estado-titulo">
        <h2 id="inicio-seu-estado-titulo">Seu estado</h2>
        <p className="inicio-seu-estado-convite">Escolha seu estado para ver Governador, Senado e Presidente nele.</p>
        <label className="seletor-uf inicio-seletor-estado">
          <span className="visualmente-oculto">Escolher estado</span>
          <select defaultValue="" onChange={(e) => e.target.value && escolher(e.target.value)}>
            <option value="" disabled>Escolher estado…</option>
            {Object.keys(NOMES_UF).filter((u) => u !== 'br' && u !== 'zz').sort((a, b) => nome(a).localeCompare(nome(b), 'pt-BR')).map((u) => (
              <option key={u} value={u}>{nome(u)}</option>
            ))}
          </select>
        </label>
      </section>
    );
  }

  const presidente = dados?.cargos.find((c) => c.cargo === 1);
  const governador = dados?.cargos.find((c) => c.cargo === 3);
  const senador = dados?.cargos.find((c) => c.cargo === 5);

  return (
    <section className="inicio-bloco inicio-seu-estado" aria-labelledby="inicio-seu-estado-titulo">
      <div className="inicio-bloco-cabecalho">
        <h2 id="inicio-seu-estado-titulo" className="inicio-seu-estado-nome">
          <Bandeira uf={uf} />
          {nome(uf)}
        </h2>
        <button type="button" className="inicio-trocar" onClick={trocar}>✎ Trocar</button>
      </div>

      {!dados ? (
        <p className="resumo-estados">Carregando…</p>
      ) : (
        <div className="inicio-seu-estado-resumo">
          {governador && (
            <ResumoMini titulo="Governador" candidatos={governador.candidatos} vagas={1} />
          )}
          {senador && (
            <ResumoMini titulo="Senado" candidatos={senador.candidatos} vagas={senador.vagas} />
          )}
          {presidente && (
            <ResumoMini titulo="Presidente" candidatos={presidente.candidatos} vagas={1} />
          )}
        </div>
      )}

      <button type="button" className="estado-cargo-todos" onClick={() => onAbrirEstado(uf)}>
        Ver {nome(uf)} completo
      </button>
    </section>
  );
}

function ResumoMini({ titulo, candidatos, vagas }: { titulo: string; candidatos: Candidato[]; vagas: number }) {
  const comVotos = candidatos.filter((c) => c.votos > 0);
  if (!comVotos.length) return (
    <p className="inicio-resumo-mini"><strong>{titulo}:</strong> aguardando totalização</p>
  );
  const mostrar = comVotos.slice(0, Math.min(vagas, 2) || 1);
  return (
    <p className="inicio-resumo-mini">
      <strong>{titulo}:</strong>{' '}
      {mostrar.map((c, i) => (
        <span key={c.numero}>
          {i > 0 && ' e '}
          {c.nome} ({pct(c.percentual)})
        </span>
      ))}
    </p>
  );
}

// "Pelo país": cards por região, com o total já apurado da região e o de cada estado
function PeloPais({ panorama, onAbrirEstado, onAbrirPorEstado }: {
  panorama: Panorama | undefined; onAbrirEstado: (uf: string) => void; onAbrirPorEstado: () => void;
}) {
  const todos = panorama?.estados ?? [];
  const exterior = todos.find((e) => e.uf === 'zz');
  const porUf = useMemo(() => new Map(todos.filter((e) => e.uf !== 'zz').map((e) => [e.uf, e])), [todos]);
  const estados = [...porUf.values()];
  const concluidos = estados.filter((e) => (e.pst ?? 0) >= 100).length;
  const regioes = REGIOES.filter((r) => r.nome !== 'Exterior').map((r) => ({
    nome: r.nome,
    ufs: r.ufs.map((uf) => porUf.get(uf)).filter((e): e is EstadoPanorama => !!e),
  }));

  return (
    <section className="inicio-bloco inicio-pelo-pais" aria-labelledby="inicio-pelo-pais-titulo">
      <div className="inicio-bloco-cabecalho">
        <h2 id="inicio-pelo-pais-titulo">Pelo país</h2>
        <button type="button" className="inicio-lista-completa" onClick={onAbrirPorEstado}>Lista completa</button>
      </div>
      <p className="resumo-estados">
        {panorama ? `${concluidos} de ${estados.length} estados concluíram a totalização.` : 'Carregando…'}
      </p>

      {regioes.length > 0 && (
        <div className="inicio-regioes">
          {regioes.map((r) => <CardRegiao key={r.nome} nome={r.nome} estados={r.ufs} onAbrir={onAbrirEstado} />)}
        </div>
      )}

      {exterior && (
        <p className="inicio-exterior-linha">
          <Bandeira uf="zz" />
          Eleitores no exterior: {exterior.pst === null ? 'sem dados' : pct(exterior.pst)}
          {exterior.lider && <> — {exterior.lider.nome} lidera com {pct(exterior.lider.percentual)}</>}
        </p>
      )}
    </section>
  );
}

// Card de uma região: total já apurado (seções da região) + cada estado com seu percentual
function CardRegiao({ nome: nomeRegiao, estados, onAbrir }: { nome: string; estados: EstadoPanorama[]; onAbrir: (uf: string) => void }) {
  const secoes = estados.reduce((s, e) => s + (e.secoes ?? 0), 0);
  const totalizadas = estados.reduce((s, e) => s + (e.secoesTotalizadas ?? 0), 0);
  // Prefere o total ponderado por seções; sem esse dado, a média dos percentuais
  const pstRegiao = secoes > 0
    ? (totalizadas / secoes) * 100
    : estados.some((e) => e.pst !== null) ? estados.reduce((s, e) => s + (e.pst ?? 0), 0) / estados.length : null;

  // Candidato que lidera em mais estados da região (a frente na região)
  const contagem = new Map<string, { c: Candidato; n: number }>();
  for (const e of estados) {
    if (!e.lider) continue;
    const atual = contagem.get(e.lider.numero);
    if (atual) atual.n += 1;
    else contagem.set(e.lider.numero, { c: e.lider, n: 1 });
  }
  let liderRegiao: Candidato | null = null;
  let nLiderRegiao = 0;
  for (const v of contagem.values()) {
    if (v.n > nLiderRegiao) { liderRegiao = v.c; nLiderRegiao = v.n; }
  }

  return (
    <div className="regiao-card">
      <div className="regiao-card-cabecalho">
        <h3>{nomeRegiao}</h3>
        <span className="regiao-card-total">{pstRegiao === null ? 'sem dados' : `${pct(pstRegiao)} apurado`}</span>
      </div>
      {liderRegiao && (
        <div className="regiao-card-lider">
          <Foto c={liderRegiao} />
          <span className="regiao-card-lider-texto">
            <strong>{liderRegiao.nome}</strong>
            <span>na frente em {nLiderRegiao} {nLiderRegiao === 1 ? 'estado' : 'estados'}</span>
          </span>
        </div>
      )}
      <div className="trilho" aria-hidden="true"><span style={{ width: `${pstRegiao ?? 0}%` }} /></div>
      <ol className="regiao-ufs">
        {estados.map((e) => (
          <li key={e.uf}>
            <button type="button" className="regiao-uf"
              aria-label={`${nome(e.uf)}: ${e.pst === null ? 'sem dados' : `${pct(e.pst)} totalizado`}${e.lider ? `, ${e.lider.nome} lidera` : ''}`}
              onClick={() => onAbrir(e.uf)}>
              <Bandeira uf={e.uf} />
              <span className="regiao-uf-nome">{nome(e.uf)}</span>
              <span className="regiao-uf-trilho" aria-hidden="true"><span style={{ width: `${e.pst ?? 0}%` }} /></span>
              <span className="regiao-uf-pct">{e.pst === null ? '–' : pct(e.pst)}</span>
              {e.lider ? <Foto c={e.lider} /> : <span className="regiao-uf-vazio" aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

