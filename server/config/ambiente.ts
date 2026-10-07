// Variável vazia conta como não definida: no Portainer/compose é comum ficar "VAR=" em branco,
// e um "" virando 0 (intervalo, limite) seria desastroso.
export function env(nome: string): string | undefined {
  const v = process.env[nome]?.trim();
  return v ? v : undefined;
}
// Número positivo ou o padrão (nunca NaN/0 por engano)
export function envNumero(nome: string, padrao: number): number {
  const n = Number(env(nome));
  return Number.isFinite(n) && n > 0 ? n : padrao;
}
