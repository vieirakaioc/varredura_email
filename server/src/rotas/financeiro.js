// Painel financeiro (contas a pagar) a partir das duplicatas das NFs recebidas.
// Cruza vencimento com a situação fiscal: o objetivo é nunca pagar uma NF sem validação.
import { Router } from 'express';
import { all, get, insert, run } from '../db/index.js';
import { permitir } from '../auth.js';
import { auditar } from '../util/log.js';
import { diasAPartirDeHoje, hojeLocal } from '../util/data.js';
import { limparId } from '../fiscal/validadores.js';
import { SQL_PAGAMENTO_SENIOR } from './documentos.js';

export const rotasFinanceiro = Router();

const ABERTA = "dp.status_pagamento IN ('aberta','programada')";
// Títulos de NFs rejeitadas, não fiscais, duplicadas ou canceladas não devem ser pagos: ficam fora dos totais "a pagar".
const DOC_VALIDO = "d.status NOT IN ('REJEITADA','NAO_FISCAL','DUPLICADA') AND COALESCE(d.situacao_sefaz,'') <> 'cancelada'";

const COM_DIVERGENCIA = "EXISTS (SELECT 1 FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.categoria = 'financeiro' AND x.severidade IN ('erro','alerta'))";

function filtroEmpresa(q) {
  return q.empresa_id ? { sql: 'AND d.empresa_id = :emp', p: { emp: Number(q.empresa_id) } } : { sql: '', p: {} };
}

