import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carteira-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-carteira';
const { db, all, get, insert, run } = await import('../src/db/index.js');
const C = await import('../src/erp/carteira.js');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const admin = insert('usuarios', { nome: 'Gestor', email: 'gestor@teste', senha_hash: 'teste', perfil: 'admin' });
const pessoa = insert('usuarios', { nome: 'Fiscal', email: 'fiscal@teste', senha_hash: 'teste', perfil: 'fiscal' });
const outra = insert('usuarios', { nome: 'Outra pessoa', email: 'outra@teste', senha_hash: 'teste', perfil: 'fiscal' });
const chave = '1'.repeat(44);
const base = { Documento: 'NF-e', 'Número': '123', 'Chave de acesso': chave, Fornecedor: 'Fornecedor', 'CNPJ fornecedor': '12.345.678/0001-90', 'Emp/Fil': '1/2',
  'Empresa destinatária': 'Matriz', Valor: 150, 'Emissão': '20/10/2026', 'Recebida em': '21/10/2026' };
async function planilha(linhas, prefixo = false) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Pendentes');
  if (prefixo) ws.addRow(['Relatório']);
  const cab = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  ws.addRow(cab);
  for (const l of linhas) ws.addRow(cab.map((c) => l[c] ?? null));
  return wb.xlsx.writeBuffer();
}
const previa = async (linhas, dia = '2026-10-22') => C.prepararImportacaoCarteira({ buffer: await planilha(linhas), arquivo: 'pendentes.xlsx', dia, usuarioId: admin });
const importar = async (linhas, dia) => { const r = await previa(linhas, dia); C.confirmarImportacaoCarteira(r.id, admin); return r; };
const limpar = () => { run('DELETE FROM carteira_historico'); run('DELETE FROM carteira_notas'); run('DELETE FROM carteira_importacoes'); run('DELETE FROM carteira_filiais'); };

test('prévia não cria notas; confirmação atribui filial, aceita exportação e é idempotente', async () => {
  limpar(); C.salvarFilialCarteira({ empfil: '01/02', usuario_id: pessoa });
  const r = await previa([{ ...base, Prioridade: 'Alta', 'Data prevista': new Date('2026-10-22T00:00:00Z') }]);
  assert.equal(r.resumo.novas, 1); assert.equal(all('SELECT * FROM carteira_notas').length, 0);
  C.confirmarImportacaoCarteira(r.id, admin);
  C.confirmarImportacaoCarteira(r.id, admin);
  const n = get('SELECT * FROM carteira_notas');
  assert.equal(n.responsavel_id, pessoa); assert.equal(n.data_original, '2026-10-22'); assert.equal(n.prioridade, 2);
  assert.equal(C.historicoCarteira(n.id).length, 1);
  const repetida = await importar([{ ...base, Prioridade: 'Alta', 'Data prevista': '22/10/2026' }]);
  assert.equal(repetida.resumo.sem_alteracao, 1); assert.equal(all('SELECT * FROM carteira_notas').length, 1);
});

test('importações acumulam e preservam andamento, prazo original e programação em branco', async () => {
  limpar(); C.salvarFilialCarteira({ empfil: '1/2', usuario_id: pessoa });
  await importar([{ ...base, Prioridade: 'Urgente', 'Observação da programação': 'Primeiro' }]);
  const n = get('SELECT * FROM carteira_notas');
  C.alterarNotaCarteira(n.id, { status: 'andamento', versao: n.atualizado_em }, pessoa);
  await importar([{ ...base, 'Data prevista': '23/10/2026', 'Prioridade': '', 'Responsável da programação': 'outra@teste' }]);
  await importar([{ ...base, 'Chave de acesso': '2'.repeat(44), 'Número': '124' }], '2026-10-23');
  const atual = get('SELECT * FROM carteira_notas WHERE id = ?', [n.id]);
  assert.equal(atual.status, 'andamento'); assert.equal(atual.data_original, '2026-10-22'); assert.equal(atual.data_prevista, '2026-10-23');
  assert.equal(atual.prioridade, 1); assert.equal(atual.observacao, 'Primeiro'); assert.equal(atual.responsavel_id, outra);
  assert.equal(all('SELECT * FROM carteira_notas').length, 2); assert.equal(C.historicoCarteira(n.id).length, 3);
});

test('duplicadas, datas impossíveis e chaves numéricas bloqueiam o lote inteiro', async () => {
  limpar();
  for (const linhas of [[base, base], [{ ...base, 'Data prevista': '31/02/2026' }], [{ ...base, 'Chave de acesso': 1e43 }], [{ ...base, Prioridade: 'Muito alta' }]]) {
    const r = await previa(linhas);
    assert.ok(r.resumo.erros > 0); assert.throws(() => C.confirmarImportacaoCarteira(r.id, admin));
  }
  assert.equal(all('SELECT * FROM carteira_notas').length, 0);
});

