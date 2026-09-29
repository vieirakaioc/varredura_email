import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarLinha } from '../src/erp/entradas.js';

const hist = (pares) => {
  const mapa = new Map(Object.entries(pares));
  const porTns = new Map();
  for (const [k, n] of mapa) porTns.set(k.split('|')[0], (porTns.get(k.split('|')[0]) ?? 0) + n);
  return { mapa, porTns };
};
const vazio = { mapaDepara: new Map(), hist: hist({}) };
const base = { codtns: '1653A', cfop_transacao: '1653', cfop_entrada: '1653', cfop_fornecedor: '5656', uf_fornecedor: 'GO', uf_filial: 'GO' };

test('nota coerente não gera apontamento', () => {
  assert.deepEqual(avaliarLinha(base, vazio), []);
});

test('de-para: CFOP do fornecedor fora da lista da transação é divergente', () => {
  const r = avaliarLinha({ ...base, cfop_fornecedor: '5102' }, { mapaDepara: new Map([['1653A', ['5656', '5655']]]), hist: hist({}) });
  assert.equal(r[0].tipo, 'depara');
});

test('histórico: combinação rara vira alerta; sem base suficiente não aponta', () => {
  const r = avaliarLinha({ ...base, cfop_fornecedor: '5102' }, { mapaDepara: new Map(), hist: hist({ '1653A|5656': 97, '1653A|5102': 3 }) });
  assert.equal(r[0].tipo, 'historico');
  assert.equal(avaliarLinha({ ...base, cfop_fornecedor: '5102' }, { mapaDepara: new Map(), hist: hist({ '1653A|5656': 5, '1653A|5102': 1 }) }).length, 0);
});

test('CFOP lançado diferente do CFOP da transação', () => {
  assert.equal(avaliarLinha({ ...base, cfop_entrada: '1556' }, vazio)[0].tipo, 'transacao');
});

test('CFOP × UF e prefixo do fornecedor', () => {
  assert.ok(avaliarLinha({ ...base, uf_fornecedor: 'SP' }, vazio).some((a) => a.tipo === 'uf'));
  const inter = { ...base, codtns: '2556A', cfop_transacao: '2556', cfop_entrada: '2556', cfop_fornecedor: '5102' };
  const r = avaliarLinha(inter, vazio);
  assert.ok(r.some((a) => a.tipo === 'uf') && r.some((a) => a.tipo === 'fornecedor' && a.grau === 'erro'));
  assert.deepEqual(avaliarLinha({ ...inter, cfop_fornecedor: '6102', uf_fornecedor: 'SP' }, vazio), []);
});

test('compra presencial em outra UF vira alerta; transporte (x3xx) não usa a UF do fornecedor', () => {
  const pres = avaliarLinha({ ...base, codtns: '2407A', cfop_transacao: '2407', cfop_entrada: '2407', cfop_fornecedor: '5405', uf_fornecedor: 'SP' }, vazio);
  assert.deepEqual(pres.map((a) => [a.tipo, a.grau]), [['fornecedor', 'alerta']]);
  assert.deepEqual(avaliarLinha({ ...base, codtns: '2352A', cfop_transacao: '2302', cfop_entrada: '2302', cfop_fornecedor: null, uf_fornecedor: 'MG', uf_filial: 'MG' }, vazio), []);
});
