// Carga de dados de DEMONSTRAÇÃO (fictícios). Uso: npm run seed -- --reset
// Os documentos são gerados no layout oficial e processados pelo pipeline real
// (captura -> leitura -> motor fiscal), exatamente como e-mails recebidos.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';

if (process.argv.includes('--reset')) {
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(paths.anexos, { recursive: true, force: true });
  console.log('Banco de dados e anexos apagados.');
}

const { all, get, insert, run } = await import('./index.js');
const { sincronizarCatalogo } = await import('../fiscal/motor.js');
const { processarMensagem } = await import('../captura/index.js');
const { hashSenha } = await import('../auth.js');
const { dataHoraLocal } = await import('../util/data.js');
const G = await import('../demo/gerador.js');

if (get('SELECT 1 FROM documentos LIMIT 1')) {
  console.error('O banco já possui documentos. Use "npm run seed -- --reset" para recriar a base de demonstração.');
  process.exit(1);
}
sincronizarCatalogo();
const rnd = G.aleatorio(2026);

// ------------------------------------------------------------------ usuários
const SENHA_DEMO = 'demo2026fiscal';
const usuarios = {};
for (const [chave, nome, email, perfil] of [
  ['admin', 'Administrador', 'admin@validador.local', 'admin'],
  ['joao', 'João Fiscal', 'joao.fiscal@validador.local', 'fiscal'],
  ['maria', 'Maria Fiscal', 'maria.fiscal@validador.local', 'fiscal'],
  ['consulta', 'Carla Consulta', 'consulta@validador.local', 'consulta'],
  ['auditor', 'André Auditor', 'auditor@validador.local', 'auditor'],
  ['financeiro', 'Fernanda Financeiro', 'financeiro@validador.local', 'financeiro'],
]) {
  usuarios[chave] = get('SELECT id FROM usuarios WHERE email = ?', [email])?.id
    ?? insert('usuarios', { nome, email, perfil, senha_hash: hashSenha(SENHA_DEMO) });
}

// ------------------------------------------------------------------ empresas do grupo (fictícias)
const EMP = {
  IND: { razao: 'COMELLI INDUSTRIA DEMO LTDA', fantasia: 'Comelli Indústria (demo)', cnpj: G.gerarCnpj('11222333', '0001'), ie: '101234567', uf: 'GO', municipio: 'Anapolis', regime: 'real', perfil: 'industria', caixa: 'suprimentos@grupocomelli.com.br' },
  COM: { razao: 'COMBER COMERCIO DEMO LTDA', fantasia: 'Comber Comércio (demo)', cnpj: G.gerarCnpj('44555666', '0001'), ie: '102345678', uf: 'GO', municipio: 'Goiania', regime: 'presumido', perfil: 'comercio', caixa: 'suprimentos@comber.com.br' },
  MG: { razao: 'COMELLI INDUSTRIA DEMO LTDA', fantasia: 'Comelli Filial MG (demo)', cnpj: G.gerarCnpj('11222333', '0002'), ie: '0012345670011', uf: 'MG', municipio: 'Uberlandia', regime: 'real', perfil: 'comercio', caixa: 'suprimentos@grupocomelli.com.br' },
};
for (const e of Object.values(EMP)) {
  e.id = insert('empresas', { razao_social: e.razao, nome_fantasia: e.fantasia, cnpj: e.cnpj, ie: e.ie, uf: e.uf, municipio: e.municipio, regime_tributario: e.regime, perfil_fiscal: e.perfil });
  e.nome = e.razao;
}
const caixas = {};
for (const email of config.captura.caixasPadrao) {
  caixas[email] = get('SELECT * FROM caixas_email WHERE email = ?', [email]) ?? get('SELECT * FROM caixas_email WHERE id = ?', [insert('caixas_email', { email, provedor: 'zoho' })]);
}