test('NFS-e sem chave é distinta por filial e a ordem das colunas não importa', async () => {
  limpar();
  const n = { ...base, Documento: 'NFS-e', 'Chave de acesso': '', 'Número': '1001' };
  const buffer = await planilha([n, { ...n, 'Emp/Fil': '1/3' }], true);
  const r = await C.prepararImportacaoCarteira({ buffer, arquivo: 'nfse.xlsx', usuarioId: admin, dia: '2026-10-22' });
  assert.equal(r.resumo.novas, 2); C.confirmarImportacaoCarteira(r.id, admin);
  assert.equal(all('SELECT * FROM carteira_notas').length, 2);
});

test('prévia detecta mudança concorrente e não importa com dados desatualizados', async () => {
  limpar();
  const r = await previa([base]);
  C.salvarFilialCarteira({ empfil: '1/2', usuario_id: pessoa });
  assert.throws(() => C.confirmarImportacaoCarteira(r.id, admin), /mudaram/);
  assert.equal(all('SELECT * FROM carteira_notas').length, 0);
});

test('bloqueio exige motivo, versão impede sobrescrita e conclusão manual é recusada', async () => {
  limpar(); await importar([base]);
  const n = get('SELECT * FROM carteira_notas');
  assert.throws(() => C.alterarNotaCarteira(n.id, { status: 'bloqueada', versao: n.atualizado_em }, pessoa), /motivo/);
  assert.throws(() => C.alterarNotaCarteira(n.id, { status: 'lancada', versao: n.atualizado_em }, pessoa), /Senior/);
  const novo = C.alterarNotaCarteira(n.id, { status: 'bloqueada', motivo_bloqueio: 'Sem pedido', versao: n.atualizado_em }, pessoa);
  assert.equal(novo.motivo_bloqueio, 'Sem pedido');
  assert.throws(() => C.alterarNotaCarteira(n.id, { prioridade: 2, versao: 'desatualizada' }, pessoa), /alterada/);
});

test('Senior confirma só nota fechada da filial correta; cancelamento reabre e reimportar não reabre concluída', async () => {
  limpar(); await importar([base]);
  const n = get('SELECT * FROM carteira_notas');
  const entrada = { CODEMP: 1, CODFIL: 2, NUMNFC: 123, CODSNF: 'NFE', CHVNEL: chave, SITNFC: 2, DATGER: new Date('2026-10-22T00:00:00Z') };
  assert.equal(C.aplicarConferenciaCarteira([n], [{ ...entrada, CODFIL: 3 }], admin).concluidas, 0);
  assert.equal(C.aplicarConferenciaCarteira([n], [{ ...entrada, SITNFC: 1 }], admin).concluidas, 0);
  assert.equal(C.aplicarConferenciaCarteira([n], [entrada], admin).concluidas, 1);
  const r = await importar([{ ...base, 'Data prevista': '29/10/2026' }]);
  assert.equal(r.resumo.concluidas, 1);
  assert.equal(get('SELECT * FROM carteira_notas').data_prevista, '2026-10-22');
  assert.equal(C.aplicarConferenciaCarteira([n], [{ ...entrada, SITNFC: 3 }], admin).reabertas, 1);
  assert.equal(get('SELECT * FROM carteira_notas').status, 'pendente');
  assert.equal(C.historicoCarteira(n.id).length, 3);
});

test('casamento sem chave ambíguo não conclui e falta na consulta não conclui', async () => {
  limpar(); await importar([{ ...base, Documento: 'NFS-e', 'Chave de acesso': '' }]);
  const n = get('SELECT * FROM carteira_notas');
  const e = { CODEMP: 1, CODFIL: 2, NUMNFC: 123, CODSNF: 'S1', CNPJFOR: '12345678000190', SITNFC: 2, DATGER: '2026-10-22' };
  const r = C.aplicarConferenciaCarteira([n], [e, { ...e, CODSNF: 'S2' }], admin);
  assert.equal(r.ambiguas, 1); assert.equal(r.concluidas, 0);
  assert.equal(C.aplicarConferenciaCarteira([n], [], admin).concluidas, 0);
});

