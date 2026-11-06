import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'senha-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-senhas-simples';
const { db, get, insert } = await import('../src/db/index.js');
const { autenticar, criarSessao, hashSenha, senhaValida } = await import('../src/auth.js');
const { rotasAuth, rotasAuthPublicas } = await import('../src/rotas/auth.js');
const { rotasCadastros } = await import('../src/rotas/cadastros.js');
const express = (await import('express')).default;

const admin = insert('usuarios', {
  nome: 'Administrador de teste', email: 'admin@senha.teste', perfil: 'admin', senha_hash: hashSenha('admin'),
});
const tokenAdmin = criarSessao(admin).token;
const app = express();
app.use(express.json());
app.use('/api', rotasAuthPublicas);
app.use('/api', autenticar, rotasAuth, rotasCadastros);
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
app.use((e, req, res, next) => res.status(e.status || e.statusCode || 500).json({ erro: e.message }));
let server;
let url;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  url = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.match(path.basename(tmp), /^senha-test-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function requisitar(caminho, { method = 'GET', token = tokenAdmin, corpo } = {}) {
  const r = await fetch(url + caminho, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
  return { status: r.status, corpo: await r.json() };
}
const login = (email, senha) => requisitar('/auth/login', { method: 'POST', token: null, corpo: { email, senha } });

test('validação aceita qualquer string não vazia sem comprimento ou composição obrigatórios', () => {
  for (const senha of ['1', '123456', 'a', 'letras', '!', '#$%', 'a1', ' ', '\t', 'á']) {
    assert.equal(senhaValida(senha), true, JSON.stringify(senha));
  }
  for (const senha of ['', undefined, null, 1, 0, true, false, {}, [], new String('a')]) {
    assert.equal(senhaValida(senha), false, String(senha));
  }
});

test('cadastro, login, troca própria e redefinição administrativa aceitam senhas de um caractere', async () => {
  const email = 'simples@senha.teste';
  const criacao = await requisitar('/usuarios', {
    method: 'POST', corpo: { nome: 'Membro com senha simples', email, perfil: 'membro', senha: '1' },
  });
  assert.equal(criacao.status, 200);
  const id = criacao.corpo.id;
  const inicial = get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash;
  assert.match(inicial, /^scrypt\$/);
  assert.notEqual(inicial, '1');
  const entrada = await login(email, '1');
  assert.equal(entrada.status, 200);
  assert.equal(entrada.corpo.usuario.id, id);
  const troca = await requisitar('/auth/senha', {
    method: 'POST', token: entrada.corpo.token, corpo: { atual: '1', nova: 'a' },
  });
  assert.equal(troca.status, 200);
  const alterada = get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash;
  assert.match(alterada, /^scrypt\$/);
  assert.notEqual(alterada, inicial);
  assert.equal((await login(email, '1')).status, 401);
  const entradaNova = await login(email, 'a');
  assert.equal(entradaNova.status, 200);
  const redefinicao = await requisitar(`/usuarios/${id}`, { method: 'PUT', corpo: { senha: '!' } });
  assert.equal(redefinicao.status, 200);
  assert.match(get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash, /^scrypt\$/);
  assert.equal((await requisitar('/auth/me', { token: entradaNova.corpo.token })).status, 401);
  assert.equal((await login(email, 'a')).status, 401);
  assert.equal((await login(email, '!')).status, 200);
});

test('cadastro exige senha não vazia e recusa valores que não sejam strings', async () => {
  const invalidas = ['', undefined, null, 1, false, {}, []];
  for (let i = 0; i < invalidas.length; i++) {
    const email = `invalida-${i}@senha.teste`;
    const r = await requisitar('/usuarios', {
      method: 'POST', corpo: { nome: 'Cadastro inválido', email, perfil: 'membro', senha: invalidas[i] },
    });
    assert.equal(r.status, 400, `Senha ${String(invalidas[i])}`);
    assert.equal(get('SELECT id FROM usuarios WHERE email = ?', [email]), undefined);
  }
});

test('troca própria exige a senha atual correta e uma nova string não vazia', async () => {
  const id = insert('usuarios', {
    nome: 'Troca inválida', email: 'troca@senha.teste', perfil: 'membro', senha_hash: hashSenha('1'),
  });
  const token = criarSessao(id).token;
  const antes = get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash;
  const atualIncorreta = await requisitar('/auth/senha', { method: 'POST', token, corpo: { atual: 'incorreta', nova: 'a' } });
  assert.equal(atualIncorreta.status, 400);
  for (const nova of ['', undefined, null, 1, false, {}, []]) {
    const r = await requisitar('/auth/senha', { method: 'POST', token, corpo: { atual: '1', nova } });
    assert.equal(r.status, 400, `Nova senha ${String(nova)}`);
    assert.equal(get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash, antes);
  }
  assert.equal((await login('troca@senha.teste', '1')).status, 200);
});

test('edição administrativa com senha vazia preserva o hash e o acesso existentes', async () => {
  const id = insert('usuarios', {
    nome: 'Preservar senha', email: 'preservar@senha.teste', perfil: 'membro', senha_hash: hashSenha('!'),
  });
  const token = criarSessao(id).token;
  const antes = get('SELECT senha_hash FROM usuarios WHERE id = ?', [id]).senha_hash;
  const r = await requisitar(`/usuarios/${id}`, { method: 'PUT', corpo: { nome: 'Nome atualizado', senha: '' } });
  assert.equal(r.status, 200);
  const depois = get('SELECT nome, senha_hash FROM usuarios WHERE id = ?', [id]);
  assert.equal(depois.nome, 'Nome atualizado');
  assert.equal(depois.senha_hash, antes);
  assert.equal((await requisitar('/auth/me', { token })).status, 200);
  assert.equal((await login('preservar@senha.teste', '!')).status, 200);
});
