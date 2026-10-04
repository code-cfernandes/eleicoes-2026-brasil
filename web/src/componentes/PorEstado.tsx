import { useEffect, useState } from 'react';
import type { EstadoPanorama, Panorama } from '../../../shared/tipos.ts';
import { NOMES_UF, REGIOES } from '../../../shared/ufs.ts';
import { buscarPanorama } from '../api.ts';
import { horaDoAparelho, pct } from '../formato.ts';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';

// Aba "Por estado": quanto cada UF já apurou e quem lidera para Presidente em cada uma.
// Barras (não mapa): comparar percentuais lado a lado é mais rápido e preciso.

type Ordem = 'andamento' | 'nome' | 'regiao';
const nome = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();
const porNome = (a: EstadoPanorama, b: EstadoPanorama) => nome(a.uf).localeCompare(nome(b.uf), 'pt-BR');
// Na lista o contexto já diz que é diferença de percentual: "15,13 pontos" basta
const pontosCurto = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} ${v === 1 ? 'ponto' : 'pontos'}`;
const porAndamento = (a: EstadoPanorama, b: EstadoPanorama) => (b.pst ?? -1) - (a.pst ?? -1) || porNome(a, b);

function Linha({ e, onAbrir }: { e: EstadoPanorama; onAbrir: (uf: string) => void }) {
  const concluido = e.pst !== null && e.pst >= 100;
  const descricao = e.pst === null
    ? `${nome(e.uf)}: sem dados do TSE no momento. Ver todas as disputas deste estado`
    : `${nome(e.uf)}: ${pct(e.pst)} totalizado${e.lider ? `, ${e.lider.nome} lidera a disputa de Presidente com ${pct(e.lider.percentual)}` : ''}. Ver todas as disputas deste estado`;
  return (
    <li>
      <button type="button" className={`estado${concluido ? ' estado-concluido' : ''}`} aria-label={descricao} onClick={() => onAbrir(e.uf)}>
        <span className="estado-nome">
          <Bandeira uf={e.uf} />
          <span>{nome(e.uf)}</span>
        </span>
        <span className="estado-andamento">
          <span className="trilho" aria-hidden="true"><span style={{ width: `${e.pst ?? 0}%` }} /></span>
          <span className="estado-pct">{e.pst === null ? 'sem dados' : concluido ? 'Concluído' : pct(e.pst)}</span>
        </span>
        <span className="estado-lider">
          {e.lider ? (
            <>
              <Foto c={e.lider} />
              <span className="estado-lider-texto">
                <span className="estado-lider-nome">{e.lider.nome}</span>
                <span>
                  {pct(e.lider.percentual)}
                  {e.vantagem !== null && <span className="estado-vantagem">, {pontosCurto(e.vantagem)} à frente</span>}
                </span>
              </span>
            </>
          ) : (
            <span className="estado-aguardando">{e.pst === null ? '' : 'Aguardando totalização'}</span>
          )}
        </span>
        <span className="estado-ver" aria-hidden="true">Ver estado</span>
      </button>
    </li>
  );
}

function LinhaExterior({ e, onAbrir }: { e: EstadoPanorama; onAbrir: (uf: string) => void }) {
  const descricao = e.pst === null
    ? 'Exterior: sem dados do TSE no momento. Abrir Presidente no exterior'
    : `Exterior: ${pct(e.pst)} totalizado${e.lider ? `, ${e.lider.nome} lidera com ${pct(e.lider.percentual)}` : ''}. Abrir Presidente no exterior`;
  return (
    <button type="button" className="estado estado-exterior" aria-label={descricao} onClick={() => onAbrir(e.uf)}>
      <span className="estado-nome">
        <Bandeira uf={e.uf} />
        <span className="estado-exterior-texto">
          <strong>Eleitores no exterior</strong>
          <span>Brasileiros que votam fora do país, só para Presidente</span>
        </span>
      </span>
      <span className="estado-andamento">
        <span className="trilho" aria-hidden="true"><span style={{ width: `${e.pst ?? 0}%` }} /></span>
        <span className="estado-pct">{e.pst === null ? 'sem dados' : e.pst >= 100 ? 'Concluído' : pct(e.pst)}</span>
      </span>
      <span className="estado-lider">
        {e.lider ? (
          <>
            <Foto c={e.lider} />
            <span className="estado-lider-texto">
              <span className="estado-lider-nome">{e.lider.nome}</span>
              <span>
                {pct(e.lider.percentual)}
                {e.vantagem !== null && <span className="estado-vantagem">, {pontosCurto(e.vantagem)} à frente</span>}
              </span>
            </span>
          </>
        ) : (
          <span className="estado-aguardando">{e.pst === null ? '' : 'Aguardando totalização'}</span>
        )}
      </span>
      <span className="estado-ver" aria-hidden="true">Ver Presidente</span>
    </button>
  );
}

export function PorEstado({ intervaloMs, onAbrir }: { intervaloMs: number; onAbrir: (uf: string) => void }) {
  const [dados, setDados] = useState<Panorama>();
  const [erro, setErro] = useState<string>();
  const [verificadoEm, setVerificadoEm] = useState<number>();
  const [ordem, setOrdem] = useState<Ordem>('andamento');

  // Atualiza no ritmo do backend; sem mudança em nenhuma UF, cada rodada é um 304 sem corpo
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        setDados(await buscarPanorama(ctrl.signal));
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
  }, [intervaloMs]);

  const todos = dados?.estados ?? [];
  // Exterior não é um estado (só vota para Presidente): fica fora da lista/ordenação, em bloco próprio
  const exterior = todos.find((e) => e.uf === 'zz');
  const estados = todos.filter((e) => e.uf !== 'zz');
  const ufs = estados;
  const comecaram = ufs.filter((e) => (e.pst ?? 0) > 0);
  const concluidos = ufs.filter((e) => (e.pst ?? 0) >= 100);
  const maisAtrasado = comecaram.length && concluidos.length < ufs.length
    ? [...ufs].filter((e) => e.pst !== null).sort((a, b) => a.pst! - b.pst!)[0]
    : undefined;
  const pstBrasil = dados?.brasil.pst ?? null;

  // "Por região" não tem grupo Exterior aqui (ele já tem seção própria depois da lista)
  const regioesDeEstados = REGIOES.filter((r) => r.nome !== 'Exterior');
  const grupos: { titulo?: string; itens: EstadoPanorama[]; pstRegiao?: number | null }[] = ordem === 'regiao'
    ? regioesDeEstados.map((r) => {
        const itens = estados.filter((e) => r.ufs.includes(e.uf)).sort(porAndamento);
        const secoes = itens.reduce((s, e) => s + (e.secoes ?? 0), 0);
        const totalizadas = itens.reduce((s, e) => s + (e.secoesTotalizadas ?? 0), 0);
        const pstRegiao = secoes > 0 ? (totalizadas / secoes) * 100 : null;
        return { titulo: r.nome, itens, pstRegiao };
      })
    : [{ itens: [...estados].sort(ordem === 'nome' ? porNome : porAndamento) }];

  return (
    <section className="por-estado" aria-labelledby="por-estado-titulo">
      <h2 id="por-estado-titulo">Totalização por estado</h2>
      <p className="andamento-numero">
        <strong>{pstBrasil === null ? '–' : pct(pstBrasil)}</strong> das seções totalizadas no Brasil
      </p>
      <div className="trilho trilho-grande" aria-hidden="true">
        <div style={{ width: `${pstBrasil ?? 0}%` }} />
      </div>

      <p className="resumo-estados" aria-live="polite">
        {!dados
          ? erro ? `Não foi possível carregar os estados (${erro}). Nova tentativa em ${intervaloMs / 1000}s.` : 'Carregando os estados…'
          : !comecaram.length
            ? 'A totalização ainda não começou. A partir das 17h (horário de Brasília), cada estado aparece aqui conforme o TSE totaliza as seções.'
            : <>
                {concluidos.length === ufs.length
                  ? 'Todos os estados concluíram a totalização.'
                  : concluidos.length === 0
                    ? 'Nenhum estado concluiu a totalização ainda.'
                    : `${concluidos.length} de ${ufs.length} estados ${concluidos.length === 1 ? 'concluiu' : 'concluíram'} a totalização.`}
                {maisAtrasado && ` O mais atrasado é ${nome(maisAtrasado.uf)}, com ${pct(maisAtrasado.pst!)}.`}
              </>}
        {verificadoEm && <span className="resumo-estados-hora"> Verificado às {horaDoAparelho(verificadoEm)}.</span>}
      </p>

      <div className="estados-controles">
        <p>Líder para Presidente em cada estado. Toque num estado para abrir a disputa de Presidente nele.</p>
        <div className="alternar" role="group" aria-label="Ordenar estados">
          <button type="button" aria-pressed={ordem === 'andamento'} onClick={() => setOrdem('andamento')}>Mais totalizados</button>
          <button type="button" aria-pressed={ordem === 'nome'} onClick={() => setOrdem('nome')}>A–Z</button>
          <button type="button" aria-pressed={ordem === 'regiao'} onClick={() => setOrdem('regiao')}>Por região</button>
        </div>
      </div>

      {grupos.map((g) => (
        <div key={g.titulo ?? 'todos'} className={`estados-grupo${g.pstRegiao !== undefined ? ' estados-grupo-regiao' : ''}`}>
          {g.titulo && (
            <div className="estados-grupo-cabecalho">
              <h3>{g.titulo}</h3>
              {g.pstRegiao !== undefined && (
                <span className="estados-grupo-total">{g.pstRegiao === null ? 'sem dados' : `${pct(g.pstRegiao)} apurado`}</span>
              )}
            </div>
          )}
          {g.pstRegiao !== undefined && (
            <div className="trilho" aria-hidden="true"><div style={{ width: `${g.pstRegiao ?? 0}%` }} /></div>
          )}
          <ol className="estados" aria-label={g.titulo ?? 'Estados'}>
            {g.itens.map((e) => <Linha key={e.uf} e={e} onAbrir={onAbrir} />)}
          </ol>
        </div>
      ))}

      {exterior && (
        <div className="estados-grupo estados-grupo-exterior">
          <ol className="estados" aria-label="Exterior">
            <li><LinhaExterior e={exterior} onAbrir={onAbrir} /></li>
          </ol>
        </div>
      )}
    </section>
  );
}
