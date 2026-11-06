import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-filas-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-dashboard-filas';
process.env.SENIOR_DB_TIPO = '';
const { db } = await import('../src/db/index.js');
const { agregarProducaoDia, agregarPendenciasDashboard } = await import('../src/erp/filas.js');
after(() => {
  db.close();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.match(path.basename(tmp), /^dashboard-filas-test-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const dia = '2026-10-22';
const consultadoEm = '2026-10-22T15:00:00.000Z';
const equipes = { escritaFiscal: ['ANA', 'BRUNO', 'SUPERVISORA'], supervisao: ['SUPERVISORA'] };
const producao = (dados = {}) => agregarProducaoDia({ ...equipes, dia, ...dados });
let numeroLancamento = 0;
function lancada(dados = {}) {
  return {
    codemp: 1, codfil: 1, codfor: 100, numero: ++numeroLancamento, serie: '1',
    situacao: '2', geracao: dia, entrada: '2026-09-30', usuario: 'ANA', categoria: 'produto', ...dados,
  };
}
let numeroPendente = 0;
function pendente(dados = {}) {
  return {
    chave: String(++numeroPendente).padStart(44, '0'), origem: 'senior',
    empresa_do_grupo: true, responsavel: 'fiscal', tipo_movimento: 'entrada',
    lancada: false, nossa_saida: false, cancelada: false, categoria: 'produto',
    recebido_via_em: '2026-10-20', recebido_em: '2026-10-20', emissao: '2026-09-01', ...dados,
  };
}
const linha = (r, usuario, categoria) => r.linhas.find((l) => l.usuario === usuario && l.categoria === categoria);

test('produção conta documentos distintos pela identidade ERP e preserva fornecedores com o mesmo número', () => {
  const nota = lancada({ numero: 700 });
  const itens = [nota, { ...nota },
    { ...nota, codfor: 101 }, { ...nota, codemp: 2 },
    { ...nota, codfil: 2 }, { ...nota, serie: '2' }, { ...nota, numero: 701 }];
  const r = producao({ itens });
  assert.equal(linha(r, 'ANA', 'produto').realizado, 6);
  assert.equal(r.indicadores.realizado_time, 6);
  assert.equal(r.indicadores.realizado_total, 6);
  assert.equal(r.notas_lancadas.total, 6);
  assert.equal(r.notas_lancadas.estado, 'ok');
  assert.equal(r.composicao.find((c) => c.chave === 'produto').notas, 6);
  assert.equal(r.composicao.find((c) => c.chave === 'produto').percentual, 100);
  // Joins que repetem uma nota não podem inflar a composição ou o cumprimento.
  assert.equal(r.linhas.reduce((s, l) => s + l.realizado, 0), 6);
});

test('produção seleciona notas fechadas pela data de geração, sem usar a data de entrada', () => {
  const itens = [
    lancada({ entrada: '2026-09-01', geracao: dia }),
    lancada({ entrada: dia, geracao: '2026-10-21' }),
    lancada({ entrada: dia, geracao: '2026-10-23' }),
    lancada({ situacao: '1' }), lancada({ situacao: '3' }),
  ];
  const r = producao({ itens });
  assert.equal(r.indicadores.realizado_total, 1);
  assert.equal(linha(r, 'ANA', 'produto').realizado, 1);
});

test('produção separa pessoa e tipo e mantém supervisão fora do cumprimento fiscal', () => {
  const itens = [lancada(), lancada({ categoria: 'servico' }),
    lancada({ usuario: 'BRUNO', categoria: 'servico' }),
    lancada({ usuario: 'SUPERVISORA', categoria: 'frete' }),
    lancada({ usuario: 'INTEGRACAO', categoria: 'energia_telecom' })];
  const r = producao({ itens, combinados: [
    { usuario: 'ANA', categoria: 'produto', quantidade: 2 },
    { usuario: 'SUPERVISORA', categoria: 'frete', quantidade: 10 },
  ] });
  assert.equal(r.linhas.length, 5);
  assert.equal(linha(r, 'ANA', 'produto').equipe, 'fiscal');
  assert.equal(linha(r, 'ANA', 'servico').realizado, 1);
  assert.equal(linha(r, 'BRUNO', 'servico').realizado, 1);
  assert.equal(linha(r, 'SUPERVISORA', 'frete').equipe, 'supervisao');
  assert.equal(linha(r, 'INTEGRACAO', 'energia_telecom').equipe, 'outros');
  assert.equal(r.indicadores.realizado_time, 3);
  assert.equal(r.indicadores.realizado_total, 5);
  assert.equal(r.indicadores.compromisso, 2);
  assert.equal(r.indicadores.cumprimento, 50);
  assert.equal(r.notas_lancadas.time, 3);
  assert.equal(r.notas_lancadas.supervisao, 1);
  assert.equal(r.notas_lancadas.outros, 1);
  assert.deepEqual(Object.fromEntries(r.composicao.map((c) => [c.chave, c.notas])), {
    produto: 1, servico: 2, frete: 1, energia_telecom: 1,
  });
  assert.equal(r.composicao.find((c) => c.chave === 'servico').percentual, 40);
});

test('excesso em uma pessoa e tipo não compensa um compromisso não cumprido em outra fila', () => {
  const r = producao({
    itens: [lancada(), lancada(), lancada(), lancada(), lancada({ usuario: 'BRUNO', categoria: 'servico' })],
    combinados: [
      { usuario: 'ANA', categoria: 'produto', quantidade: 2 },
      { usuario: 'BRUNO', categoria: 'servico', quantidade: 3 },
    ],
  });
  assert.equal(linha(r, 'ANA', 'produto').realizado, 4);
  assert.equal(linha(r, 'ANA', 'produto').diferenca, 2);
  assert.equal(linha(r, 'BRUNO', 'servico').diferenca, -2);
  assert.equal(r.indicadores.compromisso, 5);
  assert.equal(r.indicadores.realizado_time, 5);
  assert.equal(r.indicadores.cumprimento, 60);
});

test('ausência de compromisso e compromisso zero não produzem porcentagens inválidas', () => {
  const sem = producao({ itens: [lancada()] });
  assert.equal(linha(sem, 'ANA', 'produto').compromisso, null);
  assert.equal(linha(sem, 'ANA', 'produto').diferenca, null);
  assert.equal(linha(sem, 'ANA', 'produto').cumprimento, null);
  assert.equal(sem.indicadores.cumprimento, null);
  const zero = producao({ itens: [lancada()], combinados: [{ usuario: 'ANA', categoria: 'produto', quantidade: 0 }] });
  assert.equal(linha(zero, 'ANA', 'produto').cumprimento, null);
  assert.equal(zero.indicadores.cumprimento, null);
});

test('consulta de produção indisponível preserva compromissos sem apresentar realizado zero', () => {
  const r = producao({ disponivel: false, combinados: [
    { usuario: 'ANA', categoria: 'servico', quantidade: 12, sugerido: 10, observacao: 'Acordado pela manhã' },
  ] });
  const l = linha(r, 'ANA', 'servico');
  assert.equal(l.compromisso, 12);
  assert.equal(l.sugerido, 10);
  assert.equal(l.observacao, 'Acordado pela manhã');
  assert.equal(l.realizado, null);
  assert.equal(l.diferenca, null);
  assert.equal(l.cumprimento, null);
  assert.equal(r.indicadores.realizado_time, null);
  assert.equal(r.indicadores.realizado_total, null);
  assert.equal(r.indicadores.cumprimento, null);
  assert.equal(r.notas_lancadas.estado, 'indisponivel');
  assert.equal(r.notas_lancadas.total, null);
  assert.equal(r.notas_lancadas.time, null);
  assert.deepEqual(r.composicao, []);
});

test('snapshot VIA inclui somente entradas fiscais ativas do grupo e deduplica a chave', () => {
  const a = pendente();
  const b = pendente({ categoria: 'servico' });
  const itens = [a, { ...a }, b,
    pendente({ cancelada: true }), pendente({ lancada: true }),
    pendente({ nossa_saida: true }), pendente({ tipo_movimento: 'saida' }),
    pendente({ empresa_do_grupo: false }), pendente({ responsavel: 'faturamento' }),
    pendente({ origem: 'contabilidade', especie_rotulo: 'NFS-e' }),
  ];
  const { pendencias, antigos } = agregarPendenciasDashboard(itens, consultadoEm);
  assert.equal(pendencias.estado, 'ok');
  assert.equal(pendencias.total, 2);
  assert.equal(pendencias.consultado_em, consultadoEm);
  assert.equal(pendencias.por_tipo.find((c) => c.chave === 'produto').qtd, 1);
  assert.equal(pendencias.por_tipo.find((c) => c.chave === 'servico').qtd, 1);
  assert.deepEqual(new Set(antigos.itens.map((i) => i.chave)), new Set([a.chave, b.chave]));
});

test('contagem da demanda usa toda a base, mesmo além do limite da listagem', () => {
  const itens = Array.from({ length: 10025 }, (_, n) => pendente({ categoria: n % 2 ? 'servico' : 'produto' }));
  const { pendencias, antigos } = agregarPendenciasDashboard(itens, consultadoEm);
  assert.equal(pendencias.total, 10025);
  assert.equal(pendencias.por_tipo.reduce((s, c) => s + c.qtd, 0), 10025);
  assert.equal(antigos.total_com_data, 10025);
  assert.equal(antigos.itens.length, 20);
});

test('antiguidade considera exclusivamente o recebimento no VIA e identifica datas sem referência válida', () => {
  const antiga = pendente({ recebido_via_em: '2026-10-01', emissao: '2020-01-01' });
  const recente = pendente({ recebido_via_em: dia, emissao: '2019-01-01' });
  const semRecebimento = pendente({ recebido_via_em: null, recebido_em: '2020-01-01', emissao: '2020-01-01', competencia: '2020-01' });
  const invalida = pendente({ recebido_via_em: '2026-02-30' });
  const futura = pendente({ recebido_via_em: '2026-10-23' });
  const { pendencias, antigos } = agregarPendenciasDashboard([recente, semRecebimento, futura, antiga, invalida], consultadoEm);
  assert.equal(pendencias.total, 5);
  assert.equal(antigos.total_com_data, 2);
  assert.equal(antigos.sem_data, 3);
  assert.deepEqual(antigos.itens.map((i) => i.chave), [antiga.chave, recente.chave]);
  assert.deepEqual(antigos.itens.map((i) => i.dias), [21, 0]);
  assert.equal(antigos.itens[0].recebido_em, '2026-10-01');
  assert.match(antigos.data_referencia, /E000NFC\.DATENT/);
});

test('demanda indisponível permanece desconhecida, enquanto uma consulta vazia resulta em zero', () => {
  const indisponivel = agregarPendenciasDashboard(null, consultadoEm);
  assert.equal(indisponivel.pendencias.estado, 'indisponivel');
  assert.equal(indisponivel.antigos.estado, 'indisponivel');
  assert.equal(indisponivel.pendencias.total, null);
  assert.equal(indisponivel.antigos.total_com_data, null);
  assert.equal(indisponivel.antigos.sem_data, null);
  const vazio = agregarPendenciasDashboard([], consultadoEm);
  assert.equal(vazio.pendencias.estado, 'ok');
  assert.equal(vazio.pendencias.total, 0);
  assert.equal(vazio.antigos.total_com_data, 0);
  assert.equal(vazio.antigos.sem_data, 0);
  assert.deepEqual(vazio.antigos.itens, []);
});
