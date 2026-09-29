import { Router } from 'express';
import { all, get, getConfig, insert, parseJSON, run, setConfig, update } from '../db/index.js';
import { permitir, hashSenha, senhaForte, PERFIS } from '../auth.js';
import { auditar } from '../util/log.js';
import { cnpjValido, limparId } from '../fiscal/validadores.js';
import { perfilFornecedor, resumoOcorrenciasFornecedor } from '../fiscal/historico.js';
import { executarMotor, OPERADORES_DISPONIVEIS } from '../fiscal/motor.js';
import { REGRAS_POR_CODIGO } from '../fiscal/regras.js';
import { TIPOS_FORNECEDOR, DESCRICAO_CFOP, ALIQUOTA_INTERNA_PADRAO } from '../fiscal/tabelas.js';
import { dataHoraLocal } from '../util/data.js';
import { TIPOS_DOCUMENTO, aplicarEscopo, reprocessarTodosAnexos } from '../processamento/ingestao.js';

export const rotasCadastros = Router();

async function conciliarAgora() {
  try {
    const { conciliarSenior, seniorConfigurado } = await import('../erp/senior.js');
    return seniorConfigurado() ? await conciliarSenior() : null;
  } catch (e) { return { erro: e.message }; }
}

// ------------------------------------------------------------------ referências
// Nomes fantasia repetidos (mesma marca em várias filiais) ganham município para o usuário saber qual é qual.
// qtd_docs permite que os filtros mostrem só as empresas que de fato recebem notas.
function empresasReferencia() {
  const lista = all(`SELECT e.id, e.razao_social, e.nome_fantasia, e.cnpj, e.uf, e.municipio, e.regras_especificas,
      (SELECT COUNT(*) FROM documentos d WHERE d.empresa_id = e.id) AS qtd_docs
    FROM empresas e WHERE e.ativo = 1 ORDER BY e.nome_fantasia, e.razao_social`).map(({ regras_especificas: r, ...e }) => {
    // códigos Senior (empresa/filial) para filtros que consultam o ERP
    const cod = JSON.parse(r || '{}');
    return { ...e, codemp: cod.codigo_empresa_erp ?? null, codfil: cod.codigo_filial_erp ?? null };
  });
  const repetidos = new Map();
  for (const e of lista) { const n = e.nome_fantasia || e.razao_social; repetidos.set(n, (repetidos.get(n) ?? 0) + 1); }
  return lista.map((e) => {
    const n = e.nome_fantasia || e.razao_social;
    return repetidos.get(n) > 1 ? { ...e, nome_fantasia: `${n} · ${e.municipio ? `${e.municipio}/${e.uf}` : e.cnpj}` } : e;
  });
}

rotasCadastros.get('/referencias', (req, res) => {
  res.json({
    perfis: PERFIS, tipos_fornecedor: TIPOS_FORNECEDOR, cfops: DESCRICAO_CFOP, operadores: OPERADORES_DISPONIVEIS,
    aliquotas_internas: ALIQUOTA_INTERNA_PADRAO,
    empresas: empresasReferencia(),
    usuarios: all("SELECT id, nome, perfil FROM usuarios WHERE ativo = 1 ORDER BY nome"),
    caixas: all('SELECT id, email FROM caixas_email ORDER BY email'),
  });
});

// ------------------------------------------------------------------ empresas
rotasCadastros.get('/empresas', (req, res) => {
  res.json(all(`SELECT e.*, (SELECT COUNT(*) FROM documentos d WHERE d.empresa_id = e.id) AS qtd_documentos FROM empresas e ORDER BY e.razao_social`)
    .map((e) => ({ ...e, regras_especificas: parseJSON(e.regras_especificas) })));
});

