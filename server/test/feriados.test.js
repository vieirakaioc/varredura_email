import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarioFeriados, feriadosNacionais, pascoa } from '../src/erp/feriados.js';

test('Páscoa confere com as datas publicadas', () => {
  assert.equal(pascoa(2024), '2024-03-31');
  assert.equal(pascoa(2025), '2025-04-20');
  assert.equal(pascoa(2026), '2026-04-05');
  assert.equal(pascoa(2027), '2027-03-28');
});

test('feriados móveis saem da Páscoa e os fixos vêm por lei', () => {
  const f = feriadosNacionais(2026);
  assert.equal(f.get('2026-04-03').nome, 'Sexta-feira Santa');   // Páscoa 05/04 − 2
  assert.equal(f.get('2026-02-17').nome, 'Carnaval (terça)');    // Páscoa − 47
  assert.equal(f.get('2026-06-04').nome, 'Corpus Christi');      // Páscoa + 60
  assert.equal(f.get('2026-09-07').nome, 'Independência');
  assert.equal(f.get('2026-11-20').nome, 'Consciência Negra');
  assert.equal(f.get('2026-04-03').tipo, 'nacional');
  assert.equal(f.get('2026-02-17').tipo, 'facultativo');
});

test('feriado da empresa entra e data ignorada volta a ser dia útil', () => {
  const c = calendarioFeriados({
    extras: { '2026-06-24': 'São João' },
    ignorados: ['2026-06-04'],   // a empresa trabalha no Corpus Christi
  });
  assert.equal(c.feriadoEm('2026-06-24').nome, 'São João');
  assert.equal(c.feriadoEm('2026-06-24').tipo, 'empresa');
  assert.equal(c.feriadoEm('2026-06-04'), null);
  assert.equal(c.feriadoEm('2026-09-07').nome, 'Independência');
  assert.equal(c.feriadoEm('2026-09-08'), null);
});

test('lista vazia e datas inválidas não quebram o calendário', () => {
  const c = calendarioFeriados();
  assert.equal(c.feriadoEm('2026-01-01').nome, 'Confraternização Universal');
  assert.equal(c.feriadoEm('não é data'), null);
  assert.equal(c.feriadoEm(null), null);
  const sujo = calendarioFeriados({ extras: ['2026-13-99', '', null, '2026-07-10'], ignorados: ['x'] });
  assert.deepEqual(sujo.extras.map((e) => e.dia), ['2026-07-10']);
  assert.equal(sujo.feriadoEm('2026-07-10').nome, 'Feriado da empresa');
});
