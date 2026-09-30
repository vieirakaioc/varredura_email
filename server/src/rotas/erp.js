// API de integração com ERP (Senior, Sankhya, TOTVS, etc.).
// Autenticação por chave de API (header X-API-Key); apenas o hash da chave é armazenado.
// Fluxo sugerido: o ERP consulta documentos APROVADOS com erp_status = 'pendente', importa e confirma.
import { Router } from 'express';
import { all, get, insert, parseJSON, run } from '../db/index.js';
import { permitir } from '../auth.js';
import { auditar } from '../util/log.js';
import { hash, tokenAleatorio } from '../util/cripto.js';
import { carregarItens } from '../fiscal/motor.js';
import { ADAPTADORES } from '../erp/adaptadores.js';

export const rotasErpAdmin = Router();
export const rotasErpApi = Router();

// ------------------------------------------------------------------ gestão das chaves (admin)
rotasErpAdmin.get('/integracoes', permitir('administrar'), (req, res) => {
  res.json({
    integracoes: all('SELECT id, nome, sistema, chave_prefixo, ativo, ultimo_uso, created_at FROM integracoes_erp ORDER BY id'),
    sistemas: Object.fromEntries(Object.entries(ADAPTADORES).map(([k, a]) => [k, a.nome])),
    pendentes: get("SELECT COUNT(*) AS n FROM documentos WHERE status = 'APROVADA' AND COALESCE(erp_status,'pendente') = 'pendente'").n,
  });
});

rotasErpAdmin.post('/integracoes', permitir('administrar'), (req, res) => {
  const { nome, sistema = 'generico' } = req.body || {};
  if (!nome) return res.status(400).json({ erro: 'Informe o nome da integração' });
  if (!ADAPTADORES[sistema]) return res.status(400).json({ erro: 'Sistema inválido' });
  const chave = `vf_${tokenAleatorio(24)}`;
  const id = insert('integracoes_erp', { nome, sistema, chave_hash: hash(chave), chave_prefixo: chave.slice(0, 7) });
  auditar(req.usuario.id, 'erp.criar_chave', 'integracao_erp', id, { nome, sistema }, req.ip);
  res.json({ id, chave, aviso: 'Guarde esta chave agora: ela não será exibida novamente.' });
});