// ------------------------------------------------------------------ fornecedores (fictícios)
const F = {
  ACO: { nome: 'ACO FORTE DISTRIBUIDORA LTDA', base: '12345678', uf: 'SP', municipio: 'Sao Paulo', crt: '3', tipo: 'insumo', dest: 'IND', cfop: '6102', pICMS: 7, freq: 0.35, prods: [{ codigo: 'CH-3MM', descricao: 'CHAPA ACO CARBONO 3MM', ncm: '72085100', unidade: 'KG', vUn: [7.8, 9.2], qtd: [500, 3000], pIPI: 5 }, { codigo: 'TB-2P', descricao: 'TUBO ACO GALVANIZADO 2POL', ncm: '73063000', unidade: 'M', vUn: [38, 45], qtd: [50, 300], pIPI: 5 }] },
  PLA: { nome: 'PLASTICOS PARANA INDUSTRIA S.A.', base: '23456789', uf: 'PR', municipio: 'Curitiba', crt: '3', tipo: 'insumo', dest: 'IND', cfop: '6101', pICMS: 7, freq: 0.25, prods: [{ codigo: 'TP-38', descricao: 'TAMPA PLASTICA PP 38MM', ncm: '39235000', unidade: 'MIL', vUn: [85, 110], qtd: [10, 80], pIPI: 6.5 }] },
  EMB: { nome: 'GOIAS EMBALAGENS LTDA', base: '34567890', uf: 'GO', municipio: 'Aparecida de Goiania', crt: '3', tipo: 'insumo', dest: 'IND', cfop: '5101', pICMS: 19, freq: 0.3, prods: [{ codigo: 'CX-40', descricao: 'CAIXA PAPELAO ONDULADO 40X30X20', ncm: '48191000', unidade: 'UN', vUn: [2.1, 3.4], qtd: [1000, 8000] }] },
  PAP: { nome: 'PAPELARIA CENTRAL ME', base: '45678901', uf: 'GO', municipio: 'Goiania', crt: '1', tipo: 'uso_consumo', dest: 'COM', cfop: '5102', freq: 0.2, prods: [{ codigo: 'A4-500', descricao: 'PAPEL SULFITE A4 75G RESMA', ncm: '48025610', unidade: 'RS', vUn: [24, 29], qtd: [10, 60] }, { codigo: 'CAN-AZ', descricao: 'CANETA ESFEROGRAFICA AZUL CX 50', ncm: '96081000', unidade: 'CX', vUn: [38, 45], qtd: [1, 6] }] },
  PAR: { nome: 'MINAS PARAFUSOS S.A.', base: '56789012', uf: 'MG', municipio: 'Contagem', crt: '3', tipo: 'insumo', dest: 'IND', cfop: '6102', pICMS: 7, freq: 0.3, prods: [{ codigo: 'PF-M8', descricao: 'PARAFUSO SEXTAVADO M8X30 ZINCADO', ncm: '73181500', unidade: 'CT', vUn: [45, 58], qtd: [20, 200], pIPI: 5 }] },
  TEC: { nome: 'TECNOINFO COMPUTADORES LTDA', base: '67890123', uf: 'SP', municipio: 'Campinas', crt: '3', tipo: 'ativo', dest: 'COM', cfop: '6102', pICMS: 7, freq: 0.15, prods: [{ codigo: 'NB-I7', descricao: 'NOTEBOOK 15POL I7 16GB SSD512', ncm: '84713012', unidade: 'UN', vUn: [5200, 6400], qtd: [1, 5] }] },
  QUI: { nome: 'QUIMICA SUL INDUSTRIA LTDA', base: '78901234', uf: 'RS', municipio: 'Caxias do Sul', crt: '3', tipo: 'insumo', dest: 'IND', cfop: '6101', pICMS: 7, freq: 0.2, prods: [{ codigo: 'TIN-18', descricao: 'TINTA EPOXI CINZA 18L', ncm: '32089010', unidade: 'GL', vUn: [410, 520], qtd: [4, 30], pIPI: 5 }] },
  NOR: { nome: 'DISTRIBUIDORA NORDESTE ALIMENTOS LTDA', base: '89012345', uf: 'BA', municipio: 'Feira de Santana', crt: '3', tipo: 'revenda', dest: 'COM', cfop: '6102', pICMS: 12, freq: 0.25, prods: [{ codigo: 'CF-500', descricao: 'CAFE TORRADO MOIDO 500G', ncm: '09012100', unidade: 'FD', vUn: [180, 230], qtd: [10, 120] }] },
  PNE: { nome: 'AUTO PECAS CENTRO OESTE LTDA', base: '90123456', uf: 'GO', municipio: 'Goiania', crt: '3', tipo: 'uso_consumo', dest: 'COM', cfop: '5405', cst: '60', freq: 0.12, prods: [{ codigo: 'PN-275', descricao: 'PNEU 275/80 R22.5', ncm: '40112090', cest: '1600100', unidade: 'UN', vUn: [1900, 2300], qtd: [2, 8] }] },
  IMP: { nome: 'IMPORTADORA GLOBAL ELETRONICOS LTDA', base: '13579246', uf: 'SC', municipio: 'Itajai', crt: '3', tipo: 'revenda', dest: 'COM', cfop: '6102', pICMS: 4, origem: '1', freq: 0.2, prods: [{ codigo: 'FT-12V', descricao: 'FONTE CHAVEADA 12V 10A', ncm: '85044090', unidade: 'UN', vUn: [48, 62], qtd: [50, 400], pIPI: 15 }] },
};
for (const [k, f] of Object.entries(F)) {
  f.cnpj = G.gerarCnpj(f.base); f.ie = String(100000000 + Number(f.base.slice(0, 6))); f.numero = 1000 + rnd.int(0, 8000); f.chave = k;
  f.email = `nfe@${f.nome.toLowerCase().split(' ')[0].normalize('NFD').replace(/[^a-z]/g, '')}.com.br`;
}
const TRANSP = { nome: 'TRANSPORTES PAULISTA LTDA', cnpj: G.gerarCnpj('24681357'), ie: '111222333444', uf: 'SP', municipio: 'Guarulhos', numero: 5000, email: 'cte@transpaulista.com.br' };
const SERV = [
  { nome: 'ALFA CONSULTORIA CONTABIL LTDA', cnpj: G.gerarCnpj('11335577'), uf: 'GO', aliquota: 5, desc: 'Consultoria tributaria mensal - competencia', valor: [3500, 4800], item: '17.19', numero: 300, email: 'financeiro@alfaconsultoria.com.br', dest: 'IND' },
  { nome: 'BETA MANUTENCAO INDUSTRIAL LTDA', cnpj: G.gerarCnpj('22446688'), uf: 'GO', aliquota: 3, desc: 'Manutencao preventiva de equipamentos industriais', valor: [1800, 9500], item: '14.01', numero: 800, email: 'nfse@betamanutencao.com.br', dest: 'IND' },
];
const CLIENTE = { nome: 'SUPERMERCADO BOA COMPRA LTDA', cnpj: G.gerarCnpj('31415926'), ie: '109876543', uf: 'GO', municipio: 'Goiania', email: 'fiscal@boacompra.com.br' };

