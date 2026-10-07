import type { TipoEleicao } from '../../shared/tipos.ts';

// Um turno só existe se ao menos um código de eleição estiver definido. O turno "atual" é o
// último definido: é o único coletado do TSE; os anteriores ficam arquivados (só leitura).
// Os códigos vêm do ambiente ou, na falta dele, da descoberta automática (codigos.ts), que pode
// preenchê-los depois da subida: por isso `turnos` e `turnoAtual` são calculados a cada leitura.
export type DefTurno = {
  numero: number;
  nome: string;
  eleicao: Record<TipoEleicao, string | undefined>;
  /** Início da apuração (epoch ms), para a contagem regressiva */
  inicioApuracao: number | null;
};
