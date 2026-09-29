import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Banco isolado em pasta temporária (definido antes de importar os módulos).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validador-teste-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'teste';
process.env.ANTHROPIC_API_KEY = '';

const V = await import('../src/fiscal/validadores.js');
const G = await import('../src/demo/gerador.js');
const { processarXml } = await import('../src/processamento/xml.js');
const { get, all, insert } = await import('../src/db/index.js');
const { sincronizarCatalogo } = await import('../src/fiscal/motor.js');
const { processarArquivo } = await import('../src/processamento/ingestao.js');
const { aliquotaInterestadual, sugerirCfopEntrada } = await import('../src/fiscal/tabelas.js');
const { cifrar, decifrar } = await import('../src/util/cripto.js');

test('CNPJ numérico e alfanumérico', () => {
  assert.equal(V.cnpjValido('11.222.333/0001-81'), true);
  assert.equal(V.cnpjValido('11.222.333/0001-80'), false);
  assert.equal(V.cnpjValido('00000000000000'), false);
  assert.equal(V.cnpjValido('12.ABC.345/01DE-35'), true); // exemplo oficial da RFB
  assert.equal(V.cnpjValido('12.ABC.345/01DE-36'), false);
  assert.equal(V.cpfValido('529.982.247-25'), true);
});

test('chave de acesso: DV, decomposição e coerência', () => {
  const chave = V.montarChave({ cUF: 35, aamm: '2609', cnpj: '11222333000181', serie: 1, numero: 1234, codigo: 12345678 });
  assert.equal(chave.length, 44);
  assert.deepEqual(V.problemasChave(chave, { emitente_cnpj: '11222333000181', numero: '1234', serie: '1', modelo: '55', data_emissao: '2026-09-10' }), []);
  const adulterada = chave.slice(0, 43) + ((Number(chave[43]) + 1) % 10);
  assert.match(V.problemasChave(adulterada)[0], /Dígito verificador/);
  assert.match(V.problemasChave(chave, { numero: '999' }).join(), /Número na chave/);
  assert.deepEqual(V.encontrarChaves(`CHAVE DE ACESSO\n${chave.match(/.{4}/g).join(' ')}\nPROTOCOLO`), [chave]);
});

test('tabelas: alíquota interestadual e CFOP de entrada', () => {
  assert.equal(aliquotaInterestadual('SP', 'GO', '0'), 7);
  assert.equal(aliquotaInterestadual('GO', 'SP', '0'), 12);
  assert.equal(aliquotaInterestadual('SP', 'MG', '0'), 12);
  assert.equal(aliquotaInterestadual('SC', 'GO', '1'), 4);
  assert.equal(sugerirCfopEntrada('6102', { destinacao: 'revenda' }), '2102');
  assert.equal(sugerirCfopEntrada('5102', { destinacao: 'uso_consumo' }), '1556');
  assert.equal(sugerirCfopEntrada('6405', { destinacao: 'revenda' }), '2403');
  assert.equal(sugerirCfopEntrada('5202', {}), '1202');
});

test('cifra de tokens OAuth (AES-GCM)', () => {
  const c = cifrar('refresh-token-secreto');
  assert.notEqual(c, 'refresh-token-secreto');
  assert.equal(decifrar(c), 'refresh-token-secreto');
});

const EMIT = { cnpj: G.gerarCnpj('12345678'), nome: 'FORNECEDOR TESTE LTDA', ie: '123', uf: 'SP', municipio: 'Sao Paulo' };
const DEST = { cnpj: G.gerarCnpj('11222333'), nome: 'EMPRESA TESTE LTDA', ie: '456', uf: 'GO', municipio: 'Goiania' };
const item = (extra = {}) => ({ codigo: 'A1', descricao: 'PRODUTO', ncm: '73181500', unidade: 'UN', cfop: '6102', qtd: 10, vUn: 100, pICMS: 7, pIPI: 5, ...extra });

test('leitura de NF-e: cabeçalho, itens, tributos e duplicatas', () => {
  const { xml, chave } = G.xmlNFe({ emit: EMIT, dest: DEST, numero: 77, dhEmi: '2026-09-10T10:00:00-03:00', itens: [item(), item({ codigo: 'B2', qtd: 2 })], parcelas: [30, 60] });
  const r = processarXml(Buffer.from(xml));
  assert.equal(r.tipo, 'nfe_xml');
  const d = r.documento;
  assert.equal(d.chave_acesso, chave);
  assert.equal(d.numero, '77');
  assert.equal(d.itens.length, 2);
  assert.equal(d.itens[0].impostos.ICMS.cst, '00');
  assert.equal(d.itens[0].impostos.ICMS.valor, 70);
  assert.equal(d.itens[0].impostos.IPI.valor, 50);
  assert.equal(d.totais.v_prod, 1200);
  assert.equal(d.totais.v_total, 1260);
  assert.equal(d.cobranca.duplicatas.length, 2);
  assert.equal(d.cobranca.duplicatas[0].vencimento, '2026-10-10');
});

test('XML malformado é rejeitado', () => {
  assert.throws(() => processarXml(Buffer.from('<nfeProc><NFe><infNFe>')), /malformado/);
});

test('motor: NF correta sem erros; CFOP interno em operação interestadual gera erro; duplicidade', async () => {
  sincronizarCatalogo();
  insert('empresas', { razao_social: DEST.nome, cnpj: DEST.cnpj, ie: DEST.ie, uf: 'GO', regime_tributario: 'real', perfil_fiscal: 'comercio' });

  const ok = G.xmlNFe({ emit: EMIT, dest: DEST, numero: 100, dhEmi: new Date().toISOString().slice(0, 19) + '-03:00', itens: [item()] });
  const [r1] = await processarArquivo({ buffer: Buffer.from(ok.xml), nome: 'ok.xml', origem: 'upload' });
  const d1 = get('SELECT status FROM documentos WHERE id = ?', [r1.documentoId]);
  const erros1 = all("SELECT regra_codigo FROM inconsistencias WHERE documento_id = ? AND status = 'aberta' AND severidade = 'erro'", [r1.documentoId]);
  assert.deepEqual(erros1, []);
  assert.equal(d1.status, 'PENDENTE');

  const errado = G.xmlNFe({ emit: EMIT, dest: DEST, numero: 101, dhEmi: new Date().toISOString().slice(0, 19) + '-03:00', itens: [item({ cfop: '5102' })] });
  const [r2] = await processarArquivo({ buffer: Buffer.from(errado.xml), nome: 'errado.xml', origem: 'upload' });
  const regras = all("SELECT regra_codigo FROM inconsistencias WHERE documento_id = ? AND status = 'aberta'", [r2.documentoId]).map((x) => x.regra_codigo);
  assert.ok(regras.includes('CFOP_UF_OPERACAO'), regras.join());
  assert.equal(get('SELECT status FROM documentos WHERE id = ?', [r2.documentoId]).status, 'INCONSISTENTE');

  // Mesmo arquivo de novo: não cria documento, registra recebimento duplicado
  const [r3] = await processarArquivo({ buffer: Buffer.from(ok.xml), nome: 'ok-copia.xml', origem: 'upload' });
  assert.equal(r3.acao, 'duplicado');
  assert.equal(r3.documentoId, r1.documentoId);
  assert.equal(get('SELECT COUNT(*) AS n FROM documentos').n, 2);
});
