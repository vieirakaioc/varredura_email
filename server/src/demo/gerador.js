// Geração de documentos fiscais sintéticos (layout oficial) para demonstração e testes.
// Nenhum dado aqui corresponde a documentos reais.
import { dvChave, montarChave, formatarCnpj } from '../fiscal/validadores.js';
import { CODIGO_UF } from '../fiscal/tabelas.js';

const r2 = (v) => Math.round(v * 100) / 100;
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const f4 = (v) => Number(v).toFixed(4);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function gerarCnpj(base8, filial = '0001') {
  const b = `${String(base8).padStart(8, '0')}${filial}`;
  const dv = (s) => {
    let peso = 2, t = 0;
    for (let i = s.length - 1; i >= 0; i--) { t += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const r = t % 11; return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(b); const d2 = dv(b + d1);
  return `${b}${d1}${d2}`;
}

/** PRNG determinístico (mulberry32) para dados reprodutíveis. */
export function aleatorio(semente = 42) {
  let a = semente >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  rnd.int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
  rnd.pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  return rnd;
}

/**
 * Monta itens com tributos calculados. Opções por item permitem injetar erros.
 * item: { codigo, descricao, ncm, cest?, cfop, unidade, qtd, vUn, origem?, cst?, pICMS?, pIPI?, st?: {mva, pInterna}, erroIcms?, vDesc?, vFrete? }
 */
export function calcularItens(itens, { crt = '3', pis = 1.65, cofins = 7.6 } = {}) {
  return itens.map((it, i) => {
    const vProd = r2(it.qtd * it.vUn);
    const vDesc = it.vDesc ?? 0, vFrete = it.vFrete ?? 0;
    const base = r2(vProd - vDesc + vFrete);
    const simples = crt === '1' || crt === '4';
    const cst = it.cst ?? (simples ? '102' : '00');
    const icms = { cst, origem: it.origem ?? '0' };
    if (['00', '10', '20', '70', '90'].includes(cst)) {
      icms.vBC = it.cst === '20' ? r2(base * (1 - (it.pRedBC ?? 0) / 100)) : base;
      if (it.pRedBC) icms.pRedBC = it.pRedBC;
      icms.pICMS = it.pICMS;
      icms.vICMS = r2(icms.vBC * it.pICMS / 100 + (it.erroIcms ?? 0));
    }
    let ipi = null;
    if (it.pIPI != null) ipi = { cst: '50', vBC: vProd, pIPI: it.pIPI, vIPI: r2(vProd * it.pIPI / 100) };
    if (it.st) {
      const bcSt = r2((base + (ipi?.vIPI ?? 0)) * (1 + it.st.mva / 100));
      icms.vBCST = bcSt; icms.pMVAST = it.st.mva; icms.pICMSST = it.st.pInterna;
      icms.vICMSST = r2(bcSt * it.st.pInterna / 100 - (icms.vICMS ?? 0));
    }
    const pisCst = simples ? '99' : (it.pisCst ?? '01');
    return {
      ...it, nItem: i + 1, vProd, vDesc, vFrete, icms, ipi,
      pis: pisCst === '01' ? { cst: '01', vBC: base, p: pis, v: r2(base * pis / 100) } : { cst: pisCst, vBC: 0, p: 0, v: 0 },
      cofins: pisCst === '01' ? { cst: '01', vBC: base, p: cofins, v: r2(base * cofins / 100) } : { cst: pisCst, vBC: 0, p: 0, v: 0 },
    };
  });
}

function grupoIcms(icms) {
  const c = icms.cst;
  if (c.length === 3) {
    if (c === '500') return `<ICMSSN500><orig>${icms.origem}</orig><CSOSN>500</CSOSN></ICMSSN500>`;
    return `<ICMSSN102><orig>${icms.origem}</orig><CSOSN>${c}</CSOSN></ICMSSN102>`;
  }
  const tag = { '00': 'ICMS00', '10': 'ICMS10', '20': 'ICMS20', '60': 'ICMS60', '40': 'ICMS40', '41': 'ICMS40', '90': 'ICMS90', '70': 'ICMS70' }[c] ?? 'ICMS90';
  let x = `<orig>${icms.origem}</orig><CST>${c}</CST>`;
  if (icms.vBC != null) x += `<modBC>3</modBC>${icms.pRedBC ? `<pRedBC>${f4(icms.pRedBC)}</pRedBC>` : ''}<vBC>${f2(icms.vBC)}</vBC><pICMS>${f4(icms.pICMS)}</pICMS><vICMS>${f2(icms.vICMS)}</vICMS>`;
  if (icms.vBCST != null) x += `<modBCST>4</modBCST><pMVAST>${f4(icms.pMVAST)}</pMVAST><vBCST>${f2(icms.vBCST)}</vBCST><pICMSST>${f4(icms.pICMSST)}</pICMSST><vICMSST>${f2(icms.vICMSST)}</vICMSST>`;
  if (c === '60') x += '<vBCSTRet>0.00</vBCSTRet><vICMSSTRet>0.00</vICMSSTRet>';
  return `<${tag}>${x}</${tag}>`;
}

/**
 * Gera XML de NF-e (nfeProc, layout 4.00) com totais coerentes com os itens.
 * `ajusteTotais` permite injetar divergências nos totais (ex.: { vProd: +10 }).
 */
export function xmlNFe(p) {
  const { emit, dest, numero, serie = 1, dhEmi, natOp = 'VENDA DE MERCADORIA', tpNF = '1', finNFe = '1', refNFe, crt = '3', semProtocolo } = p;
  const itens = calcularItens(p.itens, { crt });
  const aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const cNF = String(p.codigo ?? 10000000 + numero * 7).slice(-8).padStart(8, '0');
  const chave = p.chave ?? montarChave({ cUF: CODIGO_UF[emit.uf], aamm, cnpj: emit.cnpj, modelo: '55', serie, numero, codigo: cNF });
  const s = (fn) => r2(itens.reduce((a, i) => a + (fn(i) ?? 0), 0));
  const tot = {
    vBC: s((i) => i.icms.vBC), vICMS: s((i) => i.icms.vICMS), vBCST: s((i) => i.icms.vBCST), vST: s((i) => i.icms.vICMSST),
    vProd: s((i) => i.vProd), vFrete: s((i) => i.vFrete), vDesc: s((i) => i.vDesc), vIPI: s((i) => i.ipi?.vIPI),
    vPIS: s((i) => i.pis.v), vCOFINS: s((i) => i.cofins.v),
  };
  for (const [k, v] of Object.entries(p.ajusteTotais ?? {})) tot[k] = r2((tot[k] ?? 0) + v);
  tot.vNF = r2(tot.vProd - tot.vDesc + tot.vST + tot.vFrete + tot.vIPI + (p.ajusteTotais?.vNF ?? 0));
  const det = itens.map((i) => `<det nItem="${i.nItem}"><prod><cProd>${esc(i.codigo)}</cProd><cEAN>SEM GTIN</cEAN><xProd>${esc(i.descricao)}</xProd><NCM>${i.ncm}</NCM>${i.cest ? `<CEST>${i.cest}</CEST>` : ''}<CFOP>${i.cfop}</CFOP><uCom>${i.unidade}</uCom><qCom>${f4(i.qtd)}</qCom><vUnCom>${Number(i.vUn).toFixed(10)}</vUnCom><vProd>${f2(i.vProd + (i.ajusteVProd ?? 0))}</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>${i.unidade}</uTrib><qTrib>${f4(i.qtd)}</qTrib><vUnTrib>${Number(i.vUn).toFixed(10)}</vUnTrib>${i.vFrete ? `<vFrete>${f2(i.vFrete)}</vFrete>` : ''}${i.vDesc ? `<vDesc>${f2(i.vDesc)}</vDesc>` : ''}<indTot>1</indTot></prod>`
    + `<imposto><ICMS>${grupoIcms(i.icms)}</ICMS>${i.ipi ? `<IPI><cEnq>999</cEnq><IPITrib><CST>${i.ipi.cst}</CST><vBC>${f2(i.ipi.vBC)}</vBC><pIPI>${f4(i.ipi.pIPI)}</pIPI><vIPI>${f2(i.ipi.vIPI)}</vIPI></IPITrib></IPI>` : ''}`
    + `<PIS>${i.pis.cst === '01' ? `<PISAliq><CST>01</CST><vBC>${f2(i.pis.vBC)}</vBC><pPIS>${f4(i.pis.p)}</pPIS><vPIS>${f2(i.pis.v)}</vPIS></PISAliq>` : `<PISOutr><CST>${i.pis.cst}</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr>`}</PIS>`
    + `<COFINS>${i.cofins.cst === '01' ? `<COFINSAliq><CST>01</CST><vBC>${f2(i.cofins.vBC)}</vBC><pCOFINS>${f4(i.cofins.p)}</pCOFINS><vCOFINS>${f2(i.cofins.v)}</vCOFINS></COFINSAliq>` : `<COFINSOutr><CST>${i.cofins.cst}</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr>`}</COFINS></imposto></det>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${chave}">`
    + `<ide><cUF>${CODIGO_UF[emit.uf]}</cUF><cNF>${cNF}</cNF><natOp>${esc(natOp)}</natOp><mod>55</mod><serie>${serie}</serie><nNF>${numero}</nNF><dhEmi>${dhEmi}</dhEmi><tpNF>${tpNF}</tpNF><idDest>${emit.uf === dest.uf ? 1 : 2}</idDest><cMunFG>5201108</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${chave.slice(-1)}</cDV><tpAmb>1</tpAmb><finNFe>${finNFe}</finNFe><indFinal>0</indFinal><indPres>9</indPres><procEmi>0</procEmi><verProc>DEMO</verProc>${refNFe ? `<NFref><refNFe>${refNFe}</refNFe></NFref>` : ''}</ide>`
    + `<emit><CNPJ>${emit.cnpj}</CNPJ><xNome>${esc(emit.nome)}</xNome>${emit.fantasia ? `<xFant>${esc(emit.fantasia)}</xFant>` : ''}<enderEmit><xLgr>RUA DEMONSTRACAO</xLgr><nro>100</nro><xBairro>CENTRO</xBairro><cMun>0000000</cMun><xMun>${esc(emit.municipio)}</xMun><UF>${emit.uf}</UF><CEP>00000000</CEP></enderEmit><IE>${emit.ie}</IE><CRT>${crt}</CRT></emit>`
    + `<dest><CNPJ>${dest.cnpj}</CNPJ><xNome>${esc(dest.nome)}</xNome><enderDest><xLgr>AV DEMONSTRACAO</xLgr><nro>1</nro><xBairro>INDUSTRIAL</xBairro><cMun>0000000</cMun><xMun>${esc(dest.municipio)}</xMun><UF>${dest.uf}</UF><CEP>00000000</CEP></enderDest><indIEDest>1</indIEDest><IE>${dest.ie}</IE></dest>`
    + det
    + `<total><ICMSTot><vBC>${f2(tot.vBC)}</vBC><vICMS>${f2(tot.vICMS)}</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>${f2(tot.vBCST)}</vBCST><vST>${f2(tot.vST)}</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${f2(tot.vProd)}</vProd><vFrete>${f2(tot.vFrete)}</vFrete><vSeg>0.00</vSeg><vDesc>${f2(tot.vDesc)}</vDesc><vII>0.00</vII><vIPI>${f2(tot.vIPI)}</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${f2(tot.vPIS)}</vPIS><vCOFINS>${f2(tot.vCOFINS)}</vCOFINS><vOutro>0.00</vOutro><vNF>${f2(tot.vNF)}</vNF></ICMSTot></total>`
    + `<transp><modFrete>${tot.vFrete ? 0 : 1}</modFrete></transp>${grupoCobranca(p, tot.vNF, numero, dhEmi)}<infAdic><infCpl>Documento gerado para demonstracao do Validador Fiscal.</infCpl></infAdic>`
    + `</infNFe></NFe>${semProtocolo ? '' : `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><verAplic>DEMO</verAplic><chNFe>${chave}</chNFe><dhRecbto>${dhEmi}</dhRecbto><nProt>1${String(numero).padStart(14, '0')}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`}</nfeProc>`;
  return { xml, chave, totais: tot };
}

/** Fatura + duplicatas (boleto). `parcelas` = dias após a emissão; [] = pagamento à vista sem duplicatas. */
function grupoCobranca(p, vNF, numero, dhEmi) {
  const parcelas = p.parcelas ?? [28];
  if (!parcelas.length) return `<pag><detPag><indPag>0</indPag><tPag>17</tPag><vPag>${f2(vNF)}</vPag></detPag></pag>`;
  const base = r2(vNF / parcelas.length);
  const venc = (dias) => { const d = new Date(`${dhEmi.slice(0, 10)}T12:00:00`); d.setDate(d.getDate() + dias); return d.toLocaleDateString('sv-SE'); };
  const dups = parcelas.map((dias, i) => {
    const valor = i === parcelas.length - 1 ? r2(vNF - base * (parcelas.length - 1)) : base;
    return `<dup><nDup>${String(i + 1).padStart(3, '0')}</nDup><dVenc>${venc(dias)}</dVenc><vDup>${f2(valor + (i === 0 ? (p.ajusteDuplicata ?? 0) : 0))}</vDup></dup>`;
  }).join('');
  return `<cobr><fat><nFat>${numero}</nFat><vOrig>${f2(vNF)}</vOrig><vDesc>0.00</vDesc><vLiq>${f2(vNF)}</vLiq></fat>${dups}</cobr>`
    + `<pag><detPag><indPag>1</indPag><tPag>15</tPag><vPag>${f2(vNF)}</vPag></detPag></pag>`;
}

export function xmlCTe(p) {
  const { emit, rem, dest, numero, serie = 1, dhEmi, ufIni, ufFim, munIni, munFim, cfop, vPrest, pICMS, erroIcms = 0, nfes = [] } = p;
  const aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const cCT = String(20000000 + numero * 3).slice(-8);
  const chave = montarChave({ cUF: CODIGO_UF[emit.uf], aamm, cnpj: emit.cnpj, modelo: '57', serie, numero, codigo: cCT });
  const vICMS = r2(vPrest * pICMS / 100 + erroIcms);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><cteProc xmlns="http://www.portalfiscal.inf.br/cte" versao="4.00"><CTe xmlns="http://www.portalfiscal.inf.br/cte"><infCte versao="4.00" Id="CTe${chave}">`
    + `<ide><cUF>${CODIGO_UF[emit.uf]}</cUF><cCT>${cCT}</cCT><CFOP>${cfop}</CFOP><natOp>PRESTACAO DE SERVICO DE TRANSPORTE</natOp><mod>57</mod><serie>${serie}</serie><nCT>${numero}</nCT><dhEmi>${dhEmi}</dhEmi><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${chave.slice(-1)}</cDV><tpAmb>1</tpAmb><tpCTe>0</tpCTe><procEmi>0</procEmi><verProc>DEMO</verProc><cMunEnv>0000000</cMunEnv><xMunEnv>${esc(munIni)}</xMunEnv><UFEnv>${ufIni}</UFEnv><modal>01</modal><tpServ>0</tpServ><cMunIni>0000000</cMunIni><xMunIni>${esc(munIni)}</xMunIni><UFIni>${ufIni}</UFIni><cMunFim>0000000</cMunFim><xMunFim>${esc(munFim)}</xMunFim><UFFim>${ufFim}</UFFim><retira>1</retira><indIEToma>1</indIEToma><toma3><toma>3</toma></toma3></ide>`
    + `<emit><CNPJ>${emit.cnpj}</CNPJ><IE>${emit.ie}</IE><xNome>${esc(emit.nome)}</xNome><enderEmit><xLgr>RODOVIA DEMO</xLgr><nro>KM 10</nro><xBairro>DISTRITO</xBairro><cMun>0000000</cMun><xMun>${esc(emit.municipio)}</xMun><UF>${emit.uf}</UF></enderEmit><CRT>3</CRT></emit>`
    + `<rem><CNPJ>${rem.cnpj}</CNPJ><IE>${rem.ie}</IE><xNome>${esc(rem.nome)}</xNome><enderReme><xLgr>RUA</xLgr><nro>1</nro><xBairro>C</xBairro><cMun>0000000</cMun><xMun>${esc(rem.municipio)}</xMun><UF>${rem.uf}</UF></enderReme></rem>`
    + `<dest><CNPJ>${dest.cnpj}</CNPJ><IE>${dest.ie}</IE><xNome>${esc(dest.nome)}</xNome><enderDest><xLgr>AV</xLgr><nro>1</nro><xBairro>I</xBairro><cMun>0000000</cMun><xMun>${esc(dest.municipio)}</xMun><UF>${dest.uf}</UF></enderDest></dest>`
    + `<vPrest><vTPrest>${f2(vPrest)}</vTPrest><vRec>${f2(vPrest)}</vRec></vPrest><imp><ICMS><ICMS00><CST>00</CST><vBC>${f2(vPrest)}</vBC><pICMS>${f4(pICMS)}</pICMS><vICMS>${f2(vICMS)}</vICMS></ICMS00></ICMS></imp>`
    + `<infCTeNorm><infCarga><vCarga>0.00</vCarga><proPred>DIVERSOS</proPred></infCarga><infDoc>${nfes.map((c) => `<infNFe><chave>${c}</chave></infNFe>`).join('')}</infDoc></infCTeNorm>`
    + `</infCte></CTe><protCTe versao="4.00"><infProt><tpAmb>1</tpAmb><chCTe>${chave}</chCTe><dhRecbto>${dhEmi}</dhRecbto><nProt>2${String(numero).padStart(14, '0')}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe></cteProc>`;
  return { xml, chave };
}

export function xmlNFSeAbrasf(p) {
  const { prest, toma, numero, data, valor, aliquota, item = '17.01', discriminacao, municipio = '5208707' } = p;
  const iss = r2(valor * aliquota / 100);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse versao="2.04"><InfNfse Id="nfse${numero}">`
    + `<Numero>${numero}</Numero><CodigoVerificacao>DEMO${numero}</CodigoVerificacao><DataEmissao>${data}</DataEmissao>`
    + `<ValoresNfse><BaseCalculo>${f2(valor)}</BaseCalculo><Aliquota>${f2(aliquota)}</Aliquota><ValorIss>${f2(iss)}</ValorIss><ValorLiquidoNfse>${f2(valor)}</ValorLiquidoNfse></ValoresNfse>`
    + `<PrestadorServico><IdentificacaoPrestador><CpfCnpj><Cnpj>${prest.cnpj}</Cnpj></CpfCnpj><InscricaoMunicipal>12345</InscricaoMunicipal></IdentificacaoPrestador><RazaoSocial>${esc(prest.nome)}</RazaoSocial><Endereco><Endereco>RUA</Endereco><Numero>1</Numero><Bairro>C</Bairro><CodigoMunicipio>${municipio}</CodigoMunicipio><Uf>${prest.uf}</Uf></Endereco></PrestadorServico>`
    + `<DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico><Competencia>${data.slice(0, 10)}</Competencia><Servico><Valores><ValorServicos>${f2(valor)}</ValorServicos><ValorIss>${f2(iss)}</ValorIss><Aliquota>${f2(aliquota)}</Aliquota></Valores><IssRetido>2</IssRetido><ItemListaServico>${item}</ItemListaServico><Discriminacao>${esc(discriminacao)}</Discriminacao><CodigoMunicipio>${municipio}</CodigoMunicipio></Servico>`
    + `<Prestador><CpfCnpj><Cnpj>${prest.cnpj}</Cnpj></CpfCnpj></Prestador><TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${toma.cnpj}</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>${esc(toma.nome)}</RazaoSocial><Endereco><Uf>${toma.uf}</Uf></Endereco></TomadorServico></InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico>`
    + `</InfNfse></Nfse></CompNfse>`;
  return { xml };
}

export function xmlCancelamento({ chave, cnpj, dhEvento, justificativa }) {
  return `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><cOrgao>${chave.slice(0, 2)}</cOrgao><tpAmb>1</tpAmb><CNPJ>${cnpj}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dhEvento}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>100000000000001</nProt><xJust>${esc(justificativa)}</xJust></detEvento></infEvento></evento><retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${chave}</chNFe><tpEvento>110111</tpEvento></infEvento></retEvento></procEventoNFe>`;
}

// ------------------------------------------------------------------ PDF mínimo (texto)
/** Gera um PDF de uma página com linhas de texto (Helvetica, WinAnsi). */
export function pdfTexto(linhas) {
  const escPdf = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const corpo = ['BT', '/F1 9 Tf', '11 TL', '36 806 Td', ...linhas.map((l) => `(${escPdf(l)}) '`), 'ET'].join('\n');
  const conteudo = Buffer.from(corpo, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = partes[0].length;
  objs.forEach((o, i) => {
    const b = o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${conteudo.length} >>\nstream\n`, 'latin1'), conteudo, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    offsets.push(pos); partes.push(b); pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  partes.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(partes);
}

export function danfe({ chave, numero, serie, emit, dest, dhEmi, vNF, vProd, vICMS, natOp = 'VENDA DE MERCADORIA' }) {
  const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n = String(numero).padStart(9, '0');
  return pdfTexto([
    'DANFE',
    'DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA',
    `${emit.nome}`,
    `Nº ${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6)}   SÉRIE ${serie}`,
    'CHAVE DE ACESSO',
    chave.match(/.{1,4}/g).join(' '),
    `NATUREZA DA OPERAÇÃO`,
    natOp,
    `CNPJ ${formatarCnpj(emit.cnpj)}   INSCRIÇÃO ESTADUAL ${emit.ie}`,
    'DESTINATÁRIO / REMETENTE',
    `${dest.nome}   CNPJ ${formatarCnpj(dest.cnpj)}`,
    `DATA DA EMISSÃO ${dhEmi.slice(8, 10)}/${dhEmi.slice(5, 7)}/${dhEmi.slice(0, 4)}`,
    'CÁLCULO DO IMPOSTO',
    `VALOR DO ICMS ${brl(vICMS)}`,
    `VALOR TOTAL DOS PRODUTOS ${brl(vProd)}`,
    `VALOR TOTAL DA NOTA ${brl(vNF)}`,
  ]);
}

export { dvChave };