rotasErpAdmin.put('/integracoes/:id', permitir('administrar'), (req, res) => {
  run('UPDATE integracoes_erp SET ativo = ? WHERE id = ?', [req.body?.ativo ? 1 : 0, Number(req.params.id)]);
  auditar(req.usuario.id, 'erp.alterar_chave', 'integracao_erp', req.params.id, req.body, req.ip);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ Senior (leitura das notas de entrada)
rotasErpAdmin.get('/senior', permitir('ver'), async (req, res) => {
  const { seniorConfigurado, ultimaConciliacao } = await import('../erp/senior.js');
  const cont = get(`SELECT SUM(senior_status = 'lancada') AS lancadas, SUM(senior_status = 'nao_lancada') AS nao_lancadas,
    SUM(senior_status IS NULL) AS nao_verificadas FROM documentos`);
  res.json({ configurado: seniorConfigurado(), tipo: process.env.SENIOR_DB_TIPO ?? null, ultima: ultimaConciliacao(), ...cont });
});
rotasErpAdmin.post('/senior/testar', permitir('administrar'), async (req, res) => {
  const { testarSenior } = await import('../erp/senior.js');
  res.json(await testarSenior());
});
rotasErpAdmin.post('/senior/conciliar', permitir('decidir'), async (req, res) => {
  const { conciliarSenior } = await import('../erp/senior.js');
  const r = await conciliarSenior();
  auditar(req.usuario.id, 'senior.conciliar', 'documento', null, r, req.ip);
  res.json(r);
});

// ------------------------------------------------------------------ Entradas do Senior: Transação × CFOP
const erroSenior = (res, e) => res.status(502).json({
  erro: /connect|ETIMEOUT|ESOCKET|ECONNREFUSED/i.test(e.message)
    ? 'Sem conexão com o banco do Senior (SERVERBD). Verifique a rede/firewall com o TI e tente de novo.'
    : `Consulta ao Senior falhou: ${e.message}`,
});
rotasErpAdmin.get('/entradas', permitir('ver'), async (req, res) => {
  const { listarEntradas } = await import('../erp/entradas.js');
  try { res.json(await listarEntradas(req.query)); } catch (e) { erroSenior(res, e); }
});
rotasErpAdmin.get('/pendentes-lancamento', permitir('ver'), async (req, res) => {
  const { painelPendentes } = await import('../erp/pendentes.js');
  try { res.json(await painelPendentes(req.query)); } catch (e) { erroSenior(res, e); }
});

rotasErpAdmin.put('/pendentes-lancamento/motivo', permitir('decidir'), async (req, res) => {
  const { salvarMotivo } = await import('../erp/pendentes.js');
  const r = salvarMotivo(req.body ?? {}, req.usuario.id);
  auditar(req.usuario.id, 'pendentes.motivo', 'xml_senior', req.body?.chave ?? null, req.body, req.ip);
  res.json({ ok: true, motivo: r });
});
rotasErpAdmin.get('/pendentes-lancamento/diagnostico', permitir('ver'), async (req, res) => {
  const { diagnosticarPendentes } = await import('../erp/pendentes.js');
  try { res.json(await diagnosticarPendentes(req.query.busca)); } catch (e) { erroSenior(res, e); }
});
rotasErpAdmin.get('/lancamentos', permitir('ver'), async (req, res) => {
  const { painelLancamentos } = await import('../erp/lancamentos.js');
  try { res.json(await painelLancamentos(req.query)); } catch (e) { erroSenior(res, e); }
});

rotasErpAdmin.get('/lancamentos/historico', permitir('ver'), async (req, res) => {
  const { historicoMensal } = await import('../erp/lancamentos.js');
  try { res.json(await historicoMensal(req.query)); } catch (e) { erroSenior(res, e); }
});
rotasErpAdmin.put('/lancamentos/metas', permitir('administrar'), async (req, res) => {
  const { salvarMetas } = await import('../erp/lancamentos.js');
  const r = salvarMetas(req.body ?? {});
  auditar(req.usuario.id, 'lancamentos.metas', 'meta', null, req.body, req.ip);
  res.json(r);
});
rotasErpAdmin.get('/entradas/transacoes', permitir('ver'), async (req, res) => {
  const { resumoTransacoes } = await import('../erp/entradas.js');
  try { res.json(await resumoTransacoes()); } catch (e) { erroSenior(res, e); }
});
rotasErpAdmin.put('/entradas/depara/:codtns', permitir('decidir'), async (req, res) => {
  const { salvarDepara } = await import('../erp/entradas.js');
  const r = salvarDepara({ codtns: req.params.codtns, cfops: req.body?.cfops, observacao: req.body?.observacao }, req.usuario.id);
  auditar(req.usuario.id, 'entradas.depara', 'transacao', req.params.codtns, req.body, req.ip);
  res.json({ ok: true, depara: r });
});
rotasErpAdmin.post('/entradas/depara/:codtns/aceitar', permitir('decidir'), async (req, res) => {
  const { aceitarCombinacao } = await import('../erp/entradas.js');
  const r = aceitarCombinacao(req.params.codtns, req.body?.cfop, req.usuario.id);
  auditar(req.usuario.id, 'entradas.aceitar_combinacao', 'transacao', req.params.codtns, req.body, req.ip);
  res.json({ ok: true, depara: r });
});
rotasErpAdmin.get('/entradas/diagnostico', permitir('administrar'), async (req, res) => {
  const { diagnosticoEsquema } = await import('../erp/entradas.js');
  try { res.json(await diagnosticoEsquema()); } catch (e) { erroSenior(res, e); }
});

// ------------------------------------------------------------------ API pública para o ERP
function autenticarErp(req, res, next) {
  const chave = req.headers['x-api-key'];
  const integ = chave ? get('SELECT * FROM integracoes_erp WHERE chave_hash = ? AND ativo = 1', [hash(chave)]) : null;
  if (!integ) return res.status(401).json({ erro: 'Chave de API inválida' });
  run("UPDATE integracoes_erp SET ultimo_uso = datetime('now','localtime') WHERE id = ?", [integ.id]);
  req.integracao = integ;
  next();
}
rotasErpApi.use(autenticarErp);

function documentoCanonico(id) {
  const d = get('SELECT * FROM documentos WHERE id = ?', [id]);
  if (!d) return null;
  const emp = d.empresa_id ? get('SELECT cnpj, razao_social, ie, uf FROM empresas WHERE id = ?', [d.empresa_id]) : null;
  const aprov = get("SELECT dc.created_at, u.nome, u.email FROM decisoes dc LEFT JOIN usuarios u ON u.id = dc.usuario_id WHERE dc.documento_id = ? AND dc.acao = 'APROVAR' ORDER BY dc.id DESC LIMIT 1", [id]);
  return {
    id: d.id, tipo: d.tipo, modelo: d.modelo, chave_acesso: d.chave_acesso, numero: d.numero, serie: d.serie,
    data_emissao: d.data_emissao, data_entrada: d.data_entrada, natureza_operacao: d.natureza_operacao, finalidade: d.finalidade,
    status: d.status, situacao_sefaz: d.situacao_sefaz, origem_dados: d.origem_dados,
    emitente: { cnpj: d.emitente_cnpj, nome: d.emitente_nome, ie: d.emitente_ie, uf: d.emitente_uf, crt: d.emitente_crt },
    destinatario: emp ?? { cnpj: d.destinatario_cnpj, razao_social: d.destinatario_nome, ie: d.destinatario_ie, uf: d.destinatario_uf },
    totais: {
      produtos: d.v_prod, frete: d.v_frete, seguro: d.v_seguro, desconto: d.v_desconto, outras: d.v_outro, bc_icms: d.v_bc_icms, icms: d.v_icms,
      bc_icms_st: d.v_bc_st, icms_st: d.v_icms_st, ipi: d.v_ipi, pis: d.v_pis, cofins: d.v_cofins, iss: d.v_iss, total: d.v_total,
    },
    itens: carregarItens(id).map((i) => ({
      n_item: i.n_item, codigo: i.codigo, ean: i.ean, descricao: i.descricao, ncm: i.ncm, cest: i.cest,
      cfop_emitente: i.cfop, cfop_entrada: i.cfop_entrada, cfop_entrada_confirmado: Boolean(i.cfop_entrada),
      unidade: i.unidade, quantidade: i.quantidade, valor_unitario: i.valor_unitario, valor_total: i.valor_total, desconto: i.v_desconto, frete: i.v_frete,
      impostos: Object.fromEntries(Object.entries(i.impostos).map(([k, t]) => [k, { cst: t.cst, base: t.base, aliquota: t.aliquota, valor: t.valor }])),
    })),
    referencias: parseJSON(d.dados_extraidos, {}).referencias ?? [],
    duplicatas: all('SELECT numero, vencimento, valor, status_pagamento, data_pagamento FROM documento_duplicatas WHERE documento_id = ? ORDER BY vencimento', [id]),
    aprovacao: aprov ? { data: aprov.created_at, usuario: aprov.nome, email: aprov.email } : null,
    erp: { status: d.erp_status, referencia: d.erp_referencia, integrado_em: d.erp_integrado_em },
  };
}

rotasErpApi.get('/documentos', (req, res) => {
  const status = req.query.status || 'APROVADA';
  const erpStatus = req.query.erp_status || 'pendente';
  const limite = Math.min(Number(req.query.limite) || 100, 500);
  const docs = all(`SELECT id FROM documentos WHERE status = ? AND COALESCE(erp_status, 'pendente') = ? AND decidido_em >= ?
    ORDER BY decidido_em LIMIT ${limite}`, [status, erpStatus, req.query.desde || '0000']);
  const adaptador = ADAPTADORES[req.integracao.sistema] ?? ADAPTADORES.generico;
  res.json({ sistema: req.integracao.sistema, documentos: docs.map((d) => adaptador.converter(documentoCanonico(d.id))) });
});

rotasErpApi.get('/documentos/:id', (req, res) => {
  const doc = documentoCanonico(Number(req.params.id));
  if (!doc) return res.status(404).json({ erro: 'Documento não encontrado' });
  res.json((ADAPTADORES[req.integracao.sistema] ?? ADAPTADORES.generico).converter(doc));
});

rotasErpApi.post('/documentos/:id/confirmar', (req, res) => {
  const { sucesso = true, referencia, mensagem } = req.body || {};
  const id = Number(req.params.id);
  const d = get('SELECT status FROM documentos WHERE id = ?', [id]);
  if (!d) return res.status(404).json({ erro: 'Documento não encontrado' });
  if (d.status !== 'APROVADA') return res.status(409).json({ erro: 'Somente documentos aprovados podem ser integrados' });
  run("UPDATE documentos SET erp_status = ?, erp_referencia = ?, erp_integrado_em = datetime('now','localtime') WHERE id = ?", [sucesso ? 'integrado' : 'erro', referencia ?? mensagem ?? null, id]);
  insert('decisoes', { documento_id: id, acao: 'SISTEMA', justificativa: `ERP ${req.integracao.nome}: ${sucesso ? `integrado (ref. ${referencia ?? '—'})` : `erro: ${mensagem ?? '—'}`}` });
  auditar(null, 'erp.confirmar', 'documento', id, { integracao: req.integracao.nome, sucesso, referencia, mensagem }, req.ip);
  res.json({ ok: true });
});
