import { Router } from 'express';
import ExcelJS from 'exceljs';
import { all, getConfig } from '../db/index.js';
import { SQL_PAGAMENTO_SENIOR } from './documentos.js';
import { permitir } from '../auth.js';
import { auditar } from '../util/log.js';
import { filtroDocumentos } from './filtros.js';

export const rotasRelatorios = Router();

const C = (campo, titulo, tipo = 'texto') => ({ campo, titulo, tipo });
const COLS_DOC = [
  C('id', 'ID', 'numero'), C('tipo', 'Tipo'), C('numero', 'Número'), C('serie', 'Série'), C('chave_acesso', 'Chave de acesso'),
  C('data_emissao', 'Emissão', 'data'), C('recebido_em', 'Recebimento', 'data'), C('emitente_cnpj', 'CNPJ emitente'),
  C('emitente_nome', 'Fornecedor'), C('empresa', 'Empresa'), C('v_total', 'Valor total', 'moeda'), C('v_liquido', 'Valor líquido', 'moeda'), C('status', 'Status'),
  C('senior_status', 'Senior'), C('senior_data_entrada', 'Entrada no Senior', 'data'), C('senior_pagamento', 'Pagamento (Senior)'),
  C('senior_vencimento', 'Vencimento (Senior)', 'data'), C('senior_data_pagamento', 'Pago em', 'data'),
];
const docsBase = (q, extraWhere = '', extraCols = '') => {
  const { where, params } = filtroDocumentos({ ...q, campo_data: q.campo_data ?? 'recebimento' });
  const w = [where.replace(/^WHERE /, ''), extraWhere].filter(Boolean).join(' AND ');
  return all(`SELECT d.id, d.tipo, d.numero, d.serie, d.chave_acesso, substr(d.data_emissao,1,10) AS data_emissao, d.recebido_em,
    d.emitente_cnpj, d.emitente_nome, COALESCE(e.nome_fantasia, e.razao_social) AS empresa, d.v_total, d.v_liquido, d.status,
    d.senior_status, d.senior_data_entrada, ${SQL_PAGAMENTO_SENIOR} ${extraCols}
    FROM documentos d LEFT JOIN empresas e ON e.id = d.empresa_id ${w ? `WHERE ${w}` : ''} ORDER BY d.recebido_em DESC LIMIT 50000`, params);
};
// Nos relatórios o período se refere, por padrão, à data de recebimento.
const filtroSimples = (q) => filtroDocumentos({ ...q, campo_data: q.campo_data ?? 'recebimento' });

