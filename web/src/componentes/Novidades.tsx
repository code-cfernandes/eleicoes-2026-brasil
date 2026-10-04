import { useEffect, useState } from 'react';
import type { EventoApuracao, TipoEvento } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { horaMinuto } from '../formato.ts';

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

export function Novidades({ intervaloMs, compacto = false, limite, onVerTodas }: {
  intervaloMs: number; compacto?: boolean; limite?: number; onVerTodas?: () => void;
}) {
  const [eventos, setEventos] = useState<EventoApuracao[]>();
  const [disponivel, setDisponivel] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>('todas');

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        const r = await fetch(`/api/novidades?limite=${limite ?? 30}`, { signal: ctrl.signal, cache: 'no-cache' });
        if (r.status === 404) { setDisponivel(false); return; }
        if (r.ok) { setEventos((await r.json()).eventos); setDisponivel(true); }
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
          setEventos((atual) => {
            const lista = atual ?? [];
            if (lista.some((x) => x.id === e.id)) return lista;
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
              <span className="novidade-texto">{e.texto}{local(e.uf)}</span>
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
      {conteudo}
    </section>
  );
}
