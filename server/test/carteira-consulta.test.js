import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carteira-consulta-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-consulta-carteira';
process.env.SENIOR_DB_TIPO = '';
const { db } = await import('../src/db/index.js');
const { consultaConferenciaCarteira } = await import('../src/erp/carteira.js');
after(() => {
  db.close();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.match(path.basename(tmp), /^carteira-consulta-test-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const nota = (numero, dados = {}) => ({
  empfil: '1/2', chave: '', cnpj_fornecedor: '12345678000190', numero, ...dados,
});

test('consulta aceita número municipal de 15 dígitos sem overflow nem encurtar a identidade', () => {
  const numero = '202600000001523';
  const { sql, params } = consultaConferenciaCarteira([nota(numero)], 'mssql');
  assert.equal(params.n0, numero);
  assert.equal(typeof params.n0, 'string');
  assert.match(sql, /n\.NUMNFC\s*=\s*CAST\(@n0 AS NUMERIC\(38,\s*0\)\)/i);
  assert.match(sql, /f\.CGCCPF\s*=\s*CAST\(@c0 AS NUMERIC\(14,\s*0\)\)/i);
  assert.equal(params.c0, '12345678000190');
  assert.equal(params.e0, 1);
  assert.equal(params.f0, 2);
  assert.ok(!sql.includes(numero), 'Número deve continuar sendo parâmetro, sem interpolação');
});

test('consulta preserva exatamente os 38 dígitos, inclusive acima da precisão de Number', () => {
  const numero = '98765432109876543210987654321098765432';
  const { params } = consultaConferenciaCarteira([nota(numero)], 'mssql');
  assert.equal(numero.length, 38);
  assert.equal(params.n0, numero);
  assert.equal(typeof params.n0, 'string');
});

test('número acima de 38 dígitos não casa nem impede consultar as outras notas do lote', () => {
  const { sql, params } = consultaConferenciaCarteira([
    nota('9'.repeat(39)), nota('123', { empfil: '3/4' }),
  ], 'mssql');
  assert.equal(params.n0, null);
  assert.equal(params.n1, '123');
  assert.equal(params.e1, 3);
  assert.equal(params.f1, 4);
  assert.match(sql, /CAST\(@n0 AS NUMERIC\(38,\s*0\)\)/i);
  assert.match(sql, /CAST\(@n1 AS NUMERIC\(38,\s*0\)\)/i);
  assert.match(sql, /\bOR\b/i);
  assert.ok(!sql.includes('9'.repeat(39)));
});

test('só os zeros iniciais são retirados antes de avaliar o limite de precisão', () => {
  const { params } = consultaConferenciaCarteira([
    nota(`${'0'.repeat(80)}123`), nota('000'), nota(`000${'9'.repeat(38)}`),
  ], 'mssql');
  assert.equal(params.n0, '123');
  assert.equal(params.n1, '0');
  assert.equal(params.n2, '9'.repeat(38));
});

test('identificadores inválidos ou ausentes viram parâmetro nulo sem conversão SQL arriscada', () => {
  for (const numero of [null, undefined, '', '123A', '12.3', '-123', '1e10', '123 OR 1=1']) {
    const { sql, params } = consultaConferenciaCarteira([nota(numero)], 'mssql');
    assert.equal(params.n0, null, `Número inválido: ${String(numero)}`);
    assert.match(sql, /n\.NUMNFC\s*=\s*CAST\(@n0 AS NUMERIC\(38,\s*0\)\)/i);
    assert.ok(!sql.includes('123 OR 1=1'));
  }
});

test('chave de 44 dígitos é consultada como texto íntegro e sempre na empresa e filial corretas', () => {
  const chave = '01234567890123456789012345678901234567890123';
  for (const [dialeto, prefixo] of [['mssql', '@'], ['oracle', ':']]) {
    const { sql, params } = consultaConferenciaCarteira([
      nota('9'.repeat(39), { chave, empfil: '7/19' }),
    ], dialeto);
    assert.equal(chave.length, 44);
    assert.equal(params.k0, chave);
    assert.equal(params.e0, 7);
    assert.equal(params.f0, 19);
    assert.ok(sql.includes(`n.CHVNEL = ${prefixo}k0`));
    assert.ok(sql.includes(`n.CODEMP = ${prefixo}e0`));
    assert.ok(sql.includes(`n.CODFIL = ${prefixo}f0`));
    assert.doesNotMatch(sql, /CAST\([^)]*[kK]0/);
    assert.ok(!Object.hasOwn(params, 'n0'));
    assert.ok(!sql.includes(chave));
  }
});

test('Oracle usa parâmetros nomeados e a mesma comparação numérica segura', () => {
  const { sql, params } = consultaConferenciaCarteira([nota('202600000001523')], 'oracle');
  assert.equal(params.n0, '202600000001523');
  assert.match(sql, /CAST\(:n0 AS NUMERIC\(38,\s*0\)\)/i);
  assert.match(sql, /CAST\(:c0 AS NUMERIC\(14,\s*0\)\)/i);
  assert.doesNotMatch(sql, /@[ecfnk]\d/);
});