export const RELATORIOS = {
  recebidas_periodo: {
    titulo: 'NFs recebidas por período', descricao: 'Todos os documentos recebidos no período, com status atual.',
    colunas: COLS_DOC, gerar: (q) => docsBase(q),
  },
  por_fornecedor: {
    titulo: 'NFs por fornecedor', descricao: 'Quantidade, valor e situação dos documentos por fornecedor.',
    colunas: [C('emitente_cnpj', 'CNPJ'), C('fornecedor', 'Fornecedor'), C('uf', 'UF'), C('qtd', 'Qtd NFs', 'numero'), C('valor', 'Valor total', 'moeda'), C('aprovadas', 'Aprovadas', 'numero'), C('inconsistentes', 'Com inconsistência', 'numero'), C('rejeitadas', 'Rejeitadas', 'numero')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT d.emitente_cnpj, MAX(d.emitente_nome) AS fornecedor, MAX(d.emitente_uf) AS uf, COUNT(*) AS qtd, SUM(d.v_total) AS valor,
        SUM(d.status = 'APROVADA') AS aprovadas, SUM(d.status = 'INCONSISTENTE') AS inconsistentes, SUM(d.status = 'REJEITADA') AS rejeitadas
        FROM documentos d ${where} GROUP BY d.emitente_cnpj ORDER BY qtd DESC`, params);
    },
  },
  por_empresa: {
    titulo: 'NFs por empresa', descricao: 'Documentos por empresa destinatária.',
    colunas: [C('empresa', 'Empresa'), C('cnpj', 'CNPJ'), C('qtd', 'Qtd NFs', 'numero'), C('valor', 'Valor total', 'moeda'), C('aprovadas', 'Aprovadas', 'numero'), C('pendentes', 'Aguardando ação', 'numero')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT COALESCE(e.nome_fantasia, e.razao_social, 'Não identificada') AS empresa, COALESCE(e.cnpj, d.destinatario_cnpj) AS cnpj,
        COUNT(*) AS qtd, SUM(d.v_total) AS valor, SUM(d.status = 'APROVADA') AS aprovadas,
        SUM(d.status IN ('PENDENTE','INCONSISTENTE','DUPLICADA','AGUARDANDO_XML','CORRECAO_SOLICITADA')) AS pendentes
        FROM documentos d LEFT JOIN empresas e ON e.id = d.empresa_id ${where} GROUP BY COALESCE(d.empresa_id, d.destinatario_cnpj) ORDER BY qtd DESC`, params);
    },
  },
  por_cfop: {
    titulo: 'NFs por CFOP', descricao: 'Itens agrupados por CFOP do emitente e CFOP de entrada confirmado.',
    colunas: [C('cfop', 'CFOP emitente'), C('cfop_entrada', 'CFOP entrada (confirmado)'), C('documentos', 'Qtd NFs', 'numero'), C('itens', 'Qtd itens', 'numero'), C('valor', 'Valor dos itens', 'moeda'), C('icms', 'ICMS', 'moeda')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT i.cfop, i.cfop_entrada, COUNT(DISTINCT d.id) AS documentos, COUNT(*) AS itens, SUM(i.valor_total) AS valor,
        SUM((SELECT t.valor FROM item_impostos t WHERE t.item_id = i.id AND t.tributo = 'ICMS')) AS icms
        FROM documento_itens i JOIN documentos d ON d.id = i.documento_id ${where} GROUP BY i.cfop, i.cfop_entrada ORDER BY documentos DESC`, params);
    },
  },
  inconsistencias: {
    titulo: 'NFs com inconsistências', descricao: 'Ocorrências abertas (erros e alertas) com o detalhamento completo.',
    colunas: [C('documento_id', 'ID NF', 'numero'), C('numero', 'Número'), C('emitente_nome', 'Fornecedor'), C('empresa', 'Empresa'), C('v_total', 'Valor', 'moeda'), C('severidade', 'Severidade'), C('n_item', 'Item', 'numero'), C('problema', 'Problema'), C('regra_violada', 'Regra violada'), C('valor_encontrado', 'Valor encontrado'), C('valor_esperado', 'Valor esperado'), C('acao_sugerida', 'Ação sugerida'), C('status_nf', 'Status NF')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT x.documento_id, d.numero, d.emitente_nome, COALESCE(e.nome_fantasia, e.razao_social) AS empresa, d.v_total, x.severidade, x.n_item,
        x.problema, x.regra_violada, x.valor_encontrado, x.valor_esperado, x.acao_sugerida, d.status AS status_nf
        FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id LEFT JOIN empresas e ON e.id = d.empresa_id
        ${where ? `${where} AND` : 'WHERE'} x.status = 'aberta' AND x.severidade IN ('erro','alerta')
        ORDER BY x.documento_id DESC, CASE x.severidade WHEN 'erro' THEN 1 ELSE 2 END`, params);
    },
  },
  aprovadas_reprovadas: {
    titulo: 'NFs aprovadas / reprovadas', descricao: 'Decisões do usuário com responsável, data e justificativa.',
    colunas: [...COLS_DOC.slice(0, 11), C('decisao', 'Decisão'), C('usuario', 'Usuário'), C('data_decisao', 'Data da decisão', 'data'), C('justificativa', 'Justificativa')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT d.id, d.tipo, d.numero, d.serie, d.chave_acesso, substr(d.data_emissao,1,10) AS data_emissao, d.recebido_em, d.emitente_cnpj, d.emitente_nome,
        COALESCE(e.nome_fantasia, e.razao_social) AS empresa, d.v_total, dc.acao AS decisao, u.nome AS usuario, dc.created_at AS data_decisao, dc.justificativa
        FROM decisoes dc JOIN documentos d ON d.id = dc.documento_id LEFT JOIN empresas e ON e.id = d.empresa_id LEFT JOIN usuarios u ON u.id = dc.usuario_id
        ${where ? `${where} AND` : 'WHERE'} dc.acao IN ('APROVAR','REPROVAR','SOLICITAR_CORRECAO','NAO_FISCAL') ORDER BY dc.created_at DESC`, params);
    },
  },
  tempo_validacao: {
    titulo: 'Tempo médio de validação', descricao: 'Horas entre o recebimento e a decisão do usuário, por mês e usuário.',
    colunas: [C('mes', 'Mês'), C('usuario', 'Usuário'), C('decisoes', 'Decisões', 'numero'), C('horas_media', 'Tempo médio (h)', 'decimal'), C('horas_max', 'Tempo máximo (h)', 'decimal')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT substr(dc.created_at,1,7) AS mes, u.nome AS usuario, COUNT(*) AS decisoes,
        ROUND(AVG((julianday(dc.created_at) - julianday(d.recebido_em)) * 24), 1) AS horas_media,
        ROUND(MAX((julianday(dc.created_at) - julianday(d.recebido_em)) * 24), 1) AS horas_max
        FROM decisoes dc JOIN documentos d ON d.id = dc.documento_id LEFT JOIN usuarios u ON u.id = dc.usuario_id
        ${where ? `${where} AND` : 'WHERE'} dc.acao IN ('APROVAR','REPROVAR','SOLICITAR_CORRECAO','NAO_FISCAL')
        GROUP BY mes, dc.usuario_id ORDER BY mes DESC, decisoes DESC`, params);
    },
  },
  erros_por_fornecedor: {
    titulo: 'Quantidade de erros por fornecedor', descricao: 'Fornecedores com mais ocorrências fiscais (erros e alertas).',
    colunas: [C('cnpj', 'CNPJ'), C('fornecedor', 'Fornecedor'), C('nfs', 'NFs recebidas', 'numero'), C('nfs_com_erro', 'NFs com erro', 'numero'), C('ocorrencias', 'Ocorrências', 'numero'), C('pct', '% NFs com erro', 'decimal'), C('principal', 'Principal ocorrência')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT f.cnpj, COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor, COUNT(DISTINCT d.id) AS nfs,
        COUNT(DISTINCT CASE WHEN x.severidade = 'erro' THEN x.documento_id END) AS nfs_com_erro, COUNT(x.id) AS ocorrencias,
        ROUND(100.0 * COUNT(DISTINCT CASE WHEN x.severidade = 'erro' THEN x.documento_id END) / COUNT(DISTINCT d.id), 1) AS pct,
        (SELECT x2.regra_violada FROM inconsistencias x2 JOIN documentos d2 ON d2.id = x2.documento_id WHERE d2.fornecedor_id = f.id AND x2.status <> 'resolvida' AND x2.severidade IN ('erro','alerta') GROUP BY x2.regra_codigo ORDER BY COUNT(*) DESC LIMIT 1) AS principal
        FROM documentos d JOIN fornecedores f ON f.id = d.fornecedor_id
        LEFT JOIN inconsistencias x ON x.documento_id = d.id AND x.status IN ('aberta','ignorada') AND x.severidade IN ('erro','alerta')
        ${where} GROUP BY f.id HAVING ocorrencias > 0 ORDER BY nfs_com_erro DESC, ocorrencias DESC`, params);
    },
  },
  principais_inconsistencias: {
    titulo: 'Principais inconsistências fiscais', descricao: 'Ranking das regras mais violadas no período.',
    colunas: [C('regra_codigo', 'Regra'), C('nome', 'Descrição'), C('categoria', 'Categoria'), C('severidade', 'Severidade'), C('documentos', 'NFs afetadas', 'numero'), C('ocorrencias', 'Ocorrências', 'numero'), C('ignoradas', 'Ignoradas pelo usuário', 'numero')],
    gerar(q) {
      const { where, params } = filtroSimples(q);
      return all(`SELECT x.regra_codigo, r.nome, x.categoria, x.severidade, COUNT(DISTINCT x.documento_id) AS documentos, COUNT(*) AS ocorrencias,
        SUM(x.status = 'ignorada') AS ignoradas
        FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id LEFT JOIN regras_fiscais r ON r.codigo = x.regra_codigo
        ${where ? `${where} AND` : 'WHERE'} x.status IN ('aberta','ignorada') GROUP BY x.regra_codigo, x.severidade ORDER BY documentos DESC`, params);
    },
  },
  sem_xml: {
    titulo: 'NFs sem XML', descricao: 'Documentos recebidos apenas em PDF, aguardando o XML.',
    colunas: [...COLS_DOC, C('origem_dados', 'Origem dos dados'), C('confianca', 'Confiança da leitura', 'decimal'), C('remetente', 'Remetente do e-mail')],
    gerar: (q) => docsBase(q, "d.origem_dados <> 'xml'", ', d.origem_dados, d.confianca_extracao AS confianca, (SELECT remetente FROM emails em WHERE em.id = d.email_id) AS remetente'),
  },
  duplicadas: {
    titulo: 'NFs duplicadas', descricao: 'Documentos marcados como duplicados e recebimentos repetidos do mesmo documento.',
    colunas: [...COLS_DOC, C('qtd_recebimentos', 'Vezes recebida', 'numero'), C('duplicado_de_id', 'Duplicada de (ID)', 'numero')],
    gerar: (q) => docsBase(q, "(d.status = 'DUPLICADA' OR d.qtd_recebimentos > 1)", ', d.qtd_recebimentos, d.duplicado_de_id'),
  },
  contas_a_pagar: {
    titulo: 'Contas a pagar (duplicatas)', descricao: 'Parcelas das NFs recebidas com vencimento, situação de pagamento e situação fiscal. O período filtra o vencimento.',
    colunas: [C('vencimento', 'Vencimento', 'data'), C('dias', 'Dias p/ vencer', 'numero'), C('numero_dup', 'Duplicata'), C('numero', 'NF'), C('emitente_cnpj', 'CNPJ fornecedor'), C('emitente_nome', 'Fornecedor'), C('empresa', 'Empresa'), C('valor', 'Valor', 'moeda'), C('status_pagamento', 'Pagamento'), C('data_pagamento', 'Pago em', 'data'), C('status_fiscal', 'Situação fiscal')],
    gerar(q) {
      const w = [], p = {};
      if (q.de) { w.push('dp.vencimento >= :de'); p.de = q.de; }
      if (q.ate) { w.push('dp.vencimento <= :ate'); p.ate = q.ate; }
      if (q.empresa_id) { w.push('d.empresa_id = :emp'); p.emp = Number(q.empresa_id); }
      return all(`SELECT dp.vencimento, CAST(julianday(dp.vencimento) - julianday(date('now','localtime')) AS INTEGER) AS dias, dp.numero AS numero_dup,
        d.numero, d.emitente_cnpj, d.emitente_nome, COALESCE(e.nome_fantasia, e.razao_social) AS empresa, dp.valor, dp.status_pagamento, dp.data_pagamento, d.status AS status_fiscal
        FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id LEFT JOIN empresas e ON e.id = d.empresa_id
        ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY dp.vencimento`, p);
    },
  },
  escrituracao: {
    titulo: 'Escrituração de entradas (aprovadas)', descricao: 'Itens de NFs aprovadas com CFOP de entrada e tributos, base para lançamento no ERP.',
    colunas: [C('documento_id', 'ID NF', 'numero'), C('numero', 'Número'), C('serie', 'Série'), C('chave_acesso', 'Chave'), C('data_emissao', 'Emissão', 'data'), C('emitente_cnpj', 'CNPJ emitente'), C('emitente_nome', 'Fornecedor'), C('n_item', 'Item', 'numero'), C('codigo', 'Código'), C('descricao', 'Descrição'), C('ncm', 'NCM'), C('cfop', 'CFOP emitente'), C('cfop_entrada', 'CFOP entrada'), C('valor_total', 'Valor item', 'moeda'), C('bc_icms', 'BC ICMS', 'moeda'), C('aliq_icms', 'Alíq. ICMS', 'decimal'), C('icms', 'ICMS', 'moeda'), C('icms_st', 'ICMS-ST', 'moeda'), C('ipi', 'IPI', 'moeda'), C('pis', 'PIS', 'moeda'), C('cofins', 'COFINS', 'moeda')],
    gerar(q) {
      const { where, params } = filtroSimples({ ...q, status: 'APROVADA' });
      const t = (trib, campo = 'valor') => `(SELECT ${campo} FROM item_impostos t WHERE t.item_id = i.id AND t.tributo = '${trib}')`;
      return all(`SELECT d.id AS documento_id, d.numero, d.serie, d.chave_acesso, substr(d.data_emissao,1,10) AS data_emissao, d.emitente_cnpj, d.emitente_nome,
        i.n_item, i.codigo, i.descricao, i.ncm, i.cfop, COALESCE(i.cfop_entrada, '(não confirmado)') AS cfop_entrada, i.valor_total,
        ${t('ICMS', 'base')} AS bc_icms, ${t('ICMS', 'aliquota')} AS aliq_icms, ${t('ICMS')} AS icms, ${t('ICMSST')} AS icms_st, ${t('IPI')} AS ipi, ${t('PIS')} AS pis, ${t('COFINS')} AS cofins
        FROM documento_itens i JOIN documentos d ON d.id = i.documento_id ${where} ORDER BY d.id, i.n_item`, params);
    },
  },
};

rotasRelatorios.get('/relatorios', permitir('relatorios'), (req, res) => {
  // Relatórios de escrituração de mercadorias (CFOP, XML) só aparecem quando NF-e/CT-e estão no escopo
  const escopo = getConfig('tipos_documento_aceitos', null);
  const soServicos = Array.isArray(escopo) && !escopo.some((t) => ['NFE', 'NFCE', 'CTE'].includes(t));
  const ocultos = soServicos ? ['por_cfop', 'sem_xml', 'escrituracao'] : [];
  res.json(Object.entries(RELATORIOS).filter(([id]) => !ocultos.includes(id)).map(([id, r]) => ({ id, titulo: r.titulo, descricao: r.descricao })));
});

rotasRelatorios.get('/relatorios/:id', permitir('relatorios'), async (req, res) => {
  const rel = RELATORIOS[req.params.id];
  if (!rel) return res.status(404).json({ erro: 'Relatório não encontrado' });
  const linhas = rel.gerar(req.query);
  const formato = req.query.formato;
  if (!formato) return res.json({ titulo: rel.titulo, colunas: rel.colunas, linhas: linhas.slice(0, 2000), total: linhas.length });

  auditar(req.usuario.id, 'relatorio.exportar', 'relatorio', req.params.id, { formato, filtros: req.query, linhas: linhas.length }, req.ip);
  const nomeArq = `${req.params.id}_${new Date().toISOString().slice(0, 10)}`;
  if (formato === 'csv') {
    const esc = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const fmt = (v, tipo) => (v != null && ['moeda', 'decimal'].includes(tipo) ? String(v).replace('.', ',') : v);
    const csv = [rel.colunas.map((c) => esc(c.titulo)).join(';'), ...linhas.map((l) => rel.colunas.map((c) => esc(fmt(l[c.campo], c.tipo))).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}.csv"`);
    return res.send('﻿' + csv); // BOM: acentuação correta no Excel
  }
  if (formato === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Validador Fiscal';
    const ws = wb.addWorksheet(rel.titulo.slice(0, 31));
    ws.columns = rel.colunas.map((c) => ({
      header: c.titulo, key: c.campo, width: Math.min(60, Math.max(12, c.titulo.length + 4, c.campo === 'chave_acesso' ? 48 : 0, ['problema', 'descricao', 'acao_sugerida', 'justificativa'].includes(c.campo) ? 50 : 0)),
      style: c.tipo === 'moeda' ? { numFmt: '"R$" #,##0.00' } : c.tipo === 'decimal' ? { numFmt: '#,##0.00' } : {},
    }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rel.colunas.length } };
    for (const l of linhas) ws.addRow(Object.fromEntries(rel.colunas.map((c) => [c.campo, c.tipo === 'data' && l[c.campo] ? String(l[c.campo]).slice(0, 10) : l[c.campo]])));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  res.status(400).json({ erro: 'Formato inválido (csv ou xlsx)' });
});

