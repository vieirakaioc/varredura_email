// Leitura de XMLs fiscais e normalização para um formato único de documento.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { num, soDigitos } from '../util/num.js';
import { limparId } from '../fiscal/validadores.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,      // preserva zeros à esquerda (CST "00", NCM, CFOP)
  parseAttributeValue: false,
  trimValues: true,
  isArray: (nome) => ['det', 'NFref', 'dup', 'obsCont', 'detPag'].includes(nome),
});

export function lerXml(buffer) {
  let texto = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  if (/encoding=["']ISO-8859-1["']/i.test(texto.slice(0, 200)) && Buffer.isBuffer(buffer)) texto = buffer.toString('latin1');
  const valido = XMLValidator.validate(texto);
  if (valido !== true) throw new Error(`XML malformado ou incompleto (linha ${valido.err?.line}: ${valido.err?.msg})`);
  return parser.parse(texto);
}

// ---------------------------------------------------------------- utilitários
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (v == null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
const primeiroFilho = (o) => (o && typeof o === 'object' ? Object.values(o).find((v) => v && typeof v === 'object') : null);

/** Busca profunda pelo primeiro nó com um dos nomes (sem diferenciar maiúsculas). */
function achar(o, nomes, profundidadeMax = 12) {
  const alvo = arr(nomes).map((n) => n.toLowerCase());
  const fila = [[o, 0]];
  while (fila.length) {
    const [n, d] = fila.shift();
    if (!n || typeof n !== 'object' || d > profundidadeMax) continue;
    for (const [k, v] of Object.entries(n)) {
      if (alvo.includes(k.toLowerCase())) return v;
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') fila.push([v, d + 1]);
  }
  return undefined;
}
const acharTxt = (o, nomes) => txt(achar(o, nomes));

function dataIso(v) {
  const s = txt(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/);
  if (m) return m[2] ? `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}` : m[1];
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : s;
}

// ---------------------------------------------------------------- detecção
export function detectarTipoXml(obj) {
  if (!obj || typeof obj !== 'object') return 'desconhecido';
  const raiz = Object.keys(obj).filter((k) => !k.startsWith('?'));
  const tem = (n) => raiz.some((r) => r.toLowerCase() === n.toLowerCase());
  if (tem('nfeProc') || tem('NFe')) return 'nfe';
  if (tem('cteProc') || tem('CTe') || tem('cteOSProc') || tem('CTeOS')) return 'cte';
  if (tem('procEventoNFe') || tem('evento') || tem('procEventoCTe')) return 'evento';
  if (tem('resNFe')) return 'resumo_nfe';
  if (tem('NFSe') || tem('CompNfse') || tem('Nfse') || tem('ConsultarNfseResposta') || tem('ConsultarNfseServicoPrestadoResposta')
    || tem('ConsultarLoteRpsResposta') || tem('ListaNfse') || tem('GerarNfseResposta') || tem('EnviarLoteRpsSincronoResposta')) return 'nfse';
  if (achar(obj, ['InfNfse', 'infNFSe'])) return 'nfse';
  return 'desconhecido';
}

// ---------------------------------------------------------------- NF-e / NFC-e
function lerIcms(grupo) {
  const g = primeiroFilho(grupo) || {};
  const cst = txt(g.CST) ?? txt(g.CSOSN);
  const icms = {
    cst, origem: txt(g.orig), modalidade_bc: txt(g.modBC),
    base: num(txt(g.vBC)), aliquota: num(txt(g.pICMS)), valor: num(txt(g.vICMS)), reducao_bc: num(txt(g.pRedBC)),
  };
  // Simples Nacional com crédito (CSOSN 101/201/900)
  if (g.pCredSN != null) icms.credito_sn = { aliquota: num(txt(g.pCredSN)), valor: num(txt(g.vCredICMSSN)) };
  const st = (g.vBCST != null || g.vICMSST != null) ? {
    cst, modalidade_bc: txt(g.modBCST), base: num(txt(g.vBCST)), aliquota: num(txt(g.pICMSST)),
    valor: num(txt(g.vICMSST)), mva: num(txt(g.pMVAST)), reducao_bc: num(txt(g.pRedBCST)),
  } : null;
  const fcp = g.vFCP != null ? { base: num(txt(g.vBCFCP)), aliquota: num(txt(g.pFCP)), valor: num(txt(g.vFCP)) } : null;
  return { icms, st, fcp };
}

function lerTributoPisCofins(grupo, sufixo) {
  const g = primeiroFilho(grupo);
  if (!g) return null;
  return {
    cst: txt(g.CST), base: num(txt(g.vBC)), aliquota: num(txt(g[`p${sufixo}`])), valor: num(txt(g[`v${sufixo}`])),
  };
}

function lerIpi(ipi) {
  if (!ipi) return null;
  const trib = ipi.IPITrib || ipi.IPINT || {};
  return { cst: txt(trib.CST), base: num(txt(trib.vBC)), aliquota: num(txt(trib.pIPI)), valor: num(txt(trib.vIPI)) };
}

export function normalizarNFe(obj) {
  const nfe = obj.nfeProc?.NFe ?? obj.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw new Error('Estrutura de NF-e não reconhecida (infNFe ausente)');
  const prot = obj.nfeProc?.protNFe?.infProt;
  const ide = inf.ide || {}, emit = inf.emit || {}, dest = inf.dest || {};
  const tot = inf.total?.ICMSTot || {};
  const chave = soDigitos(txt(inf['@_Id'])).length === 44 ? limparId(txt(inf['@_Id']).replace(/^NFe/, '')) : limparId(txt(prot?.chNFe));
  const cStat = txt(prot?.cStat);

  const itens = arr(inf.det).map((d, i) => {
    const p = d.prod || {}, imp = d.imposto || {};
    const impostos = {};
    if (imp.ICMS) {
      const { icms, st, fcp } = lerIcms(imp.ICMS);
      impostos.ICMS = icms;
      if (st) impostos.ICMSST = st;
      if (fcp) impostos.FCP = fcp;
    }
    const difal = imp.ICMSUFDest;
    if (difal) impostos.DIFAL = { base: num(txt(difal.vBCUFDest)), aliquota: num(txt(difal.pICMSUFDest)), valor: num(txt(difal.vICMSUFDest)) };
    const ipi = lerIpi(imp.IPI);
    if (ipi) impostos.IPI = ipi;
    const pis = lerTributoPisCofins(imp.PIS, 'PIS');
    if (pis) impostos.PIS = pis;
    const cofins = lerTributoPisCofins(imp.COFINS, 'COFINS');
    if (cofins) impostos.COFINS = cofins;
    if (imp.ISSQN) impostos.ISS = { base: num(txt(imp.ISSQN.vBC)), aliquota: num(txt(imp.ISSQN.vAliq)), valor: num(txt(imp.ISSQN.vISSQN)) };
    return {
      n_item: Number(txt(d['@_nItem'])) || i + 1,
      codigo: txt(p.cProd), ean: txt(p.cEAN), descricao: txt(p.xProd), pedido: txt(p.xPed), ncm: txt(p.NCM), cest: txt(p.CEST),
      cfop: txt(p.CFOP), unidade: txt(p.uCom), quantidade: num(txt(p.qCom)), valor_unitario: num(txt(p.vUnCom)),
      valor_total: num(txt(p.vProd)), v_desconto: num(txt(p.vDesc)), v_frete: num(txt(p.vFrete)),
      v_seguro: num(txt(p.vSeg)), v_outro: num(txt(p.vOutro)), impostos,
    };
  });

  const modelo = txt(ide.mod);
  return {
    tipo: modelo === '65' ? 'NFCE' : 'NFE',
    modelo,
    origem_dados: 'xml',
    confianca: 1,
    chave_acesso: chave || null,
    numero: txt(ide.nNF),
    serie: txt(ide.serie),
    data_emissao: dataIso(ide.dhEmi ?? ide.dEmi),
    data_entrada: dataIso(ide.dhSaiEnt ?? ide.dSaiEnt),
    natureza_operacao: txt(ide.natOp),
    tipo_operacao: txt(ide.tpNF),
    finalidade: txt(ide.finNFe),
    protocolo: txt(prot?.nProt),
    situacao_sefaz: cStat ? (['100', '150'].includes(cStat) ? 'autorizada' : `cStat ${cStat}`) : 'sem_protocolo',
    emitente: {
      cnpj: limparId(txt(emit.CNPJ) ?? txt(emit.CPF)), nome: txt(emit.xNome), fantasia: txt(emit.xFant), ie: txt(emit.IE),
      uf: txt(emit.enderEmit?.UF), municipio: txt(emit.enderEmit?.xMun), crt: txt(emit.CRT),
    },
    destinatario: {
      cnpj: limparId(txt(dest.CNPJ) ?? txt(dest.CPF) ?? txt(dest.idEstrangeiro)), nome: txt(dest.xNome), ie: txt(dest.IE),
      uf: txt(dest.enderDest?.UF), ind_ie: txt(dest.indIEDest),
    },
    totais: {
      v_prod: num(txt(tot.vProd)), v_frete: num(txt(tot.vFrete)), v_seguro: num(txt(tot.vSeg)), v_desconto: num(txt(tot.vDesc)),
      v_outro: num(txt(tot.vOutro)), v_bc_icms: num(txt(tot.vBC)), v_icms: num(txt(tot.vICMS)), v_icms_deson: num(txt(tot.vICMSDeson)),
      v_bc_st: num(txt(tot.vBCST)), v_icms_st: num(txt(tot.vST)), v_fcp: num(txt(tot.vFCP)), v_fcp_st: num(txt(tot.vFCPST)),
      v_ipi: num(txt(tot.vIPI)), v_ipi_devol: num(txt(tot.vIPIDevol)), v_ii: num(txt(tot.vII)), v_pis: num(txt(tot.vPIS)),
      v_cofins: num(txt(tot.vCOFINS)), v_servicos: num(txt(inf.total?.ISSQNtot?.vServ)), v_iss: num(txt(inf.total?.ISSQNtot?.vISS)),
      v_total: num(txt(tot.vNF)),
    },
    referencias: arr(ide.NFref).map((r) => txt(r.refNFe) ?? txt(r.refCTe)).filter(Boolean),
    informacoes_complementares: txt(inf.infAdic?.infCpl),
    cobranca: lerCobranca(inf),
    itens,
  };
}

// Grupo de cobrança (fatura + duplicatas) e formas de pagamento.
const FORMA_PAGAMENTO = { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja', '15': 'Boleto bancário', '16': 'Depósito bancário', '17': 'PIX', '18': 'Transferência', '19': 'Programa de fidelidade', '90': 'Sem pagamento', '99': 'Outros' };
function lerCobranca(inf) {
  const fat = inf.cobr?.fat;
  const duplicatas = arr(inf.cobr?.dup).map((d, i) => ({ numero: txt(d.nDup) ?? String(i + 1).padStart(3, '0'), vencimento: dataIso(d.dVenc), valor: num(txt(d.vDup)) }));
  const pagamentos = arr(inf.pag?.detPag).map((p) => ({ forma: txt(p.tPag), descricao: FORMA_PAGAMENTO[txt(p.tPag)] ?? txt(p.xPag) ?? txt(p.tPag), valor: num(txt(p.vPag)), prazo: txt(p.indPag) === '1' ? 'a prazo' : txt(p.indPag) === '0' ? 'à vista' : null }));
  if (!fat && !duplicatas.length && !pagamentos.length) return null;
  return {
    fatura: fat ? { numero: txt(fat.nFat), valor_original: num(txt(fat.vOrig)), desconto: num(txt(fat.vDesc)), valor_liquido: num(txt(fat.vLiq)) } : null,
    duplicatas, pagamentos,
  };
}

// ---------------------------------------------------------------- CT-e
export function normalizarCTe(obj) {
  const cte = obj.cteProc?.CTe ?? obj.CTe ?? obj.cteOSProc?.CTeOS ?? obj.CTeOS;
  const inf = cte?.infCte;
  if (!inf) throw new Error('Estrutura de CT-e não reconhecida (infCte ausente)');
  const prot = (obj.cteProc ?? obj.cteOSProc)?.protCTe?.infProt;
  const ide = inf.ide || {}, emit = inf.emit || {};
  const chave = limparId(txt(inf['@_Id'])?.replace(/^CTe/, '') ?? txt(prot?.chCTe));

  // Tomador do serviço (quem paga o frete) = destinatário para fins de escrituração.
  const papeis = { 0: inf.rem, 1: inf.exped, 2: inf.receb, 3: inf.dest };
  const tomaCod = txt(ide.toma3?.toma ?? ide.toma03?.toma);
  const tomador = tomaCod != null ? papeis[tomaCod] : (ide.toma4 ?? inf.toma);
  const endTom = tomador?.enderReme ?? tomador?.enderExped ?? tomador?.enderReceb ?? tomador?.enderDest ?? tomador?.enderToma ?? {};

  const icmsGrupo = primeiroFilho(inf.imp?.ICMS) || {};
  const vPrest = num(txt(inf.vPrest?.vTPrest));
  const icms = {
    cst: txt(icmsGrupo.CST) ?? (icmsGrupo.indSN ? 'SN' : null),
    base: num(txt(icmsGrupo.vBC ?? icmsGrupo.vBCOutraUF)),
    aliquota: num(txt(icmsGrupo.pICMS ?? icmsGrupo.pICMSOutraUF)),
    valor: num(txt(icmsGrupo.vICMS ?? icmsGrupo.vICMSOutraUF)),
    reducao_bc: num(txt(icmsGrupo.pRedBC ?? icmsGrupo.pRedBCOutraUF)),
  };
  const cStat = txt(prot?.cStat);
  return {
    tipo: 'CTE',
    modelo: txt(ide.mod) ?? '57',
    origem_dados: 'xml',
    confianca: 1,
    chave_acesso: chave || null,
    numero: txt(ide.nCT),
    serie: txt(ide.serie),
    data_emissao: dataIso(ide.dhEmi),
    data_entrada: null,
    natureza_operacao: txt(ide.natOp),
    tipo_operacao: '1',
    finalidade: txt(ide.tpCTe),
    protocolo: txt(prot?.nProt),
    situacao_sefaz: cStat ? (['100', '150'].includes(cStat) ? 'autorizada' : `cStat ${cStat}`) : 'sem_protocolo',
    emitente: {
      cnpj: limparId(txt(emit.CNPJ) ?? txt(emit.CPF)), nome: txt(emit.xNome), fantasia: txt(emit.xFant), ie: txt(emit.IE),
      uf: txt(emit.enderEmit?.UF), municipio: txt(emit.enderEmit?.xMun), crt: txt(emit.CRT),
    },
    destinatario: {
      cnpj: limparId(txt(tomador?.CNPJ) ?? txt(tomador?.CPF)), nome: txt(tomador?.xNome), ie: txt(tomador?.IE), uf: txt(endTom.UF),
    },
    transporte: { uf_inicio: txt(ide.UFIni), uf_fim: txt(ide.UFFim), municipio_inicio: txt(ide.xMunIni), municipio_fim: txt(ide.xMunFim), tomador: tomaCod },
    totais: {
      v_prod: vPrest, v_frete: null, v_seguro: null, v_desconto: null, v_outro: null,
      v_bc_icms: icms.base, v_icms: icms.valor, v_total: num(txt(inf.vPrest?.vRec)) ?? vPrest, v_servicos: vPrest,
    },
    referencias: arr(inf.infCTeNorm?.infDoc?.infNFe).map((n) => txt(n.chave)).filter(Boolean),
    itens: [{
      n_item: 1, codigo: 'FRETE', descricao: `Prestação de serviço de transporte ${txt(ide.xMunIni) ?? ''}/${txt(ide.UFIni) ?? ''} → ${txt(ide.xMunFim) ?? ''}/${txt(ide.UFFim) ?? ''}`.trim(),
      cfop: txt(ide.CFOP), unidade: 'SV', quantidade: 1, valor_unitario: vPrest, valor_total: vPrest,
      impostos: { ICMS: icms },
    }],
  };
}

// ---------------------------------------------------------------- NFS-e
export function normalizarNFSe(obj) {
  // Padrão Nacional (Sefin Nacional / ADN)
  const nac = achar(obj, ['infNFSe']);
  if (nac && (nac.DPS || nac.emit)) {
    const dps = nac.DPS?.infDPS || {};
    const serv = dps.serv || {};
    const trib = dps.valores?.trib || {};
    const vServ = num(txt(dps.valores?.vServPrest?.vServ));
    const aliq = num(txt(trib.tribMun?.pAliq));
    const vIss = num(txt(nac.valores?.vISSQN));
    const pisCofins = trib.tribFed?.piscofins || {};
    const idNac = soDigitos(txt(nac['@_Id']));
    const cnpjPrest = limparId(txt(nac.emit?.CNPJ) ?? txt(nac.emit?.CPF) ?? txt(dps.prest?.CNPJ));
    const impostos = { ISS: { cst: txt(trib.tribMun?.tribISSQN), base: num(txt(nac.valores?.vBC)) ?? vServ, aliquota: aliq, valor: vIss } };
    if (pisCofins.CST) {
      impostos.PIS = { cst: txt(pisCofins.CST), base: num(txt(pisCofins.vBCPisCofins)), aliquota: num(txt(pisCofins.pAliqPis)), valor: num(txt(pisCofins.vPis)) };
      impostos.COFINS = { cst: txt(pisCofins.CST), base: num(txt(pisCofins.vBCPisCofins)), aliquota: num(txt(pisCofins.pAliqCofins)), valor: num(txt(pisCofins.vCofins)) };
    }
    return {
      tipo: 'NFSE', modelo: 'NFSE-NAC', origem_dados: 'xml', confianca: 1,
      chave_acesso: idNac ? `NFSE${idNac}` : null,
      numero: txt(nac.nNFSe), serie: txt(dps.serie),
      data_emissao: dataIso(dps.dhEmi ?? nac.dhProc), data_entrada: null,
      natureza_operacao: txt(serv.cServ?.xDescServ)?.slice(0, 120) ?? 'Prestação de serviço',
      tipo_operacao: '1', finalidade: '1', protocolo: txt(nac.nDFSe), situacao_sefaz: 'autorizada',
      emitente: { cnpj: cnpjPrest, nome: txt(nac.emit?.xNome), fantasia: txt(nac.emit?.xFant), ie: txt(nac.emit?.IM), uf: txt(nac.emit?.enderNac?.UF), municipio: txt(nac.xLocEmi), crt: null },
      destinatario: { cnpj: limparId(txt(dps.toma?.CNPJ) ?? txt(dps.toma?.CPF)), nome: txt(dps.toma?.xNome), ie: null, uf: txt(dps.toma?.end?.endNac?.UF) },
      totais: {
        v_prod: vServ, v_servicos: vServ, v_iss: vIss, v_pis: impostos.PIS?.valor ?? null, v_cofins: impostos.COFINS?.valor ?? null, v_total: vServ,
        v_liquido: num(txt(nac.valores?.vLiq)) ?? vServ,
        v_retencoes: (() => { const t = (num(txt(trib.tribFed?.vRetIRRF)) ?? 0) + (num(txt(trib.tribFed?.vRetCP)) ?? 0) + (num(txt(trib.tribFed?.vRetCSLL)) ?? 0); return t || null; })(),
      },
      retencoes: { irrf: num(txt(trib.tribFed?.vRetIRRF)), inss: num(txt(trib.tribFed?.vRetCP)), csrf: num(txt(trib.tribFed?.vRetCSLL)) },
      municipio_ibge: idNac ? idNac.slice(0, 7) : null,
      referencias: [],
      itens: [{
        n_item: 1, codigo: txt(serv.cServ?.cTribNac), descricao: txt(serv.cServ?.xDescServ), cfop: null, unidade: 'SV',
        quantidade: 1, valor_unitario: vServ, valor_total: vServ, impostos,
      }],
    };
  }

  // Layouts municipais (ABRASF 1.x/2.x, Agili e similares): busca por nomes de tags usuais em qualquer nível.
  const inf = achar(obj, ['InfNfse']) ?? achar(obj, ['Nfse']) ?? obj;
  const decl = achar(inf, ['InfDeclaracaoPrestacaoServico', 'DeclaracaoPrestacaoServico']) || inf;
  const servico = achar(decl, ['Servico']) || decl;
  const valores = servico.Valores || achar(inf, ['ValoresNfse']) || decl;
  const prest = achar(inf, ['PrestadorServico', 'Prestador', 'DadosPrestador']) || {};
  const idPrest = achar(decl, ['IdentificacaoPrestador']) || prest;
  const tom = achar(decl, ['TomadorServico', 'Tomador', 'DadosTomador']) || {};
  const v = (...nomes) => num(acharTxt(valores, nomes) ?? acharTxt(decl, nomes) ?? acharTxt(inf, nomes));
  const cnpjPrest = limparId(acharTxt(idPrest, ['Cnpj', 'Cpf']) ?? acharTxt(prest, ['Cnpj', 'Cpf']));
  const numero = txt(inf.Numero) ?? acharTxt(inf, ['NumeroNfse', 'Numero']);
  const vServ = v('ValorServicos', 'ValorServico');
  const aliqRaw = v('AliquotaISSQN', 'Aliquota', 'AliquotaIss');
  const aliq = aliqRaw != null && aliqRaw < 1 && aliqRaw > 0 ? aliqRaw * 100 : aliqRaw; // ABRASF 1.0 usa fração (0.05)
  const municipio = acharTxt(achar(decl, ['MunicipioIncidencia']) ?? {}, ['CodigoMunicipioIBGE', 'CodigoMunicipio'])
    ?? acharTxt(servico, ['CodigoMunicipio', 'MunicipioIncidencia']) ?? acharTxt(inf, ['CodigoMunicipioIBGE']);
  const retidoFlag = acharTxt(decl, ['IssRetido', 'ISSQNRetido']) ?? acharTxt(servico, ['IssRetido']);
  const issRetido = retidoFlag === '1';
  const vIss = v('ValorIss', 'ValorISSQNRecolher', 'ValorISSQNCalculado');
  const ret = {
    iss_retido: issRetido ? (v('ValorIssRetido') ?? vIss) : 0,
    irrf: v('ValorIr', 'ValorIrrf'), inss: v('ValorInss'), pis: v('ValorPis'), cofins: v('ValorCofins'), csll: v('ValorCsll'),
    outras: v('OutrasRetencoes', 'ValorOutrasRetencoes'),
  };
  const somaRet = Math.round(Object.values(ret).reduce((a, x) => a + (x ?? 0), 0) * 100) / 100;
  const impostos = { ISS: { cst: issRetido ? 'RETIDO' : null, base: v('BaseCalculo', 'ValorBaseCalculoISSQN') ?? vServ, aliquota: aliq, valor: vIss } };
  if (ret.pis) impostos.PIS = { cst: 'RETIDO', valor: ret.pis };
  if (ret.cofins) impostos.COFINS = { cst: 'RETIDO', valor: ret.cofins };
  if (!cnpjPrest && !numero && vServ == null) throw new Error('Layout de NFS-e não reconhecido');
  return {
    tipo: 'NFSE', modelo: 'NFSE-MUNICIPAL', origem_dados: 'xml', confianca: 1,
    // NFS-e municipal não tem chave nacional: identificador sintético prestador+município+número
    chave_acesso: cnpjPrest && numero ? `NFSE:${cnpjPrest}:${municipio ?? ''}:${numero}` : null,
    numero, serie: acharTxt(decl, ['Serie']),
    data_emissao: dataIso(txt(inf.DataEmissao) ?? acharTxt(decl, ['DataEmissao', 'Competencia'])), data_entrada: null,
    natureza_operacao: 'Prestação de serviço', tipo_operacao: '1', finalidade: '1',
    protocolo: txt(inf.CodigoVerificacao) ?? txt(inf.CodigoAutenticidade), situacao_sefaz: 'autorizada',
    municipio_ibge: municipio,
    emitente: { cnpj: cnpjPrest, nome: acharTxt(prest, ['RazaoSocial']), fantasia: acharTxt(prest, ['NomeFantasia']), ie: acharTxt(idPrest, ['InscricaoMunicipal']), uf: acharTxt(prest, ['Uf']), municipio: null, crt: null },
    destinatario: { cnpj: limparId(acharTxt(tom, ['Cnpj', 'Cpf'])), nome: acharTxt(tom, ['RazaoSocial']), ie: null, uf: acharTxt(tom, ['Uf']) },
    totais: {
      v_prod: vServ, v_servicos: vServ, v_iss: vIss, v_pis: ret.pis, v_cofins: ret.cofins, v_total: vServ,
      v_liquido: v('ValorLiquidoNfse', 'ValorLiquido') ?? (vServ != null ? Math.round((vServ - somaRet) * 100) / 100 : null), v_retencoes: somaRet || null,
    },
    retencoes: ret,
    referencias: [],
    itens: [{
      n_item: 1, codigo: acharTxt(servico, ['ItemListaServico', 'ItemLei116AtividadeEconomica', 'CodigoTributacaoMunicipio']),
      descricao: acharTxt(servico, ['Discriminacao']) ?? acharTxt(decl, ['Discriminacao']),
      cfop: null, unidade: 'SV', quantidade: 1, valor_unitario: vServ, valor_total: vServ, impostos,
    }],
  };
}

// ---------------------------------------------------------------- eventos
export function normalizarEvento(obj) {
  const proc = obj.procEventoNFe ?? obj.procEventoCTe ?? obj;
  const inf = (proc.evento ?? proc.eventoCTe)?.infEvento;
  if (!inf) throw new Error('Evento não reconhecido');
  const det = inf.detEvento || {};
  const ret = (proc.retEvento ?? proc.retEventoCTe)?.infEvento;
  return {
    tipo: 'EVENTO',
    chave_acesso: limparId(txt(inf.chNFe) ?? txt(inf.chCTe)),
    tp_evento: txt(inf.tpEvento),
    descricao: txt(det.descEvento) ?? txt(det.evCancCTe?.descEvento),
    texto: txt(det.xCorrecao) ?? txt(det.xJust) ?? txt(det.evCancCTe?.xJust),
    data: dataIso(inf.dhEvento),
    homologado: ret ? ['135', '136', '155'].includes(txt(ret.cStat)) : null,
  };
}

/** Lê um XML e devolve { tipo, documento | evento }. */
export function processarXml(buffer) {
  const obj = lerXml(buffer);
  const tipo = detectarTipoXml(obj);
  switch (tipo) {
    case 'nfe': return { tipo: 'nfe_xml', documento: normalizarNFe(obj) };
    case 'cte': return { tipo: 'cte_xml', documento: normalizarCTe(obj) };
    case 'nfse': return { tipo: 'nfse_xml', documento: normalizarNFSe(obj) };
    case 'evento': return { tipo: 'evento_xml', evento: normalizarEvento(obj) };
    case 'resumo_nfe': return { tipo: 'outro', motivo: 'Resumo de NF-e (resNFe) sem itens: aguarde o XML completo' };
    default: return { tipo: 'outro', motivo: 'XML não é um documento fiscal reconhecido' };
  }
}
