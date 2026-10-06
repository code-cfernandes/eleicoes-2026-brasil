import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';
import { ajustarCandidatos, buscarConfig, buscarHistorico, buscarResultado, comTurno, definirTurno, mesclarHistorico } from './api.ts';
import { Avisos } from './componentes/Avisos.tsx';
import { Cartao } from './componentes/Cartao.tsx';
import { Cronometro, useAntesDoInicio } from './componentes/Cronometro.tsx';
import { DisputasDoTurno } from './componentes/DisputasDoTurno.tsx';
import { Evolucao, type Granularidade } from './componentes/Evolucao.tsx';
import { Bandeira } from './componentes/Bandeira.tsx';
import { Inicio } from './componentes/Inicio.tsx';
import { Mais } from './componentes/Mais.tsx';
import { Mapa } from './componentes/Mapa.tsx';
import { NavInferiorMobile, SidebarDesktop, useRolarAbaAtiva, type Secao } from './componentes/Navegacao.tsx';
import { Novidades } from './componentes/Novidades.tsx';
import { PorEstado } from './componentes/PorEstado.tsx';
import { ResumoLideranca } from './componentes/ResumoLideranca.tsx';
import { VisaoEstado } from './componentes/VisaoEstado.tsx';
import { dataHora, horaDoAparelho, pct, semAcento, votos } from './formato.ts';
import { corSerie, MAX_SERIES, useTema } from './paleta.ts';
import { NOMES_UF } from '../../shared/ufs.ts';

const POR_PAGINA = 24;
const NO_GRAFICO = 30; // linhas no gráfico: as 8 coloridas + contexto em cinza
const SEGURANCA_MS = 120_000; // com o ao vivo funcionando, só uma conferência a cada 2 min
const ESPALHAR_MS = 2_000;    // padrão; o servidor manda um maior quando há muita gente assistindo

function IconeGitHub() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.67 0 8.21c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.2-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.03.08-2.15 0 0 .67-.22 2.2.84a7.4 7.4 0 0 1 4 0c1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.15.51.57.82 1.29.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.75.54 1.5 0 1.09-.01 1.97-.01 2.24 0 .21.15.47.55.39A8.23 8.23 0 0 0 16 8.21C16 3.67 12.42 0 8 0Z" />
    </svg>
  );
}

// Cargo e UF ficam na URL: dá para compartilhar o link de uma disputa.
// Sentinelas de "cargo" para seções que não são uma disputa (o efeito de atualização por
// cargo/SSE fica parado nelas): 0 Por estado, -1 Visão do estado, -2 Início, -3 Mapa,
// -4 Novidades, -5 Mais (só mobile), -6 Sobre (só desktop).
const POR_ESTADO = 0;
const VISAO_ESTADO = -1;
const INICIO = -2;
const MAPA = -3;
const NOVIDADES = -4;
const MAIS = -5;
const SOBRE = -6;

// Mapeia o sentinela de cargo para a Secao da navegação (sidebar/nav inferior)
function secaoDoCargo(cargo: number): Secao {
  switch (cargo) {
    case INICIO: return 'inicio';
    case POR_ESTADO: return 'por-estado';
    case VISAO_ESTADO: return 'visao-estado';
    case MAPA: return 'mapa';
    case NOVIDADES: return 'novidades';
    case MAIS: return 'mais';
    case SOBRE: return 'sobre';
    default: return 'candidatos';
  }
}

// ?turno=N escolhe o turno; sem ele, vale o turno atual do servidor
function lerTurnoUrl(): number | null {
  return Number(new URLSearchParams(location.search).get('turno')) || null;
}

function lerUrl() {
  const q = new URLSearchParams(location.search);
  const uf = q.get('uf')?.toLowerCase() || 'br';
  const aba = q.get('aba');
  // URL "/" sem parâmetros (só ?turno, no máximo): Início
  q.delete('turno');
  if (!q.size) return { cargo: INICIO, uf: 'br' };
  if (aba === 'estados') return { cargo: POR_ESTADO, uf };
  if (aba === 'estado') return { cargo: VISAO_ESTADO, uf };
  if (aba === 'mapa') return { cargo: MAPA, uf: 'br' };
  if (aba === 'novidades') return { cargo: NOVIDADES, uf: 'br' };
  if (aba === 'mais') return { cargo: MAIS, uf: 'br' };
  if (aba === 'sobre') return { cargo: SOBRE, uf: 'br' };
  return { cargo: Number(q.get('cargo')) || 1, uf };
}

