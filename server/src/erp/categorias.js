// Tipo de nota (serviço, combustível, produto, frete...) a partir dos itens do XML no Senior.
// Usado nas duas abas de "Lançamento de notas": pendentes (E000NFC) e lançadas (E440NFC).
import { getConfig } from '../db/index.js';
import { consultar } from './senior.js';

export const CATEGORIAS = {
  combustivel: 'Combustível (posto)',
  servico: 'Serviço',
  frete: 'Frete (CT-e)',
  energia_telecom: 'Energia/Telecom',
  biomassa: 'Bagaço/Madeira',
  produto: 'Produto',
  sem_itens: 'Sem itens',
};

// Notas de bagaço, madeira, cavaco etc. (lançadas pelo Faturamento). Padrões LIKE sobre a descrição em
// maiúsculas ("_" cobre Ç/Ã: BAGAÇO e BAGACO). NCM: 2303 bagaço; 4401 lenha/cavaco/serragem; 4403/4404/4407 madeira.
const REGRA_BIOMASSA_PADRAO = {
  descricoes: ['%BAGA_O%', '%MADEIRA%', '%CAVACO%', '%LENHA%', '%EUCALIPTO%', '%SERRAGEM%', '%BIOMASSA%'],
  ncms: ['2303', '4401', '4403', '4404', '4407'],
};
// Combustível: NCM 2710 (diesel, gasolina, óleos), 2207 (etanol), 3102 (ARLA 32); ou fornecedor com POSTO no nome
const REGRA_COMBUSTIVEL = {
  descricoes: ['%DIESEL%', '%GASOLINA%', '%ETANOL%', '%ALCOOL COMB%', '%ARLA%', '%LUBRIFICANTE%', '%GNV%', '%COMBUST_VEL%'],
  ncms: ['2710', '2207', '310210'],
  fornecedor: ['%POSTO%', '%COMBUST_VEIS%', '%AUTO POSTO%'],
};
export const regraBiomassa = () => ({ ...REGRA_BIOMASSA_PADRAO, ...(getConfig('regra_faturamento', null) ?? {}) });

const COLUNAS_DESCRICAO = ['DESPRO', 'CPLIPC', 'DESIPC', 'DESITE', 'XPROD', 'PRODES', 'DESNFE'];
const COLUNAS_NCM = ['CODCLF', 'NCMPRO', 'CODNCM', 'CLAFIS', 'NCMIPC', 'NCM'];
let colunasItemCache = { em: 0, valor: null };

/** Descobre, uma vez por dia, quais colunas de descrição e NCM existem em E000IPC nesta base do Senior. */
export async function colunasItem() {
  if (colunasItemCache.valor && Date.now() - colunasItemCache.em < 24 * 3600_000) return colunasItemCache.valor;
  try {
    const cols = new Set((await consultar(`SELECT UPPER(COLUMN_NAME) AS C FROM INFORMATION_SCHEMA.COLUMNS WHERE UPPER(TABLE_NAME) = 'E000IPC'`)).map((l) => l.C));
    const valor = { descricao: COLUNAS_DESCRICAO.find((c) => cols.has(c)) ?? null, ncm: COLUNAS_NCM.find((c) => cols.has(c)) ?? null, todas: [...cols].sort() };
    colunasItemCache = { em: Date.now(), valor };
    return valor;
  } catch {
    return { descricao: null, ncm: null, todas: [] };
  }
}

const soTexto = (v) => String(v).toUpperCase().replace(/'/g, '');

/** Condição SQL sobre um item de E000IPC (alias `ip`) para uma regra de descrição/NCM. */
function condicaoItem(cols, regra) {
  const conds = [
    ...(cols.descricao ? regra.descricoes.map((d) => `UPPER(ip.${cols.descricao}) LIKE '${soTexto(d)}'`) : []),
    ...(cols.ncm ? regra.ncms.map((n) => `CAST(ip.${cols.ncm} AS varchar(20)) LIKE '${soTexto(n).replace(/\D/g, '')}%'`) : []),
  ];
  return conds.join(' OR ') || '1 = 0';
}

/**
 * Colunas SQL com as marcas de tipo de um documento.
 * chaveExpr: expressão com a chave de acesso (ex.: x.CHVNEL); fornecedorExpr: nome do fornecedor (ex.: fo.NOMFOR).
 * Devolve BIOMASSA e COMBUSTIVEL (0/1), mais PRODUTO (1º item) quando houver coluna de descrição.
 */
export function sqlMarcasItem(cols, chaveExpr, fornecedorExpr) {
  const porFornecedor = fornecedorExpr ? REGRA_COMBUSTIVEL.fornecedor.map((f) => `UPPER(${fornecedorExpr}) LIKE '${f}'`).join(' OR ') : '1 = 0';
  if (!cols.descricao && !cols.ncm) {
    return `, CAST(NULL AS varchar(1)) AS PRODUTO, 0 AS BIOMASSA, CASE WHEN ${porFornecedor} THEN 1 ELSE 0 END AS COMBUSTIVEL`;
  }
  const produto = cols.descricao ? `(SELECT TOP 1 ip0.${cols.descricao} FROM E000IPC ip0 WHERE ip0.CHVNEL = ${chaveExpr})` : 'CAST(NULL AS varchar(1))';
  return `, ${produto} AS PRODUTO`
    + `, CASE WHEN EXISTS (SELECT 1 FROM E000IPC ip WHERE ip.CHVNEL = ${chaveExpr} AND (${condicaoItem(cols, regraBiomassa())})) THEN 1 ELSE 0 END AS BIOMASSA`
    + `, CASE WHEN (${porFornecedor}) OR EXISTS (SELECT 1 FROM E000IPC ip WHERE ip.CHVNEL = ${chaveExpr} AND (${condicaoItem(cols, REGRA_COMBUSTIVEL)})) THEN 1 ELSE 0 END AS COMBUSTIVEL`;
}

/** Modelo do documento pelos dígitos 21-22 da chave de acesso. */
export const modeloDaChave = (chave) => Number(String(chave ?? '').replace(/\D/g, '').slice(20, 22)) || null;

/** Tipo de nota a partir das marcas. Ordem: bagaço/madeira, frete, energia/telecom, combustível, serviço, produto. */
export function categoriaDe({ chave, especie, biomassa, combustivel, temProduto, temServico }) {
  const modelo = modeloDaChave(chave);
  const esp = String(especie ?? '').trim().toUpperCase();
  if (biomassa) return 'biomassa';
  if (modelo === 57 || modelo === 67 || esp.startsWith('CT')) return 'frete';
  if (modelo === 66 || modelo === 62 || modelo === 6 || modelo === 21 || modelo === 22) return 'energia_telecom';
  if (combustivel) return 'combustivel';
  if (temServico && !temProduto) return 'servico';
  if (temProduto) return 'produto';
  if (temServico) return 'servico';
  return 'sem_itens';
}
