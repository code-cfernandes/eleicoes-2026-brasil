import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';
import { ajustarCandidatos, buscarConfig, buscarHistorico, buscarResultado, mesclarHistorico } from './api.ts';
import { Avisos } from './componentes/Avisos.tsx';
import { Cartao } from './componentes/Cartao.tsx';
import { Evolucao, type Granularidade } from './componentes/Evolucao.tsx';
import { dataHora, horaDoAparelho, pct, pontos, semAcento, votos } from './formato.ts';
import { corSerie, MAX_SERIES, useTema } from './paleta.ts';
import { NOMES_UF } from '../../shared/ufs.ts';

const POR_PAGINA = 24;
const NO_GRAFICO = 30; // linhas no gráfico: as 8 coloridas + contexto em cinza
const SEGURANCA_MS = 120_000; // com o ao vivo funcionando, só uma conferência a cada 2 min
const ESPALHAR_MS = 2_000;    // padrão; o servidor manda um maior quando há muita gente assistindo

// Cargo e UF ficam na URL: dá para compartilhar o link de uma disputa
function lerUrl() {
  const q = new URLSearchParams(location.search);
  return { cargo: Number(q.get('cargo')) || 1, uf: q.get('uf')?.toLowerCase() || 'br' };
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

  useEffect(() => { buscarConfig().then(setCfg).catch((e: Error) => setErro(e.message)); }, []);

  const cargoAtual = cfg?.cargos.find((c) => c.codigo === cargo);

  // Garante uma UF válida para o cargo (ex.: Governador não tem "Brasil"; Distrital só DF)
  useEffect(() => {
    if (!cargoAtual || cargoAtual.ufs.includes(uf)) return;
    const nova = cargoAtual.ufs.includes(ufEstadual) ? ufEstadual : cargoAtual.ufs[0]!;
    setDisputa({ cargo, uf: nova });
  }, [cargoAtual, cargo, uf, ufEstadual]);

  useEffect(() => {
    history.replaceState(null, '', `?cargo=${cargo}&uf=${uf}`);
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
        <h1>Apuração 2026 <span>{cfg?.turno}</span></h1>
        <p className={`status${erro ? ' status-erro' : ''}`} role="status">
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
        </p>
      </header>

      <nav className="filtros" aria-label="Disputa">
        <div className="cargos" role="tablist" aria-label="Cargo">
          {cfg?.cargos.map((c) => (
            <button key={c.codigo} type="button" role="tab" aria-selected={c.codigo === cargo}
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

      <section className="andamento" aria-labelledby="disputa-titulo">
        <div className="andamento-cabecalho">
          <h2 id="disputa-titulo">{cargoAtual?.nome ?? '…'}, {local}</h2>
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
