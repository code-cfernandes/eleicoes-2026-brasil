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

export interface RespostaHistorico {
  /** Candidatos que o gráfico acompanha (top N do snapshot mais recente) */
  numeros: string[];
  /** Pontos em ordem cronológica; com ?desde=, só os posteriores a ele */
  pontos: PontoHistorico[];
}

export interface ConfigPublica {
  intervaloMs: number;
  turno: string;
  cargos: Cargo[];
}