// ------------------------------------------------------------------ utilitários de data
const HOJE = new Date();
const dia = (diasAtras, hora = rnd.int(7, 18), min = rnd.int(0, 59)) => {
  const d = new Date(HOJE); d.setDate(d.getDate() - diasAtras); d.setHours(hora, min, rnd.int(0, 59), 0); return d;
};
const dhEmi = (d, horasAntes = rnd.int(2, 40)) => {
  const e = new Date(d.getTime() - horasAntes * 3600000);
  return `${dataHoraLocal(e).replace(' ', 'T')}-03:00`;
};

// ------------------------------------------------------------------ envio (simula a caixa de e-mail)
let seq = 0;
async function enviarEmail({ caixa, de, nomeDe, assunto, data, anexos, messageId }) {
  seq++;
  const cx = caixas[caixa];
  return processarMensagem(cx, {
    idProvedor: `demo-${seq}`, internetMessageId: messageId ?? `<demo-${seq}@${de.split('@')[1]}>`, pasta: 'Inbox',
    remetente: de, remetenteNome: nomeDe, destinatarios: caixa, cc: null, assunto, data: dataHoraLocal(data),
    carregarAnexos: async () => anexos.map((a) => ({ nome: a.nome, tamanho: a.conteudo.length, baixar: async () => a.conteudo })),
  });
}

