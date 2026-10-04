import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfigPublica, PontoHistorico, Resultado } from '../../shared/tipos.ts';
import { buscarConfig, buscarHistorico, buscarResultado } from './api.ts';
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

  // Atualização automática no ritmo do cache do backend; volta da aba = dado fresco
  useEffect(() => {
    if (!cfg || !cargoAtual?.ufs.includes(uf)) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        const [r, h] = await Promise.all([
          buscarResultado(uf, cargo, ctrl.signal),
          buscarHistorico(uf, cargo, por, NO_GRAFICO, ctrl.signal).catch(() => []), // histórico é opcional
        ]);
        setResultado(r); setHistorico(h); setErro(undefined);
      } catch (e) {
        if (!ctrl.signal.aborted) setErro((e as Error).message);
      }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, cfg.intervaloMs);
    };
    const aoVoltar = () => { if (!document.hidden) void carregar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', aoVoltar); };
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
              ? <><span className="ao-vivo" aria-hidden="true" />TSE atualizou às {horaMinuto(resultado.instante)}</>
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
        Fonte: TSE{resultado?.atualizadoEm ? `, dados gerados em ${resultado.atualizadoEm}` : ''}. Atualiza sozinho a cada {(cfg?.intervaloMs ?? 30000) / 1000}s.
      </footer>
    </main>
  );
}
