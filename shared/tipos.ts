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

/** Números gerais da disputa (mesmo arquivo do TSE: blocos s, e e v) */
export interface Totais {
  secoes: number;             // s.ts
  secoesTotalizadas: number;  // s.st
  eleitores: number;          // e.te
  comparecimento: number;     // e.c
  abstencao: number;          // e.a
  votosTotais: number;        // v.tv  (todos os votos computados até agora)
  validos: number;            // v.vv
  brancos: number;            // v.vb
  nulos: number;              // v.tvn (nulos + nulos técnicos)
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
  /** Ausente em respostas antigas/cache; a tela deve tolerar */
  totais?: Totais;
}

export interface PontoHistorico {
  em: string;
  /** epoch ms da geração do TSE */
  instante: number;
  /** epoch ms do início da faixa de 10 minutos (Brasília) */
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
  /** 2º mais votado, quando o cargo tem mais de uma vaga (Senado); ausente na vaga única */
  segundo?: Candidato;
  /** Diferença que decide: vaga única = 1º − 2º; Senado = 2º − 3º (margem da última vaga) */
  vantagem: number | null;
  /** Contagem exata de seções, para agregar o total por região; ausente em respostas antigas */
  secoesTotalizadas?: number;
  secoes?: number;
}

export interface Panorama {
  /** Cargo do líder mostrado em cada UF: 1 Presidente (padrão), 3 Governador, 5 Senador (GET /api/panorama?cargo=) */
  cargo?: number;
  brasil: { pst: number | null; instante: number | null; totais?: Totais };
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
  /** Início da apuração (epoch ms), para a contagem regressiva; null se não configurado */
  inicioApuracao: number | null;
  turno: string;
  cargos: Cargo[];
}

// "O que está acontecendo agora": eventos estatísticos da totalização (sem análise política).
// GET /api/novidades?desde=<id>&limite=30 → mais recentes primeiro; com ?desde, só os de id maior.
export type TipoEvento =
  | 'inicio'            // a totalização da disputa começou
  | 'marco'             // disputa/UF atingiu 25, 50, 75, 90 ou 100% das seções
  | 'estado-concluido'  // uma UF chegou a 100%
  | 'virada'            // mudou quem lidera (ou quem está nas vagas, no Senado)
  | 'definido'          // TSE marcou eleito ou 2º turno
  | 'ritmo'             // volume de votos totalizados num intervalo (ex.: +1,2 mi em 5 min)
  | 'diferenca'         // diferença entre 1º e 2º mudou de forma relevante
  | 'progresso';        // balanço periódico do andamento (a cada poucos minutos)

export interface EventoApuracao {
  id: number;
  /** epoch ms (horário da geração do TSE que originou o evento) */
  instante: number;
  tipo: TipoEvento;
  uf: string;    // 'br', UF ou 'zz'
  cargo: number;
  texto: string; // frase pronta em português, neutra
  /** 'ia' quando o texto foi redigido pela DeepSeek (ausente nas frases-modelo do código) */
  fonte?: 'ia';
}

export interface RespostaNovidades {
  eventos: EventoApuracao[];
}

// Saúde da coleta, para o rodapé "Status dos dados" (GET /api/saude → { ..., dados: SaudeDados })
export interface SaudeDados {
  tse: {
    /** Última resposta bem-sucedida do TSE (epoch ms) */
    ultimaRespostaOk: number | null;
    ultimaFalha: number | null;
    /** Falhas nos últimos 10 minutos */
    falhasRecentes: number;
    latenciaMediaMs: number | null;
  };
  coletaIntervaloMs: number;
  conexoesAoVivo: number;
}