function montarNFe(f, d, extra = {}) {
  const dest = EMP[extra.dest ?? f.dest];
  const qtdItens = extra.itens?.length ?? rnd.int(1, Math.min(3, f.prods.length + 1));
  const itens = extra.itens ?? Array.from({ length: qtdItens }, (_, i) => {
    const p = f.prods[i % f.prods.length];
    return {
      codigo: p.codigo, descricao: p.descricao, ncm: p.ncm, cest: p.cest, cfop: extra.cfop ?? f.cfop, unidade: p.unidade,
      qtd: rnd.int(p.qtd[0], p.qtd[1]), vUn: Math.round((p.vUn[0] + rnd() * (p.vUn[1] - p.vUn[0])) * 100) / 100,
      origem: f.origem ?? '0', cst: extra.cst ?? f.cst, pICMS: extra.pICMS ?? f.pICMS, pIPI: p.pIPI,
      ...(i === 0 ? extra.item0 : {}),
    };
  });
  const numero = extra.numero ?? ++f.numero;
  const r = G.xmlNFe({
    emit: { cnpj: f.cnpj, nome: f.nome, ie: f.ie, uf: f.uf, municipio: f.municipio }, dest: { ...dest, nome: extra.destNome ?? dest.nome, cnpj: extra.destCnpj ?? dest.cnpj },
    numero, serie: extra.serie ?? 1, dhEmi: dhEmi(d), crt: f.crt, itens, natOp: extra.natOp, finNFe: extra.finNFe, refNFe: extra.refNFe,
    codigo: extra.codigo, ajusteTotais: extra.ajusteTotais, ajusteDuplicata: extra.ajusteDuplicata,
    parcelas: extra.parcelas ?? (f.crt === '1' && rnd() < 0.5 ? [] : rnd.pick([[7], [14], [21], [28], [28], [28, 56], [30, 60, 90]])),
  });
  return { ...r, numero, dest, emit: f, dhEmi: dhEmi(d, 0) };
}

async function nfePorEmail(f, d, extra = {}, { comPdf = rnd() < 0.5, pdfDeOutra, somentePdf, caixa, messageId } = {}) {
  const nf = montarNFe(f, d, extra);
  const anexos = [];
  if (!somentePdf) anexos.push({ nome: `${nf.chave}-nfe.xml`, conteudo: Buffer.from(nf.xml) });
  if (comPdf || somentePdf) {
    const ref = pdfDeOutra ?? nf;
    anexos.push({ nome: `DANFE_${nf.numero}.pdf`, conteudo: G.danfe({ chave: ref.chave, numero: ref.numero, serie: 1, emit: f, dest: nf.dest, dhEmi: nf.dhEmi, vNF: ref.totais.vNF, vProd: ref.totais.vProd, vICMS: ref.totais.vICMS }) });
  }
  await enviarEmail({ caixa: caixa ?? nf.dest.caixa, de: f.email, nomeDe: f.nome, assunto: rnd.pick([`NF-e ${nf.numero} - ${f.nome}`, `Envio de XML NF ${nf.numero}`, `Nota Fiscal Eletrônica nº ${nf.numero}`, `Faturamento pedido ${rnd.int(10000, 99999)}`]), data: d, anexos, messageId });
  return nf;
}

