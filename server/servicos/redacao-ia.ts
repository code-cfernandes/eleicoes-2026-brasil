import { gravarTextoRedigido, proximaParaRedigir, type LinhaNovidade } from '../dados/novidades.ts';
import { iaDisponivel, intervaloIaMs, redigir } from '../integracoes/ia.ts';
import { estaTudoConcluido } from './encerramento.ts';
import { invalidarLeitura, paraEvento } from './novidades.ts';
import { CANAL_NOVIDADES, transmitir } from './tempo-real.ts';

// Redação por IA (DeepSeek): reescreve, aos poucos, o texto dos eventos de Presidente/Brasil.
// A detecção continua determinística e a frase-modelo é gravada na hora (nunca fica vazio); a IA
// só substitui o texto depois. Sem chave ou em qualquer falha, a frase-modelo permanece.
// Dois ritmos: backfillIA() sobe e recalcula as antigas (1s entre chamadas); redigirComIA()
// cuida do que vai aparecendo, no ritmo de ~1 chamada por IA_INTERVALO_MIN.
let processandoIA = false;
let ultimaChamadaIA = 0;

function aplicarRedigida(p: LinhaNovidade, textoIA: string) {
  gravarTextoRedigido(p.id, textoIA);
  invalidarLeitura();
  console.log(`[ia] ${textoIA}`);
  transmitir(CANAL_NOVIDADES, 'novidade', paraEvento({ ...p, texto: textoIA, ia: 1 }));
}

// Recalcula as notícias antigas que ainda têm frase-modelo (chamado uma vez na subida)
export async function backfillIA() {
  if (!iaDisponivel() || processandoIA || estaTudoConcluido()) return;
  processandoIA = true;
  try {
    let n = 0;
    while (n < 200) {
      const p = proximaParaRedigir();
      if (!p) break;
      const textoIA = await redigir(p.texto);
      if (!textoIA) break; // falhou/limite: para o backfill, o throttle assume depois
      aplicarRedigida(p, textoIA);
      n++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error('[ia backfill]', (e as Error).message);
  } finally {
    processandoIA = false;
  }
}

export async function redigirComIA() {
  if (!iaDisponivel() || processandoIA || estaTudoConcluido() || Date.now() - ultimaChamadaIA < intervaloIaMs()) return;
  ultimaChamadaIA = Date.now();
  processandoIA = true;
  try {
    const p = proximaParaRedigir();
    if (!p) return;
    const textoIA = await redigir(p.texto);
    if (!textoIA) return;
    aplicarRedigida(p, textoIA);
  } catch (e) {
    console.error('[ia]', (e as Error).message);
  } finally {
    processandoIA = false;
  }
}
