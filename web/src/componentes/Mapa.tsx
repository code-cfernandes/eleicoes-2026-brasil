import { useEffect, useState } from 'react';
import type { Panorama } from '../../../shared/tipos.ts';
import { buscarPanorama } from '../api.ts';
import { pct } from '../formato.ts';
import { MapaBrasil } from './MapaBrasil.tsx';

// Página "Mapa": totalização por estado, com alternância de cargo (Presidente/Governador/
// Senador). GET /api/panorama?cargo= é novo (backend em implementação em paralelo); sem
// ?cargo= o servidor antigo ainda responde com o panorama de Presidente, então o 1º turno
// continua funcionando mesmo antes do deploy da rota nova. Se algum cargo além de Presidente
// der 400 (rota ainda não aceita ?cargo= naquele deploy), a alternância se esconde sozinha.

const CARGOS_MAPA: { cargo: number; rotulo: string }[] = [
  { cargo: 1, rotulo: 'Presidente' },
  { cargo: 3, rotulo: 'Governador' },
  { cargo: 5, rotulo: 'Senador' },
];

export function Mapa({ intervaloMs, onAbrirEstado, onVerComoLista, cargoInicial, fixarCargo }: {
  intervaloMs: number; onAbrirEstado: (uf: string) => void; onVerComoLista?: () => void;
  /** Usado dentro da aba "Por estado" de uma disputa específica (Presidente/Governador/Senador) */
  cargoInicial?: number; fixarCargo?: boolean;
}) {
  const [cargo, setCargo] = useState(cargoInicial ?? 1);
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

  return (
    <section className={fixarCargo ? undefined : 'mapa-pagina'} aria-labelledby={fixarCargo ? undefined : 'mapa-titulo'}>
      {!fixarCargo && (
        <div className="inicio-bloco-cabecalho">
          <h2 id="mapa-titulo">Totalização por estado</h2>
          {alternanciaDisponivel && (
            <div className="alternar" role="group" aria-label="Cargo mostrado no mapa">
              {CARGOS_MAPA.map((c) => (
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
        <MapaBrasil estados={dados.estados} rotuloLider={rotuloCargo} modo="andamento"
          onSelecionar={onAbrirEstado} verComoLista={onVerComoLista} />
      )}
    </section>
  );
}