// ------------------------------------------------------------------ geração cronológica
console.log('Gerando documentos de demonstração...');
const anomalias = {
  7: [async (d) => nfePorEmail(F.PAP, d, { destCnpj: G.gerarCnpj('99887766'), destNome: 'OUTRA EMPRESA QUALQUER LTDA' })],
  6: [async (d) => nfePorEmail(F.ACO, d, { cfop: '5102' }), async (d) => { const nf = await nfePorEmail(F.PLA, d); anomalias.cancelar = nf; }],
  5: [async (d) => nfePorEmail(F.PAR, d, { item0: { erroIcms: 15.3 } }),
    async (d) => { const nf = anomalias.cancelar; await enviarEmail({ caixa: nf.dest.caixa, de: F.PLA.email, nomeDe: F.PLA.nome, assunto: `Cancelamento NF-e ${nf.numero}`, data: d, anexos: [{ nome: `${nf.chave}-can.xml`, conteudo: Buffer.from(G.xmlCancelamento({ chave: nf.chave, cnpj: F.PLA.cnpj, dhEvento: dhEmi(d, 1), justificativa: 'Erro na quantidade faturada, sera emitida nova nota' })) }] }); },
    async (d) => nfePorEmail(F.PAP, d, {}, { somentePdf: true })],
  4: [async (d) => nfePorEmail(F.QUI, d, { pICMS: 12 }),
    async (d) => nfePorEmail(F.PNE, d, { cst: '10', cfop: '5403', pICMS: 19, item0: { cest: undefined, st: { mva: 50, pInterna: 19 } } }),
    async (d) => nfePorEmail(F.NOR, d, {}, { comPdf: true, pdfDeOutra: montarNFe(F.NOR, d) })],
  3: [async (d) => { anomalias.pdfDepois = await nfePorEmail(F.EMB, d, {}, { somentePdf: true }); },
    async (d) => nfePorEmail(F.EMB, d, { item0: { ajusteVProd: 120 } }),
    async (d) => nfePorEmail(F.IMP, d, { pICMS: 12 }),
    async (d) => nfePorEmail(F.ACO, d, { ajusteDuplicata: 150, parcelas: [10, 40] }),
    async (d) => { // transferência correta entre estabelecimentos
      const nf = G.xmlNFe({ emit: { ...EMP.IND, nome: EMP.IND.razao }, dest: { ...EMP.MG, nome: EMP.MG.razao }, numero: 7001, serie: 2, dhEmi: dhEmi(d), natOp: 'TRANSFERENCIA DE MERCADORIA', itens: [{ codigo: 'CX-40', descricao: 'CAIXA PAPELAO ONDULADO 40X30X20', ncm: '48191000', unidade: 'UN', cfop: '6152', qtd: 2000, vUn: 2.5, pICMS: 12 }] });
      await enviarEmail({ caixa: EMP.MG.caixa, de: 'faturamento@comelli-demo.com.br', nomeDe: 'Faturamento Comelli', assunto: 'Transferência NF 7001', data: d, anexos: [{ nome: `${nf.chave}.xml`, conteudo: Buffer.from(nf.xml) }] });
    }],
  2: [async (d) => nfePorEmail(F.TEC, d, { cfop: '6108' }),
    async (d) => nfePorEmail(F.NOR, d, { pICMS: 7 }),
    async (d) => { // devolução de cliente sem NF referenciada
      const nf = G.xmlNFe({ emit: CLIENTE, dest: { ...EMP.COM, nome: EMP.COM.razao }, numero: 45120, dhEmi: dhEmi(d), natOp: 'DEVOLUCAO DE COMPRA', finNFe: '4', itens: [{ codigo: 'CF-500', descricao: 'CAFE TORRADO MOIDO 500G', ncm: '09012100', unidade: 'FD', cfop: '5202', qtd: 5, vUn: 205, pICMS: 19 }] });
      await enviarEmail({ caixa: EMP.COM.caixa, de: CLIENTE.email, nomeDe: CLIENTE.nome, assunto: 'Devolução - NF 45120', data: d, anexos: [{ nome: `${nf.chave}.xml`, conteudo: Buffer.from(nf.xml) }] });
    }],
  1: [async (d) => { // mesmo e-mail enviado para as duas caixas
      const mid = '<nfe-duplicada-demo@acoforte.com.br>';
      const nf = montarNFe(F.ACO, d);
      const anexos = [{ nome: `${nf.chave}-nfe.xml`, conteudo: Buffer.from(nf.xml) }];
      await enviarEmail({ caixa: 'suprimentos@grupocomelli.com.br', de: F.ACO.email, nomeDe: F.ACO.nome, assunto: `NF-e ${nf.numero}`, data: d, anexos, messageId: mid });
      await enviarEmail({ caixa: 'suprimentos@comber.com.br', de: F.ACO.email, nomeDe: F.ACO.nome, assunto: `NF-e ${nf.numero}`, data: d, anexos, messageId: mid });
    },
    async (d) => { // reemissão com mesmo número e chave diferente
      const nf = montarNFe(F.PAR, d); await enviarEmail({ caixa: nf.dest.caixa, de: F.PAR.email, nomeDe: F.PAR.nome, assunto: `NF-e ${nf.numero}`, data: d, anexos: [{ nome: `${nf.chave}.xml`, conteudo: Buffer.from(nf.xml) }] });
      const nf2 = montarNFe(F.PAR, dia(0, 9), { numero: nf.numero, codigo: 55555555 }); await enviarEmail({ caixa: nf.dest.caixa, de: F.PAR.email, nomeDe: F.PAR.nome, assunto: `REENVIO NF-e ${nf.numero}`, data: dia(0, 9), anexos: [{ nome: `${nf2.chave}.xml`, conteudo: Buffer.from(nf2.xml) }] });
    },
    async (d) => { // o XML da NF que havia chegado só em PDF
      const nf = anomalias.pdfDepois;
      await enviarEmail({ caixa: nf.dest.caixa, de: F.EMB.email, nomeDe: F.EMB.nome, assunto: `XML da NF ${nf.numero}`, data: d, anexos: [{ nome: `${nf.chave}.xml`, conteudo: Buffer.from(nf.xml) }] });
    },
    async (d) => { // transferência com CFOP de venda
      const nf = G.xmlNFe({ emit: { ...EMP.IND, nome: EMP.IND.razao }, dest: { ...EMP.MG, nome: EMP.MG.razao }, numero: 7002, serie: 2, dhEmi: dhEmi(d), itens: [{ codigo: 'TP-38', descricao: 'TAMPA PLASTICA PP 38MM', ncm: '39235000', unidade: 'MIL', cfop: '6102', qtd: 20, vUn: 95, pICMS: 12 }] });
      await enviarEmail({ caixa: EMP.MG.caixa, de: 'faturamento@comelli-demo.com.br', nomeDe: 'Faturamento Comelli', assunto: 'NF 7002', data: d, anexos: [{ nome: `${nf.chave}.xml`, conteudo: Buffer.from(nf.xml) }] });
    }],
  0: [async (d) => nfePorEmail(F.PLA, d, {}, { somentePdf: true })],
};

