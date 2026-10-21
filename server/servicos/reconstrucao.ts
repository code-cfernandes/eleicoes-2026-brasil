import { defTurno } from '../config/config.ts';
import { disputasComSnapshots, maisVotadosDoSnapshot, snapshotsDaDisputa } from '../dados/historico.ts';
import { lerEstadoNovidades, salvarEstadoNovidades } from '../dados/novidades.ts';
import { CARGOS } from '../dominio/cargos.ts';
import { marcosDoTurno } from '../dominio/deteccao.ts';
import { conclusaoBrasil, conclusaoUF, inicioDaTotalizacao, lugar, nome, pct } from '../dominio/textos.ts';
import { gravarNovidade, idMaisRecente, recomecarLinhaDoTempo } from './novidades.ts';

// Reconstrução do histórico: numa base que rodou numa versão sem a linha do tempo, os snapshots
// existem mas os eventos não. Roda UMA vez na subida: apaga as novidades (não o estado de
// alerta/push) e reconstrói início, marcos, conclusões e viradas a partir dos snapshots, em ordem
// cronológica. Só grava (não publica: nada de SSE/push) e não mexe em alerta_estado, então não
// há aviso repetido.
export function reconstruirHistorico() {
  if (lerEstadoNovidades('reconstruido:1')) return;

  recomecarLinhaDoTempo();

  for (const { turno, uf, cargo } of disputasComSnapshots()) {
    const cfg = CARGOS[cargo];
    if (!cfg) continue;
    const snaps = snapshotsDaDisputa(turno, uf, cargo);
    if (!snaps.length) continue;

    const vagas = cargo === 5 ? 2 : 1;
    const brasil = cargo === 1 && uf === 'br';
    let inicioFeito = false;
    let marcoAtual = -1;
    let lideres: string | null = null;
    const conclusao = (id: number) => maisVotadosDoSnapshot(id, 2)
      .map((c) => ({ nome: c.nome, votos: c.votos, percentual: c.percentual, eleito: false, situacao: '' }));

    for (const s of snaps) {
      if (brasil && !inicioFeito) {
        inicioFeito = true;
        const inicio = defTurno(turno)?.inicioApuracao ?? s.instante;
        gravarNovidade({ chave: 'inicio:br:1', turno, instante: inicio, tipo: 'inicio', uf: 'br', cargo: 1,
          texto: inicioDaTotalizacao(turno, inicio) });
      }

      if (brasil) {
        // Só o maior marco atingido por snapshot (um salto de 20% para 55% gera só o de 50%,
        // como na detecção em tempo real: marcos saltados não são inventados)
        const m = Math.max(-1, ...marcosDoTurno(turno).filter((x) => x > 0 && s.pst >= x));
        if (m > marcoAtual) {
          marcoAtual = m;
          if (m === 100) {
            gravarNovidade({ chave: 'marco:br:1:100', turno, instante: s.instante, tipo: 'marco', uf: 'br', cargo: 1,
              texto: conclusaoBrasil({ candidatos: conclusao(s.id) }), final: true });
          } else {
            gravarNovidade({ chave: `marco:br:1:${m}`, turno, instante: s.instante, tipo: 'marco', uf: 'br', cargo: 1,
              texto: `Brasil passou de ${m}% das seções totalizadas para Presidente.` });
          }
        }
      }

      if (cargo === 1 && !brasil && uf !== 'zz' && s.pst >= 100) {
        gravarNovidade({ chave: `concluido:${uf}:1`, turno, instante: s.instante, tipo: 'estado-concluido', uf, cargo: 1,
          texto: conclusaoUF({ candidatos: conclusao(s.id), uf }), final: true });
        break;
      }

      if (!cfg.proporcional && s.pst >= 5) {
        const top = maisVotadosDoSnapshot(s.id, vagas);
        const atuais = top.map((c) => c.numero).sort().join(',');
        if (atuais && lideres !== null && lideres !== atuais) {
          const antes = new Set(lideres.split(','));
          const entrou = top.find((c) => !antes.has(c.numero));
          if (entrou) {
            const quem = vagas === 1 ? 'passou à frente' : `passou a ocupar uma das ${vagas} primeiras posições`;
            gravarNovidade({ chave: `virada:${uf}:${cargo}:${s.instante}`, turno, instante: s.instante, tipo: 'virada', uf, cargo,
              texto: `${cfg.nome}, ${lugar(uf)}: ${nome(entrou)} ${quem} (${pct(s.pst)} das seções totalizadas).` });
          }
        }
        if (atuais) lideres = atuais;
      }
    }
  }

  salvarEstadoNovidades('reconstruido:1', true);
  console.log(`[novidades] histórico reconstruído (${idMaisRecente()} evento(s))`);
}
