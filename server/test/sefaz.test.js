import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretar, CANCELAMENTOS } from '../src/fiscal/sefaz/dfe.js';

const CHAVE = '52260935258684000100550010000080521351089530';

test('resumo de NF-e destinada ao CNPJ', () => {
  const xml = `<resNFe versao="1.01"><chNFe>${CHAVE}</chNFe><CNPJ>35258684000100</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome>
    <dhEmi>2026-09-20T10:15:00-03:00</dhEmi><vNF>1234.56</vNF><nProt>152260000123456</nProt></resNFe>`;
  const r = interpretar(xml, '05094194000155', '000000000000101');
  assert.equal(r.tipo, 'resumo');
  assert.equal(r.chave, CHAVE);
  assert.equal(r.emitente_nome, 'FORNECEDOR TESTE LTDA');
  assert.equal(r.valor, 1234.56);
  assert.equal(r.data_emissao, '2026-09-20');
});

test('evento de cancelamento traz tipo, data e justificativa', () => {
  const xml = `<procEventoNFe versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><evento><infEvento Id="ID1101112">
    <chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento><dhEvento>2026-09-25T14:02:00-03:00</dhEvento>
    <detEvento><xJust>Erro na emissao do documento</xJust></detEvento></infEvento></evento>
    <retEvento><infEvento><nProt>352260000999888</nProt></infEvento></retEvento></procEventoNFe>`;
  const r = interpretar(xml, '05094194000155', '000000000000102');
  assert.equal(r.tipo, 'evento');
  assert.equal(r.tp_evento, '110111');
  assert.ok(CANCELAMENTOS.includes(r.tp_evento));
  assert.equal(r.descricao, 'Cancelamento');
  assert.equal(r.data_evento, '2026-09-25');
  assert.equal(r.justificativa, 'Erro na emissao do documento');
  assert.equal(r.protocolo, '352260000999888');
});

test('ciência da operação não é tratada como cancelamento', () => {
  const xml = `<resEvento versao="1.01"><chNFe>${CHAVE}</chNFe><tpEvento>210210</tpEvento><dhEvento>2026-09-26T08:00:00-03:00</dhEvento></resEvento>`;
  const r = interpretar(xml, '05094194000155', '000000000000103');
  assert.equal(r.descricao, 'Ciência da operação');
  assert.ok(!CANCELAMENTOS.includes(r.tp_evento));
});

test('NF-e completa (nfeProc) devolve número, série e valor', () => {
  const xml = `<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${CHAVE}">
    <ide><nNF>8052</nNF><serie>1</serie><dhEmi>2026-09-18T09:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>35258684000100</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome></emit>
    <total><ICMSTot><vNF>999.90</vNF></ICMSTot></total></infNFe></NFe>
    <protNFe><infProt><chNFe>${CHAVE}</chNFe><nProt>152260000123457</nProt></infProt></protNFe></nfeProc>`;
  const r = interpretar(xml, '05094194000155', '000000000000104');
  assert.equal(r.chave, CHAVE);
  assert.equal(r.numero, '8052');
  assert.equal(r.serie, '1');
  assert.equal(r.valor, 999.9);
});
