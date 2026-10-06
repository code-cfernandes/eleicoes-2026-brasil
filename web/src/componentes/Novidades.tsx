import { useEffect, useState } from 'react';
import type { EventoApuracao, TipoEvento } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { comTurno, turnoDaTela } from '../api.ts';
import { horaMinuto } from '../formato.ts';
import { AvisosNovidades } from './AvisosNovidades.tsx';

// "O que está acontecendo agora": linha do tempo de eventos estatísticos da totalização
// (GET /api/novidades), atualizada ao vivo pelo canal global de SSE (/api/eventos?canal=novidades).
// Sem SSE disponível, a consulta periódica continua como garantia.

type Filtro = 'todas' | 'estados' | 'marcos' | 'viradas';

const TIPOS_POR_FILTRO: Record<Filtro, TipoEvento[] | null> = {
  todas: null,
  estados: ['estado-concluido'],
  marcos: ['marco', 'inicio'],
  viradas: ['virada', 'definido', 'diferenca'],
};

function corPonto(tipo: TipoEvento) {
  if (tipo === 'virada' || tipo === 'definido') return 'novidade-ponto-destaque';
  if (tipo === 'estado-concluido') return 'novidade-ponto-ok';
  return 'novidade-ponto-neutro';
}

function local(uf: string) {
  if (uf === 'br') return '';
  return NOMES_UF[uf] ? ` · ${NOMES_UF[uf]}` : '';
}

export function Novidades({ intervaloMs, compacto = false, limite, onVerTodas, chave }: {
  intervaloMs: number; compacto?: boolean; limite?: number; onVerTodas?: () => void; chave?: string;
}) {
  const [eventos, setEventos] = useState<EventoApuracao[]>();
  const [disponivel, setDisponivel] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [temMais, setTemMais] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        const r = await fetch(comTurno(`/api/novidades?limite=${limite ?? 30}`), { signal: ctrl.signal, cache: 'no-cache' });
        if (r.status === 404) { setDisponivel(false); return; }
        if (r.ok) {
          const { eventos: lista } = await r.json() as { eventos: EventoApuracao[] };
          setEventos(lista);
          setTemMais(lista.length >= (limite ?? 30));
          setDisponivel(true);
        }
      } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();

    // Ao vivo: o servidor publica cada evento novo no canal global "novidades" (SSE) assim
    // que o grava. A tela recebe e já acrescenta, sem esperar a próxima consulta. Sem SSE
    // (rede bloqueia, servidor lotado), a consulta periódica acima continua como garantia.
    let fonte: EventSource | undefined;
    const conectar = () => {
      fonte = new EventSource('/api/eventos?canal=novidades');
      fonte.addEventListener('novidade', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent<string>).data) as EventoApuracao;
          // O canal é global: só entra o que é do turno em exibição
          if (e.turno !== undefined && turnoDaTela() !== undefined && e.turno !== turnoDaTela()) return;
          setEventos((atual) => {
            const lista = atual ?? [];
            const jaTem = lista.some((x) => x.id === e.id);
            // O mesmo id pode chegar de novo (a IA substitui o texto depois): atualiza em vez de duplicar
            if (jaTem) return lista.map((x) => (x.id === e.id ? e : x));
            return [e, ...lista].slice(0, limite ?? 30);
          });
          setDisponivel(true);
        } catch { /* evento malformado: a consulta periódica reconcilia na próxima rodada */ }
      });
      fonte.onerror = () => {
        // CONNECTING: o navegador reconecta sozinho. CLOSED: recusado (ex.: 503); o polling
        // já cobre, então fechamos a assinatura em vez de insistir.
        if (fonte?.readyState === EventSource.CLOSED && !ctrl.signal.aborted) fonte.close();
      };
    };
    conectar();

    return () => { ctrl.abort(); clearTimeout(timer); fonte?.close(); };
  }, [intervaloMs, limite]);

  // Histórico: busca a página anterior (eventos com id menor que o mais antigo já na tela)
  async function verMaisAntigas() {
    if (!eventos?.length || carregandoMais) return;
    const minId = Math.min(...eventos.map((e) => e.id));
    setCarregandoMais(true);
    try {
      const r = await fetch(comTurno(`/api/novidades?antes=${minId}&limite=30`), { cache: 'no-cache' });
      if (r.ok) {
        const { eventos: antigos } = await r.json() as { eventos: EventoApuracao[] };
        setTemMais(antigos.length >= 30);
        setEventos((atual) => [...(atual ?? []), ...antigos]);
      }
    } catch { /* mantém o que já tem */ }
    setCarregandoMais(false);
  }

  if (!disponivel) {
    return compacto ? null : (
      <section className="inicio-bloco novidades" aria-labelledby="novidades-titulo">
        <h2 id="novidades-titulo">O que está acontecendo agora</h2>
        <p className="novidade-em-breve">Em breve.</p>
      </section>
    );
  }

  const cabecalhoCompacto = (
    <div className="inicio-bloco-cabecalho">
      <h2 id="novidades-titulo">O que está acontecendo agora</h2>
      {onVerTodas && <button type="button" className="inicio-lista-completa" onClick={onVerTodas}>Ver todas</button>}
    </div>
  );

  const tipos = TIPOS_POR_FILTRO[filtro];
  const filtrados = (eventos ?? []).filter((e) => !tipos || tipos.includes(e.tipo));

  const conteudo = (
    <>
      {!compacto && (
        <div className="alternar novidade-filtros" role="group" aria-label="Filtrar novidades">
          <button type="button" aria-pressed={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas</button>
          <button type="button" aria-pressed={filtro === 'estados'} onClick={() => setFiltro('estados')}>Estados</button>
          <button type="button" aria-pressed={filtro === 'marcos'} onClick={() => setFiltro('marcos')}>Marcos</button>
          <button type="button" aria-pressed={filtro === 'viradas'} onClick={() => setFiltro('viradas')}>Viradas</button>
        </div>
      )}
      {!eventos ? (
        <p className="resumo-estados">Carregando…</p>
      ) : !filtrados.length ? (
        <p className="novidade-em-breve">Nada por aqui ainda.</p>
      ) : (
        <ol className="novidade-lista">
          {filtrados.map((e) => (
            <li key={e.id} className="novidade-item">
              <span className={`novidade-ponto ${corPonto(e.tipo)}`} aria-hidden="true" />
              <span className="novidade-hora">{horaMinuto(e.instante)}</span>
              <span className="novidade-texto">
                {e.texto}{local(e.uf)}
                {e.fonte === 'ia' && <span className="novidade-ia" title="Texto redigido por IA (DeepSeek)">IA</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );

  if (compacto) {
    return (
      <section className="inicio-bloco novidades" aria-labelledby="novidades-titulo">
        {cabecalhoCompacto}
        {conteudo}
      </section>
    );
  }
  return (
    <section className="novidades-pagina" aria-labelledby="novidades-titulo">
      <h2 id="novidades-titulo">Novidades</h2>
      <p className="resumo-estados">Atualizações em tempo real da totalização.</p>
      {chave && <AvisosNovidades chave={chave} />}
      {conteudo}
      {filtro === 'todas' && temMais && (
        <button type="button" className="mais-botao" disabled={carregandoMais} onClick={() => void verMaisAntigas()}>
          {carregandoMais ? 'Carregando…' : 'Ver novidades mais antigas'}
        </button>
      )}
    </section>
  );
}
