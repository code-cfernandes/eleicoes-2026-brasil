import { useEffect, useMemo, useState } from 'react';
import type { Candidato, ConfigPublica, EstadoPanorama, Panorama, Resultado, VisaoEstado } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { buscarEstado, buscarPanorama, buscarResultado } from '../api.ts';
import { dataHora, horaDoAparelho, pct, votos } from '../formato.ts';
import { Avisos } from './Avisos.tsx';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';
import { ResumoLideranca } from './ResumoLideranca.tsx';

// Página inicial: o que a maioria quer saber em poucos segundos, sem precisar escolher
// cargo e local primeiro. Quatro blocos, nesta ordem: contagem regressiva (só antes da
// apuração), placar nacional de Presidente, "Seu estado" (personalizado) e "Pelo país".

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

// Conta regressiva até o início da apuração, atualizada a cada minuto
function useContagem(inicioApuracao: number | null) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (inicioApuracao === null || agora >= inicioApuracao) return;
    const t = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [inicioApuracao, agora]);
  if (inicioApuracao === null || agora >= inicioApuracao) return null;
  const faltamMin = Math.max(0, Math.round((inicioApuracao - agora) / 60_000));
  const h = Math.floor(faltamMin / 60);
  const m = faltamMin % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}min` : ''}` : `${m}min`;
}

interface PropsInicio {
  cfg: ConfigPublica | undefined;
  onAbrirDisputa: (cargo: number, uf: string) => void;
  onAbrirEstado: (uf: string) => void;
  onAbrirPorEstado: () => void;
}

export function Inicio({ cfg, onAbrirDisputa, onAbrirEstado, onAbrirPorEstado }: PropsInicio) {
  const faltam = useContagem(cfg?.inicioApuracao ?? null);
  // O relógio do aparelho diz quando a apuração deveria começar, mas o dado real do TSE manda:
  // se as seções já começaram a ser totalizadas, a contagem some mesmo que o relógio ache que não
  const [apuracaoComecouDados, setApuracaoComecouDados] = useState(false);
  const mostrarContagem = faltam !== null && !apuracaoComecouDados;

  return (
    <div className="inicio">
      {mostrarContagem && (
        <section className="inicio-contagem" aria-live="polite">
          <p>
            A apuração começa às 17h (horário de Brasília){faltam && <>, faltam <strong>{faltam}</strong></>}.
          </p>
          {cfg && <Avisos uf="br" cargo={1} chave={cfg.chavePush} proporcional={false} />}
        </section>
      )}

      <PlacarNacional intervaloMs={cfg?.intervaloMs ?? 30_000} onAbrirDisputa={onAbrirDisputa} onApuracaoComecou={setApuracaoComecouDados} />
      <SeuEstado intervaloMs={cfg?.intervaloMs ?? 30_000} onAbrirEstado={onAbrirEstado} />
      <PeloPais intervaloMs={cfg?.intervaloMs ?? 30_000} onAbrirEstado={onAbrirEstado} onAbrirPorEstado={onAbrirPorEstado} />
    </div>
  );
}