for (let atras = 29; atras >= 0; atras--) {
  // fluxo normal de fornecedores
  for (const f of Object.values(F)) {
    if (rnd() < f.freq) await nfePorEmail(f, dia(atras));
  }
  // CT-e semanal da transportadora (SP -> GO)
  if (atras % 6 === 2) {
    const d = dia(atras);
    const erro = atras === 2 ? 22.5 : 0;
    const c = G.xmlCTe({ emit: TRANSP, rem: { ...F.ACO }, dest: { ...EMP.COM, nome: EMP.COM.razao }, numero: ++TRANSP.numero, dhEmi: dhEmi(d), ufIni: 'SP', ufFim: 'GO', munIni: 'Sao Paulo', munFim: 'Goiania', cfop: '6353', vPrest: 800 + rnd.int(0, 2400), pICMS: 7, erroIcms: erro });
    await enviarEmail({ caixa: EMP.COM.caixa, de: TRANSP.email, nomeDe: TRANSP.nome, assunto: `CT-e ${TRANSP.numero}`, data: d, anexos: [{ nome: `${c.chave}-cte.xml`, conteudo: Buffer.from(c.xml) }] });
  }
  // NFS-e
  for (const s of SERV) {
    const quando = s.aliquota === 5 ? [25, 10] : [20, 6, 1];
    if (!quando.includes(atras)) continue;
    const d = dia(atras);
    const aliquota = s.aliquota === 3 && atras === 1 ? 6 : s.aliquota;
    const { xml } = G.xmlNFSeAbrasf({ prest: s, toma: { ...EMP[s.dest], nome: EMP[s.dest].razao }, numero: ++s.numero, data: dhEmi(d).slice(0, 19), valor: s.valor[0] + rnd.int(0, s.valor[1] - s.valor[0]), aliquota, item: s.item, discriminacao: s.desc });
    await enviarEmail({ caixa: EMP[s.dest].caixa, de: s.email, nomeDe: s.nome, assunto: `NFS-e ${s.numero}`, data: d, anexos: [{ nome: `nfse_${s.numero}.xml`, conteudo: Buffer.from(xml) }] });
  }
  // e-mails sem NF / com erro
  if (atras === 12) await enviarEmail({ caixa: 'suprimentos@grupocomelli.com.br', de: 'vendas@acoforte.com.br', nomeDe: 'Vendas Aço Forte', assunto: 'Cotação atualizada', data: dia(atras), anexos: [{ nome: 'cotacao.docx', conteudo: Buffer.from('PK...') }] });
  if (atras === 9) await enviarEmail({ caixa: 'suprimentos@comber.com.br', de: 'cobranca@nordeste.com.br', nomeDe: 'Cobrança', assunto: 'Boleto vencimento', data: dia(atras), anexos: [{ nome: 'boleto.pdf', conteudo: G.pdfTexto(['BOLETO BANCARIO', 'Beneficiario: Distribuidora Nordeste', 'Vencimento 10/10/2026', 'Valor 1.234,00']) }] });
  if (atras === 4) await enviarEmail({ caixa: 'suprimentos@grupocomelli.com.br', de: F.QUI.email, nomeDe: F.QUI.nome, assunto: 'XML NF', data: dia(atras), anexos: [{ nome: 'nota.xml', conteudo: Buffer.from('<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe123"><ide><nNF>1') }] });
  for (const fn of anomalias[atras] ?? []) await fn(dia(atras));
}