test('gestão à vista distingue plano, carteira lançada no dia, atrasos, futuras e minha fila', async () => {
  limpar(); C.salvarFilialCarteira({ empfil: '1/2', usuario_id: pessoa });
  await importar([base], '2026-10-21');
  await importar([{ ...base, 'Chave de acesso': '2'.repeat(44), 'Número': '124' }], '2026-10-22');
  await importar([{ ...base, 'Chave de acesso': '3'.repeat(44), 'Número': '125', 'Responsável da programação': 'outra@teste' }], '2026-10-23');
  const n = get('SELECT * FROM carteira_notas WHERE numero = ?', ['123']);
  C.aplicarConferenciaCarteira([n], [{ CODEMP: 1, CODFIL: 2, NUMNFC: 123, CODSNF: 'NFE', CHVNEL: chave, SITNFC: 2, DATGER: '2026-10-22' }], admin);
  const r = C.listarCarteira({ dia: '2026-10-22', minha: '1' }, pessoa);
  assert.equal(r.indicadores.programadas, 1); assert.equal(r.indicadores.concluidas_plano, 0); assert.equal(r.indicadores.lancadas_dia, 1);
  assert.equal(r.itens.length, 1); assert.equal(r.itens[0].numero, '124');
  assert.equal(C.listarCarteira({ dia: '2026-10-22', visao: 'carteira' }, admin).itens.length, 2);
  assert.equal(C.listarCarteira({ dia: '2026-10-22', visao: 'historico' }, admin).itens.length, 1);
});

test('conferência sem mudança não invalida prévia e cada edição tem versão distinta', async () => {
  limpar(); await importar([base]);
  const n = get('SELECT * FROM carteira_notas');
  const r = await previa([{ ...base, Prioridade: 'Alta' }]);
  C.aplicarConferenciaCarteira([n], [], admin);
  C.confirmarImportacaoCarteira(r.id, admin);
  const atual = get('SELECT * FROM carteira_notas');
  assert.notEqual(atual.atualizado_em, n.atualizado_em);
  const editada = C.alterarNotaCarteira(n.id, { versao: atual.atualizado_em, status: 'andamento' }, pessoa);
  assert.notEqual(editada.atualizado_em, atual.atualizado_em);
  assert.throws(() => C.alterarNotaCarteira(n.id, { versao: atual.atualizado_em, prioridade: 1 }, pessoa), /alterada/);
});

