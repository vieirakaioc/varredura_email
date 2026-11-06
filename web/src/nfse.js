/** Exibe apenas o sequencial das NFS-e no formato ano + zeros + número. */
export function numeroNfse(valor) {
  if (valor == null) return valor;
  const texto = String(valor);
  const padrao = texto.match(/^20\d{2}0{3,}([1-9]\d*)$/);
  // Usa texto para preservar todos os dígitos, inclusive em números longos.
  return padrao ? padrao[1] : texto;
}
