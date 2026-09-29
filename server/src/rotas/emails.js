import { Router } from 'express';
import { all, get, insert, run } from '../db/index.js';
import { config } from '../config.js';
import { permitir } from '../auth.js';
import { auditar, log } from '../util/log.js';
import { limparId } from '../fiscal/validadores.js';
import { sincronizarCaixa, reprocessarEmail } from '../captura/index.js';
import { concluirAutorizacao, resolverConta, urlAutorizacao, zohoConfigurado } from '../captura/zoho.js';
import { verificarEstado } from '../util/cripto.js';

export const rotasEmails = Router();
export const rotasOauthPublicas = Router();

const COLS_CAIXA = `id, email, provedor, empresa_id, provedor_conta_id, pastas, status, ultima_sincronizacao, sincronizar_desde, ultimo_erro, ativo,
  conta_autorizada, filtro_destinatario,
  oauth_token_enc IS NOT NULL AS autorizada, created_at`;

// ------------------------------------------------------------------ caixas
rotasEmails.get('/caixas', (req, res) => {
  const caixas = all(`SELECT ${COLS_CAIXA},
    (SELECT COUNT(*) FROM emails e WHERE e.caixa_id = c.id) AS total_emails,
    (SELECT COUNT(*) FROM emails e WHERE e.caixa_id = c.id AND e.status = 'erro') AS emails_erro
    FROM caixas_email c ORDER BY email`);
  res.json({ caixas, zoho_configurado: zohoConfigurado(), redirect_uri: config.zoho.redirectUri, intervalo_min: config.captura.intervaloMin, captura_automatica: config.captura.habilitada });
});

function validarCaixa(b) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) return 'E-mail inválido';
  if (b.provedor && !['zoho', 'imap', 'pasta', 'manual'].includes(b.provedor)) return 'Provedor inválido';
  return null;
}
const pastasJson = (p) => (p == null ? null : JSON.stringify(Array.isArray(p) ? p : String(p).split(',').map((s) => s.trim()).filter(Boolean)));

rotasEmails.post('/caixas', permitir('administrar'), (req, res) => {
  const b = req.body || {};
  const erro = validarCaixa(b);
  if (erro) return res.status(400).json({ erro });
  const id = insert('caixas_email', { email: b.email.trim().toLowerCase(), provedor: b.provedor || 'zoho', empresa_id: b.empresa_id || null, pastas: pastasJson(b.pastas), sincronizar_desde: b.sincronizar_desde || null });
  auditar(req.usuario.id, 'caixa.criar', 'caixa_email', id, { email: b.email, provedor: b.provedor }, req.ip);
  res.json({ id });
});

rotasEmails.put('/caixas/:id', permitir('administrar'), (req, res) => {
  const b = req.body || {};
  run(`UPDATE caixas_email SET provedor = COALESCE(?, provedor), empresa_id = ?, pastas = ?, sincronizar_desde = ?, ativo = COALESCE(?, ativo) WHERE id = ?`,
    [b.provedor ?? null, b.empresa_id || null, pastasJson(b.pastas), b.sincronizar_desde || null, b.ativo == null ? null : (b.ativo ? 1 : 0), Number(req.params.id)]);
  auditar(req.usuario.id, 'caixa.alterar', 'caixa_email', req.params.id, b, req.ip);
  res.json({ ok: true });
});

rotasEmails.post('/caixas/:id/oauth', permitir('administrar'), (req, res) => {
  if (!zohoConfigurado()) return res.status(400).json({ erro: 'Defina ZOHO_CLIENT_ID e ZOHO_CLIENT_SECRET no .env (Zoho API Console > Server-based Application).' });
  auditar(req.usuario.id, 'caixa.oauth_iniciar', 'caixa_email', req.params.id, null, req.ip);
  res.json({ url: urlAutorizacao(Number(req.params.id)) });
});