function dadosEmpresa(b) {
  const cnpj = limparId(b.cnpj);
  if (!b.razao_social?.trim()) return { erro: 'Razão social obrigatória' };
  if (!cnpjValido(cnpj)) return { erro: 'CNPJ inválido' };
  if (!/^[A-Z]{2}$/.test(b.uf || '')) return { erro: 'UF inválida' };
  let regras = null;
  if (b.regras_especificas) {
    try { regras = typeof b.regras_especificas === 'string' ? JSON.stringify(JSON.parse(b.regras_especificas)) : JSON.stringify(b.regras_especificas); } catch { return { erro: 'Regras específicas: JSON inválido' }; }
  }
  return {
    dados: {
      razao_social: b.razao_social.trim(), nome_fantasia: b.nome_fantasia || null, cnpj, ie: b.ie || null, uf: b.uf,
      municipio: b.municipio || null, regime_tributario: b.regime_tributario || null, perfil_fiscal: b.perfil_fiscal || null,
      regras_especificas: regras, ativo: b.ativo === false ? 0 : 1,
    },
  };
}

// Vincula documentos já recebidos cujo destinatário é a empresa (cadastro posterior ao recebimento).
function vincularDocumentos(empresaId, cnpj) {
  const docs = all('SELECT id FROM documentos WHERE destinatario_cnpj = ? AND (empresa_id IS NULL OR empresa_id <> ?)', [cnpj, empresaId]);
  for (const d of docs) {
    run('UPDATE documentos SET empresa_id = ? WHERE id = ?', [empresaId, d.id]);
    executarMotor(d.id);
  }
  return docs.length;
}

rotasCadastros.post('/empresas', permitir('administrar'), (req, res) => {
  const { dados, erro } = dadosEmpresa(req.body || {});
  if (erro) return res.status(400).json({ erro });
  if (get('SELECT 1 FROM empresas WHERE cnpj = ?', [dados.cnpj])) return res.status(409).json({ erro: 'CNPJ já cadastrado' });
  const id = insert('empresas', dados);
  const vinculados = vincularDocumentos(id, dados.cnpj);
  auditar(req.usuario.id, 'empresa.criar', 'empresa', id, dados, req.ip);
  res.json({ id, documentos_vinculados: vinculados });
});

