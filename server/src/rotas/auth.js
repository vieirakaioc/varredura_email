import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { autenticar, conferirSenha, criarSessao, encerrarSessao, hashSenha, senhaForte, PERMISSOES, permitir } from '../auth.js';
import { auditar } from '../util/log.js';

export const rotasAuthPublicas = Router();
export const rotasAuth = Router();

// Bloqueio simples contra força bruta: 5 falhas em 15 min por e-mail+IP.
const falhas = new Map();
const JANELA = 15 * 60 * 1000;

rotasAuthPublicas.post('/auth/login', (req, res) => {
  const { email, senha } = req.body || {};
  const chave = `${String(email).toLowerCase()}|${req.ip}`;
  const f = falhas.get(chave);
  if (f && f.qtd >= 5 && Date.now() - f.inicio < JANELA) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const u = email ? get('SELECT * FROM usuarios WHERE email = ?', [String(email).trim()]) : null;
  if (!u || !u.ativo || !conferirSenha(String(senha || ''), u.senha_hash)) {
    const atual = f && Date.now() - f.inicio < JANELA ? f : { qtd: 0, inicio: Date.now() };
    falhas.set(chave, { ...atual, qtd: atual.qtd + 1 });
    auditar(u?.id ?? null, 'login.falha', 'usuario', u?.id, { email }, req.ip);
    return res.status(401).json({ erro: 'E-mail ou senha inválidos' });
  }
  falhas.delete(chave);
  const { token, expira } = criarSessao(u.id, req.ip);
  run("UPDATE usuarios SET ultimo_login = datetime('now','localtime') WHERE id = ?", [u.id]);
  auditar(u.id, 'login', 'usuario', u.id, null, req.ip);
  res.json({ token, expira, usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil } });
});

rotasAuth.post('/auth/logout', (req, res) => {
  encerrarSessao(req.token);
  auditar(req.usuario.id, 'logout', 'usuario', req.usuario.id, null, req.ip);
  res.json({ ok: true });
});

rotasAuth.get('/auth/me', (req, res) => {
  const permissoes = Object.entries(PERMISSOES).filter(([, perfis]) => perfis.includes(req.usuario.perfil)).map(([p]) => p);
  res.json({ usuario: req.usuario, permissoes });
});

rotasAuth.post('/auth/senha', (req, res) => {
  const { atual, nova } = req.body || {};
  const u = get('SELECT senha_hash FROM usuarios WHERE id = ?', [req.usuario.id]);
  if (!conferirSenha(String(atual || ''), u.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta' });
  if (!senhaForte(nova)) return res.status(400).json({ erro: 'A nova senha deve ter ao menos 10 caracteres, com letras e números' });
  run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hashSenha(nova), req.usuario.id]);
  auditar(req.usuario.id, 'usuario.alterar_senha', 'usuario', req.usuario.id, null, req.ip);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ auditoria
rotasAuth.get('/auditoria', permitir('auditoria'), (req, res) => {
  const w = [], p = {};
  if (req.query.usuario_id) { w.push('l.usuario_id = :u'); p.u = Number(req.query.usuario_id); }
  if (req.query.acao) { w.push('l.acao LIKE :a'); p.a = `%${req.query.acao}%`; }
  if (req.query.entidade_id) { w.push('l.entidade_id = :e'); p.e = String(req.query.entidade_id); }
  if (req.query.de) { w.push('substr(l.created_at,1,10) >= :de'); p.de = req.query.de; }
  if (req.query.ate) { w.push('substr(l.created_at,1,10) <= :ate'); p.ate = req.query.ate; }
  res.json(all(`SELECT l.*, u.nome AS usuario_nome FROM logs_auditoria l LEFT JOIN usuarios u ON u.id = l.usuario_id
    ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 1000`, p));
});

rotasAuth.get('/logs-processamento', permitir('administrar'), (req, res) => {
  const nivel = req.query.nivel;
  res.json(all(`SELECT * FROM logs_processamento ${nivel ? 'WHERE nivel = ?' : ''} ORDER BY id DESC LIMIT 500`, nivel ? [nivel] : []));
});