// Troca a conta que autoriza a leitura: um único login no Zoho vale para todas as caixas ativas
rotasEmails.post('/caixas/oauth-todas', permitir('administrar'), (req, res) => {
  if (!zohoConfigurado()) return res.status(400).json({ erro: 'Defina ZOHO_CLIENT_ID e ZOHO_CLIENT_SECRET no .env.' });
  const primeira = get("SELECT id FROM caixas_email WHERE provedor = 'zoho' AND ativo = 1 ORDER BY id LIMIT 1");
  if (!primeira) return res.status(400).json({ erro: 'Nenhuma caixa Zoho ativa' });
  auditar(req.usuario.id, 'caixa.oauth_trocar_conta', 'caixa_email', null, null, req.ip);
  res.json({ url: urlAutorizacao(primeira.id, { todas: true }) });
});

rotasEmails.post('/caixas/:id/verificar', permitir('administrar'), async (req, res) => {
  const r = await resolverConta(Number(req.params.id));
  auditar(req.usuario.id, 'caixa.verificar_conta', 'caixa_email', req.params.id, r, req.ip);
  res.json(r);
});

rotasEmails.post('/caixas/:id/desconectar', permitir('administrar'), (req, res) => {
  run("UPDATE caixas_email SET oauth_token_enc = NULL, status = 'desconectada', conta_autorizada = NULL, filtro_destinatario = 0 WHERE id = ?", [Number(req.params.id)]);
  auditar(req.usuario.id, 'caixa.desconectar', 'caixa_email', req.params.id, null, req.ip);
  res.json({ ok: true });
});

rotasEmails.post('/caixas/:id/sincronizar', permitir('decidir'), async (req, res) => {
  auditar(req.usuario.id, 'caixa.sincronizar', 'caixa_email', req.params.id, null, req.ip);
  const r = await sincronizarCaixa(Number(req.params.id));
  res.json(r);
});

// Callback OAuth (público: o Zoho redireciona o navegador; a autenticidade vem do "state" assinado)
rotasOauthPublicas.get('/oauth/zoho/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    // 1 hora: sair do Zoho, trocar de usuário e fazer o login leva tempo
    const { caixaId, todas } = verificarEstado(req.query.state, 60 * 60 * 1000);
    const r = await concluirAutorizacao(caixaId, String(req.query.code || ''), { todas: Boolean(todas) });
    auditar(null, todas ? 'caixa.oauth_trocar_conta_concluido' : 'caixa.oauth_concluido', 'caixa_email', caixaId, r, req.ip);
    res.redirect('/caixas?oauth=ok');
  } catch (e) {
    log('erro', 'oauth', e.message);
    const amigavel = /expirado/i.test(e.message)
      ? 'A autorização demorou mais de 1 hora entre abrir o link e concluir o login. Nada foi alterado: clique em "Trocar conta autorizada" e refaça o login.'
      : e.message;
    res.redirect(`/caixas?oauth=erro&msg=${encodeURIComponent(amigavel)}`);
  }
});

