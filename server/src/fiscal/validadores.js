// Validações de identificação: CNPJ (numérico e alfanumérico), CPF e chave de acesso.

const valorCaractere = (c) => c.charCodeAt(0) - 48; // regra da RFB para CNPJ alfanumérico ('A' = 17)

export function limparId(v) {
  return v == null ? '' : String(v).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** CNPJ numérico ou alfanumérico (IN RFB 2.229/2024, vigente a partir de jul/2026). */
export function cnpjValido(v) {
  const c = limparId(v);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c)) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;
  const dv = (base) => {
    let peso = 2, total = 0;
    for (let i = base.length - 1; i >= 0; i--) {
      total += valorCaractere(base[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const r = total % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

export function cpfValido(v) {
  const c = limparId(v);
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

export const documentoValido = (v) => {
  const c = limparId(v);
  return c.length === 11 ? cpfValido(c) : cnpjValido(c);
};

export const raizCnpj = (v) => limparId(v).slice(0, 8);

export function formatarCnpj(v) {
  const c = limparId(v);
  if (c.length === 14) return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
  if (c.length === 11) return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
  return v ?? '';
}

/** Dígito verificador (módulo 11) da chave de acesso de 43 posições. */
export function dvChave(chave43) {
  let peso = 2, total = 0;
  for (let i = chave43.length - 1; i >= 0; i--) {
    total += valorCaractere(chave43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = total % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Decompõe a chave de acesso (NF-e, NFC-e, CT-e, MDF-e) em seus campos. */
export function decomporChave(v) {
  const c = limparId(v);
  if (c.length !== 44) return null;
  return {
    cUF: c.slice(0, 2),
    aamm: c.slice(2, 6),
    cnpj: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: String(Number(c.slice(22, 25))),
    numero: String(Number(c.slice(25, 34))),
    tpEmis: c.slice(34, 35),
    codigo: c.slice(35, 43),
    dv: c.slice(43),
  };
}

/** Valida a chave. Devolve lista de problemas (vazia = válida). */
export function problemasChave(v, doc = {}) {
  const c = limparId(v);
  const p = [];
  if (!c) return ['Chave de acesso ausente'];
  if (!/^\d{2}\d{4}[0-9A-Z]{12}\d{2}\d{24}$/.test(c)) return [`Formato inválido (${c.length} posições; esperado 44)`];
  const partes = decomporChave(c);
  const dv = dvChave(c.slice(0, 43));
  if (String(dv) !== partes.dv) p.push(`Dígito verificador inválido: informado ${partes.dv}, calculado ${dv}`);
  const mes = Number(partes.aamm.slice(2));
  if (mes < 1 || mes > 12) p.push(`Mês de emissão inválido na chave (${partes.aamm})`);
  if (doc.emitente_cnpj && limparId(doc.emitente_cnpj).length === 14 && partes.cnpj !== limparId(doc.emitente_cnpj)) {
    p.push(`CNPJ da chave (${partes.cnpj}) difere do emitente (${limparId(doc.emitente_cnpj)})`);
  }
  if (doc.numero && partes.numero !== String(Number(doc.numero))) p.push(`Número na chave (${partes.numero}) difere do documento (${doc.numero})`);
  if (doc.serie != null && doc.serie !== '' && partes.serie !== String(Number(doc.serie))) p.push(`Série na chave (${partes.serie}) difere do documento (${doc.serie})`);
  if (doc.modelo && partes.modelo !== String(doc.modelo).padStart(2, '0')) p.push(`Modelo na chave (${partes.modelo}) difere do documento (${doc.modelo})`);
  if (doc.data_emissao) {
    const aamm = doc.data_emissao.slice(2, 4) + doc.data_emissao.slice(5, 7);
    if (aamm !== partes.aamm) p.push(`Ano/mês da chave (${partes.aamm}) difere da emissão (${doc.data_emissao.slice(0, 7)})`);
  }
  return p;
}

/** Gera uma chave válida (usada na geração de dados de demonstração e testes). */
export function montarChave({ cUF, aamm, cnpj, modelo = '55', serie, numero, tpEmis = '1', codigo }) {
  const base = `${String(cUF).padStart(2, '0')}${aamm}${limparId(cnpj).padStart(14, '0')}${modelo}` +
    `${String(serie).padStart(3, '0')}${String(numero).padStart(9, '0')}${tpEmis}${String(codigo).padStart(8, '0')}`;
  return base + dvChave(base);
}

// ------------------------------------------------------------------ NFS-e padrão nacional (chave de 50 dígitos)
// cMun(7) ambGer(1) tpInsc(1) CNPJ/CPF(14) nNFSe(13) AAMM(4) cNF(9) DV(1) — DV módulo 11 como na NF-e.
export function decomporChaveNFSe(v) {
  const c = String(v ?? '').replace(/^NFSE/, '').replace(/\D/g, '');
  if (c.length !== 50) return null;
  const tpInsc = c[8];
  return {
    chave: c, municipio: c.slice(0, 7), ambiente: c[7], tpInsc,
    documento: tpInsc === '1' ? c.slice(12, 23) : c.slice(9, 23),
    numero: String(Number(c.slice(23, 36))), aamm: c.slice(36, 40), codigo: c.slice(40, 49), dv: c[49],
  };
}
const CODIGOS_UF = new Set(['11', '12', '13', '14', '15', '16', '17', '21', '22', '23', '24', '25', '26', '27', '28', '29', '31', '32', '33', '35', '41', '42', '43', '50', '51', '52', '53']);
export function chaveNFSeValida(c) {
  if (!/^\d{50}$/.test(c) || String(dvChave(c.slice(0, 49))) !== c[49]) return false;
  const p = decomporChaveNFSe(c);
  const ano = Number(p.aamm.slice(0, 2)), mes = Number(p.aamm.slice(2));
  return CODIGOS_UF.has(c.slice(0, 2)) && ['1', '2'].includes(p.ambiente) && ['1', '2'].includes(p.tpInsc)
    && mes >= 1 && mes <= 12 && ano >= 20 && ano <= 40 && documentoValido(p.documento);
}

/** Procura chaves nacionais de NFS-e no texto, inclusive quando quebradas em duas linhas. */
export function encontrarChavesNFSe(texto) {
  if (!texto) return [];
  const achadas = new Set();
  const runs = [...texto.matchAll(/\d[\d .]*\d/g)].map((m) => m[0].replace(/\D/g, '')).filter((r) => r.length >= 10);
  for (let i = 0; i < runs.length; i++) {
    let acc = '';
    for (let j = i; j < Math.min(runs.length, i + 3) && acc.length < 50; j++) {
      acc += runs[j];
      for (let k = 0; k + 50 <= acc.length; k++) if (chaveNFSeValida(acc.slice(k, k + 50))) achadas.add(acc.slice(k, k + 50));
    }
  }
  return [...achadas];
}

/** Procura chaves de 44 dígitos em um texto (DANFE, corpo de e-mail). Aceita espaços entre blocos. */
export function encontrarChaves(texto) {
  if (!texto) return [];
  const achadas = new Set();
  const compacto = texto.replace(/(\d)[ .\-]+(?=\d)/g, '$1');
  for (const m of compacto.matchAll(/(?<!\d)(\d{44})(?!\d)/g)) {
    if (String(dvChave(m[1].slice(0, 43))) === m[1][43]) achadas.add(m[1]);
  }
  return [...achadas];
}
