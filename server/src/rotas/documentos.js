import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { all, get, insert, parseJSON, run, tx } from '../db/index.js';
import { paths, config } from '../config.js';
import { permitir, pode } from '../auth.js';
import { auditar } from '../util/log.js';
import { filtroDocumentos, ordenacao } from './filtros.js';
import { carregarItens, executarMotor, recalcularStatusAposTratamento } from '../fiscal/motor.js';
import { processarArquivo, reprocessarDocumento } from '../processamento/ingestao.js';
import { perfilFornecedor } from '../fiscal/historico.js';
import { DESCRICAO_CFOP } from '../fiscal/tabelas.js';

export const rotasDocumentos = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } });

// Situação de pagamento pelos títulos do Senior (substituídos e cancelados não contam)
export const SQL_PAGAMENTO_SENIOR = `(SELECT CASE WHEN COUNT(*) = 0 THEN NULL
      WHEN SUM(t.situacao_grupo IN ('aberto','em_pagamento')) = 0 THEN 'pago'
      WHEN SUM(t.situacao_grupo = 'em_pagamento') > 0 THEN 'em_pagamento' ELSE 'aberto' END
    FROM senior_titulos t WHERE t.documento_id = d.id AND t.situacao_grupo <> 'cancelado' AND t.situacao <> 'LS') AS senior_pagamento,
  (SELECT MAX(t.data_pagamento) FROM senior_titulos t WHERE t.documento_id = d.id) AS senior_data_pagamento,
  (SELECT MIN(t.vencimento) FROM senior_titulos t WHERE t.documento_id = d.id AND t.situacao_grupo IN ('aberto','em_pagamento')) AS senior_vencimento`;

// Tudo o que pertence à nota na mesma linha: boleto (arquivo, vencimento, valor) e ordem de compra (da nota e do Senior)
export const SQL_VINCULOS = `d.oc_documento, d.senior_ocs,
  (SELECT a.id FROM anexos a WHERE a.documento_id = d.id AND a.tipo_detectado = 'boleto_pdf' ORDER BY a.id LIMIT 1) AS boleto_anexo_id,
  (SELECT COUNT(*) FROM documento_duplicatas b WHERE b.documento_id = d.id) AS qtd_boletos,
  (SELECT MIN(b.vencimento) FROM documento_duplicatas b WHERE b.documento_id = d.id AND b.status_pagamento IN ('aberta','programada')) AS boleto_vencimento,
  (SELECT SUM(b.valor) FROM documento_duplicatas b WHERE b.documento_id = d.id) AS boleto_valor`;

const COLUNAS_LISTA = `d.id, d.tipo, d.modelo, d.origem_dados, d.chave_acesso, d.numero, d.serie, d.data_emissao, d.recebido_em,
  d.emitente_cnpj, d.emitente_nome, d.emitente_uf, d.destinatario_cnpj, d.destinatario_nome, d.destinatario_uf,
  d.empresa_id, d.fornecedor_id, d.v_total, d.status, d.prioridade, d.prazo, d.responsavel_id, d.qtd_recebimentos, d.situacao_sefaz,
  d.bloqueada, d.confianca_extracao, d.v_liquido, d.senior_status, d.senior_ref, d.senior_data_entrada, d.pdf_anexo_id, d.xml_anexo_id,
  emp.nome_fantasia AS empresa_nome, u.nome AS responsavel_nome,
  (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'erro') AS qtd_erros,
  (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'alerta') AS qtd_alertas,
  (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'conferencia') AS qtd_conferencias,
  (SELECT group_concat(DISTINCT i.cfop) FROM documento_itens i WHERE i.documento_id = d.id) AS cfops,
  ${SQL_PAGAMENTO_SENIOR},
  ${SQL_VINCULOS}`;
const JOINS = 'FROM documentos d LEFT JOIN empresas emp ON emp.id = d.empresa_id LEFT JOIN usuarios u ON u.id = d.responsavel_id';

