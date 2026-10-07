import { transmitirTodos } from './tempo-real.ts';

// Estado global da apuração do turno atual: quando todas as disputas coletadas fecham (100% +
// resultado definido), o coletor para de consultar o TSE, os resultados viram arquivo e a IA e os
// balanços param de gerar notícias novas. Quem está com a tela aberta recebe o aviso na hora.
let tudoConcluido = false;

export const marcarTudoConcluido = () => {
  if (tudoConcluido) return;
  tudoConcluido = true;
  transmitirTodos('finalizado', { finalizado: true });
};

export const estaTudoConcluido = () => tudoConcluido;