rotasFinanceiro.get('/financeiro', permitir('financeiro'), (req, res) => {
  const { sql: fe, p } = filtroEmpresa(req.query);
  const hoje = hojeLocal();
  const d7 = diasAPartirDeHoje(7), d30 = diasAPartirDeHoje(30);
  const P = { ...p, hoje, d7, d30, mes: hoje.slice(0, 7) };
  const base = `FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id WHERE ${DOC_VALIDO} ${fe}`;
  const k = get(`SELECT
      SUM(${ABERTA} AND dp.vencimento < :hoje) AS vencidas_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento < :hoje THEN dp.valor END),0) AS vencidas_valor,
      SUM(${ABERTA} AND dp.vencimento = :hoje) AS hoje_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento = :hoje THEN dp.valor END),0) AS hoje_valor,
      SUM(${ABERTA} AND dp.vencimento > :hoje AND dp.vencimento <= :d7) AS prox7_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento > :hoje AND dp.vencimento <= :d7 THEN dp.valor END),0) AS prox7_valor,
      SUM(${ABERTA} AND dp.vencimento > :d7 AND dp.vencimento <= :d30) AS prox30_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento > :d7 AND dp.vencimento <= :d30 THEN dp.valor END),0) AS prox30_valor,
      SUM(${ABERTA} AND dp.vencimento > :d30) AS apos30_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento > :d30 THEN dp.valor END),0) AS apos30_valor,
      SUM(${ABERTA}) AS aberto_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} THEN dp.valor END),0) AS aberto_valor,
      SUM(dp.status_pagamento = 'programada') AS programadas_qtd, COALESCE(SUM(CASE WHEN dp.status_pagamento = 'programada' THEN dp.valor END),0) AS programadas_valor,
      SUM(dp.status_pagamento = 'paga' AND substr(dp.data_pagamento,1,7) = :mes) AS pagas_mes_qtd, COALESCE(SUM(CASE WHEN dp.status_pagamento = 'paga' AND substr(dp.data_pagamento,1,7) = :mes THEN dp.valor END),0) AS pagas_mes_valor,
      SUM(${ABERTA} AND dp.vencimento <= :d7 AND d.status <> 'APROVADA') AS risco_qtd, COALESCE(SUM(CASE WHEN ${ABERTA} AND dp.vencimento <= :d7 AND d.status <> 'APROVADA' THEN dp.valor END),0) AS risco_valor
    ${base}`, P);
  // Títulos bloqueados: NF rejeitada/duplicada/cancelada com parcela ainda em aberto (não pagar)
  const bloqueados = get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(dp.valor),0) AS valor FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id
    WHERE ${ABERTA} AND NOT (${DOC_VALIDO}) ${fe}`, p);
  const semCobranca = get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(d.v_total),0) AS valor FROM documentos d WHERE ${DOC_VALIDO} ${fe}
    AND d.tipo IN ('NFE','NFCE') AND d.origem_dados = 'xml' AND NOT EXISTS (SELECT 1 FROM documento_duplicatas dp WHERE dp.documento_id = d.id)
    AND d.recebido_em >= date(:hoje, '-60 day')`, { ...p, hoje });

  // Validador financeiro: boleto × nota × título no Senior
  const divergencias = get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(COALESCE(d.v_liquido, d.v_total)),0) AS valor FROM documentos d
    WHERE ${DOC_VALIDO} ${fe} AND ${COM_DIVERGENCIA}`, p);

  const aging = all(`SELECT CASE
        WHEN julianday(:hoje) - julianday(dp.vencimento) <= 15 THEN '1–15 dias'
        WHEN julianday(:hoje) - julianday(dp.vencimento) <= 30 THEN '16–30 dias'
        WHEN julianday(:hoje) - julianday(dp.vencimento) <= 60 THEN '31–60 dias'
        ELSE 'Mais de 60 dias' END AS faixa,
      COUNT(*) AS qtd, SUM(dp.valor) AS valor, MIN(julianday(:hoje) - julianday(dp.vencimento)) AS ordem
    ${base} AND ${ABERTA} AND dp.vencimento < :hoje GROUP BY faixa ORDER BY ordem`, P);

  // Fluxo de pagamentos: próximos 30 dias, separado por situação fiscal da NF
  const fluxo = all(`SELECT dp.vencimento AS dia,
      COALESCE(SUM(CASE WHEN d.status = 'APROVADA' THEN dp.valor END),0) AS aprovadas,
      COALESCE(SUM(CASE WHEN d.status <> 'APROVADA' THEN dp.valor END),0) AS pendentes_fiscal
    ${base} AND ${ABERTA} AND dp.vencimento >= :hoje AND dp.vencimento <= :d30 GROUP BY dp.vencimento ORDER BY dp.vencimento`, P);

  const fornecedores = all(`SELECT d.fornecedor_id AS id, COALESCE(f.nome_fantasia, f.razao_social, d.emitente_nome) AS fornecedor, COUNT(*) AS qtd,
      SUM(dp.valor) AS valor, COALESCE(SUM(CASE WHEN dp.vencimento < :hoje THEN dp.valor END),0) AS vencido
    ${base.replace('JOIN documentos d ON d.id = dp.documento_id', 'JOIN documentos d ON d.id = dp.documento_id LEFT JOIN fornecedores f ON f.id = d.fornecedor_id')}
    AND ${ABERTA} GROUP BY d.fornecedor_id ORDER BY valor DESC LIMIT 10`, P);

  const porEmpresa = all(`SELECT COALESCE(e.nome_fantasia, e.razao_social, 'Não identificada') AS empresa, SUM(dp.valor) AS valor,
      COALESCE(SUM(CASE WHEN dp.vencimento < :hoje THEN dp.valor END),0) AS vencido
    ${base.replace('JOIN documentos d ON d.id = dp.documento_id', 'JOIN documentos d ON d.id = dp.documento_id LEFT JOIN empresas e ON e.id = d.empresa_id')}
    AND ${ABERTA} GROUP BY d.empresa_id ORDER BY valor DESC`, P);

  res.json({ hoje, indicadores: { ...k, bloqueados_qtd: bloqueados.qtd, bloqueados_valor: bloqueados.valor, sem_cobranca_qtd: semCobranca.qtd, sem_cobranca_valor: semCobranca.valor, divergencias_qtd: divergencias.qtd, divergencias_valor: divergencias.valor }, aging, fluxo, fornecedores, porEmpresa });
});

rotasFinanceiro.get('/financeiro/titulos', permitir('financeiro'), (req, res) => {
  const q = req.query;
  const hoje = hojeLocal();
  const w = [];
  const p = { hoje, d7: diasAPartirDeHoje(7), d30: diasAPartirDeHoje(30) };
  switch (q.situacao) {
    case 'vencidas': w.push(`${ABERTA} AND dp.vencimento < :hoje`, DOC_VALIDO); break;
    case 'hoje': w.push(`${ABERTA} AND dp.vencimento = :hoje`, DOC_VALIDO); break;
    case '7d': w.push(`${ABERTA} AND dp.vencimento > :hoje AND dp.vencimento <= :d7`, DOC_VALIDO); break;
    case '30d': w.push(`${ABERTA} AND dp.vencimento > :d7 AND dp.vencimento <= :d30`, DOC_VALIDO); break;
    case 'risco': w.push(`${ABERTA} AND dp.vencimento <= :d7 AND d.status <> 'APROVADA'`, DOC_VALIDO); break;
    case 'programadas': w.push("dp.status_pagamento = 'programada'"); break;
    case 'pagas': w.push("dp.status_pagamento = 'paga'"); break;
    case 'bloqueados': w.push(ABERTA, `NOT (${DOC_VALIDO})`); break;
    case 'divergencias': w.push(COM_DIVERGENCIA, DOC_VALIDO); break;
    case 'todas': break;
    default: w.push(ABERTA, DOC_VALIDO);
  }
  if (q.empresa_id) { w.push('d.empresa_id = :emp'); p.emp = Number(q.empresa_id); }
  if (q.fornecedor_id) { w.push('d.fornecedor_id = :forn'); p.forn = Number(q.fornecedor_id); }
  if (q.fornecedor) { w.push('(d.emitente_nome LIKE :fn OR d.emitente_cnpj LIKE :fc)'); p.fn = `%${q.fornecedor}%`; p.fc = `%${limparId(q.fornecedor) || '#'}%`; }
  if (q.status_fiscal === 'aprovada') w.push("d.status = 'APROVADA'");
  if (q.status_fiscal === 'pendente') w.push("d.status <> 'APROVADA'");
  if (q.de) { w.push('dp.vencimento >= :de'); p.de = q.de; }
  if (q.ate) { w.push('dp.vencimento <= :ate'); p.ate = q.ate; }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const ordem = q.situacao === 'pagas' ? 'dp.data_pagamento DESC' : 'dp.vencimento ASC, dp.valor DESC';
  const itens = all(`SELECT dp.*, dp.numero AS numero_dup, d.numero, d.serie, d.tipo, d.emitente_nome, d.emitente_cnpj, d.status AS status_fiscal, d.situacao_sefaz, d.v_total, d.empresa_id,
      d.senior_status, d.senior_ref, ${SQL_PAGAMENTO_SENIOR}, d.oc_documento, d.senior_ocs, d.pdf_anexo_id, d.xml_anexo_id,
      (SELECT a.id FROM anexos a WHERE a.documento_id = d.id AND a.tipo_detectado = 'boleto_pdf' ORDER BY a.id LIMIT 1) AS boleto_anexo_id,
      COALESCE(e.nome_fantasia, e.razao_social) AS empresa, u.nome AS atualizado_por_nome,
      CAST(julianday(dp.vencimento) - julianday(:hoje) AS INTEGER) AS dias,
      (SELECT COUNT(*) FROM documento_duplicatas x WHERE x.documento_id = d.id) AS parcelas,
      (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'erro') AS qtd_erros,
      (SELECT group_concat(x.problema, ' · ') FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.categoria = 'financeiro' AND x.severidade IN ('erro','alerta')) AS divergencia
    FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id LEFT JOIN empresas e ON e.id = d.empresa_id LEFT JOIN usuarios u ON u.id = dp.atualizado_por
    ${where} ORDER BY ${ordem} LIMIT 1000`, p);
  res.json({ itens, total_valor: itens.reduce((a, t) => a + (t.valor ?? 0), 0) });
});

rotasFinanceiro.post('/duplicatas/:id/pagamento', permitir('pagamentos'), (req, res) => {
  const dp = get('SELECT dp.*, d.status AS status_fiscal, d.situacao_sefaz FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id WHERE dp.id = ?', [Number(req.params.id)]);
  if (!dp) return res.status(404).json({ erro: 'Duplicata não encontrada' });
  const { status_pagamento, data_pagamento, observacao } = req.body || {};
  if (!['aberta', 'programada', 'paga', 'cancelada'].includes(status_pagamento)) return res.status(400).json({ erro: 'Situação inválida' });
  if (status_pagamento === 'paga' && !/^\d{4}-\d{2}-\d{2}$/.test(data_pagamento || '')) return res.status(400).json({ erro: 'Informe a data do pagamento' });
  // Pagar título de NF sem aprovação fiscal exige justificativa (fica no histórico do documento).
  if (['paga', 'programada'].includes(status_pagamento) && dp.status_fiscal !== 'APROVADA' && !(observacao && observacao.trim().length >= 10)) {
    return res.status(400).json({ erro: `A NF ainda não foi aprovada pelo fiscal (${dp.status_fiscal}). Justifique o pagamento (mín. 10 caracteres).` });
  }
  run('UPDATE documento_duplicatas SET status_pagamento = ?, data_pagamento = ?, observacao = ?, atualizado_por = ? WHERE id = ?',
    [status_pagamento, status_pagamento === 'paga' ? data_pagamento : null, observacao || null, req.usuario.id, dp.id]);
  insert('decisoes', {
    documento_id: dp.documento_id, usuario_id: req.usuario.id, acao: 'FINANCEIRO', justificativa: observacao || null,
    dados: JSON.stringify({ duplicata: dp.numero, vencimento: dp.vencimento, valor: dp.valor, de: dp.status_pagamento, para: status_pagamento, data_pagamento }),
  });
  auditar(req.usuario.id, 'duplicata.pagamento', 'documento', dp.documento_id, { duplicata: dp.numero, de: dp.status_pagamento, para: status_pagamento, data_pagamento, observacao }, req.ip);
  res.json({ ok: true });
});