/**
 * Exporta para Excel o que está na tela (tabela já filtrada no navegador).
 * Corpo: { titulo, colunas: [{ titulo, tipo? }], linhas: [[valor, ...]] } — tipo: texto | moeda | numero | data
 */
rotasRelatorios.post('/exportar', permitir('ver'), async (req, res) => {
  const { titulo = 'Exportação', colunas = [], linhas = [] } = req.body ?? {};
  if (!Array.isArray(colunas) || !colunas.length || !Array.isArray(linhas)) return res.status(400).json({ erro: 'Nada para exportar' });
  if (linhas.length > 50000) return res.status(400).json({ erro: 'Limite de 50.000 linhas por exportação' });
  auditar(req.usuario.id, 'tabela.exportar', 'tabela', String(titulo).slice(0, 60), { linhas: linhas.length }, req.ip);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Validador Fiscal';
  const ws = wb.addWorksheet(String(titulo).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  ws.columns = colunas.map((c, i) => {
    const maior = Math.max(String(c.titulo ?? '').length, ...linhas.slice(0, 300).map((l) => String(l[i] ?? '').length));
    return {
      header: c.titulo, key: `c${i}`, width: Math.min(60, Math.max(10, maior + 2)),
      style: c.tipo === 'moeda' ? { numFmt: '"R$" #,##0.00' } : c.tipo === 'data' ? { numFmt: 'dd/mm/yyyy' } : {},
    };
  });
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colunas.length } };
  const converter = (v, tipo) => {
    if (v == null || v === '') return null;
    if (tipo === 'data') { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : v; }
    if (tipo === 'moeda' || tipo === 'numero') return Number.isFinite(Number(v)) ? Number(v) : v;
    return String(v);
  };
  for (const l of linhas) ws.addRow(Object.fromEntries(colunas.map((c, i) => [`c${i}`, converter(l[i], c.tipo)])));
  const nomeArq = `${String(titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').toLowerCase()}_${new Date().toLocaleDateString('sv-SE')}`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