// ------------------------------------------------------------------ histórico de decisões (demonstração)
const agora = Date.now();
run("UPDATE documentos SET validado_em = datetime(recebido_em, '+2 minutes')");
run("UPDATE decisoes SET created_at = (SELECT datetime(d.recebido_em, '+2 minutes') FROM documentos d WHERE d.id = decisoes.documento_id) WHERE acao = 'SISTEMA' AND usuario_id IS NULL");
run("UPDATE emails SET processado_em = datetime(data_recebimento, '+1 minutes'), created_at = data_recebimento");
run("UPDATE documentos SET prazo = date(recebido_em, '+3 day')");

const fiscais = [usuarios.joao, usuarios.maria];
const decidir = (doc, acao, status, justificativa, horas) => {
  const quando = dataHoraLocal(new Date(new Date(doc.recebido_em.replace(' ', 'T')).getTime() + horas * 3600000));
  if (new Date(quando.replace(' ', 'T')).getTime() > agora) return;
  const u = rnd.pick(fiscais);
  if (acao === 'APROVAR') {
    for (const it of all('SELECT id, cfop_entrada_sugerido FROM documento_itens WHERE documento_id = ? AND cfop_entrada_sugerido IS NOT NULL', [doc.id])) {
      run('UPDATE documento_itens SET cfop_entrada = ? WHERE id = ?', [it.cfop_entrada_sugerido, it.id]);
      insert('alteracoes_campo', { documento_id: doc.id, item_id: it.id, campo: 'cfop_entrada', valor_novo: it.cfop_entrada_sugerido, origem: 'SUGESTAO_MOTOR_ACEITA', usuario_id: u, justificativa: 'Confirmado na aprovação', created_at: quando });
    }
  }
  insert('decisoes', { documento_id: doc.id, usuario_id: u, acao, justificativa, status_anterior: doc.status, status_novo: status, created_at: quando });
  run(`UPDATE documentos SET status = ?, decidido_em = ?, responsavel_id = ?, erp_status = ? WHERE id = ?`, [status, quando, u, acao === 'APROVAR' ? 'pendente' : null, doc.id]);
};
const antigos = all("SELECT * FROM documentos WHERE recebido_em < datetime('now','localtime','-2 day') ORDER BY recebido_em");
let rejeitada = false, correcao = false;
for (const d of antigos) {
  if (d.status === 'PENDENTE' && rnd() < 0.9) decidir(d, 'APROVAR', 'APROVADA', null, rnd.int(1, 30));
  else if (d.status === 'INCONSISTENTE' && !rejeitada && d.situacao_sefaz === 'cancelada') { decidir(d, 'REPROVAR', 'REJEITADA', 'NF cancelada pelo fornecedor; aguardando nova emissão.', 3); rejeitada = true; }
  else if (d.status === 'INCONSISTENTE' && !correcao && d.tipo === 'NFE') { decidir(d, 'SOLICITAR_CORRECAO', 'CORRECAO_SOLICITADA', 'Solicitado ao fornecedor ajuste do destaque de ICMS.', 5); correcao = true; }
}
// Responsáveis na fila atual
for (const d of all("SELECT id FROM documentos WHERE status IN ('INCONSISTENTE','PENDENTE','DUPLICADA','AGUARDANDO_XML') AND responsavel_id IS NULL")) {
  if (rnd() < 0.7) run('UPDATE documentos SET responsavel_id = ? WHERE id = ?', [rnd.pick(fiscais), d.id]);
}