// Bloco 1: placar nacional de Presidente, com SSE (mesmo padrão de App.tsx, sem histórico)
function PlacarNacional({ intervaloMs, onAbrirDisputa, onApuracaoComecou }: {
  intervaloMs: number; onAbrirDisputa: (cargo: number, uf: string) => void; onApuracaoComecou: (v: boolean) => void;
}) {
  const [resultado, setResultado] = useState<Resultado>();
  const [erro, setErro] = useState<string>();
  const [aoVivo, setAoVivo] = useState(false);
  const [verificadoEm, setVerificadoEm] = useState<number>();

  useEffect(() => {
    const ctrl = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const depois = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
    };
    let versao: number | null | undefined;
    let vivo = false;
    let seguranca: ReturnType<typeof setTimeout> | undefined;
    let rodando = false, deNovo = false;

    const carregar = async () => {
      if (rodando) { deNovo = true; return; }
      rodando = true;
      clearTimeout(seguranca);
      try {
        const r = await buscarResultado('br', 1, ctrl.signal);
        if (r.instante !== versao) { setResultado(r); versao = r.instante; }
        setErro(undefined);
        setVerificadoEm(Date.now());
      } catch (e) {
        if (!ctrl.signal.aborted) setErro((e as Error).message);
      } finally {
        rodando = false;
      }
      if (ctrl.signal.aborted) return;
      if (deNovo) { deNovo = false; void carregar(); return; }
      seguranca = setTimeout(carregar, vivo ? 120_000 : intervaloMs);
    };

    let fonte: EventSource | undefined;
    let jaAbriu = false;
    const conectar = () => {
      fonte = new EventSource('/api/eventos?uf=br&cargo=1');
      fonte.onopen = () => {
        vivo = true; setAoVivo(true);
        if (jaAbriu) void carregar();
        jaAbriu = true;
      };
      fonte.addEventListener('atualizacao', (ev) => {
        const { instante, espalharMs } = JSON.parse((ev as MessageEvent<string>).data) as { instante: number | null; espalharMs?: number };
        if (instante !== versao) depois(() => void carregar(), Math.random() * (espalharMs ?? 2_000));
      });
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
    conectar();
    return () => {
      ctrl.abort();
      fonte?.close();
      clearTimeout(seguranca);
      timers.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [intervaloMs]);

  const candidatos = resultado?.candidatos ?? [];
  const apuracaoComecou = (resultado?.secoesTotalizadas ?? 0) > 0 && candidatos.some((c) => c.votos > 0);
  const top3 = candidatos.filter((c) => c.votos > 0).slice(0, 3);

  useEffect(() => { onApuracaoComecou(apuracaoComecou); }, [apuracaoComecou, onApuracaoComecou]);

  return (
    <section className="inicio-bloco inicio-placar" aria-labelledby="inicio-placar-titulo">
      <div className="inicio-bloco-cabecalho">
        <h2 id="inicio-placar-titulo">Presidente, Brasil</h2>
        <span className="inicio-status">
          {erro
            ? 'Sem conexão'
            : resultado
              ? aoVivo ? <><span className="ao-vivo" aria-hidden="true" />Ao vivo</> : `Atualizado ${dataHora(resultado.instante ?? Date.now())}`
              : 'Carregando…'}
        </span>
      </div>

      {resultado && (
        <>
          <p className="andamento-numero">
            <strong>{pct(resultado.secoesTotalizadas)}</strong> das seções totalizadas
          </p>
          <div className="trilho trilho-grande" aria-hidden="true">
            <div style={{ width: `${resultado.secoesTotalizadas}%` }} />
          </div>
        </>
      )}

      {resultado && !apuracaoComecou && (
        <p className="resumo resumo-espera">A apuração ainda não começou nesta disputa.</p>
      )}

      {resultado && apuracaoComecou && (
        <ResumoLideranca candidatos={candidatos} vagas={1} proporcional={false} />
      )}

      {top3.length > 0 && (
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
          Ver todos os {candidatos.length} candidatos
        </button>
      )}
    </section>
  );
}

// Bloco 2: "Seu estado" — personalizado, lembrado em localStorage
function SeuEstado({ intervaloMs, onAbrirEstado }: { intervaloMs: number; onAbrirEstado: (uf: string) => void }) {
  const [uf, setUf] = useState<string | null>(() => lerEstadoSalvo());
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

  const escolher = (u: string) => { setUf(u); salvarEstado(u); setDados(undefined); };
  const trocar = () => { setUf(null); salvarEstado(null); setDados(undefined); };

  if (!uf) {
    return (
      <section className="inicio-bloco inicio-seu-estado" aria-labelledby="inicio-seu-estado-titulo">
        <h2 id="inicio-seu-estado-titulo">Seu estado</h2>
        <p className="inicio-seu-estado-convite">Escolha seu estado para ver Governador, Senado e Presidente nele.</p>
        <div className="inicio-grade-ufs" role="list">
          {Object.keys(NOMES_UF).filter((u) => u !== 'br' && u !== 'zz').sort((a, b) => nome(a).localeCompare(nome(b), 'pt-BR')).map((u) => (
            <button key={u} type="button" className="inicio-uf-botao" onClick={() => escolher(u)}>
              <Bandeira uf={u} />
              <span>{nome(u)}</span>
            </button>
          ))}
        </div>
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
            <ResumoMini titulo="Governador" cargo={governador.cargo} candidatos={governador.candidatos} vagas={1} />
          )}
          {senador && (
            <ResumoMini titulo="Senado" cargo={senador.cargo} candidatos={senador.candidatos} vagas={senador.vagas} />
          )}
          {presidente && (
            <ResumoMini titulo="Presidente" cargo={presidente.cargo} candidatos={presidente.candidatos} vagas={1} />
          )}
        </div>
      )}

      <button type="button" className="estado-cargo-todos" onClick={() => onAbrirEstado(uf)}>
        Ver {nome(uf)} completo
      </button>
    </section>
  );
}