rotasCadastros.put('/empresas/:id', permitir('administrar'), (req, res) => {
  const { dados, erro } = dadosEmpresa(req.body || {});
  if (erro) return res.status(400).json({ erro });
  const id = Number(req.params.id);
  if (get('SELECT 1 FROM empresas WHERE cnpj = ? AND id <> ?', [dados.cnpj, id])) return res.status(409).json({ erro: 'CNPJ já cadastrado em outra empresa' });
  const antes = get('SELECT * FROM empresas WHERE id = ?', [id]);
  update('empresas', id, { ...dados, updated_at: dataHoraLocal() });
  vincularDocumentos(id, dados.cnpj);
  auditar(req.usuario.id, 'empresa.alterar', 'empresa', id, { antes, depois: dados }, req.ip);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ fornecedores
rotasCadastros.get('/fornecedores', (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  const qd = req.query.q ? `%${limparId(req.query.q) || '#'}%` : null;
  res.json(all(`SELECT f.*,
      (SELECT COUNT(*) FROM documentos d WHERE d.fornecedor_id = f.id) AS qtd_nfs,
      (SELECT COALESCE(SUM(v_total),0) FROM documentos d WHERE d.fornecedor_id = f.id) AS valor_total,
      (SELECT MAX(recebido_em) FROM documentos d WHERE d.fornecedor_id = f.id) AS ultima_nf,
      (SELECT COUNT(DISTINCT x.documento_id) FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id
        WHERE d.fornecedor_id = f.id AND x.status IN ('aberta','ignorada') AND x.severidade = 'erro') AS nfs_com_erro
    FROM fornecedores f ${q ? 'WHERE f.razao_social LIKE :q OR f.nome_fantasia LIKE :q OR f.cnpj LIKE :qd' : ''}
    ORDER BY qtd_nfs DESC, f.razao_social LIMIT 500`, q ? { q, qd } : {}));
});

rotasCadastros.get('/fornecedores/:id', (req, res) => {
  const id = Number(req.params.id);
  const f = get('SELECT * FROM fornecedores WHERE id = ?', [id]);
  if (!f) return res.status(404).json({ erro: 'Fornecedor não encontrado' });
  res.json({
    fornecedor: f,
    perfil: perfilFornecedor(id),
    ocorrencias: resumoOcorrenciasFornecedor(id),
    documentos: all(`SELECT id, tipo, numero, serie, data_emissao, recebido_em, v_total, status, empresa_id,
      (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'erro') AS qtd_erros
      FROM documentos d WHERE fornecedor_id = ? ORDER BY recebido_em DESC LIMIT 200`, [id]),
  });
});

rotasCadastros.put('/fornecedores/:id', permitir('cadastros'), (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  if (b.tipo_fornecedor && !TIPOS_FORNECEDOR[b.tipo_fornecedor]) return res.status(400).json({ erro: 'Tipo de fornecedor inválido' });
  const antes = get('SELECT * FROM fornecedores WHERE id = ?', [id]);
  update('fornecedores', id, {
    nome_fantasia: b.nome_fantasia ?? antes.nome_fantasia, uf: b.uf ?? antes.uf, municipio: b.municipio ?? antes.municipio,
    regime_tributario: b.regime_tributario ?? antes.regime_tributario, tipo_fornecedor: b.tipo_fornecedor ?? antes.tipo_fornecedor,
    observacoes: b.observacoes ?? antes.observacoes, updated_at: dataHoraLocal(),
  });
  auditar(req.usuario.id, 'fornecedor.alterar', 'fornecedor', id, { antes, depois: b }, req.ip);
  // O tipo do fornecedor muda a sugestão de CFOP de entrada: revalida documentos em aberto.
  if (b.tipo_fornecedor !== undefined && b.tipo_fornecedor !== antes.tipo_fornecedor) {
    for (const d of all("SELECT id FROM documentos WHERE fornecedor_id = ? AND status IN ('PENDENTE','INCONSISTENTE','AGUARDANDO_XML')", [id])) executarMotor(d.id);
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------------ usuários
rotasCadastros.get('/usuarios', permitir('administrar'), (req, res) => {
  res.json(all('SELECT id, nome, email, perfil, ativo, ultimo_login, created_at FROM usuarios ORDER BY nome'));
});

rotasCadastros.post('/usuarios', permitir('administrar'), (req, res) => {
  const b = req.body || {};
  if (!b.nome?.trim() || !/^[^@\s]+@[^@\s]+$/.test(b.email || '')) return res.status(400).json({ erro: 'Nome e e-mail obrigatórios' });
  if (!PERFIS[b.perfil]) return res.status(400).json({ erro: 'Perfil inválido' });
  if (!senhaForte(b.senha)) return res.status(400).json({ erro: 'Senha deve ter ao menos 10 caracteres, com letras e números' });
  if (get('SELECT 1 FROM usuarios WHERE email = ?', [b.email])) return res.status(409).json({ erro: 'E-mail já cadastrado' });
  const id = insert('usuarios', { nome: b.nome.trim(), email: b.email.trim().toLowerCase(), perfil: b.perfil, senha_hash: hashSenha(b.senha) });
  auditar(req.usuario.id, 'usuario.criar', 'usuario', id, { nome: b.nome, email: b.email, perfil: b.perfil }, req.ip);
  res.json({ id });
});

rotasCadastros.put('/usuarios/:id', permitir('administrar'), (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  if (b.perfil && !PERFIS[b.perfil]) return res.status(400).json({ erro: 'Perfil inválido' });
  if (id === req.usuario.id && (b.ativo === false || (b.perfil && b.perfil !== 'admin'))) return res.status(400).json({ erro: 'Você não pode desativar ou rebaixar o próprio usuário' });
  if (b.senha && !senhaForte(b.senha)) return res.status(400).json({ erro: 'Senha deve ter ao menos 10 caracteres, com letras e números' });
  update('usuarios', id, {
    nome: b.nome, perfil: b.perfil, ativo: b.ativo == null ? undefined : (b.ativo ? 1 : 0),
    senha_hash: b.senha ? hashSenha(b.senha) : undefined,
  });
  if (b.ativo === false || b.senha) run('DELETE FROM sessoes WHERE usuario_id = ?', [id]);
  auditar(req.usuario.id, 'usuario.alterar', 'usuario', id, { nome: b.nome, perfil: b.perfil, ativo: b.ativo, senha_alterada: Boolean(b.senha) }, req.ip);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ regras fiscais
rotasCadastros.get('/regras', (req, res) => {
  res.json(all(`SELECT r.*, e.nome_fantasia AS empresa_nome, u.nome AS atualizado_por,
      (SELECT COUNT(*) FROM inconsistencias x WHERE x.regra_codigo = r.codigo AND x.status = 'aberta') AS ocorrencias_abertas
    FROM regras_fiscais r LEFT JOIN empresas e ON e.id = r.empresa_id LEFT JOIN usuarios u ON u.id = r.updated_by
    ORDER BY r.categoria, r.codigo`).map((r) => ({
    ...r, parametros: parseJSON(r.parametros), definicao: parseJSON(r.definicao),
    parametros_padrao: REGRAS_POR_CODIGO[r.codigo]?.parametros ?? null,
  })));
});

function validarDefinicao(def) {
  if (!def || typeof def !== 'object') return 'Definição obrigatória';
  if (!['item', 'documento'].includes(def.escopo)) return 'Escopo deve ser "item" ou "documento"';
  if (!Array.isArray(def.exigencias) || !def.exigencias.length) return 'Informe ao menos uma exigência';
  for (const c of [...(def.condicoes || []), ...def.exigencias]) {
    if (!c.campo || !OPERADORES_DISPONIVEIS.includes(c.operador)) return `Condição inválida: ${JSON.stringify(c)}`;
  }
  if (!def.problema) return 'Descreva o problema (mensagem do alerta)';
  return null;
}

rotasCadastros.post('/regras', permitir('administrar'), (req, res) => {
  const b = req.body || {};
  const codigo = String(b.codigo || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!codigo.startsWith('COND_')) return res.status(400).json({ erro: 'Código de regra personalizada deve começar com COND_' });
  if (get('SELECT 1 FROM regras_fiscais WHERE codigo = ?', [codigo])) return res.status(409).json({ erro: 'Código já existe' });
  const erro = validarDefinicao(b.definicao);
  if (erro) return res.status(400).json({ erro });
  const id = insert('regras_fiscais', {
    codigo, nome: b.nome || codigo, descricao: b.descricao || null, categoria: b.categoria || 'personalizada', tipo: 'condicional',
    severidade: ['erro', 'alerta', 'conferencia'].includes(b.severidade) ? b.severidade : 'alerta',
    definicao: JSON.stringify(b.definicao), empresa_id: b.empresa_id || null, ativo: b.ativo === false ? 0 : 1, updated_by: req.usuario.id,
  });
  auditar(req.usuario.id, 'regra.criar', 'regra', codigo, b, req.ip);
  res.json({ id });
});

rotasCadastros.put('/regras/:id', permitir('administrar'), (req, res) => {
  const id = Number(req.params.id);
  const r = get('SELECT * FROM regras_fiscais WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ erro: 'Regra não encontrada' });
  const b = req.body || {};
  if (b.severidade && !['erro', 'alerta', 'conferencia'].includes(b.severidade)) return res.status(400).json({ erro: 'Severidade inválida' });
  if (r.tipo === 'condicional' && b.definicao) {
    const erro = validarDefinicao(b.definicao);
    if (erro) return res.status(400).json({ erro });
  }
  if (b.parametros !== undefined && (typeof b.parametros !== 'object' || Array.isArray(b.parametros))) return res.status(400).json({ erro: 'Parâmetros devem ser um objeto JSON' });
  update('regras_fiscais', id, {
    nome: b.nome, descricao: b.descricao, severidade: b.severidade, ativo: b.ativo == null ? undefined : (b.ativo ? 1 : 0),
    parametros: b.parametros !== undefined ? JSON.stringify(b.parametros) : undefined,
    definicao: r.tipo === 'condicional' && b.definicao ? JSON.stringify(b.definicao) : undefined,
    empresa_id: b.empresa_id !== undefined ? (b.empresa_id || null) : undefined,
    updated_by: req.usuario.id, updated_at: dataHoraLocal(),
  });
  auditar(req.usuario.id, 'regra.alterar', 'regra', r.codigo, { antes: { ...r, parametros: parseJSON(r.parametros) }, depois: b }, req.ip);
  res.json({ ok: true });
});

rotasCadastros.post('/regras/revalidar', permitir('administrar'), (req, res) => {
  const docs = all("SELECT id FROM documentos WHERE status IN ('PENDENTE','INCONSISTENTE','AGUARDANDO_XML','DUPLICADA')");
  for (const d of docs) executarMotor(d.id);
  auditar(req.usuario.id, 'regra.revalidar_pendentes', 'documento', null, { documentos: docs.length }, req.ip);
  res.json({ revalidados: docs.length });
});

// ------------------------------------------------------------------ configurações gerais
const CONFIGS = {
  tipos_documento_aceitos: { padrao: Object.keys(TIPOS_DOCUMENTO), tipo: 'lista', opcoes: TIPOS_DOCUMENTO, descricao: 'Tipos de documento controlados (os demais anexos são ignorados)' },
  senior_lancada_aprova: { padrao: true, tipo: 'boolean', descricao: 'Nota encontrada lançada no Senior sai da fila (aprovada automaticamente)' },
  auto_aprovar_sem_alertas: { padrao: false, tipo: 'boolean', descricao: 'Aprovar automaticamente documentos XML sem nenhuma ocorrência' },
  prazo_validacao_dias: { padrao: 3, tipo: 'number', descricao: 'Prazo (dias) para validação de novos documentos' },
  valor_prioridade_alta: { padrao: 50000, tipo: 'number', descricao: 'Valor a partir do qual a NF recebe prioridade alta' },
  dias_vencimento_prioridade: { padrao: 5, tipo: 'number', descricao: 'Prioridade alta na fila quando a duplicata vence em até (dias)' },
};
rotasCadastros.get('/configuracoes', permitir('administrar'), (req, res) => {
  res.json(Object.fromEntries(Object.entries(CONFIGS).map(([k, v]) => [k, { ...v, valor: getConfig(k, v.padrao) }])));
});
rotasCadastros.put('/configuracoes', permitir('administrar'), async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!CONFIGS[k]) continue;
    const valor = CONFIGS[k].tipo === 'boolean' ? Boolean(v)
      : CONFIGS[k].tipo === 'lista' ? (Array.isArray(v) ? v : []).filter((x) => CONFIGS[k].opcoes[x])
        : Number(v);
    if (CONFIGS[k].tipo === 'lista' && !valor.length) return res.status(400).json({ erro: 'Selecione ao menos um tipo de documento' });
    setConfig(k, valor);
  }
  auditar(req.usuario.id, 'configuracao.alterar', 'configuracao', null, req.body, req.ip);
  // Mudança de escopo vale imediatamente também para o que já foi recebido.
  const escopo = req.body?.tipos_documento_aceitos !== undefined ? await aplicarEscopo() : null;
  if (escopo) {
    auditar(req.usuario.id, 'escopo.aplicar', 'documento', null, escopo, req.ip);
    await conciliarAgora(); // notas incluídas já saem conferidas com o Senior
  }
  res.json({ ok: true, escopo });
});

// Relê no provedor (somente leitura) os e-mails que ficaram sem o registro dos anexos
rotasCadastros.post('/configuracoes/recuperar-emails', permitir('administrar'), async (req, res) => {
  const { recuperarEmailsSemAnexos } = await import('../captura/index.js');
  const r = await recuperarEmailsSemAnexos();
  auditar(req.usuario.id, 'emails.recuperar_anexos', 'email', null, r, req.ip);
  r.senior = await conciliarAgora();
  res.json(r);
});

rotasCadastros.post('/configuracoes/reprocessar-anexos', permitir('administrar'), async (req, res) => {
  const r = await reprocessarTodosAnexos();
  auditar(req.usuario.id, 'anexos.reprocessar_todos', 'anexo', null, r, req.ip);
  // os documentos foram recriados: confere no Senior imediatamente (sem esperar o ciclo de 10 min)
  r.senior = await conciliarAgora();
  res.json(r);
});