export function App() {
  const [tema, alternarTema] = useTema();
  const [cfgServidor, setCfg] = useState<ConfigPublica>();
  const [turnoPedido, setTurnoPedido] = useState(lerTurnoUrl);
  const [{ cargo, uf }, setDisputa] = useState(lerUrl);
  const [ufEstadual, setUfEstadual] = useState(uf === 'br' ? 'sp' : uf);
  const [por, setPor] = useState<Granularidade>('hora');
  const [resultado, setResultado] = useState<Resultado>();
  const [historico, setHistorico] = useState<PontoHistorico[]>([]);
  const [erro, setErro] = useState<string>();
  const [aoVivo, setAoVivo] = useState(false);
  const [verificadoEm, setVerificadoEm] = useState<number>(); // última consulta bem-sucedida (relógio do aparelho)
  const [busca, setBusca] = useState('');
  const [limite, setLimite] = useState(POR_PAGINA);
  const [destacado, setDestacado] = useState<string | null>(null);
  const [fixado, setFixado] = useState<string | null>(null);
  const [subAba, setSubAba] = useState<'resultados' | 'evolucao' | 'por-estado'>('resultados');
  const [finalizadoAoVivo, setFinalizadoAoVivo] = useState(false); // aviso SSE de que o turno atual encerrou
  // Rola a aba ativa do seletor de cargo (dentro de "Candidatos") para o centro visível
  const abaAtivaRef = useRolarAbaAtiva(cargo);

  // Sem a config não há seletor de turno nem cargos: se falhar (servidor reiniciando, rede),
  // tenta de novo a cada 10s em vez de deixar a tela pela metade até recarregar
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let vivo = true;
    const carregar = () => buscarConfig()
      .then((c) => { if (vivo) { setCfg(c); setErro(undefined); } })
      .catch((e: Error) => { if (vivo) { setErro(e.message); timer = setTimeout(carregar, 10_000); } });
    void carregar();
    return () => { vivo = false; clearTimeout(timer); };
  }, []);

  // Turno em exibição: o pedido na URL, se o servidor o tiver; senão, o atual.
  // Antes da config chegar, vale o pedido (ou nenhum: o servidor responde com o atual).
  const turnosServidor = cfgServidor?.turnos ?? [];
  const turno = cfgServidor
    ? (turnosServidor.some((t) => t.numero === turnoPedido) ? turnoPedido! : cfgServidor.turnoAtual)
    : turnoPedido ?? undefined;
  const ehTurnoAtual = !cfgServidor || turno === cfgServidor.turnoAtual;
  definirTurno(turno); // antes dos efeitos dos filhos: toda busca já sai com ?turno=

  // A config "vista" pelo resto da tela é a do turno escolhido (cargos, início, encerrado)
  const infoTurno = turnosServidor.find((t) => t.numero === turno);
  const cfg = useMemo((): ConfigPublica | undefined => cfgServidor && infoTurno && {
    ...cfgServidor,
    cargos: infoTurno.cargos,
    turno: infoTurno.nome,
    inicioApuracao: infoTurno.inicioApuracao,
    finalizado: infoTurno.finalizado,
  }, [cfgServidor, infoTurno]);
  const encerrado = !!cfg?.finalizado || (ehTurnoAtual && finalizadoAoVivo);
  // Turno que ainda não começou (ex.: 2º turno antes de 25/10, 17h): as telas de dados dão lugar
  // ao cronômetro, e nada é buscado da disputa até lá. Vira false sozinho no horário.
  const aguardando = useAntesDoInicio(cfg?.inicioApuracao);

  const cargoAtual = cfg?.cargos.find((c) => c.codigo === cargo);

  // Garante cargo e UF válidos no turno (ex.: Governador não tem "Brasil"; Distrital só DF;
  // no 2º turno não há Senador e Governador só existe em algumas UFs)
  useEffect(() => {
    if (!cfg || cargo <= 0) return;
    const c = cargoAtual ?? cfg.cargos[0];
    if (!c || (c === cargoAtual && c.ufs.includes(uf))) return;
    const nova = c.ufs.includes(uf) ? uf : c.ufs.includes(ufEstadual) ? ufEstadual : c.ufs[0]!;
    setDisputa({ cargo: c.codigo, uf: nova });
  }, [cfg, cargoAtual, cargo, uf, ufEstadual]);

  useEffect(() => {
    const base = cargo === INICIO ? ''
      : cargo === POR_ESTADO ? '?aba=estados'
      : cargo === VISAO_ESTADO ? `?aba=estado&uf=${uf}`
      : cargo === MAPA ? '?aba=mapa'
      : cargo === NOVIDADES ? '?aba=novidades'
      : cargo === MAIS ? '?aba=mais'
      : cargo === SOBRE ? '?aba=sobre'
      : `?cargo=${cargo}&uf=${uf}`;
    // O turno só vai para a URL quando não é o atual (o link sem ?turno segue sempre o mais recente)
    const comTurnoNaUrl = turnoPedido && !ehTurnoAtual ? `${base ? `${base}&` : '?'}turno=${turnoPedido}` : base;
    history.replaceState(null, '', comTurnoNaUrl || '/');
    if (uf !== 'br') setUfEstadual(uf);
    setBusca(''); setLimite(POR_PAGINA); setFixado(null); setDestacado(null);
    setResultado(undefined); setHistorico([]); setSubAba('resultados');
  }, [cargo, uf, turno, turnoPedido, ehTurnoAtual]);

  // Atualização: o servidor avisa por SSE quando o TSE publica versão nova; aí a tela
  // busca pelas rotas HTTP (304 se nada mudou, histórico só a partir do último ponto).
  // Sem SSE (rede bloqueia, servidor lotado), cai para polling no ritmo do backend.
  useEffect(() => {
    if (!cfg || aguardando || !cargoAtual?.ufs.includes(uf)) return;
    const ctrl = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const depois = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
    };
    let versao: number | null | undefined;  // geração do TSE já exibida
    let pontos: PontoHistorico[] = [];
    let acompanhados = new Set<string>();    // candidatos que o gráfico acompanha (top 30)
    let vivo = false;
    let seguranca: ReturnType<typeof setTimeout> | undefined;
    let rodando = false, deNovo = false;     // aviso + timer + volta da aba não duplicam requisições

    const carregar = async () => {
      if (rodando) { deNovo = true; return; }
      rodando = true;
      clearTimeout(seguranca);
      try {
        const r = await buscarResultado(uf, cargo, ctrl.signal);
        if (r.instante !== versao) {
          setResultado(r);
          try {
            const desde = pontos.at(-1)?.instante ?? 0;
            const h = await buscarHistorico(uf, cargo, por, NO_GRAFICO, desde, ctrl.signal);
            pontos = mesclarHistorico(pontos, h.pontos, por);
            // Quem entrou agora no top só tem os pontos novos: busca o passado só dele
            const novatos = desde ? h.numeros.filter((n) => !acompanhados.has(n)) : [];
            const passado = novatos.length
              ? (await buscarHistorico(uf, cargo, por, NO_GRAFICO, 0, ctrl.signal, novatos)).pontos
              : [];
            acompanhados = new Set(h.numeros);
            pontos = ajustarCandidatos(pontos, passado, por, acompanhados);
            setHistorico(pontos);
            versao = r.instante; // só marca como visto se o histórico também veio
          } catch (e) {
            if (ctrl.signal.aborted) throw e; // histórico é opcional: tenta de novo na próxima rodada
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
      if (cfg.finalizado && versao !== undefined) return; // turno encerrado: os números não mudam mais
      seguranca = setTimeout(carregar, vivo ? SEGURANCA_MS : cfg.intervaloMs);
    };

    let fonte: EventSource | undefined;
    let jaAbriu = false;
    const conectar = () => {
      fonte = new EventSource(comTurno(`/api/eventos?uf=${uf}&cargo=${cargo}`));
      fonte.onopen = () => {
        vivo = true; setAoVivo(true);
        if (jaAbriu) void carregar(); // reconectou: confere o que pode ter perdido
        jaAbriu = true;
      };
      fonte.addEventListener('atualizacao', (ev) => {
        const { instante, espalharMs } = JSON.parse((ev as MessageEvent<string>).data) as { instante: number | null; espalharMs?: number };
        if (instante !== versao) depois(() => void carregar(), Math.random() * (espalharMs ?? ESPALHAR_MS));
      });
      fonte.addEventListener('finalizado', () => setFinalizadoAoVivo(true));
      fonte.onerror = () => {
        vivo = false; setAoVivo(false);
        // CONNECTING: o navegador já está reconectando. CLOSED: recusado (ex.: 503), tenta em 1 min
        if (fonte?.readyState === EventSource.CLOSED && !ctrl.signal.aborted) depois(conectar, 60_000);
        clearTimeout(seguranca);
        seguranca = setTimeout(carregar, cfg.intervaloMs);
      };
    };

    const aoVoltar = () => { if (!document.hidden) void carregar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    void carregar();
    if (!cfg.finalizado) conectar();
    return () => {
      ctrl.abort();
      fonte?.close();
      clearTimeout(seguranca);
      timers.forEach(clearTimeout);
      setAoVivo(false);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [cfg, aguardando, cargoAtual, uf, cargo, por]);

  // Cores: os 8 mais votados agora, distribuídos pela ordem do número (não do placar),
  // então uma virada não troca as cores de quem já estava na tela.
  const slots = useMemo(() => {
    const top = (resultado?.candidatos ?? []).filter((c) => c.votos > 0).slice(0, MAX_SERIES);
    const fonte = top.length ? top : (historico.at(-1)?.cand ?? []).slice(0, MAX_SERIES);
    return new Map([...fonte].map((c) => c.numero)
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
      .map((n, i) => [n, i] as const));
  }, [resultado, historico]);

  const noGrafico = useMemo(() => new Set(historico.flatMap((p) => p.cand.map((c) => c.numero))), [historico]);
  const ativo = fixado ?? destacado;
  const fixar = useCallback((n: string) => setFixado((f) => (f === n ? null : n)), []);

  const candidatos = resultado?.candidatos ?? [];
  const termo = semAcento(busca.trim());
  const filtrados = termo
    ? candidatos.filter((c) => semAcento(`${c.nome} ${c.numero} ${c.partido}`).includes(termo))
    : candidatos;
  const visiveis = filtrados.slice(0, limite);
  const comBusca = candidatos.length > 16;

  const local = NOMES_UF[uf] ?? uf.toUpperCase();
  const vagas = resultado?.vagas ?? 1;

  // Resumo da liderança: só faz sentido com apuração em andamento e alguém com voto
  const apuracaoComecou = (resultado?.secoesTotalizadas ?? 0) > 0 && candidatos.some((c) => c.votos > 0);
  const proporcional = !!cargoAtual?.proporcional;

  const secao = secaoDoCargo(cargo);
  const ir = (s: Secao) => {
    const destino: Record<Secao, { cargo: number; uf: string }> = {
      inicio: { cargo: INICIO, uf: 'br' },
      candidatos: { cargo: cargoAtual ? cargo : (cfg?.cargos[0]?.codigo ?? 1), uf: cargo > 0 ? uf : ufEstadual },
      mapa: { cargo: MAPA, uf: 'br' },
      novidades: { cargo: NOVIDADES, uf: 'br' },
      mais: { cargo: MAIS, uf: 'br' },
      'por-estado': { cargo: POR_ESTADO, uf: 'br' },
      'visao-estado': { cargo: VISAO_ESTADO, uf },
      sobre: { cargo: SOBRE, uf: 'br' },
    };
    setDisputa(destino[s]);
    scrollTo({ top: 0 });
  };
  const abrirEstado = (u: string) => { setDisputa({ cargo: VISAO_ESTADO, uf: u }); scrollTo({ top: 0 }); };

  // Na espera, o topo não mostra "ao vivo"/atualização de uma disputa que ainda não começou
  const ehDisputa = cargo > 0 && !aguardando;
  const telaDeEspera = aguardando && !!cfg?.inicioApuracao && secao !== 'mais' && secao !== 'sobre';

  return (
    <div className="layout">
      <SidebarDesktop secao={secao} onIr={ir} tema={tema} onAlternarTema={alternarTema} />

      <main className="conteudo">
        <header className="topo">
          <div className="topo-titulo">
            {/* Título e seletor de turno na mesma linha (quebra para baixo em telas estreitas) */}
            <div className="topo-titulo-linha">
            <h1>
              {/* Volta à página Início. Link real: Ctrl/⌘+clique abre em nova aba */}
              <a href="/" className="topo-inicio" onClick={(e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                ir('inicio');
              }}>
                Eleições <span className="topo-ano">2026</span>
        {cfgServidor?.simulacao && (
          <p className="faixa-simulacao" role="note">
            <strong>Simulação</strong> · dados fictícios gerados para ensaiar o 2º turno. Não são resultados do TSE.
          </p>
        )}
              </a>
            </h1>
            {turnosServidor.length > 1 && (
              <div className="alternar topo-turno" role="group" aria-label="Turno">
                {turnosServidor.map((t) => (
                  <button key={t.numero} type="button" aria-pressed={t.numero === turno}
                    onClick={() => setTurnoPedido(t.numero)}>
                    {t.nome}
                  </button>
                ))}
              </div>
            )}
            </div>
            <p className="topo-subtitulo">
              {encerrado
                ? 'Totalização encerrada'
                : aguardando && cfg?.inicioApuracao
                  ? `Totalização começa ${dataHora(cfg.inicioApuracao)}`
                  : 'Totalização ao vivo'}
              {turnosServidor.length <= 1 && cfg?.turno ? ` · ${cfg.turno}` : ''}
            </p>
          </div>

          <div className="topo-status">
            {/* O indicador reflete a conexão SSE da disputa aberta; no Início (e nas demais
                seções sem uma disputa específica) cada bloco mostra seu próprio "Ao vivo". */}
            {ehDisputa && (
              <span className={`topo-ao-vivo${aoVivo && !encerrado ? ' topo-ao-vivo-ativo' : ''}`}>
                <span className="ao-vivo" aria-hidden="true" />
                {encerrado ? 'Totalização encerrada' : aoVivo ? 'AO VIVO' : 'Reconectando'}
              </span>
            )}
            {ehDisputa && resultado?.instante && (
              <span className="topo-atualizacao" role="status">
                {resultado.secoesTotalizadas === 0
                  // Antes da totalização o arquivo do TSE tem horário de dias atrás: o que
                  // interessa é quando o site conferiu pela última vez, no relógio do aparelho.
                  ? <>Verificado {verificadoEm ? `às ${horaDoAparelho(verificadoEm)}` : '…'}</>
                  : <>Última atualização: {dataHora(resultado.instante)}</>}
              </span>
            )}
            <a className="topo-fonte" href="https://resultados.tse.jus.br" target="_blank" rel="noopener noreferrer">
              Fonte: TSE · Ver no TSE
            </a>
          </div>

          {ehDisputa && erro && (
            <p className="status status-erro" role="status">
              Sem conexão com os resultados ({erro}). Nova tentativa em {(cfg?.intervaloMs ?? 30000) / 1000}s.
            </p>
          )}
        </header>

        {secao === 'candidatos' && !telaDeEspera && (
          <nav className="filtros" aria-label="Disputa">
            <div className="cargos" role="tablist" aria-label="Cargo">
              {cfg?.cargos.map((c) => (
                <button key={c.codigo} type="button" role="tab" aria-selected={c.codigo === cargo}
                  ref={c.codigo === cargo ? abaAtivaRef : undefined}
                  onClick={() => setDisputa({ cargo: c.codigo, uf })}>
                  {c.nome}
                </button>
              ))}
            </div>
            <label className="seletor-uf">
              <span className="visualmente-oculto">Local</span>
              <select value={uf} onChange={(e) => setDisputa({ cargo, uf: e.target.value })}>
                {cargoAtual?.ufs.map((u) => <option key={u} value={u}>{NOMES_UF[u] ?? u.toUpperCase()}</option>)}
              </select>
            </label>
          </nav>
        )}

        {/* Trocar de turno remonta tudo abaixo: cada bloco volta a buscar já no turno novo.
            Sem ?turno na URL a chave é fixa, então a chegada da config não remonta nada. */}
        <Fragment key={turnoPedido === null ? 'atual' : String(turno)}>
        {telaDeEspera ? (<>
          <Cronometro inicio={cfg!.inicioApuracao!} turno={cfg!.turno}
            chavePush={ehTurnoAtual ? cfg!.chavePush : undefined} />
          {/* 2º turno em diante: o que se vota em cada estado (no 1º turno seria todo cargo em toda UF) */}
          {(turno ?? 1) > 1 && <DisputasDoTurno turno={cfg!.turno} />}
        </>) : secao === 'inicio' ? (
          <Inicio cfg={cfg} tema={tema}
            onAbrirDisputa={(c, u) => { setDisputa({ cargo: c, uf: u }); scrollTo({ top: 0 }); }}
            onAbrirEstado={abrirEstado}
            onAbrirPorEstado={() => ir('por-estado')}
            onAbrirMapa={() => ir('mapa')}
            onAbrirNovidades={() => ir('novidades')} />
        ) : secao === 'por-estado' ? (
          <PorEstado intervaloMs={cfg?.intervaloMs ?? 30_000}
            onAbrir={(u) => {
              // Exterior só tem Presidente: vai direto para a disputa. Estados têm visão própria.
              if (u === 'zz') { setDisputa({ cargo: 1, uf: u }); scrollTo({ top: 0 }); } else abrirEstado(u);
            }} />
        ) : secao === 'visao-estado' ? (
          <VisaoEstado uf={uf} intervaloMs={cfg?.intervaloMs ?? 30_000}
            onVoltar={() => ir('por-estado')}
            onAbrirDisputa={(c, u) => { setDisputa({ cargo: c, uf: u }); scrollTo({ top: 0 }); }} />
        ) : secao === 'mapa' ? (
          <Mapa intervaloMs={cfg?.intervaloMs ?? 30_000} onAbrirEstado={abrirEstado} cargos={cfg?.cargos.map((c) => c.codigo)} />
        ) : secao === 'novidades' ? (
          // Inscrição em novidades vale para o turno atual: no turno anterior, sem o sino
          <Novidades intervaloMs={cfg?.intervaloMs ?? 30_000} chave={ehTurnoAtual ? (cfg?.chavePush ?? '') : undefined} />
        ) : secao === 'mais' ? (
          <Mais tema={tema} onAlternarTema={alternarTema} />
        ) : secao === 'sobre' ? (
          <Mais tema={tema} onAlternarTema={alternarTema} />
        ) : (<>

        <section className="andamento" aria-labelledby="disputa-titulo">
          <div className="andamento-cabecalho">
            <h2 id="disputa-titulo">
              {cargoAtual?.nome ?? '…'}, {local}
              {uf !== 'br' && <Bandeira uf={uf} />}
            </h2>
            <p className="andamento-numero">
              <strong>{resultado ? pct(resultado.secoesTotalizadas) : '–'}</strong> das seções totalizadas
            </p>
          </div>
          <div className="trilho trilho-grande" aria-hidden="true">
            <div style={{ width: `${resultado?.secoesTotalizadas ?? 0}%` }} />
          </div>
          {resultado && (
            <p className="andamento-detalhe">
              {candidatos.length} candidatos
              {vagas > 1 ? `, ${vagas} vagas` : ', 1 vaga'}
              {proporcional && '. Deputados são eleitos pelo quociente partidário: a ordem da lista não define quem entra'}
            </p>
          )}

          {resultado && !apuracaoComecou && (
            <p className="resumo resumo-espera">
              A totalização desta disputa ainda não começou. Os números aparecem assim que o TSE totalizar as primeiras seções.
            </p>
          )}

          {resultado && apuracaoComecou && (
            <ResumoLideranca candidatos={candidatos} vagas={vagas} proporcional={proporcional} />
          )}

          {resultado?.totais && resultado.totais.votosTotais > 0 && <BrancosNulos totais={resultado.totais} />}

          {cfg && ehTurnoAtual && cargoAtual?.ufs.includes(uf) && (
            <Avisos uf={uf} cargo={cargo} chave={cfg.chavePush} proporcional={cargoAtual.proporcional} />
          )}
        </section>

        {(() => {
          const porEstadoDisponivel = cargo === 1 || cargo === 3 || cargo === 5;
          return (
            <div className="alternar subabas" role="group" aria-label="Seção da disputa">
              <button type="button" aria-pressed={subAba === 'resultados'} onClick={() => setSubAba('resultados')}>Resultados</button>
              <button type="button" aria-pressed={subAba === 'evolucao'} onClick={() => setSubAba('evolucao')}>Evolução</button>
              {porEstadoDisponivel && (
                <button type="button" aria-pressed={subAba === 'por-estado'} onClick={() => setSubAba('por-estado')}>Por estado</button>
              )}
            </div>
          );
        })()}

        {subAba === 'resultados' && (<>
          {comBusca && (
            <div className="busca">
              <label>
                <span className="visualmente-oculto">Buscar candidato</span>
                <input type="search" placeholder="Buscar por nome, número ou partido" value={busca}
                  onChange={(e) => { setBusca(e.target.value); setLimite(POR_PAGINA); }} />
              </label>
              {termo && <span className="busca-total">{filtrados.length} encontrado{filtrados.length === 1 ? '' : 's'}</span>}
            </div>
          )}

          <ol className="cartoes" aria-label="Candidatos, do mais votado ao menos votado">
            {visiveis.map((c, i) => (
              <Cartao key={c.numero} c={c}
                cor={corSerie(tema, slots.get(c.numero))}
                noGrafico={noGrafico.has(c.numero)}
                ativo={ativo === c.numero}
                esmaecido={ativo !== null && ativo !== c.numero}
                destaque={apuracaoComecou && !termo && i < 3}
                apuracaoComecou={apuracaoComecou}
                dentroDasVagas={!termo && !proporcional && vagas > 1 && c.votos > 0 && i < vagas}
                referencia50={!proporcional && vagas === 1}
                onDestacar={setDestacado} onFixar={fixar} />
            ))}
          </ol>
          {termo && !filtrados.length && <p className="vazio">Nenhum candidato com “{busca.trim()}”. Confira a grafia ou busque pelo número.</p>}
          {filtrados.length > limite && (
            <button type="button" className="mais-botao" onClick={() => setLimite((l) => l + POR_PAGINA)}>
              Mostrar mais {Math.min(POR_PAGINA, filtrados.length - limite)} de {filtrados.length - limite} restantes
            </button>
          )}
        </>)}

        {subAba === 'evolucao' && (
          <Evolucao historico={historico} slots={slots} por={por} onPor={setPor}
            ativo={ativo} onDestacar={setDestacado} onFixar={fixar} tema={tema}
            referencia50={!proporcional && vagas === 1} />
        )}

        {subAba === 'por-estado' && (cargo === 1 || cargo === 3 || cargo === 5) && (
          <Mapa intervaloMs={cfg?.intervaloMs ?? 30_000} onAbrirEstado={abrirEstado} cargoInicial={cargo} fixarCargo />
        )}

        </>)}
        </Fragment>

        <footer className="rodape">
          <p>
            Fonte: TSE{resultado?.atualizadoEm ? `, dados gerados em ${resultado.atualizadoEm}` : ''}. A tela se atualiza sozinha quando o TSE publica dados novos.
          </p>
          <p>
            Projeto de código aberto, sem vínculo com o TSE.{' '}
            <a href="https://github.com/code-cfernandes/eleicoes-2026-brasil" target="_blank" rel="noopener noreferrer">
              Veja no GitHub e deixe sua estrela
            </a>
          </p>
        </footer>
      </main>

      <NavInferiorMobile secao={secao} onIr={ir} />
    </div>
  );
}

// Brancos, nulos e abstenção à parte da tabela de candidatos: os percentuais dos candidatos
// são sobre votos válidos, não sobre o total (brancos/nulos não entram nessa conta)
function BrancosNulos({ totais }: { totais: NonNullable<Resultado['totais']> }) {
  const pctSobreTotal = (v: number) => totais.votosTotais > 0 ? pct((v / totais.votosTotais) * 100) : '–';
  return (
    <div className="brancos-nulos">
      <span><strong>{votos(totais.brancos)}</strong> brancos ({pctSobreTotal(totais.brancos)})</span>
      <span><strong>{votos(totais.nulos)}</strong> nulos ({pctSobreTotal(totais.nulos)})</span>
      <span><strong>{pct(totais.eleitores > 0 ? (totais.abstencao / totais.eleitores) * 100 : 0)}</strong> de abstenção</span>
    </div>
  );
}
