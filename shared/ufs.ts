// Nome por extenso de cada abrangência (tela e texto das notificações)
export const NOMES_UF: Record<string, string> = {
  br: 'Brasil', zz: 'Exterior', ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia', ce: 'Ceará',
  df: 'Distrito Federal', es: 'Espírito Santo', go: 'Goiás', ma: 'Maranhão', mt: 'Mato Grosso',
  ms: 'Mato Grosso do Sul', mg: 'Minas Gerais', pa: 'Pará', pb: 'Paraíba', pr: 'Paraná',
  pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte',
  rs: 'Rio Grande do Sul', ro: 'Rondônia', rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo',
  se: 'Sergipe', to: 'Tocantins',
};

// Regiões (agrupamento da aba "Por estado"); o exterior fica num grupo próprio
export const REGIOES: { nome: string; ufs: string[] }[] = [
  { nome: 'Norte', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'] },
  { nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  { nome: 'Centro-Oeste', ufs: ['df', 'go', 'ms', 'mt'] },
  { nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  { nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
  { nome: 'Exterior', ufs: ['zz'] },
];
