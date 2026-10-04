// Contrato entre o backend (server/) e a tela (web/). Só tipos: some no build.

export type TipoEleicao = 'federal' | 'estadual';

export interface Cargo {
  codigo: number;
  nome: string;
  eleicao: TipoEleicao;
  /** Abrangências com resultado publicado; 'br' = nacional */
  ufs: string[];
  /** Deputados: eleitos por quociente, não pelos mais votados */
  proporcional: boolean;
}

export interface Candidato {
  numero: string;
  nome: string;
  partido: string;
  /** Sequencial do candidato no TSE (identifica a foto) */
  sqcand: string;
  /** URL da foto oficial servida pelo backend */
  foto: string;
  votos: number;
  percentual: number;
  eleito: boolean;
  /** Texto do TSE: "Eleito", "2º turno", "Eleito por QP", "Suplente"… */
  situacao: string;
}

export interface Resultado {
  cargo: number;
  nomeCargo: string;
  uf: string;
  atualizadoEm: string;
  instante: number | null;
  secoesTotalizadas: number;
  vagas: number;
  candidatos: Candidato[];
}

export interface PontoHistorico {
  em: string;
  /** epoch ms da geração do TSE */
  instante: number;
  /** epoch ms do início da hora (Brasília) */
  hora: number;
  pst: number;
  cand: { numero: string; nome: string; votos: number; percentual: number }[];
}

// Aba "Por estado": andamento da apuração e líder (Presidente) em cada UF
export interface EstadoPanorama {
  uf: string;
  /** % de seções totalizadas; null se o TSE não respondeu para esta UF */
  pst: number | null;
  instante: number | null;
  /** Mais votado no estado, se a apuração já começou */
  lider: Candidato | null;
  /** Diferença do líder para o 2º, em pontos percentuais */
  vantagem: number | null;
}

export interface Panorama {
  brasil: { pst: number | null; instante: number | null };
  estados: EstadoPanorama[];
}

// Visão de um estado: todos os cargos daquela UF, só com os mais votados
export interface ResumoCargo {
  cargo: number;
  nome: string;
  proporcional: boolean;
  vagas: number;
  /** % de seções totalizadas desse cargo na UF; null se o TSE não respondeu */
  pst: number | null;
  instante: number | null;
  /** Total de candidatos na disputa */
  total: number;
  /** Só quem tem votos, do mais votado para o menos: top 3 (Presidente) ou top 5 (demais) */
  candidatos: Candidato[];
}

export interface VisaoEstado {
  uf: string;
  cargos: ResumoCargo[];
}

export interface RespostaHistorico {
  /** Candidatos que o gráfico acompanha (top N do snapshot mais recente) */
  numeros: string[];
  /** Pontos em ordem cronológica; com ?desde=, só os posteriores a ele */
  pontos: PontoHistorico[];
}

export interface ConfigPublica {
  intervaloMs: number;
  /** Chave pública VAPID para inscrever o aparelho em notificações */
  chavePush: string;
  turno: string;
  cargos: Cargo[];
}
