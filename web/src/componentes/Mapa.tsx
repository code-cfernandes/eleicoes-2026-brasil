import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Panorama } from '../../../shared/tipos.ts';
import { buscarPanorama } from '../api.ts';
import { pct } from '../formato.ts';
import { MAX_SERIES, corFixa } from '../paleta.ts';
import { MapaBrasil } from './MapaBrasil.tsx';

// Página "Mapa": totalização por estado, com alternância de cargo (Presidente/Governador/
// Senador) via GET /api/panorama?cargo=. Sem ?cargo=, o servidor responde com o panorama de
// Presidente. Se algum cargo além de Presidente der 400 (ex.: deploy antigo ainda sem a rota),
// a alternância se esconde sozinha em vez de insistir num cargo que sempre falharia.

const CARGOS_MAPA: { cargo: number; rotulo: string }[] = [
  { cargo: 1, rotulo: 'Presidente' },
  { cargo: 3, rotulo: 'Governador' },
  { cargo: 5, rotulo: 'Senador' },
];

export function Mapa({ intervaloMs, onAbrirEstado, onVerComoLista, cargoInicial, fixarCargo, cargos }: {
  intervaloMs: number; onAbrirEstado: (uf: string) => void; onVerComoLista?: () => void;
  /** Usado dentro da aba "Por estado" de uma disputa específica (Presidente/Governador/Senador) */
  cargoInicial?: number; fixarCargo?: boolean;
  /** Cargos com disputa no turno em exibição (no 2º turno não há Senador) */
  cargos?: number[];
}) {
  const opcoes = CARGOS_MAPA.filter((c) => !cargos || cargos.includes(c.cargo));
  const [cargo, setCargo] = useState(cargoInicial ?? opcoes[0]?.cargo ?? 1);
  const [dados, setDados] = useState<Panorama>();
  const [erro, setErro] = useState<string>();
  const [alternanciaDisponivel, setAlternanciaDisponivel] = useState(!fixarCargo);

  useEffect(() => {
    setDados(undefined);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        setDados(await buscarPanorama(ctrl.signal, cargo));
        setErro(undefined);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setErro((e as Error).message);
          // ?cargo= ainda não suportado por esse deploy do backend: volta para Presidente e
          // esconde a alternância, em vez de ficar tentando um cargo que sempre vai falhar
          if (cargo !== 1) { setAlternanciaDisponivel(false); setCargo(1); }
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [cargo, intervaloMs]);

  const rotuloCargo = CARGOS_MAPA.find((c) => c.cargo === cargo)?.rotulo ?? 'Presidente';
  const pstBrasil = dados?.brasil.pst ?? null;

  // Cor de quem lidera em cada estado: mesma regra do resto do app (número ordenado -> série),
  // então a cor do candidato no mapa é a mesma dos cards e do gráfico.
  const slots = useMemo(() => {
    const numeros = [...new Set((dados?.estados ?? []).map((e) => e.lider?.numero).filter((n): n is string => !!n))];
    return new Map(numeros.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
      .slice(0, MAX_SERIES)
      .map((n, i) => [n, i] as const));
  }, [dados]);
  const corDoCandidato = useCallback((c: { numero: string; nome: string }) => {
    const fixa = corFixa(c.nome);
    if (fixa) return fixa;
    const s = slots.get(c.numero);
    return s === undefined ? undefined : `var(--s${s})`;
  }, [slots]);

  return (
    <section className={fixarCargo ? undefined : 'mapa-pagina'} aria-labelledby={fixarCargo ? undefined : 'mapa-titulo'}>
      {!fixarCargo && (
        <div className="inicio-bloco-cabecalho">
          <h2 id="mapa-titulo">Liderança por estado</h2>
          {alternanciaDisponivel && (
            <div className="alternar" role="group" aria-label="Cargo mostrado no mapa">
              {opcoes.map((c) => (
                <button key={c.cargo} type="button" aria-pressed={cargo === c.cargo} onClick={() => setCargo(c.cargo)}>{c.rotulo}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="resumo-estados">
        {pstBrasil === null ? (erro ? `Não foi possível carregar (${erro}).` : 'Carregando…') : `${pct(pstBrasil)} das seções totalizadas no Brasil (${rotuloCargo}).`}
      </p>

      {dados && (
        <MapaBrasil estados={dados.estados} rotuloLider={rotuloCargo} modo="lider" corDoCandidato={corDoCandidato}
          onSelecionar={onAbrirEstado} verComoLista={onVerComoLista} />
      )}
    </section>
  );
}
