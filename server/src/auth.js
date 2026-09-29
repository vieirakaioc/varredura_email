// Autenticação de usuários do sistema e controle de acesso por perfil.
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db/index.js';
import { hash, tokenAleatorio } from './util/cripto.js';

export const PERFIS = {
  admin: 'Administrador',
  fiscal: 'Fiscal',
  consulta: 'Consulta',
  auditor: 'Auditor',
  financeiro: 'Financeiro',
};

// Permissões por perfil (item 13 da especificação + perfil Financeiro para contas a pagar).
export const PERMISSOES = {
  ver: ['admin', 'fiscal', 'consulta', 'auditor', 'financeiro'],
  decidir: ['admin', 'fiscal'],            // aprovar, reprovar, ignorar alerta, encaminhar, reprocessar
  financeiro: ['admin', 'fiscal', 'auditor', 'financeiro'], // painel de contas a pagar
  pagamentos: ['admin', 'financeiro'],     // registrar pagamento/programação das duplicatas
  relatorios: ['admin', 'fiscal', 'auditor', 'financeiro'],
  historico: ['admin', 'fiscal', 'auditor'],
  auditoria: ['admin', 'auditor'],
  cadastros: ['admin', 'fiscal'],          // fornecedores (tipo/destinação)
  administrar: ['admin'],                  // empresas, usuários, regras, caixas, integrações
  ia: ['admin', 'fiscal'],
};

export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function conferirSenha(senha, armazenado) {
  const [alg, sal, h] = String(armazenado).split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(senha, Buffer.from(sal, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const esperado = Buffer.from(h, 'base64');
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

export function senhaForte(senha) {
  return typeof senha === 'string' && senha.length >= 10 && /[A-Za-z]/.test(senha) && /\d/.test(senha);
}

export function criarSessao(usuarioId, ip) {
  const token = tokenAleatorio(32);
  const expira = new Date(Date.now() + config.sessaoHoras * 3600000).toISOString();
  run('INSERT INTO sessoes (token_hash, usuario_id, expira_em, ip) VALUES (?,?,?,?)', [hash(token), usuarioId, expira, ip ?? null]);
  run("DELETE FROM sessoes WHERE expira_em < ?", [new Date().toISOString()]);
  return { token, expira };
}

export function encerrarSessao(token) {
  run('DELETE FROM sessoes WHERE token_hash = ?', [hash(token)]);
}

function tokenDaRequisicao(req) {
  const h = req.headers.authorization || '';
  // Downloads também usam fetch + Authorization: o token nunca vai para a URL.
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Middleware: exige sessão válida. */
export function autenticar(req, res, next) {
  const token = tokenDaRequisicao(req);
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  const s = get(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, s.expira_em FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ?`, [hash(token)]);
  if (!s || !s.ativo || s.expira_em < new Date().toISOString()) return res.status(401).json({ erro: 'Sessão expirada' });
  req.usuario = { id: s.id, nome: s.nome, email: s.email, perfil: s.perfil };
  req.token = token;
  next();
}

/** Middleware: exige uma das permissões. */
export const permitir = (permissao) => (req, res, next) => {
  if (!PERMISSOES[permissao]?.includes(req.usuario?.perfil)) {
    return res.status(403).json({ erro: `Seu perfil (${PERFIS[req.usuario?.perfil] ?? '—'}) não tem permissão para esta ação` });
  }
  next();
};

export const pode = (usuario, permissao) => PERMISSOES[permissao]?.includes(usuario?.perfil) ?? false;
