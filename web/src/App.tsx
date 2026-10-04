import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';
import { ajustarCandidatos, buscarConfig, buscarHistorico, buscarResultado, mesclarHistorico } from './api.ts';
import { Avisos } from './componentes/Avisos.tsx';
import { Cartao } from './componentes/Cartao.tsx';
import { Evolucao, type Granularidade } from './componentes/Evolucao.tsx';
import { Bandeira } from './componentes/Bandeira.tsx';
import { PorEstado } from './componentes/PorEstado.tsx';
import { VisaoEstado } from './componentes/VisaoEstado.tsx';
import { dataHora, horaDoAparelho, pct, pontos, semAcento, votos } from './formato.ts';
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

// Cargo e UF ficam na URL: dá para compartilhar o link de uma disputa
// "cargo" 0 = aba "Por estado"; -1 = visão especializada de um estado (nenhum dos dois é uma
// disputa: o efeito de atualização por cargo/SSE fica parado nesses dois modos)
const POR_ESTADO = 0;
const VISAO_ESTADO = -1;

function lerUrl() {
  const q = new URLSearchParams(location.search);
  const uf = q.get('uf')?.toLowerCase() || 'br';
  const aba = q.get('aba');
  if (aba === 'estados') return { cargo: POR_ESTADO, uf };
  if (aba === 'estado') return { cargo: VISAO_ESTADO, uf };
  return { cargo: Number(q.get('cargo')) || 1, uf };
}

