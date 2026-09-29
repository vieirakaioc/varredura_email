// Perfil histórico do fornecedor: base para os "pontos de conferência" de comportamento.
import { all, get } from '../db/index.js';

const STATUS_VALIDOS = "('PENDENTE','APROVADA','INCONSISTENTE','CORRECAO_SOLICITADA')";

export function perfilFornecedor(fornecedorId, excluirDocumentoId = 0) {
  if (!fornecedorId) return null;
  const docs = all(`SELECT id, v_total, data_emissao FROM documentos
    WHERE fornecedor_id = ? AND id <> ? AND origem_dados = 'xml' AND status IN ${STATUS_VALIDOS}`, [fornecedorId, excluirDocumentoId]);
  const qtd = docs.length;
  const cfops = all(`SELECT i.cfop, COUNT(DISTINCT i.documento_id) AS docs, COUNT(*) AS itens FROM documento_itens i
    JOIN documentos d ON d.id = i.documento_id
    WHERE d.fornecedor_id = ? AND d.id <> ? AND d.origem_dados = 'xml' AND d.status IN ${STATUS_VALIDOS} AND i.cfop IS NOT NULL
    GROUP BY i.cfop ORDER BY docs DESC`, [fornecedorId, excluirDocumentoId]);
  const ncms = all(`SELECT i.ncm, COUNT(*) AS itens, MAX(i.descricao) AS exemplo, ROUND(AVG(i.valor_unitario), 4) AS preco_medio FROM documento_itens i
    JOIN documentos d ON d.id = i.documento_id
    WHERE d.fornecedor_id = ? AND d.id <> ? AND d.origem_dados = 'xml' AND d.status IN ${STATUS_VALIDOS} AND i.ncm IS NOT NULL
    GROUP BY i.ncm ORDER BY itens DESC`, [fornecedorId, excluirDocumentoId]);
  const aliquotas = all(`SELECT i.ncm, t.aliquota, t.cst, COUNT(*) AS itens FROM item_impostos t
    JOIN documento_itens i ON i.id = t.item_id JOIN documentos d ON d.id = i.documento_id
    WHERE d.fornecedor_id = ? AND d.id <> ? AND d.origem_dados = 'xml' AND d.status IN ${STATUS_VALIDOS} AND t.tributo = 'ICMS'
    GROUP BY i.ncm, t.aliquota, t.cst`, [fornecedorId, excluirDocumentoId]);

  const valores = docs.map((d) => d.v_total).filter((v) => v != null);
  const media = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
  const desvio = valores.length > 1 ? Math.sqrt(valores.reduce((a, v) => a + (v - media) ** 2, 0) / (valores.length - 1)) : null;

  const aliqPorNcm = {};
  const cstIcms = {};
  for (const a of aliquotas) {
    (aliqPorNcm[a.ncm] ??= {})[a.aliquota ?? 0] = ((aliqPorNcm[a.ncm] ?? {})[a.aliquota ?? 0] ?? 0) + a.itens;
    if (a.cst) cstIcms[a.cst] = (cstIcms[a.cst] ?? 0) + a.itens;
  }
  return {
    qtd_nfs: qtd,
    cfops: cfops.map((c) => ({ ...c, pct: qtd ? Math.round((c.docs / qtd) * 1000) / 10 : 0 })),
    ncms,
    valor_medio: media,
    valor_desvio: desvio,
    valor_max: valores.length ? Math.max(...valores) : null,
    aliquota_icms_por_ncm: aliqPorNcm,
    cst_icms: cstIcms,
  };
}

export function resumoOcorrenciasFornecedor(fornecedorId) {
  return all(`SELECT i.regra_codigo, i.regra_violada, COUNT(*) AS qtd, MAX(i.created_at) AS ultima
    FROM inconsistencias i JOIN documentos d ON d.id = i.documento_id
    WHERE d.fornecedor_id = ? AND i.status <> 'resolvida'
    GROUP BY i.regra_codigo ORDER BY qtd DESC`, [fornecedorId]);
}

export function contarNfsFornecedor(fornecedorId) {
  return get('SELECT COUNT(*) AS n FROM documentos WHERE fornecedor_id = ?', [fornecedorId]).n;
}
