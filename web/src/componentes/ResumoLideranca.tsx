import type { Candidato } from '../../../shared/tipos.ts';
import { pct, pontos, votos } from '../formato.ts';

// Resumo textual de quem lidera uma disputa: usado tanto na disputa completa (App.tsx)
// quanto no placar nacional da página Início. Mesma lógica, um só lugar para manter.

export interface Props {
  candidatos: Candidato[];
  vagas: number;
  proporcional: boolean;
}

export function ResumoLideranca({ candidatos, vagas, proporcional }: Props) {
  const apuracaoComecou = candidatos.some((c) => c.votos > 0);
  if (!apuracaoComecou) return null;

  const comVotos = candidatos.filter((c) => c.votos > 0);
  const [lider, vice] = comVotos;
  if (!lider) return null;
  const indefinido = !candidatos.some((c) => c.eleito || /2º turno/i.test(c.situacao || ''));
  const dentro = !proporcional && vagas > 1 ? comVotos.slice(0, vagas) : [];
  const ultimaVaga = dentro.at(-1);
  const primeiroFora = dentro.length === vagas ? comVotos[vagas] : undefined;

  return (
    <div className="resumo" aria-live="polite">
      <p className="resumo-estado">
        {candidatos.find((c) => c.eleito)
          ? <span className="resumo-tag resumo-tag-eleito">Resultado definido</span>
          : candidatos.some((c) => /2º turno/i.test(c.situacao || ''))
            ? <span className="resumo-tag resumo-tag-segundo-turno">Vai para o 2º turno</span>
            : <span className="resumo-tag resumo-tag-andamento">Em totalização</span>}
      </p>
      {proporcional ? (
        // Eleição proporcional: não existe "disputa" entre o 1º e o 2º da lista
        <p className="resumo-lider">
          <strong>{lider.nome}</strong> ({lider.partido}) é quem tem mais votos até agora, com <strong>{pct(lider.percentual)}</strong>.
        </p>
      ) : vagas > 1 ? (
        <>
          <p className="resumo-lider">
            Nas {vagas} vagas agora:{' '}
            {dentro.map((c, i) => (
              <span key={c.numero}>
                {i > 0 && (i === dentro.length - 1 ? ' e ' : ', ')}
                <strong>{c.nome}</strong> ({pct(c.percentual)})
              </span>
            ))}.
          </p>
          {ultimaVaga && primeiroFora && (
            <p className="resumo-corte">
              {primeiroFora.nome}, em {vagas + 1}º, está a {pontos(ultimaVaga.percentual - primeiroFora.percentual)} da
              última vaga ({votos(ultimaVaga.votos - primeiroFora.votos)}).
            </p>
          )}
        </>
      ) : (
        <p className="resumo-lider">
          {vice && lider.votos === vice.votos ? (
            <><strong>{lider.nome}</strong> e <strong>{vice.nome}</strong> estão empatados, com {pct(lider.percentual)}.</>
          ) : (
            <>
              <strong>{lider.nome}</strong> ({lider.partido}) lidera com <strong>{pct(lider.percentual)}</strong>
              {vice && <>, {pontos(lider.percentual - vice.percentual)} à frente de <strong>{vice.nome}</strong> ({vice.partido}), {votos(lider.votos - vice.votos)} de diferença</>}.
            </>
          )}
          {/* Maioria absoluta só decide com mais de dois na disputa: no 2º turno (dois candidatos)
              quem lidera sempre tem mais da metade, e a frase sobre "1º turno" não cabe */}
          {indefinido && candidatos.length > 2 && (lider.percentual > 50
            ? ' Com mais da metade dos votos válidos, vence no 1º turno se mantiver a vantagem.'
            : ` Para vencer no 1º turno é preciso mais da metade dos votos válidos: faltam ${pontos(50 - lider.percentual)}.`)}
        </p>
      )}
    </div>
  );
}