// Pagamentos: títulos vencidos de NFs aprovadas quase sempre pagos; alguns programados
const hojeTxt = dataHoraLocal().slice(0, 10);
const em7 = dataHoraLocal(new Date(Date.now() + 7 * 86400000)).slice(0, 10);
for (const t of all("SELECT dp.id, dp.vencimento, d.status FROM documento_duplicatas dp JOIN documentos d ON d.id = dp.documento_id")) {
  if (t.status === 'APROVADA' && t.vencimento < hojeTxt && rnd() < 0.85) {
    run("UPDATE documento_duplicatas SET status_pagamento = 'paga', data_pagamento = date(vencimento, ?), atualizado_por = ? WHERE id = ?", [`-${rnd.int(0, 2)} day`, usuarios.financeiro, t.id]);
  } else if (t.status === 'APROVADA' && t.vencimento >= hojeTxt && t.vencimento <= em7 && rnd() < 0.5) {
    run("UPDATE documento_duplicatas SET status_pagamento = 'programada', atualizado_por = ? WHERE id = ?", [usuarios.financeiro, t.id]);
  }
}
// Prioridade/prazo consideram os vencimentos: revalida a fila atual
const { executarMotor } = await import('../fiscal/motor.js');
for (const d of all("SELECT id FROM documentos WHERE status IN ('PENDENTE','INCONSISTENTE','AGUARDANDO_XML','DUPLICADA')")) executarMotor(d.id);
run("UPDATE documentos SET validado_em = datetime(recebido_em, '+2 minutes')");
run("DELETE FROM decisoes WHERE acao = 'SISTEMA' AND justificativa LIKE 'Motor fiscal%' AND status_anterior = status_novo");

const tot = get("SELECT COUNT(*) AS docs, SUM(status='APROVADA') AS aprov, SUM(status='INCONSISTENTE') AS inc, SUM(status='PENDENTE') AS pend, SUM(status='AGUARDANDO_XML') AS semxml, SUM(status='DUPLICADA') AS dup FROM documentos");
const em = get('SELECT COUNT(*) AS n FROM emails').n;
console.log(`\n${em} e-mails, ${tot.docs} documentos: ${tot.aprov} aprovados, ${tot.pend} pendentes, ${tot.inc} com inconsistência, ${tot.semxml} aguardando XML, ${tot.dup} duplicados.`);
console.log('\nUsuários de demonstração (senha para todos: ' + SENHA_DEMO + '):');
for (const u of all('SELECT email, perfil FROM usuarios ORDER BY id')) console.log(`  ${u.perfil.padEnd(9)} ${u.email}`);
console.log('\nATENÇÃO: base fictícia para demonstração. Para produção, rode sem seed e cadastre as empresas reais.');
