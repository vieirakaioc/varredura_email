// Empresas que a Escrita Fiscal não acompanha.
//
// Empresa 3 não é lançada por este time: as notas dela não entram em lista, indicador, gráfico,
// produtividade nem malha fina. O corte é feito no SQL, e não na tela, por dois motivos: o que não
// vem do Senior não pesa na consulta nem no cache, e nenhum total pode somar o que está fora do
// escopo — um número filtrado só na exibição volta a aparecer no primeiro gráfico esquecido.
//
// Para incluir ou tirar outra empresa, mexa só nesta lista.
export const EMPRESAS_FORA = [3];

/**
 * Cláusula AND que descarta as empresas fora do escopo.
 * `coluna`: a coluna CODEMP da consulta (ex.: 'n.CODEMP', 'fi.CODEMP').
 * `aceitaNulo`: mantém as linhas sem empresa identificada — notas destinadas a um CNPJ que não é
 * filial do grupo ("fora do grupo"), que devem continuar aparecendo.
 */
export function semEmpresasFora(coluna, { aceitaNulo = false } = {}) {
  if (!EMPRESAS_FORA.length) return '';
  const fora = `${coluna} NOT IN (${EMPRESAS_FORA.join(',')})`;
  return aceitaNulo ? ` AND (${coluna} IS NULL OR ${fora})` : ` AND ${fora}`;
}
