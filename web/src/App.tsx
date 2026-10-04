import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';
import { ajustarCandidatos, buscarConfig, buscarHistorico, buscarResultado, mesclarHistorico } from './api.ts';
import { Cartao } from './componentes/Cartao.tsx';
import { Evolucao, type Granularidade } from './componentes/Evolucao.tsx';
import { horaMinuto, pct, semAcento } from './formato.ts';
import { corSerie, MAX_SERIES, useTema } from './paleta.ts';

const NOMES_UF: Record<string, string> = {
  br: 'Brasil', ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia', ce: 'Ceará',
  df: 'Distrito Federal', es: 'Espírito Santo', go: 'Goiás', ma: 'Maranhão', mt: 'Mato Grosso',
  ms: 'Mato Grosso do Sul', mg: 'Minas Gerais', pa: 'Pará', pb: 'Paraíba', pr: 'Paraná',
  pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte',
  rs: 'Rio Grande do Sul', ro: 'Rondônia', rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo',
  se: 'Sergipe', to: 'Tocantins',
};
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

  return (
    <main>
      <header className="topo">
        <h1>Apuração 2026 <span>{cfg?.turno}</span></h1>
        <p className={`status${erro ? ' status-erro' : ''}`} role="status">
          {erro
            ? `Sem conexão com os resultados (${erro}). Nova tentativa em ${(cfg?.intervaloMs ?? 30000) / 1000}s.`
            : resultado?.instante
              ? aoVivo
                ? <><span className="ao-vivo" aria-hidden="true" />Ao vivo. TSE atualizou às {horaMinuto(resultado.instante)}</>
                : <>TSE atualizou às {horaMinuto(resultado.instante)}. Conferindo a cada {(cfg?.intervaloMs ?? 30000) / 1000}s</>
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
        <h2 id="disputa-titulo">{cargoAtual?.nome ?? '…'}, {local}</h2>
        <p className="andamento-numero">
          <strong>{resultado ? pct(resultado.secoesTotalizadas) : '–'}</strong> das seções totalizadas
        </p>
        <div className="trilho trilho-grande" aria-hidden="true">
          <div style={{ width: `${resultado?.secoesTotalizadas ?? 0}%` }} />
        </div>
        {resultado && (
          <p className="andamento-detalhe">
            {candidatos.length} candidatos
            {vagas > 1 ? `, ${vagas} vagas` : ', 1 vaga'}
            {cargoAtual?.proporcional && '. Deputados são eleitos pelo quociente partidário, não só pelos mais votados'}
          </p>
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
        {visiveis.map((c) => (
          <Cartao key={c.numero} c={c}
            cor={corSerie(tema, slots.get(c.numero))}
            noGrafico={noGrafico.has(c.numero)}
            ativo={ativo === c.numero}
            esmaecido={ativo !== null && ativo !== c.numero}
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
        ativo={ativo} onDestacar={setDestacado} onFixar={fixar} tema={tema} />

      <footer className="rodape">
        Fonte: TSE{resultado?.atualizadoEm ? `, dados gerados em ${resultado.atualizadoEm}` : ''}. A tela se atualiza sozinha quando o TSE publica dados novos.
      </footer>
    </main>
  );
}
