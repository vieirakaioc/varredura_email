import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// A base isolada começa no esquema anterior para também exercitar a migração
// do CHECK de perfis, com um usuário e uma sessão que precisam sobreviver.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acesso-membro-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-acesso-membro';
process.env.SENIOR_DB_TIPO = '';
const legado = new DatabaseSync(path.join(tmp, 'validador.db'));
legado.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL CHECK (perfil IN ('admin','fiscal','consulta','auditor','financeiro')),
    ativo INTEGER NOT NULL DEFAULT 1,
    ultimo_login TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  INSERT INTO usuarios (id,nome,email,senha_hash,perfil)
    VALUES (41,'Administrador legado','admin@acesso.teste','hash-legado','admin');
  INSERT INTO sessoes (token_hash,usuario_id,expira_em)
    VALUES ('sessao-legada',41,'2099-01-01T00:00:00.000Z');
`);
legado.close();

const { db, all, get, insert, run } = await import('../src/db/index.js');
const { paths } = await import('../src/config.js');
const { autenticar, criarSessao, hashSenha } = await import('../src/auth.js');
const express = (await import('express')).default;
const { rotasAuth, rotasAuthPublicas } = await import('../src/rotas/auth.js');
const { rotasDashboard } = await import('../src/rotas/dashboard.js');
const { rotasDocumentos } = await import('../src/rotas/documentos.js');
const { rotasEmails } = await import('../src/rotas/emails.js');
const { rotasCadastros } = await import('../src/rotas/cadastros.js');
const { rotasRelatorios } = await import('../src/rotas/relatorios.js');
const { rotasFinanceiro } = await import('../src/rotas/financeiro.js');
const { rotasErpAdmin } = await import('../src/rotas/erp.js');
const { rotasSefaz } = await import('../src/rotas/sefaz.js');

const admin = 41;
const senha = 'TesteAcesso123';
const senhaHash = hashSenha(senha);
run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [senhaHash, admin]);
const membro = insert('usuarios', { nome: 'Membro', email: 'membro@acesso.teste', senha_hash: senhaHash, perfil: 'membro' });
const outro = insert('usuarios', { nome: 'Outro membro', email: 'outro@acesso.teste', senha_hash: senhaHash, perfil: 'membro' });
const fiscal = insert('usuarios', { nome: 'Fiscal', email: 'fiscal@acesso.teste', senha_hash: senhaHash, perfil: 'fiscal' });
const consulta = insert('usuarios', { nome: 'Consulta', email: 'consulta@acesso.teste', senha_hash: senhaHash, perfil: 'consulta' });
const tokens = Object.fromEntries(Object.entries({ admin, membro, outro, fiscal, consulta }).map(([p, id]) => [p, criarSessao(id).token]));

let sequencia = 0;
function criarNota(dados = {}) {
  const numero = String(++sequencia);
  return insert('carteira_notas', {
    identidade: `teste:${numero}`, chave: numero.repeat(44).slice(0, 44), numero, documento: 'NF-e',
    cnpj_fornecedor: '12345678000190', tomador_cnpj: '22333444000155', fornecedor: 'Fornecedor teste',
    empfil: '1/2', empresa: 'Matriz', data_prevista: '2026-10-22', data_original: '2026-10-22',
    responsavel_id: membro, criada_em: '2026-10-22T08:00:00.000Z', atualizado_em: '2026-10-22T08:00:00.000Z', ...dados,
  });
}
function criarDocumento(notaId) {
  const n = notaId ? get('SELECT * FROM carteira_notas WHERE id = ?', [notaId]) : null;
  return insert('documentos', {
    tipo: 'NFE', origem_dados: 'manual', dados_extraidos: '{}', chave_acesso: n?.chave ?? '9'.repeat(44),
    numero: n?.numero ?? '999', emitente_cnpj: '12345678000190', destinatario_cnpj: '22333444000155',
    destinatario_nome: 'Tomador teste',
  });
}
function criarAnexo(documentoId, nome, tipo, mime = 'application/pdf') {
  const conteudo = mime === 'application/pdf' ? `%PDF-1.4\n${nome}\n%%EOF` : '<nfe>teste</nfe>';
  const caminho = nome;
  fs.writeFileSync(path.join(paths.anexos, caminho), conteudo);
  return insert('anexos', {
    documento_id: documentoId, nome_arquivo: nome, tipo_detectado: tipo, mime,
    tamanho: Buffer.byteLength(conteudo), caminho,
    sha256: crypto.createHash('sha256').update(conteudo).digest('hex'),
  });
}

const notaMinha = criarNota();
const notaOutro = criarNota({ responsavel_id: outro });
const notaSemResponsavel = criarNota({ responsavel_id: null });
const notaExcluida = criarNota({ excluida_em: '2026-10-22T09:00:00.000Z' });
const docAtivo = criarDocumento(notaMinha);
const docExcluido = criarDocumento(notaExcluida);
const docFora = criarDocumento();
const pdfNota = criarAnexo(docAtivo, 'nota-da-carteira.pdf', 'danfe_pdf');
const boleto = criarAnexo(docAtivo, 'boleto-da-carteira.pdf', 'boleto_pdf');
const pdfPonteiro = criarAnexo(null, 'nota-vinculada-por-ponteiro.pdf', 'pdf_desconhecido');
run('UPDATE documentos SET pdf_anexo_id = ? WHERE id = ?', [pdfPonteiro, docAtivo]);
const xml = criarAnexo(docAtivo, 'xml-da-carteira.xml', 'nfe_xml', 'application/xml');
const pdfSemClassificacao = criarAnexo(docAtivo, 'outro-pdf-do-email.pdf', 'pdf_desconhecido');
const pdfExcluido = criarAnexo(docExcluido, 'nota-excluida.pdf', 'danfe_pdf');
const pdfFora = criarAnexo(docFora, 'nota-fora-da-carteira.pdf', 'danfe_pdf');
const loteMalha = insert('malha_fina_lotes', {
  arquivo: 'malha-teste.xlsx', hash: 'hash-malha-acesso-teste', competencia: '2026-10', notas: 1, usuario_id: admin,
});
const notaMalha = insert('malha_fina_notas', {
  lote_id: loteMalha, numero: '810', cnpj_prestador: '12345678000190', prestador: 'Prestador da malha',
  competencia: '2026-10-01', valor: 250, situacao: 'nao_lancada',
});
const cnpjPj = '99888777000166';
insert('prestadores_pj', { cnpj: cnpjPj, nome: 'PJ cadastrado para consulta' });

const app = express();
app.use(express.json());
app.use('/api', rotasAuthPublicas);
app.use('/api', autenticar, rotasAuth, rotasDashboard, rotasDocumentos, rotasEmails, rotasCadastros,
  rotasRelatorios, rotasFinanceiro, rotasErpAdmin, rotasSefaz);
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
  assert.match(path.basename(tmp), /^acesso-membro-test-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function requisitar(caminho, perfil = 'membro', opcoes = {}) {
  const { corpo, token = tokens[perfil], ...op } = opcoes;
  return fetch(url + caminho, {
    ...op,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }), ...op.headers },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}
async function json(caminho, perfil = 'membro', opcoes = {}) {
  const r = await requisitar(caminho, perfil, opcoes);
  return { status: r.status, corpo: await r.json() };
}
async function deveNegar(caminho, opcoes = {}) {
  const r = await json(caminho, 'membro', opcoes);
  assert.equal(r.status, 403, `${opcoes.method || 'GET'} ${caminho}: ${JSON.stringify(r.corpo)}`);
  assert.equal(typeof r.corpo.erro, 'string');
}

test('migração permite membro e preserva usuários, sessões e referências existentes', () => {
  assert.equal(get('SELECT nome FROM usuarios WHERE id = ?', [admin]).nome, 'Administrador legado');
  assert.equal(get('SELECT usuario_id FROM sessoes WHERE token_hash = ?', ['sessao-legada']).usuario_id, admin);
  assert.equal(get('SELECT perfil FROM usuarios WHERE id = ?', [membro]).perfil, 'membro');
  assert.ok(all('PRAGMA foreign_key_list(sessoes)').some((f) => f.table === 'usuarios'));
  assert.equal(get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.deepEqual(all('PRAGMA foreign_key_check'), []);
});

test('membro autentica com leitura das notas e pendentes sem permissões de gestão', async () => {
  const login = await json('/auth/login', 'membro', {
    method: 'POST', token: null, corpo: { email: 'membro@acesso.teste', senha },
  });
  assert.equal(login.status, 200);
  assert.equal(login.corpo.usuario.perfil, 'membro');
  assert.equal(typeof login.corpo.token, 'string');
  const me = await json('/auth/me');
  assert.equal(me.status, 200);
  for (const p of ['ver', 'carteira_ver', 'carteira_operar', 'malha_ver', 'exportar']) assert.ok(me.corpo.permissoes.includes(p), p);
  for (const p of ['decidir', 'administrar', 'carteira_gerir', 'relatorios', 'financeiro', 'pagamentos', 'historico', 'ia']) {
    assert.ok(!me.corpo.permissoes.includes(p), p);
  }
  assert.equal((await json('/carteira', 'membro', { token: null })).status, 401);
});

test('membro consulta Todas as notas, detalhes e referências sem aprovar, pagar ou acessar histórico', async () => {
  const lista = await json('/documentos');
  assert.equal(lista.status, 200);
  assert.ok(lista.corpo.itens.some((d) => d.id === docAtivo));
  assert.ok(lista.corpo.itens.some((d) => d.id === docFora));
  const filtrada = await json(`/documentos?numero=${get('SELECT numero FROM documentos WHERE id = ?', [docFora]).numero}`);
  assert.equal(filtrada.status, 200);
  assert.deepEqual(filtrada.corpo.itens.map((d) => d.id), [docFora]);
  for (const id of [docAtivo, docExcluido, docFora]) {
    const detalhe = await json(`/documentos/${id}`);
    assert.equal(detalhe.status, 200);
    assert.equal(detalhe.corpo.documento.id, id);
    assert.deepEqual(detalhe.corpo.permissoes, { decidir: false, ia: false, pagamentos: false });
    assert.equal(detalhe.corpo.decisoes, null);
    assert.equal(detalhe.corpo.alteracoes, null);
    assert.equal((await json(`/documentos/${id}/navegacao`)).status, 200);
  }
  const refs = await json('/referencias');
  assert.equal(refs.status, 200);
  assert.ok(Array.isArray(refs.corpo.empresas));
  assert.ok(Array.isArray(refs.corpo.usuarios));
  assert.ok(Array.isArray(refs.corpo.caixas));
  assert.equal((await json('/DOCUMENTOS/')).status, 200);
  const head = await requisitar('/documentos', 'membro', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await json('/documentos/999999')).status, 404);
  assert.equal((await json('/documentos', 'membro', { token: null })).status, 401);
});

test('membro consulta pendentes e dashboard das filas sem conexão real ao Senior', async (t) => {
  const mssql = (await import('mssql')).default;
  const { limparCache } = await import('../src/erp/cache.js');
  const variaveis = ['SENIOR_DB_TIPO', 'SENIOR_DB_HOST', 'SENIOR_DB_USUARIO'];
  const anteriores = Object.fromEntries(variaveis.map((v) => [v, process.env[v]]));
  const consultas = [];
  // A conexão é substituída antes de habilitar o ERP: nenhuma consulta abre sockets.
  t.mock.method(mssql.ConnectionPool.prototype, 'connect', async () => ({
    connected: true,
    request() {
      return {
        input() { return this; },
        async query(sql) {
          consultas.push(sql);
          assert.match(sql, /^\s*SELECT\b/i);
          return { recordset: [] };
        },
      };
    },
  }));
  t.after(() => {
    for (const v of variaveis) {
      if (anteriores[v] === undefined) delete process.env[v];
      else process.env[v] = anteriores[v];
    }
    limparCache();
  });
  process.env.SENIOR_DB_TIPO = 'mssql';
  process.env.SENIOR_DB_HOST = 'erp-inexistente.acesso.teste';
  process.env.SENIOR_DB_USUARIO = 'somente-teste';
  limparCache();

  const pendentes = await json('/pendentes-lancamento?mes=2026-10&incluir_nfse=0&forcar=1');
  assert.equal(pendentes.status, 200, JSON.stringify(pendentes.corpo));
  assert.equal(pendentes.corpo.indicadores.pendentes, 0);
  assert.deepEqual(pendentes.corpo.itens, []);
  const diagnostico = await json(`/pendentes-lancamento/diagnostico?busca=${'1'.repeat(44)}`);
  assert.equal(diagnostico.status, 200, JSON.stringify(diagnostico.corpo));
  assert.deepEqual(diagnostico.corpo.notas, []);
  const filas = await json('/filas');
  assert.equal(filas.status, 200);
  assert.ok(filas.corpo.categorias.length > 0);
  const dia = await json('/filas/dia?dia=2026-10-22&forcar=1');
  assert.equal(dia.status, 200, JSON.stringify(dia.corpo));
  assert.equal(dia.corpo.dia, '2026-10-22');
  assert.equal(dia.corpo.dashboard.notas_lancadas.estado, 'ok');
  assert.deepEqual(dia.corpo.dashboard.avisos, []);
  const recortado = await json('/filas/dia?dia=2026-10-22&empresa=1&empfil=1/2');
  assert.equal(recortado.status, 200);
  assert.deepEqual(recortado.corpo.filtros, { empresa: '1', empfil: '1/2' });
  assert.deepEqual(recortado.corpo.filtros_disponiveis, { empresas: [], filiais: [] });
  assert.equal(recortado.corpo.indicadores.compromisso, null);
  assert.ok(consultas.some((sql) => sql.includes('FROM E000NFC')));
  assert.ok(consultas.some((sql) => sql.includes('FROM E440NFC')));
});

test('membro visualiza carteira e configuração necessária, inclusive responsáveis membros', async () => {
  const painel = await json('/carteira?visao=todas');
  assert.equal(painel.status, 200);
  assert.ok(painel.corpo.itens.some((n) => n.id === notaMinha));
  assert.ok(painel.corpo.itens.some((n) => n.id === notaOutro));
  assert.ok(!painel.corpo.itens.some((n) => n.id === notaExcluida));
  const minha = await json('/carteira?visao=todas&minha=1');
  assert.equal(minha.status, 200);
  assert.ok(minha.corpo.itens.length > 0);
  assert.ok(minha.corpo.itens.every((n) => n.responsavel_id === membro));
  const cfg = await json('/carteira/configuracao');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.corpo.pessoas.some((p) => p.id === membro));
  assert.equal(cfg.corpo.caixas, undefined);
  assert.equal((await json(`/carteira/${notaMinha}/historico`)).status, 200);
  assert.ok([403, 404].includes((await json(`/carteira/${notaExcluida}/historico`)).status));
});

test('membro consulta lotes, notas e prestadores PJ da malha fina sem consultar o Senior', async () => {
  const lista = await json('/malha-fina');
  assert.equal(lista.status, 200);
  assert.ok(lista.corpo.lotes.some((l) => l.id === loteMalha));
  const painel = await json(`/malha-fina/${loteMalha}?situacao=nao_lancada&busca=Prestador`);
  assert.equal(painel.status, 200);
  assert.equal(painel.corpo.lote.id, loteMalha);
  assert.equal(painel.corpo.total, 1);
  assert.equal(painel.corpo.notas[0].id, notaMalha);
  assert.equal(painel.corpo.indicadores.valor_nao_lancado, 250);
  const pj = await json('/malha-fina/pj');
  assert.equal(pj.status, 200);
  assert.ok(pj.corpo.pj.some((p) => p.cnpj === cnpjPj));
  assert.equal((await json('/MALHA-FINA/')).status, 200);
  assert.equal((await json('/malha-fina/999999')).status, 404);
  for (const caminho of ['/malha-fina/0', '/malha-fina/-1', '/malha-fina/abc', '/malha-fina/1/extra', '/malha-fina/pj/extra']) {
    await deveNegar(caminho);
  }
});

test('membro recebe bloqueio no servidor para demais páginas e gestão da carteira', async () => {
  for (const caminho of [
    '/dashboard', '/fila', '/usuarios',
    '/empresas', '/fornecedores', '/caixas', '/emails', '/regras', '/configuracoes', '/auditoria',
    '/logs-processamento', '/financeiro', '/relatorios', '/senior', '/sefaz',
    '/integracoes', '/lancamentos', '/lancamentos/historico',
    '/filas/sugestao', '/carteira/importacoes', '/carteira/importacoes/1/exclusao',
    '/CARTEIRA/IMPORTACOES/', '/%64ocumentos', '/carteira/configuracao/extra',
    '/documentos/0', '/documentos/abc', '/documentos/1/extra', '/anexos/1/extra', '/pendentes-lancamento/extra',
    '/carteira/importacoes?visao=todas',
  ]) await deveNegar(caminho);
  for (const [method, caminho, corpo] of [
    ['POST', '/carteira/importar/previa', {}], ['POST', '/carteira/importar/1/confirmar', {}],
    ['DELETE', '/carteira/importacoes/1?versao=' + 'a'.repeat(64)],
    ['PUT', '/carteira/filial', { empfil: '1/2', usuario_id: membro }],
    ['POST', '/carteira/conferir', {}], ['PUT', '/filas', { filas: {} }],
    ['PUT', '/filas/dia', { dia: '2026-10-22', itens: [] }],
    ['PUT', '/pendentes-lancamento/motivo', { chave: '1'.repeat(44), motivo: 'outros', observacao: 'teste' }],
    ['POST', '/usuarios', { nome: 'Intruso', email: 'intruso@acesso.teste', perfil: 'admin', senha }],
    ['PUT', `/usuarios/${membro}`, { perfil: 'admin' }],
    ['POST', `/documentos/${docAtivo}/acoes`, { acao: 'APROVAR' }],
    ['PATCH', `/carteira/${notaMinha}`, { status: 'andamento' }],
    ['POST', '/malha-fina', {}], ['POST', '/malha-fina/pj', { cnpj: cnpjPj, nome: 'Alterado' }],
    ['POST', `/malha-fina/${loteMalha}/conferir`, {}],
    ['DELETE', `/malha-fina/${loteMalha}`], ['DELETE', `/malha-fina/pj/${cnpjPj}`],
  ]) await deveNegar(caminho, { method, ...(corpo === undefined ? {} : { corpo }) });
  assert.equal(get('SELECT perfil FROM usuarios WHERE id = ?', [membro]).perfil, 'membro');
  assert.equal(get('SELECT id FROM malha_fina_notas WHERE id = ?', [notaMalha]).id, notaMalha);
  assert.equal(get('SELECT nome FROM prestadores_pj WHERE cnpj = ?', [cnpjPj]).nome, 'PJ cadastrado para consulta');
});

test('membro altera andamento e bloqueio de qualquer nota ativa, sem reprogramar', async () => {
  let n = get('SELECT * FROM carteira_notas WHERE id = ?', [notaMinha]);
  const andamento = await json(`/carteira/${notaMinha}`, 'membro', {
    method: 'PUT', corpo: { status: 'andamento', versao: n.atualizado_em },
  });
  assert.equal(andamento.status, 200);
  assert.equal(andamento.corpo.status, 'andamento');
  n = get('SELECT * FROM carteira_notas WHERE id = ?', [notaMinha]);
  const bloqueio = await json(`/carteira/${notaMinha}`, 'membro', {
    method: 'PUT', corpo: { status: 'bloqueada', motivo_bloqueio: 'Aguardando pedido', versao: n.atualizado_em },
  });
  assert.equal(bloqueio.status, 200);
  assert.equal(bloqueio.corpo.motivo_bloqueio, 'Aguardando pedido');
  // Enquanto a planilha não define responsável, o membro trata qualquer nota ativa: o perfil
  // decide as telas, não a dona da nota.
  for (const id of [notaOutro, notaSemResponsavel]) {
    const outraNota = get('SELECT * FROM carteira_notas WHERE id = ?', [id]);
    const r = await json(`/carteira/${id}`, 'membro', { method: 'PUT', corpo: { status: 'andamento', versao: outraNota.atualizado_em } });
    assert.equal(r.status, 200);
    assert.equal(get('SELECT status FROM carteira_notas WHERE id = ?', [id]).status, 'andamento');
  }
  const antes = get('SELECT * FROM carteira_notas WHERE id = ?', [notaMinha]);
  for (const extra of [{ prioridade: 1 }, { data_prevista: '2026-10-30' }, { responsavel_id: outro }, { observacao: 'Mudar plano' }]) {
    await deveNegar(`/carteira/${notaMinha}`, { method: 'PUT', corpo: { status: 'pendente', versao: antes.atualizado_em, ...extra } });
    assert.deepEqual(get('SELECT * FROM carteira_notas WHERE id = ?', [notaMinha]), antes);
  }
  const conclusao = await json(`/carteira/${notaMinha}`, 'membro', { method: 'PUT', corpo: { status: 'lancada', versao: antes.atualizado_em } });
  assert.ok([400, 403].includes(conclusao.status));
  assert.equal(get('SELECT status FROM carteira_notas WHERE id = ?', [notaMinha]).status, 'bloqueada');
  const versaoAntiga = await json(`/carteira/${notaMinha}`, 'membro', { method: 'PUT', corpo: { status: 'pendente', versao: 'antiga' } });
  assert.equal(versaoAntiga.status, 409);
});

test('membro abre PDFs e XMLs de Todas as notas, inclusive documentos fora da carteira', async () => {
  for (const id of [pdfNota, boleto, pdfPonteiro, pdfSemClassificacao, pdfExcluido, pdfFora]) {
    const r = await requisitar(`/anexos/${id}/arquivo`);
    assert.equal(r.status, 200, `PDF ${id}`);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(await r.text(), /^%PDF-/);
  }
  const xmlRecebido = await requisitar(`/anexos/${xml}/arquivo`);
  assert.equal(xmlRecebido.status, 200);
  assert.match(xmlRecebido.headers.get('content-type'), /application\/xml/);
  assert.equal(await xmlRecebido.text(), '<nfe>teste</nfe>');
  assert.equal((await json('/anexos/999999/arquivo')).status, 404);
  const r = await requisitar(`/anexos/${pdfFora}/arquivo`, 'admin');
  assert.equal(r.status, 200);
  await r.arrayBuffer();
});

test('membro exporta a tabela exibida sem obter acesso aos relatórios', async () => {
  const r = await requisitar('/exportar', 'membro', {
    method: 'POST', corpo: { titulo: 'Carteira de notas', colunas: [{ titulo: 'Número' }], linhas: [['123']] },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  assert.ok((await r.arrayBuffer()).byteLength > 100);
  await deveNegar('/relatorios/produtividade');
});

test('administrador mantém acesso completo e pode criar ou alterar usuários para membro', async () => {
  for (const caminho of ['/dashboard', '/documentos', '/usuarios', '/referencias', '/empresas', '/configuracoes', '/carteira/importacoes']) {
    assert.equal((await json(caminho, 'admin')).status, 200, caminho);
  }
  const nova = await json('/usuarios', 'admin', {
    method: 'POST', corpo: { nome: 'Novo membro', email: 'novo@acesso.teste', perfil: 'membro', senha },
  });
  assert.equal(nova.status, 200);
  assert.equal(get('SELECT perfil FROM usuarios WHERE id = ?', [nova.corpo.id]).perfil, 'membro');
  const edicao = await json(`/usuarios/${nova.corpo.id}`, 'admin', { method: 'PUT', corpo: { perfil: 'fiscal' } });
  assert.equal(edicao.status, 200);
  const token = criarSessao(nova.corpo.id).token;
  assert.equal((await json('/documentos', 'admin', { token })).status, 200);
  const rebaixamento = await json(`/usuarios/${nova.corpo.id}`, 'admin', { method: 'PUT', corpo: { perfil: 'membro' } });
  assert.equal(rebaixamento.status, 200);
  assert.equal((await json('/documentos', 'membro', { token })).status, 200);
  assert.equal((await json('/dashboard', 'membro', { token })).status, 403);
  assert.equal((await json('/lancamentos', 'membro', { token })).status, 403);
  assert.equal((await json('/lancamentos/historico', 'membro', { token })).status, 403);
  assert.equal((await json('/carteira', 'membro', { token })).status, 200);
  const n = get('SELECT * FROM carteira_notas WHERE id = ?', [notaOutro]);
  const programacao = await json(`/carteira/${notaOutro}`, 'admin', { method: 'PUT', corpo: { prioridade: 1, versao: n.atualizado_em } });
  assert.equal(programacao.status, 200);
  assert.equal(programacao.corpo.prioridade, 1);
});

test('perfis anteriores conservam acesso e consulta continua sem edição', async () => {
  assert.equal((await json('/documentos', 'fiscal')).status, 200);
  assert.equal((await json('/carteira', 'consulta')).status, 200);
  const n = get('SELECT * FROM carteira_notas WHERE id = ?', [notaOutro]);
  const r = await json(`/carteira/${notaOutro}`, 'consulta', { method: 'PUT', corpo: { status: 'andamento', versao: n.atualizado_em } });
  assert.equal(r.status, 403);
});

test('membro troca a própria senha e encerra a sessão', async () => {
  const novaSenha = 'SenhaMembro456';
  const troca = await json('/auth/senha', 'membro', { method: 'POST', corpo: { atual: senha, nova: novaSenha } });
  assert.equal(troca.status, 200);
  const login = await json('/auth/login', 'membro', { method: 'POST', token: null, corpo: { email: 'membro@acesso.teste', senha: novaSenha } });
  assert.equal(login.status, 200);
  const token = login.corpo.token;
  assert.equal((await json('/auth/logout', 'membro', { method: 'POST', token })).status, 200);
  assert.equal((await json('/auth/me', 'membro', { token })).status, 401);
});
