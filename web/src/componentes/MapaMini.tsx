import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Panorama } from '../../../shared/tipos.ts';
import { buscarPanorama } from '../api.ts';
import { MAX_SERIES, corFixa } from '../paleta.ts';
import { MapaBrasil } from './MapaBrasil.tsx';

// Mapa compacto da home: totalização por estado com alternância de cargo
// (Presidente/Governador/Senador), mesmo padrão do mapa da página própria.

const CARGOS_MAPA: { cargo: number; rotulo: string }[] = [
  { cargo: 1, rotulo: 'Presidente' },
  { cargo: 3, rotulo: 'Governador' },
  { cargo: 5, rotulo: 'Senador' },
];

export function MapaMini({ intervaloMs, onAbrirEstado, onAbrirMapa, cargos }: {
  intervaloMs: number; onAbrirEstado: (uf: string) => void; onAbrirMapa: () => void;
  /** Cargos com disputa no turno em exibição (no 2º turno não há Senador) */
  cargos?: number[];
}) {
  const opcoes = CARGOS_MAPA.filter((c) => !cargos || cargos.includes(c.cargo));
  const [cargo, setCargo] = useState(opcoes[0]?.cargo ?? 1);
  const [dados, setDados] = useState<Panorama>();

  useEffect(() => {
    setDados(undefined);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try { setDados(await buscarPanorama(ctrl.signal, cargo)); } catch { /* tenta de novo */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, intervaloMs);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [cargo, intervaloMs]);

  const rotuloCargo = CARGOS_MAPA.find((c) => c.cargo === cargo)?.rotulo ?? 'Presidente';

  // Cor de quem lidera: mesma regra do app (número ordenado -> série) + cores fixas
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
    <section className="inicio-bloco inicio-mapa-mini" aria-labelledby="inicio-mapa-titulo">
      <div className="inicio-bloco-cabecalho">
        <h2 id="inicio-mapa-titulo">Liderança por estado</h2>
        <button type="button" className="inicio-lista-completa" onClick={onAbrirMapa}>Ver mapa</button>
      </div>

      <div className="alternar inicio-mapa-alternar" role="group" aria-label="Cargo mostrado no mapa">
        {opcoes.map((c) => (
          <button key={c.cargo} type="button" aria-pressed={cargo === c.cargo} onClick={() => setCargo(c.cargo)}>{c.rotulo}</button>
        ))}
      </div>

      {dados ? (
        <MapaBrasil estados={dados.estados} rotuloLider={rotuloCargo} modo="lider" corDoCandidato={corDoCandidato}
          onSelecionar={onAbrirEstado} />
      ) : (
        <p className="resumo-estados">Carregando…</p>
      )}
    </section>
  );
}
