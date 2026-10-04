import { useEffect, useState } from 'react';
import type { SaudeDados } from '../../../shared/tipos.ts';

// "Status dos dados": só o que é medido de fato (não inventa "Integridade OK"). Usado no
// rodapé da sidebar (desktop) e na aba "Mais" (mobile). O backend pode ainda não ter o
// campo `dados` (rota em implementação em paralelo): nesse caso mostra só o que tiver.

interface RespostaSaude { ok: boolean; dados?: SaudeDados }

function haSegundos(ms: number | null) {
  if (ms === null) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `há ${s}s`;
  const min = Math.round(s / 60);
  return `há ${min} min`;
}

export function StatusDados({ compacto = false }: { compacto?: boolean }) {
  const [saude, setSaude] = useState<RespostaSaude>();

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = async () => {
      clearTimeout(timer);
      try {
        const r = await fetch('/api/saude', { signal: ctrl.signal, cache: 'no-cache' });
        if (r.ok) setSaude(await r.json());
      } catch { /* tenta de novo na próxima rodada */ }
      if (!ctrl.signal.aborted) timer = setTimeout(carregar, 30_000);
    };
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, []);

  const dados = saude?.dados;
  // "Falhas recentes" soma toda requisição que falhou (com ~110 disputas monitoradas, sobe
  // rápido mesmo quando tudo está bem — é normal um arquivo ou outro dar 404 no TSE). Só vale
  // alertar quando isso significa "estamos sem dado bom agora": a falha mais recente é depois
  // da última resposta OK, e isso já dura mais de 2 minutos.
  const semRespostaBoaHaTempo = !!dados && dados.tse.ultimaFalha !== null
    && (dados.tse.ultimaRespostaOk === null || dados.tse.ultimaFalha > dados.tse.ultimaRespostaOk)
    && Date.now() - dados.tse.ultimaFalha > 2 * 60_000;

  return (
    <div className={`status-dados${compacto ? ' status-dados-compacto' : ''}`}>
      <p className="status-dados-titulo">Status dos dados</p>
      {!dados ? (
        <p className="status-dados-linha status-dados-suave">
          {saude ? 'Conectado ao servidor.' : 'Carregando…'}
        </p>
      ) : (
        <ul className="status-dados-lista">
          <li>
            <span className={`status-dados-ponto${semRespostaBoaHaTempo ? ' status-dados-ponto-alerta' : dados.tse.ultimaRespostaOk ? ' status-dados-ponto-ok' : ''}`} aria-hidden="true" />
            <span>{semRespostaBoaHaTempo ? 'Sem resposta do TSE' : 'Última resposta do TSE'}</span>
            <strong>{haSegundos(dados.tse.ultimaRespostaOk) ?? (semRespostaBoaHaTempo ? 'desde o início' : 'sem dados')}</strong>
          </li>
          {dados.tse.falhasRecentes > 0 && (
            <li>
              <span className="status-dados-ponto status-dados-ponto-neutro" aria-hidden="true" />
              <span>Falhas recentes (10 min)</span>
              <strong>{dados.tse.falhasRecentes}</strong>
            </li>
          )}
          <li>
            <span className="status-dados-ponto status-dados-ponto-neutro" aria-hidden="true" />
            <span>Intervalo de coleta</span>
            <strong>{Math.round(dados.coletaIntervaloMs / 1000)}s</strong>
          </li>
          <li>
            <span className={`status-dados-ponto${dados.conexoesAoVivo > 0 ? ' status-dados-ponto-ok' : ' status-dados-ponto-neutro'}`} aria-hidden="true" />
            <span>Conexões ao vivo</span>
            <strong>{dados.conexoesAoVivo}</strong>
          </li>
        </ul>
      )}
    </div>
  );
}
