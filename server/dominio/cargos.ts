import type { Cargo } from '../../shared/tipos.ts';
import { UFS } from '../../shared/ufs.ts';

// Código do cargo no TSE -> eleição a que pertence e onde há resultado publicado
export const CARGOS: Record<number, Cargo> = {
  1: { codigo: 1, nome: 'Presidente', eleicao: 'federal', ufs: ['br', ...UFS, 'zz'], proporcional: false }, // zz = exterior
  3: { codigo: 3, nome: 'Governador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  5: { codigo: 5, nome: 'Senador', eleicao: 'estadual', ufs: UFS, proporcional: false },
  6: { codigo: 6, nome: 'Deputado federal', eleicao: 'estadual', ufs: UFS, proporcional: true },
  7: { codigo: 7, nome: 'Deputado estadual', eleicao: 'estadual', ufs: UFS.filter((u) => u !== 'df'), proporcional: true },
  8: { codigo: 8, nome: 'Deputado distrital', eleicao: 'estadual', ufs: ['df'], proporcional: true },
};