function ResumoMini({ titulo, candidatos, vagas }: { titulo: string; cargo: number; candidatos: Candidato[]; vagas: number }) {
  const comVotos = candidatos.filter((c) => c.votos > 0);
  if (!comVotos.length) return (
    <p className="inicio-resumo-mini"><strong>{titulo}:</strong> aguardando apuração</p>
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

// Bloco 3: "Pelo país" — grade compacta das 27 UFs, líder de Presidente em cada uma
function PeloPais({ intervaloMs, onAbrirEstado, onAbrirPorEstado }: {
  intervaloMs: number; onAbrirEstado: (uf: string) => void; onAbrirPorEstado: () => void;
}) {
  const [dados, setDados] = useState<Panorama>();

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try { setDados(await buscarPanorama(ctrl.signal)); } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [intervaloMs]);

  const todos = dados?.estados ?? [];
  const exterior = todos.find((e) => e.uf === 'zz');
  const estados = useMemo(() => todos.filter((e) => e.uf !== 'zz').sort((a, b) => nome(a.uf).localeCompare(nome(b.uf), 'pt-BR')), [todos]);
  const concluidos = estados.filter((e) => (e.pst ?? 0) >= 100).length;

  return (
    <section className="inicio-bloco inicio-pelo-pais" aria-labelledby="inicio-pelo-pais-titulo">
      <div className="inicio-bloco-cabecalho">
        <h2 id="inicio-pelo-pais-titulo">Pelo país</h2>
        <button type="button" className="inicio-lista-completa" onClick={onAbrirPorEstado}>Lista completa</button>
      </div>
      <p className="resumo-estados">
        {dados ? `${concluidos} de ${estados.length} estados concluíram a apuração.` : 'Carregando…'}
      </p>

      {estados.length > 0 && (
        <div className="inicio-grade-estados" role="list">
          {estados.map((e) => <QuadradoEstado key={e.uf} e={e} onAbrir={onAbrirEstado} />)}
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

function QuadradoEstado({ e, onAbrir }: { e: EstadoPanorama; onAbrir: (uf: string) => void }) {
  const pst = e.pst ?? 0;
  const descricao = `${nome(e.uf)}: ${e.pst === null ? 'sem dados' : `${pct(e.pst)} apurado`}${e.lider ? `, ${e.lider.nome} lidera` : ''}`;
  return (
    <button type="button" className="inicio-quadrado" aria-label={descricao} onClick={() => onAbrir(e.uf)}>
      <Bandeira uf={e.uf} />
      <span className="inicio-quadrado-sigla">{e.uf.toUpperCase()}</span>
      <span className="inicio-quadrado-trilho" aria-hidden="true"><span style={{ width: `${pst}%` }} /></span>
      {e.lider ? <Foto c={e.lider} /> : <span className="inicio-quadrado-vazio" aria-hidden="true" />}
    </button>
  );
}