// ------------------------------------------------------------------ e-mails
function filtroEmails(q) {
  const w = [], p = {};
  if (q.status) { w.push('e.status = :status'); p.status = q.status; }
  if (q.caixa_id) { w.push('e.caixa_id = :caixa_id'); p.caixa_id = Number(q.caixa_id); }
  if (q.remetente) { w.push('(e.remetente LIKE :rem OR e.remetente_nome LIKE :rem)'); p.rem = `%${q.remetente}%`; }
  if (q.assunto) { w.push('e.assunto LIKE :assunto'); p.assunto = `%${q.assunto}%`; }
  if (q.de) { w.push('substr(e.data_recebimento,1,10) >= :de'); p.de = q.de; }
  if (q.ate) { w.push('substr(e.data_recebimento,1,10) <= :ate'); p.ate = q.ate; }
  if (q.numero) { w.push('EXISTS (SELECT 1 FROM anexos a JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = e.id AND d.numero = :numero)'); p.numero = String(Number(String(q.numero).replace(/\D/g, '')) || q.numero); }
  if (q.cnpj) { w.push('EXISTS (SELECT 1 FROM anexos a JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = e.id AND (d.emitente_cnpj LIKE :cnpj OR d.destinatario_cnpj LIKE :cnpj))'); p.cnpj = `%${limparId(q.cnpj)}%`; }
  if (q.chave) { w.push('EXISTS (SELECT 1 FROM anexos a JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = e.id AND d.chave_acesso LIKE :chave)'); p.chave = `%${String(q.chave).replace(/\s/g, '')}%`; }
  if (q.q) { w.push('(e.assunto LIKE :q OR e.remetente LIKE :q OR e.remetente_nome LIKE :q)'); p.q = `%${q.q}%`; }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

rotasEmails.get('/emails', (req, res) => {
  const { where, params } = filtroEmails(req.query);
  const limite = Math.min(Number(req.query.limite) || 50, 200);
  const pagina = Math.max(Number(req.query.pagina) || 1, 1);
  const total = get(`SELECT COUNT(*) AS n FROM emails e ${where}`, params).n;
  const itens = all(`SELECT e.*, c.email AS caixa,
      (SELECT COUNT(DISTINCT a.documento_id) FROM anexos a WHERE a.email_id = e.id AND a.documento_id IS NOT NULL) AS qtd_documentos,
      (SELECT group_concat(DISTINCT d.status) FROM anexos a JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = e.id) AS status_documentos
    FROM emails e JOIN caixas_email c ON c.id = e.caixa_id ${where}
    ORDER BY e.data_recebimento DESC, e.id DESC LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, params);
  const resumo = get(`SELECT COUNT(*) AS recebidos, SUM(status = 'processado') AS processado, SUM(status = 'sem_nf') AS sem_nf,
    SUM(status = 'erro') AS erro, SUM(status = 'aguardando') AS aguardando, SUM(status = 'duplicado') AS duplicado FROM emails e
    ${req.query.caixa_id ? 'WHERE e.caixa_id = :caixa_id' : ''}`, req.query.caixa_id ? { caixa_id: Number(req.query.caixa_id) } : {});
  res.json({ itens, total, pagina, limite, resumo });
});

rotasEmails.get('/emails/:id', (req, res) => {
  const id = Number(req.params.id);
  const email = get('SELECT e.*, c.email AS caixa, c.provedor FROM emails e JOIN caixas_email c ON c.id = e.caixa_id WHERE e.id = ?', [id]);
  if (!email) return res.status(404).json({ erro: 'E-mail não encontrado' });
  const anexos = all(`SELECT a.id, a.nome_arquivo, a.tipo_detectado, a.tamanho, a.status, a.mensagem, a.origem, a.anexo_pai_id, a.documento_id,
      d.tipo AS doc_tipo, d.numero AS doc_numero, d.serie AS doc_serie, d.status AS doc_status, d.emitente_nome AS doc_emitente, d.v_total AS doc_valor,
      d.chave_acesso AS doc_chave,
      (SELECT COUNT(*) FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = 'erro') AS doc_erros
    FROM anexos a LEFT JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = ? ORDER BY a.id`, [id]);
  const mesmaMensagem = email.internet_message_id ? all('SELECT e.id, c.email AS caixa FROM emails e JOIN caixas_email c ON c.id = e.caixa_id WHERE e.internet_message_id = ? AND e.id <> ?', [email.internet_message_id, id]) : [];
  res.json({ email, anexos, mesma_mensagem_em: mesmaMensagem });
});

rotasEmails.post('/emails/:id/reprocessar', permitir('decidir'), async (req, res) => {
  auditar(req.usuario.id, 'email.reprocessar', 'email', req.params.id, null, req.ip);
  res.json(await reprocessarEmail(Number(req.params.id)));
});