test('rotas autenticadas: consulta só visualiza; fiscal importa e exportação é reimportável', async () => {
  limpar();
  const express = (await import('express')).default;
  const { autenticar, criarSessao } = await import('../src/auth.js');
  const { rotasErpAdmin } = await import('../src/rotas/erp.js');
  const { rotasRelatorios } = await import('../src/rotas/relatorios.js');
  const consulta = insert('usuarios', { nome: 'Consulta', email: 'consulta@teste', senha_hash: 'teste', perfil: 'consulta' });
  const tokens = { consulta: criarSessao(consulta).token, fiscal: criarSessao(pessoa).token };
  const app = express(); app.use(express.json()); app.use('/api', autenticar, rotasErpAdmin, rotasRelatorios);
  app.use((e, req, res, next) => res.status(e.status || 500).json({ erro: e.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const req = (caminho, perfil = 'fiscal', op = {}) => fetch(url + caminho, { ...op, headers: { Authorization: `Bearer ${tokens[perfil]}`, ...op.headers } });
  try {
    assert.equal((await fetch(url + '/carteira')).status, 401);
    assert.equal((await req('/carteira', 'consulta')).status, 200);
    assert.equal((await req('/carteira/filial', 'consulta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empfil: '1/2', usuario_id: pessoa }) })).status, 403);
    const form = new FormData(); form.append('arquivo', new Blob([await planilha([base])]), 'pendentes.xlsx'); form.append('dia', '2026-10-22');
    const previewResponse = await req('/carteira/importar/previa', 'fiscal', { method: 'POST', body: form });
    assert.equal(previewResponse.status, 200); const r = await previewResponse.json();
    assert.equal((await req(`/carteira/importar/${r.id}/confirmar`, 'consulta', { method: 'POST' })).status, 403);
    assert.equal((await req(`/carteira/importar/${r.id}/confirmar`, 'fiscal', { method: 'POST' })).status, 200);
    const lista = await (await req('/carteira?visao=todas')).json(); assert.equal(lista.itens.length, 1);
    const n = lista.itens[0];
    const colunas = ['Documento','Número','Chave de acesso','Emp/Fil','Fornecedor','CNPJ fornecedor','Valor','Data prevista','Prioridade'];
    const exportacao = await req('/exportar', 'fiscal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      titulo: 'Programação', colunas: colunas.map((titulo) => ({ titulo, tipo: titulo === 'Data prevista' ? 'data' : titulo === 'Valor' ? 'moeda' : 'texto' })),
      linhas: [[n.documento, n.numero, n.chave, n.empfil, n.fornecedor, n.cnpj_fornecedor, n.valor, n.data_prevista, 'Normal']],
    }) });
    assert.equal(exportacao.status, 200);
    const reimportacao = await C.prepararImportacaoCarteira({ buffer: Buffer.from(await exportacao.arrayBuffer()), arquivo: 'exportacao.xlsx', dia: '2026-10-23', usuarioId: pessoa });
    assert.equal(reimportacao.resumo.erros, 0); assert.equal(reimportacao.resumo.novas, 0);
    assert.equal((await req('/carteira/importacoes', 'consulta')).status, 200);
    assert.equal((await req(`/carteira/importacoes/${r.id}/exclusao`, 'consulta')).status, 403);
    assert.equal((await req(`/carteira/importacoes/${r.id}`, 'consulta', { method: 'DELETE' })).status, 403);
    const exclusao = await (await req(`/carteira/importacoes/${r.id}/exclusao`)).json();
    assert.equal(exclusao.removidas, 1);
    const removida = await req(`/carteira/importacoes/${r.id}?versao=${exclusao.versao}`, 'fiscal', { method: 'DELETE' });
    assert.equal(removida.status, 200);
    assert.equal((await (await req('/carteira?visao=todas')).json()).itens.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('excluir teste retira notas da carteira, permite reimportar e mantém histórico', async () => {
  limpar();
  const r = await importar([base]); const n = get('SELECT * FROM carteira_notas');
  assert.equal(C.listarImportacoesCarteira().length, 1);
  assert.equal(C.previaExclusaoCarteira(r.id).removidas, 1);
  assert.equal(C.excluirImportacaoCarteira(r.id, admin).removidas, 1);
  assert.equal(C.listarCarteira({visao:'todas'}, admin).itens.length, 0);
  assert.equal(C.listarImportacoesCarteira().length, 0);
  assert.equal(C.historicoCarteira(n.id)[0].acao, 'excluir_importacao');
  assert.equal(C.excluirImportacaoCarteira(r.id, admin).ja_excluida, true);
  assert.throws(() => C.confirmarImportacaoCarteira(r.id, admin), /excluída/);
  assert.throws(() => C.alterarNotaCarteira(n.id, {status:'andamento',versao:n.atualizado_em},admin), /não encontrada/);
  // Uma conferência que começou antes da exclusão não deve trazer a nota de volta.
  assert.equal(C.aplicarConferenciaCarteira([n], [{CODEMP:1,CODFIL:2,CHVNEL:chave,SITNFC:2,DATGER:'2026-10-22'}],admin).concluidas, 0);
  const novo = await importar([base]); assert.equal(novo.resumo.novas, 1);
  assert.equal(C.listarCarteira({visao:'todas'}, admin).itens.length, 1);
  assert.equal(all('SELECT * FROM carteira_notas').length, 1);
});

test('exclusão preserva notas compartilhadas inclusive em reimportação sem alterações', async () => {
  limpar();
  const exclusivoA = {...base, 'Número':'124', 'Chave de acesso':'4'.repeat(44)};
  const exclusivoB = {...base, 'Número':'125', 'Chave de acesso':'5'.repeat(44)};
  const a = await importar([base, exclusivoA]);
  const b = await importar([base, exclusivoB]);
  const r = C.excluirImportacaoCarteira(a.id, admin);
  assert.equal(r.removidas, 1); assert.equal(r.preservadas, 1);
  assert.deepEqual(C.listarCarteira({visao:'todas'},admin).itens.map(n=>n.numero), ['123','125']);
  assert.equal(C.excluirImportacaoCarteira(b.id, admin).removidas, 2);
  assert.equal(C.listarCarteira({visao:'todas'},admin).itens.length, 0);
});

test('a confirmação da exclusão exige nova revisão quando o efeito muda', async () => {
  limpar(); const a = await importar([base]); const b = await importar([base]);
  const previa = C.previaExclusaoCarteira(a.id); assert.equal(previa.removidas,0);
  C.excluirImportacaoCarteira(b.id,admin);
  assert.throws(() => C.excluirImportacaoCarteira(a.id,admin,previa.versao), /carteira mudou/);
  assert.equal(C.listarCarteira({visao:'todas'},admin).itens.length,1);
});

const criarDoc = (dados = {}) => insert('documentos', { tipo:'NFE', origem_dados:'xml', dados_extraidos:'{}',
  numero:'123', emitente_cnpj:'12345678000190', destinatario_cnpj:'11222333000144', destinatario_nome:'Tomador Industrial Ltda', ...dados });
const criarAnexo = (doc, tipo, nome) => insert('anexos', { documento_id:doc, nome_arquivo:nome, mime:'application/pdf',
  tipo_detectado:tipo, sha256:`teste-${nome}-${doc}`, caminho:`teste/${nome}` });

test('tomador e PDFs vêm de Todas as notas e boletos recebidos depois aparecem sem reimportação', async () => {
  limpar(); await importar([base]);
  const doc = criarDoc({chave_acesso:chave});
  // Também atende ao PDF apontado pela nota mesmo antes de o anexo ter documento_id.
  const pdf = criarAnexo(null, 'danfe_pdf', 'nota.pdf');
  run('UPDATE documentos SET pdf_anexo_id = ? WHERE id = ?', [pdf,doc]);
  let n = C.listarCarteira({visao:'todas'},admin).itens[0];
  assert.equal(n.documento_id,doc); assert.equal(n.tomador_nome,'Tomador Industrial Ltda'); assert.equal(n.tomador_cnpj,'11222333000144');
  assert.deepEqual(n.pdfs_nota.map(a=>a.id),[pdf]); assert.equal(n.pdfs_boleto.length,0);
  const boleto = criarAnexo(doc,'boleto_pdf','boleto-1.pdf');
  const boleto2 = criarAnexo(doc,'boleto_pdf','boleto-2.pdf');
  n = C.listarCarteira({visao:'todas'},admin).itens[0];
  assert.deepEqual(n.pdfs_boleto.map(a=>a.id),[boleto,boleto2]);
  C.excluirImportacaoCarteira(C.listarImportacoesCarteira()[0].id,admin);
  assert.ok(get('SELECT * FROM documentos WHERE id = ?',[doc]));
  assert.ok(get('SELECT * FROM anexos WHERE id = ?',[boleto]));
});

test('NFS-e sem chave exige tomador, respeita fornecedor/série/tipo e não vincula correspondências ambíguas', async () => {
  limpar();
  const baseServico = {...base, Documento:'NFS-e', 'Número':'9001', 'Chave de acesso':'', 'CNPJ tomador':'22.333.444/0001-55', Tomador:'Tomador da planilha'};
  const doc = criarDoc({tipo:'NFSE',numero:'9001',destinatario_cnpj:'22333444000155'});
  criarAnexo(doc,'nfse_pdf','servico.pdf');
  criarDoc({tipo:'NFSE',numero:'9001',destinatario_cnpj:'99999999000199'});
  await importar([baseServico]);
  assert.equal(C.listarCarteira({visao:'todas'},admin).itens[0].documento_id,doc);
  criarDoc({tipo:'NFSE',numero:'9001',destinatario_cnpj:'22333444000155',serie:'B'});
  const ambigua = C.listarCarteira({visao:'todas'},admin).itens[0];
  assert.equal(ambigua.documento_id,null); assert.equal(ambigua.vinculo_documento,'ambiguo'); assert.equal(ambigua.pdfs_nota.length,0);
  limpar(); await importar([{...baseServico, 'CNPJ tomador':''}]);
  assert.equal(C.listarCarteira({visao:'todas'},admin).itens[0].vinculo_documento,'sem_tomador');
});

test('cadastro do Senior completa o tomador pela filial sem alterar a programação ou substituir CNPJ explícito', async () => {
  limpar();
  await importar([{...base, 'Chave de acesso':'6'.repeat(44)},
    {...base, 'Chave de acesso':'7'.repeat(44), 'Número':'124', 'CNPJ tomador':'11222333000144'},
    {...base, 'Chave de acesso':'8'.repeat(44), 'Número':'125', 'Emp/Fil':'1/3'}]);
  const antes=all('SELECT * FROM carteira_notas');
  const r=C.aplicarTomadoresCarteira([{CODEMP:1,CODFIL:2,NUMCGC:'22333444000155',NOMFIL:'Tomador da filial 2'}]);
  assert.equal(r.atualizadas,1);
  const depois=all('SELECT * FROM carteira_notas');
  assert.equal(depois[0].tomador_cnpj,'22333444000155');
  assert.equal(depois[1].tomador_cnpj,'11222333000144'); assert.equal(depois[2].tomador_cnpj,null);
  assert.equal(depois[0].data_prevista,antes[0].data_prevista); assert.equal(depois[0].prioridade,antes[0].prioridade);
  assert.equal(C.historicoCarteira(depois[0].id)[0].acao,'complementar_tomador');
  assert.equal(C.aplicarTomadoresCarteira([{CODEMP:1,CODFIL:2,NUMCGC:'22333444000155'}]).atualizadas,0);
});
