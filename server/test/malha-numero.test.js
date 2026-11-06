import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'malha-numero-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste-malha-numero';
process.env.SENIOR_DB_TIPO = '';
const { db } = await import('../src/db/index.js');
const { numerosDoCasamento } = await import('../src/erp/malhafina.js');
process.on('exit', () => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('número simples casa por ele mesmo, sem zeros à esquerda', () => {
  assert.deepEqual(numerosDoCasamento('838', '2026'), ['838']);
  assert.deepEqual(numerosDoCasamento('0838', '2026'), ['838']);
  assert.deepEqual(numerosDoCasamento('12.345', '2026'), ['12345']);
});

test('prefixo de ano vira também o número curto, na ordem certa', () => {
  // o literal vem primeiro: se o Senior tiver o número cheio, é ele que vale
  assert.deepEqual(numerosDoCasamento('202600000000838', '2026'), ['202600000000838', '838']);
  assert.deepEqual(numerosDoCasamento('2026000000061', '2026'), ['2026000000061', '61']);
  assert.deepEqual(numerosDoCasamento('20260000012', '2026'), ['20260000012', '12']);
});

test('o prefixo só sai quando o ano confere com o da nota', () => {
  // nota de 2024 com número que começa em 2026: tirar o prefixo casaria com a nota 12 errada
  assert.deepEqual(numerosDoCasamento('20260000012', '2024'), ['20260000012']);
  assert.deepEqual(numerosDoCasamento('202600000000838', null), ['202600000000838', '838']);
});

test('o que não é desse padrão fica intocado', () => {
  assert.deepEqual(numerosDoCasamento('19990000123', '1999'), ['19990000123']);   // não começa com 20
  assert.deepEqual(numerosDoCasamento('20260123', '2026'), ['20260123']);         // um zero só: não é enchimento
  assert.deepEqual(numerosDoCasamento('', '2026'), []);
  assert.deepEqual(numerosDoCasamento(null, '2026'), []);
  assert.deepEqual(numerosDoCasamento('abc', '2026'), []);
});

// ---------------------------------------------------------------- escolha entre entradas iguais
const { escolherEntrada } = await import('../src/erp/malhafina.js');
const entrada = (d) => ({ CODSNF: 'NFS', SITNFC: '2', VLRLIQ: 100, ...d });

test('entre NFE e NFS com o mesmo número, a nota de serviço ganha', () => {
  // caso real: COSTA TORNEARIA nº 196 na mesma filial, NFE de R$ 466,50 e NFS de R$ 320,00
  const nota = { valor: 320, retencoes_planilha: 0 };
  const nfe = entrada({ CODSNF: 'NFE', VLRLIQ: 466.5 });
  const nfs = entrada({ CODSNF: 'NFS', VLRLIQ: 320 });
  const r = escolherEntrada(nota, [nfe, nfs]);   // a NFE vem primeiro, como vinha do banco
  assert.equal(r.entrada, nfs);
  assert.deepEqual(r.empatadas, [nfs]);          // sem empate: não há dúvida a levantar
});

test('empatando na espécie, o valor da planilha desempata', () => {
  const nota = { valor: 320, retencoes_planilha: 0 };
  const outra = entrada({ VLRLIQ: 999 });
  const certa = entrada({ VLRLIQ: 320 });
  assert.equal(escolherEntrada(nota, [outra, certa]).entrada, certa);
});

test('duas entradas igualmente prováveis continuam em empate', () => {
  const nota = { valor: 320, retencoes_planilha: 0 };
  const a = entrada({ VLRLIQ: 500 });
  const b = entrada({ VLRLIQ: 900 });
  assert.equal(escolherEntrada(nota, [a, b]).empatadas.length, 2);
});

test('cancelada só é escolhida quando não há nenhuma ativa', () => {
  const nota = { valor: 320, retencoes_planilha: 0 };
  const cancelada = entrada({ SITNFC: '3', VLRLIQ: 320 });
  const ativa = entrada({ VLRLIQ: 999 });
  assert.equal(escolherEntrada(nota, [cancelada, ativa]).entrada, ativa);
  assert.equal(escolherEntrada(nota, [cancelada]).entrada, cancelada);
  assert.equal(escolherEntrada(nota, []).entrada, null);
});

// ---------------------------------------------------------------- datas dos alertas
const { dataBr } = await import('../src/erp/malhafina.js');

test('data do alerta sai em dia/mês/ano', () => {
  assert.equal(dataBr('2026-09-11'), '11/09/2026');
  assert.equal(dataBr('2026-10-16'), '16/10/2026');
  // o que não for data ISO passa inteiro, sem virar 'undefined' no meio da frase
  assert.equal(dataBr('2026-10'), '2026-10');
  assert.equal(dataBr(null), null);
  assert.equal(dataBr(undefined), undefined);
});
