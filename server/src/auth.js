// Autenticação de usuários do sistema e controle de acesso por perfil.
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db/index.js';
import { hash, tokenAleatorio } from './util/cripto.js';

export const PERFIS = {
  admin: 'Administrador',
  membro: 'Membro',
  fiscal: 'Fiscal',
  consulta: 'Consulta',
  auditor: 'Auditor',
  financeiro: 'Financeiro',
};

// Permissões por perfil (item 13 da especificação + perfil Financeiro para contas a pagar).
export const PERMISSOES = {
  carteira_ver: ['admin', 'membro', 'fiscal', 'consulta', 'auditor', 'financeiro'],
  carteira_operar: ['admin', 'membro', 'fiscal'],
  carteira_gerir: ['admin', 'fiscal'],
  malha_ver: ['admin', 'membro', 'fiscal', 'consulta', 'auditor', 'financeiro'],
  exportar: ['admin', 'membro', 'fiscal', 'consulta', 'auditor', 'financeiro'],
  ver: ['admin', 'membro', 'fiscal', 'consulta', 'auditor', 'financeiro'],
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

export function senhaValida(senha) {
  return typeof senha === 'string' && senha.length > 0;
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
  if (s.perfil === 'membro') return acessoMembro(req, res, next);
  next();
}

// A lista é deliberadamente fechada: endpoints antigos têm leituras sem permissão própria.
// A restrição vale também para chamadas diretas à API e para sessões já abertas.
function acessoMembro(req, res, next) {
  const caminho = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  const metodo = req.method === 'HEAD' ? 'GET' : req.method;
  const negar = () => res.status(403).json({ erro: 'O perfil Membro tem acesso a Todas as notas, Pendentes de lançamento, Filas e compromisso e à consulta da Malha fina' });
  if (metodo === 'GET' && [
    '/auth/me', '/referencias', '/documentos', '/pendentes-lancamento',
    '/pendentes-lancamento/diagnostico', '/filas', '/filas/dia', '/carteira', '/carteira/configuracao',
  ].includes(caminho)) return next();
  // A consulta de Todas as notas inclui os detalhes e arquivos, mesmo fora da carteira.
  if (metodo === 'GET' && /^\/documentos\/[1-9]\d*(?:\/navegacao)?$/.test(caminho)) return next();
  if (metodo === 'GET' && /^\/anexos\/[1-9]\d*\/arquivo$/.test(caminho)) return next();
  if (metodo === 'POST' && ['/auth/logout','/auth/senha','/exportar'].includes(caminho)) return next();
  if (metodo === 'GET' && /^\/malha-fina(?:\/pj|\/[1-9]\d*)?$/.test(caminho)) return next();
  const nota = caminho.match(/^\/carteira\/([1-9]\d*)(\/historico)?$/);
  if (nota && ((metodo === 'GET' && nota[2]) || (metodo === 'PUT' && !nota[2]))) {
    // Enquanto a planilha não define responsável, o membro trata qualquer nota ativa: o perfil
    // serve para decidir as telas, não para travar a nota. Para voltar a restringir, exija
    // ativa.responsavel_id === req.usuario.id no PUT.
    const ativa = get('SELECT responsavel_id FROM carteira_notas WHERE id = ? AND excluida_em IS NULL', [Number(nota[1])]);
    if (!ativa) return negar();
    return next();
  }
  return negar();
}

/** Middleware: exige uma das permissões. */
export const permitir = (permissao) => (req, res, next) => {
  if (!PERMISSOES[permissao]?.includes(req.usuario?.perfil)) {
    return res.status(403).json({ erro: `Seu perfil (${PERFIS[req.usuario?.perfil] ?? '—'}) não tem permissão para esta ação` });
  }
  next();
};

export const pode = (usuario, permissao) => PERMISSOES[permissao]?.includes(usuario?.perfil) ?? false;
