import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carteira-filtros-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-filtros-carteira';
process.env.SENIOR_DB_TIPO = '';
const { db, insert } = await import('../src/db/index.js');
const { listarCarteira } = await import('../src/erp/carteira.js');
after(() => {
  db.close();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.match(path.basename(tmp), /^carteira-filtros-test-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ana = insert('usuarios', { nome: 'Ana', email: 'ana@filtros.teste', perfil: 'membro', senha_hash: 'teste' });
const bruno = insert('usuarios', { nome: 'Bruno', email: 'bruno@filtros.teste', perfil: 'membro', senha_hash: 'teste' });
const dia = '2026-10-22';
let sequencia = 0;
function criarNota(dados = {}) {
  const numero = String(++sequencia);
  return insert('carteira_notas', {
    identidade: `filtro:${numero}`, chave: numero.repeat(44), numero, documento: 'NF-e',
    fornecedor: 'Fornecedor geral', cnpj_fornecedor: '12345678000190', empresa: 'Matriz', empfil: '1/1',
    tomador_nome: 'Tomador Matriz', tomador_cnpj: '11222333000144', tipo_nota: 'Produto',
    prioridade: 1, responsavel_id: ana, data_original: dia, data_prevista: dia,
    criada_em: '2026-10-22T08:00:00.000Z', atualizado_em: '2026-10-22T08:00:00.000Z', ...dados,
  });
}
const a = criarNota({ fornecedor: 'Água e Serviços', tomador_cnpj: '11.222.333/0001-44' });
const b = criarNota({ empresa: 'Filial Sul', empfil: '1/2', tipo_nota: 'Serviço', prioridade: 2,
  responsavel_id: bruno, status: 'bloqueada', motivo_bloqueio: 'Sem pedido', data_prevista: '2026-10-21' });
const c = criarNota({ empresa: 'Empresa Dois', empfil: '2/1', tomador_nome: 'Outro Tomador',
  tomador_cnpj: '55666777000188', tipo_nota: 'Serviço', prioridade: 3, status: 'lancada', lancada_em: dia });
const d = criarNota({ empresa: 'Filial Dois', empfil: '2/2', tomador_nome: 'São José Comércio',
  tomador_cnpj: null, tipo_nota: 'Frete', responsavel_id: null, status: 'andamento' });
const e = criarNota({ tomador_nome: null, tomador_cnpj: null, tipo_nota: 'Energia', prioridade: 2, data_prevista: '2026-10-23' });
const f = criarNota({ empresa: 'Empresa Três', empfil: '3/3', tomador_nome: 'SAO JOSE COMERCIO',
  tomador_cnpj: '', prioridade: 3, responsavel_id: bruno, data_prevista: '2026-10-21' });
const excluida = criarNota({ empresa: 'Empresa Excluída', empfil: '9/9', tomador_nome: 'Tomador excluído',
  tomador_cnpj: '77777777000177', tipo_nota: 'Tipo excluído', excluida_em: '2026-10-22T09:00:00.000Z' });
insert('documentos', {
  tipo: 'NFE', origem_dados: 'manual', dados_extraidos: '{}', chave_acesso: '5'.repeat(44), numero: '5',
  emitente_cnpj: '12345678000190', destinatario_cnpj: '99888777000166', destinatario_nome: 'Tomador vindo da nota',
});

const painel = (filtros = {}, usuarioId = ana) => listarCarteira({ dia, visao: 'todas', ...filtros }, usuarioId);
const ids = (resultado) => resultado.itens.map((n) => n.id).sort((x, y) => x - y);
const chaves = (opcoes) => opcoes.map((o) => o.chave).sort();
const zerados = { programadas: 0, concluidas_plano: 0, restantes: 0, atrasadas: 0, bloqueadas: 0, sem_responsavel: 0, lancadas_dia: 0 };

test('empresa, filial, tipo, responsável e prioridade filtram as respectivas notas', () => {
  assert.deepEqual(ids(painel()), [a, b, c, d, e, f]);
  assert.ok(!ids(painel()).includes(excluida));
  for (const [filtro, esperado] of [
    [{ empresa: '1' }, [a, b, e]], [{ empresa: '2' }, [c, d]],
    [{ empfil: '1/1' }, [a, e]], [{ empfil: '1/2' }, [b]],
    [{ tipo_nota: 'Serviço' }, [b, c]], [{ tipo_nota: 'Frete' }, [d]],
    [{ responsavel: String(ana) }, [a, c, e]], [{ responsavel: 'sem' }, [d]],
    [{ prioridade: '1' }, [a, d]], [{ prioridade: '2' }, [b, e]], [{ prioridade: '3' }, [c, f]],
  ]) assert.deepEqual(ids(painel(filtro)), esperado, JSON.stringify(filtro));
});

test('tomador aceita CNPJ formatado e nome normalizado e resolve dados da nota vinculada', () => {
  assert.deepEqual(ids(painel({ tomador: '11222333000144' })), [a, b]);
  assert.deepEqual(ids(painel({ tomador: '11.222.333/0001-44' })), [a, b]);
  assert.deepEqual(ids(painel({ tomador: 'nome:sao jose comercio' })), [d, f]);
  const vinculado = painel({ tomador: '99888777000166' });
  assert.deepEqual(ids(vinculado), [e]);
  assert.equal(vinculado.itens[0].tomador_nome, 'Tomador vindo da nota');
  assert.equal(vinculado.itens[0].tomador_cnpj, '99888777000166');
  assert.deepEqual(ids(painel({ tomador: '99888777000166', busca: 'vindo da nota' })), [e]);
});

test('filtros combinados usam interseção e atualizam indicadores e resumos', () => {
  const r = painel({ empresa: '1', empfil: '1/2', tomador: '11222333000144', tipo_nota: 'Serviço',
    responsavel: String(bruno), prioridade: '2' });
  assert.deepEqual(ids(r), [b]);
  assert.deepEqual(r.indicadores, { ...zerados, atrasadas: 1, bloqueadas: 1 });
  assert.equal(r.por_pessoa.length, 1);
  assert.equal(r.por_pessoa[0].chave, bruno);
  assert.equal(r.por_pessoa[0].total, 1);
  assert.equal(r.por_pessoa[0].bloqueadas, 1);
  assert.equal(r.por_filial.length, 1);
  assert.equal(r.por_filial[0].chave, '1/2');
  assert.equal(r.por_filial[0].total, 1);
  assert.equal(r.por_filial[0].atrasadas, 1);
  const nenhum = painel({ empresa: '1', empfil: '2/2' });
  assert.deepEqual(nenhum.itens, []);
  assert.deepEqual(nenhum.indicadores, zerados);
  assert.deepEqual(nenhum.por_pessoa, []);
  assert.deepEqual(nenhum.por_filial, []);
});

test('novos filtros convivem com minha fila, status, busca e visões existentes', () => {
  const minha = painel({ minha: '1', empresa: '1', prioridade: '1', status: 'pendente', busca: 'agua' });
  assert.deepEqual(ids(minha), [a]);
  assert.equal(minha.indicadores.programadas, 1);
  assert.equal(minha.indicadores.restantes, 1);
  assert.equal(minha.por_pessoa.length, 1);
  assert.equal(minha.por_pessoa[0].chave, ana);
  const concluida = painel({ status: 'lancada', tipo_nota: 'Serviço' });
  assert.deepEqual(ids(concluida), [c]);
  assert.deepEqual(concluida.indicadores, { ...zerados, programadas: 1, concluidas_plano: 1, lancadas_dia: 1 });
  assert.equal(concluida.por_pessoa[0].total, 1);
  assert.equal(concluida.por_pessoa[0].lancadas, 1);
  assert.deepEqual(ids(painel({ empresa: '2', visao: 'historico' })), [c]);
  assert.deepEqual(ids(painel({ empresa: '2', visao: 'carteira' })), [d]);
  // A visão do dia também traz o que já venceu, mesmo com prazo depois do dia escolhido:
  // e vence em 2026-10-23 e o painel olha 2026-10-22, mas o prazo já passou.
  assert.deepEqual(ids(painel({ empresa: '1', visao: 'hoje' })), [a, b, e]);
});

test('opções de seleção vêm da carteira ativa completa e preservam o formato antigo das filiais', () => {
  const completo = painel();
  const opcoes = completo.filtros;
  assert.deepEqual(chaves(opcoes.empresas), ['1', '2', '3']);
  assert.equal(opcoes.empresas.find((o) => o.chave === '1').rotulo, 'Empresa 1');
  assert.deepEqual(chaves(opcoes.filiais), ['1/1', '1/2', '2/1', '2/2', '3/3']);
  assert.ok(opcoes.filiais.every((o) => o.empresa === o.chave.split('/')[0] && o.rotulo));
  assert.deepEqual(chaves(opcoes.tipos_nota), ['Energia', 'Frete', 'Produto', 'Serviço']);
  assert.deepEqual(chaves(opcoes.tomadores), ['11222333000144', '55666777000188', '99888777000166', 'nome:sao jose comercio']);
  const enriquecido = opcoes.tomadores.find((o) => o.chave === '99888777000166');
  assert.equal(enriquecido.cnpj, '99888777000166');
  assert.match(enriquecido.rotulo, /Tomador vindo da nota/);
  assert.ok(opcoes.tomadores.every((o) => o.rotulo));
  assert.ok(completo.filiais.some((o) => o.empfil === '1/2' && o.empresa === 'Filial Sul'));
  assert.ok(!completo.filiais.some((o) => o.empfil === '9/9'));
  assert.deepEqual(painel({ empresa: '1', prioridade: '1', visao: 'hoje' }).filtros, opcoes);
  assert.deepEqual(painel({ empresa: '9', status: 'bloqueada' }).filtros, opcoes);
});