// ------------------------------------------------------------------ listagem
rotasDocumentos.get('/documentos', (req, res) => {
  const { where, params } = filtroDocumentos(req.query);
  const limite = Math.min(Number(req.query.limite) || 50, 500);
  const pagina = Math.max(Number(req.query.pagina) || 1, 1);
  const total = get(`SELECT COUNT(*) AS n ${JOINS} ${where}`, params).n;
  const itens = all(`SELECT ${COLUNAS_LISTA} ${JOINS} ${where} ${ordenacao(req.query)} LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, params);
  res.json({ itens, total, pagina, limite });
});

// Fila de trabalho: documentos que precisam de ação humana.
rotasDocumentos.get('/fila', (req, res) => {
  const q = { ...req.query };
  if (!q.status) q.status = 'INCONSISTENTE,PENDENTE,DUPLICADA,AGUARDANDO_XML,CORRECAO_SOLICITADA';
  const { where, params } = filtroDocumentos(q);
  const itens = all(`SELECT ${COLUNAS_LISTA},
      (SELECT x.problema FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade IN ('erro','alerta')
        ORDER BY CASE x.severidade WHEN 'erro' THEN 1 ELSE 2 END, x.id LIMIT 1) AS problema_principal,
      (SELECT x.categoria FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade IN ('erro','alerta')
        ORDER BY CASE x.severidade WHEN 'erro' THEN 1 ELSE 2 END, x.id LIMIT 1) AS categoria_problema,
      COALESCE((SELECT MIN(dp.vencimento) FROM documento_duplicatas dp WHERE dp.documento_id = d.id AND dp.status_pagamento IN ('aberta','programada')),
        (SELECT MIN(t.vencimento) FROM senior_titulos t WHERE t.documento_id = d.id AND t.situacao_grupo IN ('aberto','em_pagamento'))) AS proximo_vencimento
    ${JOINS} ${where} ${ordenacao({ ordem: req.query.ordem ?? 'prioridade', dir: req.query.dir })} LIMIT 500`, params);
  res.json({ itens });
});

// ------------------------------------------------------------------ detalhe (Painel de Validação)
rotasDocumentos.get('/documentos/:id', (req, res) => {
  const id = Number(req.params.id);
  const doc = get('SELECT d.*, u.nome AS responsavel_nome FROM documentos d LEFT JOIN usuarios u ON u.id = d.responsavel_id WHERE d.id = ?', [id]);
  if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
  const extraido = parseJSON(doc.dados_extraidos, {});
  delete doc.dados_extraidos;
  const ultimaExec = get('SELECT MAX(execucao) AS e FROM validacoes WHERE documento_id = ?', [id]).e;
  const historico = pode(req.usuario, 'historico');
  res.json({
    documento: doc,
    dados_extraidos: extraido,
    itens: carregarItens(id).map((i) => ({ ...i, cfop_descricao: DESCRICAO_CFOP[i.cfop] ?? null, cfop_entrada_sugerido_descricao: DESCRICAO_CFOP[i.cfop_entrada_sugerido] ?? null })),
    empresa: doc.empresa_id ? get('SELECT * FROM empresas WHERE id = ?', [doc.empresa_id]) : null,
    fornecedor: doc.fornecedor_id ? get('SELECT * FROM fornecedores WHERE id = ?', [doc.fornecedor_id]) : null,
    perfil_fornecedor: doc.fornecedor_id ? perfilFornecedor(doc.fornecedor_id, id) : null,
    email: doc.email_id ? get('SELECT e.*, c.email AS caixa FROM emails e JOIN caixas_email c ON c.id = e.caixa_id WHERE e.id = ?', [doc.email_id]) : null,
    anexos: all('SELECT id, email_id, nome_arquivo, tipo_detectado, tamanho, status, mensagem, origem, created_at FROM anexos WHERE documento_id = ? ORDER BY id', [id]),
    recebimentos_duplicados: all(`SELECT r.*, e.assunto, e.remetente, e.data_recebimento, c.email AS caixa FROM recebimentos_duplicados r
      LEFT JOIN emails e ON e.id = r.email_id LEFT JOIN caixas_email c ON c.id = e.caixa_id WHERE r.documento_id = ? ORDER BY r.id`, [id]),
    duplicado_de: doc.duplicado_de_id ? get('SELECT id, numero, serie, chave_acesso, status, recebido_em FROM documentos WHERE id = ?', [doc.duplicado_de_id]) : null,
    eventos: all('SELECT * FROM documento_eventos WHERE documento_id = ? ORDER BY data_evento', [id]),
    duplicatas: all(`SELECT dp.*, u.nome AS atualizado_por_nome FROM documento_duplicatas dp LEFT JOIN usuarios u ON u.id = dp.atualizado_por
      WHERE dp.documento_id = ? ORDER BY dp.vencimento, dp.numero`, [id]),
    senior_titulos: all('SELECT * FROM senior_titulos WHERE documento_id = ? ORDER BY vencimento, numtit', [id]),
    validacoes: all(`SELECT v.regra_codigo, v.resultado, v.detalhe, r.nome, r.categoria, r.severidade FROM validacoes v
      LEFT JOIN regras_fiscais r ON r.codigo = v.regra_codigo WHERE v.documento_id = ? AND v.execucao = ?
      ORDER BY CASE v.resultado WHEN 'falha' THEN 0 WHEN 'ok' THEN 1 ELSE 2 END, r.categoria, v.regra_codigo`, [id, ultimaExec ?? 0]),
    execucao: ultimaExec,
    inconsistencias: all(`SELECT i.*, u.nome AS tratada_por_nome FROM inconsistencias i LEFT JOIN usuarios u ON u.id = i.tratada_por
      WHERE i.documento_id = ? AND i.execucao = ? ORDER BY CASE i.severidade WHEN 'erro' THEN 1 WHEN 'alerta' THEN 2 ELSE 3 END, i.n_item, i.id`, [id, ultimaExec ?? 0]),
    sugestoes_ia: all(`SELECT s.*, u.nome AS decidido_por_nome FROM sugestoes_ia s LEFT JOIN usuarios u ON u.id = s.decidido_por
      WHERE s.documento_id = ? ORDER BY s.id DESC`, [id]).map((s) => ({ ...s, conteudo: parseJSON(s.conteudo, {}) })),
    // Perfil Consulta: somente visualização, sem histórico de decisões (item 13).
    decisoes: historico ? all(`SELECT d.*, u.nome AS usuario_nome FROM decisoes d LEFT JOIN usuarios u ON u.id = d.usuario_id
      WHERE d.documento_id = ? ORDER BY d.id DESC`, [id]).map((d) => ({ ...d, dados: parseJSON(d.dados) })) : null,
    alteracoes: historico ? all(`SELECT a.*, u.nome AS usuario_nome, i.n_item FROM alteracoes_campo a JOIN usuarios u ON u.id = a.usuario_id
      LEFT JOIN documento_itens i ON i.id = a.item_id WHERE a.documento_id = ? ORDER BY a.id DESC`, [id]) : null,
    ia_habilitada: config.ia.habilitada,
    permissoes: { decidir: pode(req.usuario, 'decidir'), ia: pode(req.usuario, 'ia') && config.ia.habilitada, pagamentos: pode(req.usuario, 'pagamentos') },
  });
});

rotasDocumentos.get('/documentos/:id/navegacao', (req, res) => {
  // Próximo documento da fila (para validar em sequência)
  const atual = Number(req.params.id);
  const prox = get(`SELECT id FROM documentos WHERE status IN ('INCONSISTENTE','PENDENTE','DUPLICADA','AGUARDANDO_XML') AND id <> ?
    ORDER BY prioridade ASC, prazo ASC NULLS LAST, id ASC LIMIT 1`, [atual]);
  res.json({ proximo: prox?.id ?? null });
});

// ------------------------------------------------------------------ decisões do usuário
function registrarDecisao(req, documentoId, acao, { justificativa, dados, anterior, novo } = {}) {
  insert('decisoes', {
    documento_id: documentoId, usuario_id: req.usuario.id, acao, justificativa: justificativa || null,
    dados: dados ? JSON.stringify(dados) : null, status_anterior: anterior ?? null, status_novo: novo ?? null,
  });
  auditar(req.usuario.id, `documento.${acao.toLowerCase()}`, 'documento', documentoId, { justificativa, ...dados, de: anterior, para: novo }, req.ip);
}

const exigeJustificativa = (j, min = 5) => typeof j === 'string' && j.trim().length >= min;

function confirmarCfopsSugeridos(req, documentoId, justificativa, origem) {
  const itens = all('SELECT id, n_item, cfop_entrada, cfop_entrada_sugerido FROM documento_itens WHERE documento_id = ? AND cfop_entrada IS NULL AND cfop_entrada_sugerido IS NOT NULL', [documentoId]);
  for (const it of itens) {
    run('UPDATE documento_itens SET cfop_entrada = ? WHERE id = ?', [it.cfop_entrada_sugerido, it.id]);
    insert('alteracoes_campo', {
      documento_id: documentoId, item_id: it.id, campo: 'cfop_entrada', valor_anterior: null, valor_novo: it.cfop_entrada_sugerido,
      origem, usuario_id: req.usuario.id, justificativa,
    });
  }
  return itens.length;
}

rotasDocumentos.post('/documentos/:id/acoes', permitir('decidir'), async (req, res) => {
  const id = Number(req.params.id);
  const doc = get('SELECT * FROM documentos WHERE id = ?', [id]);
  if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
  const { acao, justificativa, responsavel_id, prazo, prioridade, confirmar_cfop_sugerido } = req.body || {};
  const muda = (novo, dados) => tx(() => {
    run("UPDATE documentos SET status = ?, decidido_em = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?", [novo, id]);
    registrarDecisao(req, id, acao, { justificativa, dados, anterior: doc.status, novo });
  });

  switch (acao) {
    case 'APROVAR': {
      if (doc.situacao_sefaz === 'cancelada') return res.status(409).json({ erro: 'Documento cancelado pelo emitente não pode ser aprovado' });
      if (doc.status === 'DUPLICADA' && !exigeJustificativa(justificativa, 10)) return res.status(400).json({ erro: 'Documento marcado como duplicado: justifique a aprovação (mín. 10 caracteres)' });
      const erros = get("SELECT COUNT(*) AS n FROM inconsistencias WHERE documento_id = ? AND status = 'aberta' AND severidade = 'erro'", [id]).n;
      if (erros && !exigeJustificativa(justificativa, 10)) return res.status(400).json({ erro: `Há ${erros} inconsistência(s) aberta(s). Informe a justificativa para aprovar com ressalva (mín. 10 caracteres).` });
      tx(() => {
        const n = confirmar_cfop_sugerido ? confirmarCfopsSugeridos(req, id, justificativa || 'Confirmado na aprovação', 'SUGESTAO_MOTOR_ACEITA') : 0;
        muda('APROVADA', { inconsistencias_abertas: erros, cfops_confirmados: n });
        run("UPDATE documentos SET erp_status = 'pendente' WHERE id = ?", [id]);
      });
      break;
    }
    case 'REPROVAR':
    case 'SOLICITAR_CORRECAO':
    case 'NAO_FISCAL': {
      if (!exigeJustificativa(justificativa)) return res.status(400).json({ erro: 'Justificativa obrigatória' });
      muda({ REPROVAR: 'REJEITADA', SOLICITAR_CORRECAO: 'CORRECAO_SOLICITADA', NAO_FISCAL: 'NAO_FISCAL' }[acao]);
      break;
    }
    case 'OBSERVACAO':
      if (!exigeJustificativa(justificativa, 2)) return res.status(400).json({ erro: 'Informe a observação' });
      registrarDecisao(req, id, acao, { justificativa });
      break;
    case 'ENCAMINHAR':
    case 'ASSUMIR': {
      const destino = acao === 'ASSUMIR' ? req.usuario.id : Number(responsavel_id);
      const u = get("SELECT id, nome FROM usuarios WHERE id = ? AND ativo = 1 AND perfil IN ('admin','fiscal')", [destino]);
      if (!u) return res.status(400).json({ erro: 'Responsável inválido (deve ser usuário Fiscal ou Administrador ativo)' });
      run("UPDATE documentos SET responsavel_id = ?, updated_at = datetime('now','localtime') WHERE id = ?", [u.id, id]);
      registrarDecisao(req, id, acao, { justificativa, dados: { responsavel_anterior: doc.responsavel_id, responsavel: u.id, responsavel_nome: u.nome } });
      break;
    }
    case 'DEFINIR_PRAZO':
      run("UPDATE documentos SET prazo = COALESCE(?, prazo), prioridade = COALESCE(?, prioridade), updated_at = datetime('now','localtime') WHERE id = ?",
        [prazo || null, prioridade ? Math.min(5, Math.max(1, Number(prioridade))) : null, id]);
      registrarDecisao(req, id, acao, { justificativa, dados: { prazo, prioridade, prazo_anterior: doc.prazo, prioridade_anterior: doc.prioridade } });
      break;
    case 'REPROCESSAR':
    case 'REABRIR': {
      const r = acao === 'REPROCESSAR' ? await reprocessarDocumento(id) : executarMotor(id, { reabrir: true });
      registrarDecisao(req, id, acao, { justificativa, anterior: doc.status, novo: r.status, dados: { execucao: r.execucao } });
      break;
    }
    default:
      return res.status(400).json({ erro: `Ação desconhecida: ${acao}` });
  }
  res.json({ ok: true, status: get('SELECT status FROM documentos WHERE id = ?', [id]).status });
});

rotasDocumentos.post('/documentos/:id/inconsistencias/:incId/:operacao', permitir('decidir'), (req, res) => {
  if (!['ignorar', 'reativar'].includes(req.params.operacao)) return res.status(404).json({ erro: 'Operação inválida' });
  const id = Number(req.params.id), incId = Number(req.params.incId);
  const inc = get('SELECT * FROM inconsistencias WHERE id = ? AND documento_id = ?', [incId, id]);
  if (!inc) return res.status(404).json({ erro: 'Alerta não encontrado' });
  const { justificativa } = req.body || {};
  if (req.params.operacao === 'ignorar') {
    if (!exigeJustificativa(justificativa)) return res.status(400).json({ erro: 'Justificativa obrigatória para ignorar um alerta' });
    run("UPDATE inconsistencias SET status = 'ignorada', tratada_por = ?, justificativa = ?, tratada_em = datetime('now','localtime') WHERE id = ?", [req.usuario.id, justificativa, incId]);
    registrarDecisao(req, id, 'IGNORAR_ALERTA', { justificativa, dados: { inconsistencia_id: incId, regra: inc.regra_codigo, problema: inc.problema } });
  } else {
    run("UPDATE inconsistencias SET status = 'aberta', tratada_por = NULL, justificativa = NULL, tratada_em = NULL WHERE id = ?", [incId]);
    registrarDecisao(req, id, 'REATIVAR_ALERTA', { justificativa, dados: { inconsistencia_id: incId, regra: inc.regra_codigo } });
  }
  res.json({ ok: true, status: recalcularStatusAposTratamento(id) });
});

// Escrituração: CFOP de entrada confirmado pelo usuário (nunca automático)
rotasDocumentos.post('/documentos/:id/itens/:itemId/cfop-entrada', permitir('decidir'), (req, res) => {
  const id = Number(req.params.id);
  const item = get('SELECT * FROM documento_itens WHERE id = ? AND documento_id = ?', [Number(req.params.itemId), id]);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });
  const { cfop, justificativa, origem = 'USUARIO' } = req.body || {};
  if (!/^[123]\d{3}$/.test(String(cfop || ''))) return res.status(400).json({ erro: 'CFOP de entrada inválido (deve iniciar com 1, 2 ou 3)' });
  if (!exigeJustificativa(justificativa, 3)) return res.status(400).json({ erro: 'Justificativa obrigatória' });
  tx(() => {
    run('UPDATE documento_itens SET cfop_entrada = ? WHERE id = ?', [cfop, item.id]);
    insert('alteracoes_campo', { documento_id: id, item_id: item.id, campo: 'cfop_entrada', valor_anterior: item.cfop_entrada, valor_novo: cfop, origem: ['USUARIO', 'SUGESTAO_MOTOR_ACEITA'].includes(origem) ? origem : 'USUARIO', usuario_id: req.usuario.id, justificativa });
    registrarDecisao(req, id, 'ALTERAR_CAMPO', { justificativa, dados: { item: item.n_item, campo: 'cfop_entrada', de: item.cfop_entrada, para: cfop } });
  });
  res.json({ ok: true });
});

rotasDocumentos.post('/documentos/:id/cfop-entrada/confirmar-sugestoes', permitir('decidir'), (req, res) => {
  const id = Number(req.params.id);
  const justificativa = req.body?.justificativa || 'Sugestões do motor confirmadas pelo usuário';
  const n = tx(() => {
    const qtd = confirmarCfopsSugeridos(req, id, justificativa, 'SUGESTAO_MOTOR_ACEITA');
    registrarDecisao(req, id, 'ALTERAR_CAMPO', { justificativa, dados: { campo: 'cfop_entrada', itens_confirmados: qtd } });
    return qtd;
  });
  res.json({ ok: true, confirmados: n });
});

// ------------------------------------------------------------------ IA (sugestões)
rotasDocumentos.post('/documentos/:id/ia/analisar', permitir('ia'), async (req, res) => {
  const { analisarDocumento } = await import('../ia/ia.js');
  const r = await analisarDocumento(Number(req.params.id));
  auditar(req.usuario.id, 'ia.analisar', 'documento', req.params.id, r, req.ip);
  res.json(r);
});

rotasDocumentos.post('/inconsistencias/:id/explicar', permitir('ia'), async (req, res) => {
  const { explicarInconsistencia } = await import('../ia/ia.js');
  res.json(await explicarInconsistencia(Number(req.params.id)));
});

rotasDocumentos.post('/documentos/:id/sugestoes/:sid/decidir', permitir('decidir'), (req, res) => {
  const id = Number(req.params.id);
  const s = get("SELECT * FROM sugestoes_ia WHERE id = ? AND documento_id = ? AND status = 'pendente'", [Number(req.params.sid), id]);
  if (!s) return res.status(404).json({ erro: 'Sugestão não encontrada ou já decidida' });
  const { aceitar, justificativa } = req.body || {};
  if (!exigeJustificativa(justificativa, 3)) return res.status(400).json({ erro: 'Justificativa obrigatória' });
  const c = parseJSON(s.conteudo, {});
  tx(() => {
    if (aceitar && s.tipo === 'classificacao' && c.campo === 'cfop_entrada') {
      const item = get('SELECT * FROM documento_itens WHERE documento_id = ? AND n_item = ?', [id, c.n_item]);
      if (item) {
        run('UPDATE documento_itens SET cfop_entrada = ? WHERE id = ?', [c.cfop_sugerido, item.id]);
        insert('alteracoes_campo', { documento_id: id, item_id: item.id, campo: 'cfop_entrada', valor_anterior: item.cfop_entrada, valor_novo: c.cfop_sugerido, origem: 'SUGESTAO_IA_ACEITA', usuario_id: req.usuario.id, justificativa });
      }
    }
    run("UPDATE sugestoes_ia SET status = ?, decidido_por = ?, decidido_em = datetime('now','localtime') WHERE id = ?", [aceitar ? 'aceita' : 'descartada', req.usuario.id, s.id]);
    registrarDecisao(req, id, aceitar ? 'ACEITAR_SUGESTAO_IA' : 'DESCARTAR_SUGESTAO_IA', { justificativa, dados: { sugestao_id: s.id, ...c } });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ arquivos
rotasDocumentos.get('/anexos/:id/arquivo', (req, res) => {
  const a = get('SELECT * FROM anexos WHERE id = ?', [Number(req.params.id)]);
  if (!a) return res.status(404).json({ erro: 'Anexo não encontrado' });
  const tipo = /\.pdf$/i.test(a.nome_arquivo) ? 'application/pdf' : /\.xml$/i.test(a.nome_arquivo) ? 'application/xml' : 'application/octet-stream';
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nome_arquivo)}"`);
  res.sendFile(path.join(paths.anexos, a.caminho));
});

rotasDocumentos.post('/importar', permitir('decidir'), upload.array('arquivos'), async (req, res) => {
  const resultados = [];
  for (const f of req.files || []) {
    const nome = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const r = await processarArquivo({ buffer: f.buffer, nome, mime: f.mimetype, origem: 'upload' });
    resultados.push(...r.map((x) => ({ arquivo: nome, ...x })));
  }
  auditar(req.usuario.id, 'documento.importar', 'anexo', null, { arquivos: (req.files || []).map((f) => f.originalname) }, req.ip);
  res.json({ resultados });
});
