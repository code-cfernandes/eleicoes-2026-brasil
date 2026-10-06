import { useEffect, useState } from 'react';
import type { ResumoCargo, VisaoEstado as DadosVisaoEstado } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { buscarEstado } from '../api.ts';
import { horaDoAparelho, pct, votos } from '../formato.ts';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';

// Visão especializada de um estado: um resumo por cargo (Presidente, Governador, Senador,
// Deputado federal, Deputado estadual/distrital), com os mais votados de cada um.

const nome = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();

function BlocoCargo({ c, uf, onAbrirDisputa }: { c: ResumoCargo; uf: string; onAbrirDisputa: (cargo: number, uf: string) => void }) {
  const apuracaoComecou = (c.pst ?? 0) > 0 && c.candidatos.length > 0;
  return (
    <div className="estado-cargo">
      <div className="estado-cargo-cabecalho">
        <h3>{c.nome}</h3>
        <span className="estado-cargo-pst">{c.pst === null ? 'sem dados' : `${pct(c.pst)} totalizado`}</span>
      </div>

      {c.proporcional && (
        <p className="estado-cargo-aviso">
          Eleitos pelo quociente partidário: estar entre os mais votados não garante vaga.
        </p>
      )}

      {!apuracaoComecou ? (
        <p className="estado-cargo-vazio">
          {c.total > 0 ? `Aguardando totalização. ${c.total} candidatos.` : 'Sem dados do TSE no momento para esta disputa.'}
        </p>
      ) : (
        <ol className="estado-cargo-lista">
          {c.candidatos.map((cand, i) => (
            <li key={cand.numero} className="estado-cargo-item">
              <Foto c={cand} />
              <span className="estado-cargo-item-texto">
                <strong>{cand.nome}</strong>
                <span>{cand.partido}</span>
              </span>
              <span className="estado-cargo-item-placar">
                <span className="estado-cargo-item-pct">{pct(cand.percentual)}</span>
                <span className="estado-cargo-item-votos">{votos(cand.votos)}</span>
              </span>
              {!c.proporcional && c.vagas > 1 && i < c.vagas && (
                <span className="selo selo-vaga estado-cargo-selo">Na faixa de vagas</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {c.total > 0 && (
        <button type="button" className="estado-cargo-todos" onClick={() => onAbrirDisputa(c.cargo, uf)}>
          Ver todos os {c.total} candidatos
        </button>
      )}
    </div>
  );
}

export function VisaoEstado({ uf, intervaloMs, onVoltar, onAbrirDisputa }: {
  uf: string;
  intervaloMs: number;
  onVoltar: () => void;
  onAbrirDisputa: (cargo: number, uf: string) => void;
}) {
  const [dados, setDados] = useState<DadosVisaoEstado>();
  const [erro, setErro] = useState<string>();
  const [verificadoEm, setVerificadoEm] = useState<number>();

  // Mesmo padrão do PorEstado: polling no ritmo do backend, 304 quando nada muda, sem SSE
  useEffect(() => {
    setDados(undefined);
    setErro(undefined);
    setVerificadoEm(undefined);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        setDados(await buscarEstado(uf, ctrl.signal));
        setErro(undefined);
        setVerificadoEm(Date.now());
      } catch (e) {
        if (!ctrl.signal.aborted) setErro((e as Error).message);
      }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    const aoVoltar = () => { if (!document.hidden) void carregar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', aoVoltar); };
  }, [uf, intervaloMs]);

  const presidente = dados?.cargos.find((c) => c.cargo === 1);
  const pst = presidente?.pst ?? null;

  return (
    <section className="visao-estado" aria-labelledby="visao-estado-titulo">
      <button type="button" className="visao-estado-voltar" onClick={onVoltar}>
        Todos os estados
      </button>

      <div className="andamento-cabecalho">
        <h2 id="visao-estado-titulo">
          {nome(uf)}
          <Bandeira uf={uf} />
        </h2>
        {pst !== null && (
          <p className="andamento-numero">
            <strong>{pct(pst)}</strong> das seções totalizadas (Presidente)
          </p>
        )}
      </div>

      {(!dados || verificadoEm) && (
        <p className="resumo-estados" aria-live="polite">
          {!dados && (erro ? `Não foi possível carregar este estado (${erro}). Nova tentativa em ${intervaloMs / 1000}s.` : 'Carregando…')}
          {verificadoEm && <span className="resumo-estados-hora"> Verificado às {horaDoAparelho(verificadoEm)}.</span>}
        </p>
      )}

      {dados && !dados.cargos.length && (
        <p className="resumo resumo-espera">Não há disputa neste estado neste turno.</p>
      )}

      {dados && (
        <div className="estado-cargos">
          {dados.cargos.map((c) => <BlocoCargo key={c.cargo} c={c} uf={uf} onAbrirDisputa={onAbrirDisputa} />)}
        </div>
      )}
    </section>
  );
}