export function App() {
  const tema = useTema();
  const [cfg, setCfg] = useState<ConfigPublica>();
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
  const abaAtivaRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { buscarConfig().then(setCfg).catch((e: Error) => setErro(e.message)); }, []);

  // Barra fixa com rolagem horizontal nas abas: mantém a aba atual visível ao trocar de cargo.
  // Rola só o container das abas (scrollLeft), nunca a página: scrollIntoView mexeria no scroll
  // vertical também, porque o elemento está dentro de uma barra sticky.
  useEffect(() => {
    const botao = abaAtivaRef.current;
    const lista = botao?.parentElement;
    if (!botao || !lista) return;
    const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const alvo = botao.offsetLeft + botao.offsetWidth / 2 - lista.clientWidth / 2;
    lista.scrollTo({ left: Math.max(0, alvo), behavior: reduzido ? 'auto' : 'smooth' });
  }, [cargo]);

  const cargoAtual = cfg?.cargos.find((c) => c.codigo === cargo);

  // Garante uma UF válida para o cargo (ex.: Governador não tem "Brasil"; Distrital só DF)
  useEffect(() => {
    if (!cargoAtual || cargoAtual.ufs.includes(uf)) return;
    const nova = cargoAtual.ufs.includes(ufEstadual) ? ufEstadual : cargoAtual.ufs[0]!;
    setDisputa({ cargo, uf: nova });
  }, [cargoAtual, cargo, uf, ufEstadual]);

  useEffect(() => {
    const url = cargo === POR_ESTADO ? '?aba=estados' : cargo === VISAO_ESTADO ? `?aba=estado&uf=${uf}` : `?cargo=${cargo}&uf=${uf}`;
    history.replaceState(null, '', url);
    if (uf !== 'br') setUfEstadual(uf);
    setBusca(''); setLimite(POR_PAGINA); setFixado(null); setDestacado(null);
    setResultado(undefined); setHistorico([]);
  }, [cargo, uf]);

  // Atualização: o servidor avisa por SSE quando o TSE publica versão nova; aí a tela
  // busca pelas rotas HTTP (304 se nada mudou, histórico só a partir do último ponto).
  // Sem SSE (rede bloqueia, servidor lotado), cai para polling no ritmo do backend.
  useEffect(() => {
    if (!cfg || !cargoAtual?.ufs.includes(uf)) return;
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
      seguranca = setTimeout(carregar, vivo ? SEGURANCA_MS : cfg.intervaloMs);
    };

    let fonte: EventSource | undefined;
    let jaAbriu = false;
    const conectar = () => {
      fonte = new EventSource(`/api/eventos?uf=${uf}&cargo=${cargo}`);
      fonte.onopen = () => {
        vivo = true; setAoVivo(true);
        if (jaAbriu) void carregar(); // reconectou: confere o que pode ter perdido
        jaAbriu = true;
      };
      fonte.addEventListener('atualizacao', (ev) => {
        const { instante, espalharMs } = JSON.parse((ev as MessageEvent<string>).data) as { instante: number | null; espalharMs?: number };
        if (instante !== versao) depois(() => void carregar(), Math.random() * (espalharMs ?? ESPALHAR_MS));
      });
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
    conectar();
    return () => {
      ctrl.abort();
      fonte?.close();
      clearTimeout(seguranca);
      timers.forEach(clearTimeout);
      setAoVivo(false);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [cfg, cargoAtual, uf, cargo, por]);

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
  const comVotos = candidatos.filter((c) => c.votos > 0);
  const proporcional = !!cargoAtual?.proporcional;
  const [lider, vice] = comVotos;
  const indefinido = resultado ? !candidatos.some((c) => c.eleito || /2º turno/i.test(c.situacao || '')) : true;
  // Senador etc.: vaga é por posição no placar (não proporcional); deputados nunca "entram" só pela posição.
  // O que interessa é a distância entre a última vaga e o primeiro de fora.
  const dentro = !proporcional && vagas > 1 ? comVotos.slice(0, vagas) : [];
  const ultimaVaga = dentro.at(-1);
  const primeiroFora = dentro.length === vagas ? comVotos[vagas] : undefined;

  return (
    <main>
      <header className="topo">
        <div className="topo-titulo">
          <h1>
            {/* Volta à página inicial (Presidente, Brasil). Link real: Ctrl/⌘+clique abre em nova aba */}
            <a href="/" className="topo-inicio" onClick={(e) => {
              if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setDisputa({ cargo: 1, uf: 'br' });
              scrollTo({ top: 0 });
            }}>
              Apuração 2026 <span>{cfg?.turno}</span>
            </a>
          </h1>
          <a className="topo-github" href="https://github.com/code-cfernandes/eleicoes-2026-brasil" target="_blank" rel="noopener noreferrer">
            <IconeGitHub />
            Código aberto no GitHub, deixe sua estrela
          </a>
        </div>
        {cargo !== POR_ESTADO && cargo !== VISAO_ESTADO && <p className={`status${erro ? ' status-erro' : ''}`} role="status">
          {erro
            ? `Sem conexão com os resultados (${erro}). Nova tentativa em ${(cfg?.intervaloMs ?? 30000) / 1000}s.`
            : resultado?.instante
              ? resultado.secoesTotalizadas === 0
                // Antes da apuração o arquivo do TSE tem horário de dias atrás (e diferente por disputa):
                // o que interessa é quando o site conferiu pela última vez, no relógio do aparelho.
                ? <>{aoVivo && <span className="ao-vivo" aria-hidden="true" />}Aguardando o início da apuração, às 17h (horário de Brasília).{verificadoEm && ` Verificado às ${horaDoAparelho(verificadoEm)}`}</>
                : aoVivo
                  ? <><span className="ao-vivo" aria-hidden="true" />Ao vivo. TSE atualizou {dataHora(resultado.instante)}</>
                  : <>TSE atualizou {dataHora(resultado.instante)}. Conferindo a cada {(cfg?.intervaloMs ?? 30000) / 1000}s</>
              : 'Carregando…'}
        </p>}
      </header>

      <nav className="filtros" aria-label="Disputa">
        <div className="cargos" role="tablist" aria-label="Cargo">
          {cfg?.cargos.map((c) => (
            <button key={c.codigo} type="button" role="tab" aria-selected={c.codigo === cargo}
              ref={c.codigo === cargo ? abaAtivaRef : undefined}
              onClick={() => setDisputa({ cargo: c.codigo, uf })}>
              {c.nome}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={cargo === POR_ESTADO || cargo === VISAO_ESTADO}
            ref={cargo === POR_ESTADO || cargo === VISAO_ESTADO ? abaAtivaRef : undefined}
            onClick={() => setDisputa({ cargo: POR_ESTADO, uf })}>
            Por estado
          </button>
        </div>
        {cargo !== POR_ESTADO && cargo !== VISAO_ESTADO && (
          <label className="seletor-uf">
            <span className="visualmente-oculto">Local</span>
            <select value={uf} onChange={(e) => setDisputa({ cargo, uf: e.target.value })}>
              {cargoAtual?.ufs.map((u) => <option key={u} value={u}>{NOMES_UF[u] ?? u.toUpperCase()}</option>)}
            </select>
          </label>
        )}
      </nav>

      {cargo === POR_ESTADO ? (
        <PorEstado intervaloMs={cfg?.intervaloMs ?? 30_000}
          onAbrir={(u) => {
            // Exterior só tem Presidente: vai direto para a disputa. Estados têm visão própria.
            setDisputa(u === 'zz' ? { cargo: 1, uf: u } : { cargo: VISAO_ESTADO, uf: u });
            scrollTo({ top: 0 });
          }} />
      ) : cargo === VISAO_ESTADO ? (
        <VisaoEstado uf={uf} intervaloMs={cfg?.intervaloMs ?? 30_000}
          onVoltar={() => { setDisputa({ cargo: POR_ESTADO, uf }); scrollTo({ top: 0 }); }}
          onAbrirDisputa={(c, u) => { setDisputa({ cargo: c, uf: u }); scrollTo({ top: 0 }); }} />
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
            A apuração desta disputa ainda não começou. Os números aparecem assim que o TSE totalizar as primeiras seções.
          </p>
        )}

        {resultado && apuracaoComecou && lider && (
          <div className="resumo" aria-live="polite">
            <p className="resumo-estado">
              {candidatos.find((c) => c.eleito)
                ? <span className="resumo-tag resumo-tag-eleito">Resultado definido</span>
                : candidatos.some((c) => /2º turno/i.test(c.situacao || ''))
                  ? <span className="resumo-tag resumo-tag-segundo-turno">Vai para o 2º turno</span>
                  : <span className="resumo-tag resumo-tag-andamento">Em apuração</span>}
            </p>
            {proporcional ? (
              // Eleição proporcional: não existe "disputa" entre o 1º e o 2º da lista
              <p className="resumo-lider">
                <strong>{lider.nome}</strong> ({lider.partido}) é quem tem mais votos até agora, com <strong>{pct(lider.percentual)}</strong>.
              </p>
            ) : vagas > 1 ? (
              <>
                <p className="resumo-lider">
                  Nas {vagas} vagas agora:{' '}
                  {dentro.map((c, i) => (
                    <span key={c.numero}>
                      {i > 0 && (i === dentro.length - 1 ? ' e ' : ', ')}
                      <strong>{c.nome}</strong> ({pct(c.percentual)})
                    </span>
                  ))}.
                </p>
                {ultimaVaga && primeiroFora && (
                  <p className="resumo-corte">
                    {primeiroFora.nome}, em {vagas + 1}º, está a {pontos(ultimaVaga.percentual - primeiroFora.percentual)} da
                    última vaga ({votos(ultimaVaga.votos - primeiroFora.votos)}).
                  </p>
                )}
              </>
            ) : (
              <p className="resumo-lider">
                {vice && lider.votos === vice.votos ? (
                  <><strong>{lider.nome}</strong> e <strong>{vice.nome}</strong> estão empatados, com {pct(lider.percentual)}.</>
                ) : (
                  <>
                    <strong>{lider.nome}</strong> ({lider.partido}) lidera com <strong>{pct(lider.percentual)}</strong>
                    {vice && <>, {pontos(lider.percentual - vice.percentual)} à frente de <strong>{vice.nome}</strong> ({vice.partido}), {votos(lider.votos - vice.votos)} de diferença</>}.
                  </>
                )}
                {indefinido && (lider.percentual > 50
                  ? ' Com mais da metade dos votos válidos, vence no 1º turno se mantiver a vantagem.'
                  : ` Para vencer no 1º turno é preciso mais da metade dos votos válidos: faltam ${pontos(50 - lider.percentual)}.`)}
              </p>
            )}
          </div>
        )}

        {cfg && cargoAtual?.ufs.includes(uf) && (
          <Avisos uf={uf} cargo={cargo} chave={cfg.chavePush} proporcional={cargoAtual.proporcional} />
        )}
      </section>

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
        <button type="button" className="mais" onClick={() => setLimite((l) => l + POR_PAGINA)}>
          Mostrar mais {Math.min(POR_PAGINA, filtrados.length - limite)} de {filtrados.length - limite} restantes
        </button>
      )}

      <Evolucao historico={historico} slots={slots} por={por} onPor={setPor}
        ativo={ativo} onDestacar={setDestacado} onFixar={fixar} tema={tema}
        referencia50={!proporcional && vagas === 1} />

      </>)}

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
  );
}
