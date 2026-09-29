// Leitura de PDFs (DANFE, DACTE, NFS-e). Extrai o texto e aplica heurísticas.
// PDFs escaneados (sem texto) são encaminhados para a camada de IA, quando habilitada.
import { encontrarChaves, encontrarChavesNFSe, decomporChaveNFSe, cnpjValido, limparId, decomporChave } from '../fiscal/validadores.js';
import { num } from '../util/num.js';

let pdfjs;
async function carregarPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

export async function extrairTextoPdf(buffer, maxPaginas = 10) {
  const lib = await carregarPdfjs();
  const tarefa = lib.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  });
  const doc = await tarefa.promise;
  const paginas = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPaginas); p++) {
      const page = await doc.getPage(p);
      const conteudo = await page.getTextContent();
      // Agrupa itens por linha (coordenada Y) para preservar a leitura do layout.
      const linhas = new Map();
      for (const it of conteudo.items) {
        if (!it.str?.trim()) continue;
        const y = Math.round(it.transform[5] / 3) * 3;
        if (!linhas.has(y)) linhas.set(y, []);
        linhas.get(y).push({ x: it.transform[4], s: it.str });
      }
      const texto = [...linhas.entries()].sort((a, b) => b[0] - a[0])
        .map(([, l]) => l.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ')).join('\n');
      paginas.push(texto);
    }
    return { texto: paginas.join('\n\f\n'), paginas: doc.numPages };
  } finally {
    await tarefa.destroy();
  }
}

export function classificarTextoPdf(texto) {
  const t = (texto || '').toUpperCase();
  if (!t.trim()) return 'pdf_sem_texto';
  if (t.includes('DACTE') || t.includes('CONHECIMENTO DE TRANSPORTE')) return 'dacte_pdf';
  // Sinais fortes de NFS-e têm prioridade (há PDFs com nota + boleto juntos).
  const nfseForte = t.includes('DANFSE') || /N[ÚU]MERO DA (NFS-?E|NOTA)/.test(t) || /NOTA FISCAL (ELETR[ÔO]NICA )?DE SERVI[ÇC]OS?/.test(t) || encontrarChavesNFSe(texto).length > 0;
  const boleto = /\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14}/.test(texto) || (/NOSSO N[ÚU]MERO/.test(t) && /BENEFICI[ÁA]RIO/.test(t));
  if (nfseForte) return 'nfse_pdf';
  if (boleto) return 'boleto_pdf';
  // Boletos e DANFE podem conter sequências numéricas longas: exige a identificação textual de NFS-e.
  if (t.includes('NFS-E') || t.includes('DANFSE')) return 'nfse_pdf';
  if (t.includes('DANFE') || t.includes('DOCUMENTO AUXILIAR DA NOTA FISCAL')) return 'danfe_pdf';
  if (encontrarChaves(texto).length) return 'danfe_pdf';
  return 'pdf_desconhecido';
}

function valorApos(texto, rotulos) {
  for (const r of rotulos) {
    const re = new RegExp(`${r}[^\\d\\n]{0,40}\\n?[^\\d\\n]{0,40}?((?:\\d{1,3}\\.)*\\d{1,3},\\d{2})`, 'i');
    const m = texto.match(re);
    if (m) return num(m[1]);
  }
  return null;
}

// ------------------------------------------------------------------ NFS-e em PDF
// Os DANFSe trazem rótulos numa linha e os valores na(s) linha(s) seguinte(s), em colunas.
const RE_TOKEN = /\d+(?:[.,]\d+)?\s*%|R\$\s*-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d{1,3}(?:\.\d{3})*,\d+|\d+\.\d{2}(?!\d)|N[ãa]o Retido|Retido(?: pelo \w+)?|SimN[ãa]o|Sim|N[ãa]o|-/gi;
const RE_DINHEIRO = /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}|\d+\.\d{2})(?!\d)(?!\s*%)/;

function tokensDaLinha(linha) {
  // aceita um rótulo curto no início da linha de valores (ex.: "Federais 0,00 0,00 ...")
  const l = linha.replace(/\bSim\s+N[ãa]o\b/gi, 'SimNão').replace(/^\s*[A-Za-zÀ-ú]{3,15}\s+(?=(?:R\$|-?\d))/, '');
  const tokens = l.match(RE_TOKEN) ?? [];
  const sobra = l.replace(RE_TOKEN, '').replace(/[\s|/]+/g, '');
  return sobra ? null : tokens; // só aceita linhas compostas apenas de valores
}

const COLUNAS_NFSE = [
  // ISSNet (ex.: Ribeirão Preto): "Total de Retenção | Valor Total do CBS | Valor Total do IBS | Valor Total Líquido | Valor Total da Nota Fiscal - IBS/CBS"
  // A última coluna é o líquido sem IBS/CBS, não o valor da nota: fica em campo próprio (vem antes de 'total' para ganhar a posição).
  ['total_menos_ibscbs', /Valor Total da Nota Fiscal - IBS\/CBS/i],
  ['total', /VALOR TOTAL DA NFS-?e|Total do\(s\) Servi[çc]o\(s\)|Valor Total da Nota|VALOR DA OPERA[ÇC][ÃA]O/i],
  ['liquido', /VALOR L[ÍI]QUIDO DA NFS-?e(?! \+)|Total L[íi]quido|Valor L[íi]quido/i],
  ['liquido_ibs', /L[ÍI]QUIDO DA NFS-?e \+/i],
  ['retencoes', /Total das Reten[çc][õo]es|Total de Reten[çc][ãa]o|^Reten[çc][õo]es \(R\$\)/i],
  ['ibscbs', /Total do IBS\/CBS/i],
  ['cbs_total', /Valor Total do CBS/i],
  ['ibs_total', /Valor Total do IBS/i],
  ['desconto_incond', /Desc(?:\.|onto) incondicionado/i],
  ['desconto_cond', /Desc(?:\.|onto) condicionado/i],
  ['bc', /BC ISSQN|Base de C[áa]lculo/i],
  ['aliquota', /Al[íi]q(?:uota|\.)(?: Aplicada| \(%\))?/i],
  ['iss_retido_flag', /Reten[çc][ãa]o do ISSQN|ISSQN Retido(?! pelo)|ISS a Reter/i],
  ['iss_retido_valor', /Valor (?:do )?ISS(?:QN)? Retido/i],
  ['iss', /ISSQN Apurado|Valor do ISSQN|Valor ISSQN(?! Retido)|Valor do ISS(?! Retido)/i],
  ['iss_ret_col', /^ISSQN \(R\$\)/i],
  ['outras_ret', /Outras reten/i],
  ['irrf', /\bIRRF\b|\bIR\b(?!RF)/i],
  ['inss', /Contribui[çc][ãa]o Previdenci[áa]ria|\bINSS\b/i],
  ['csrf', /Contribui[çc][õo]es Sociais/i],
  ['pis', /\bPIS\b(?! - D[ée]bito)/i],
  ['cofins', /\bCOFINS\b(?! - D[ée]bito)/i],
  ['csll', /\bCSLL\b/i],
  ['cbs', /Valor CBS/i],
  ['ibs', /Valor IBS/i],
];

const COLUNAS_DANFE = [
  ['bc_icms', /BASE DE C[ÁA]LCULO DO ICMS(?! S)|BASE DE C[ÁA]LCULO DE ICMS(?! S)/i],
  ['icms', /VALOR DO ICMS(?! S)/i],
  ['bc_st', /BASE DE C[ÁA]LCULO (?:DO |DE )?ICMS S(?:UBST|T)/i],
  ['icms_st', /VALOR DO ICMS S(?:UBST|T)/i],
  ['v_prod', /VALOR TOTAL DOS PRODUTOS/i],
  ['frete', /VALOR DO FRETE/i],
  ['seguro', /VALOR DO SEGURO/i],
  ['desconto', /\bDESCONTO\b/i],
  ['outras', /OUTRAS DESPESAS/i],
  ['ipi', /VALOR (?:TOTAL )?DO IPI/i],
  ['total', /VALOR TOTAL DA NOTA/i],
];

/** Valor da última coluna: quando o rótulo termina a linha de cabeçalho, pega o último valor da linha de valores. */
function ultimaColuna(texto, rotulo) {
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length; i++) {
    if (!rotulo.test(linhas[i]) || !new RegExp(`${rotulo.source}\\s*$`, 'i').test(linhas[i].trim())) continue;
    for (let j = i + 1; j <= Math.min(i + 2, linhas.length - 1); j++) {
      const tokens = tokensDaLinha(linhas[j]);
      if (tokens?.length) return valorToken(tokens[tokens.length - 1]);
    }
  }
  return null;
}

function mapearColunas(texto, definicoes = COLUNAS_NFSE) {
  const linhas = texto.split('\n');
  const r = {};
  for (let i = 0; i < linhas.length; i++) {
    const achados = [];
    for (const [campo, re] of definicoes) {
      const pos = linhas[i].search(re);
      if (pos >= 0 && !achados.some((a) => a.pos === pos)) achados.push({ campo, pos });
    }
    if (achados.length < 2) continue;
    achados.sort((a, b) => a.pos - b.pos);
    for (let j = i + 1; j <= Math.min(i + 3, linhas.length - 1); j++) {
      const tokens = tokensDaLinha(linhas[j]);
      if (!tokens) continue;
      if (tokens.length === achados.length) achados.forEach((a, k) => { if (r[a.campo] === undefined) r[a.campo] = tokens[k]; });
      break;
    }
  }
  return r;
}

function primeiroValorApos(texto, rotulos, janela = 220, maxLinhas = 3) {
  for (const rot of rotulos) {
    const m = texto.match(rot);
    if (!m) continue;
    const trecho = texto.slice(m.index + m[0].length, m.index + m[0].length + janela).split('\n').slice(0, maxLinhas).join('\n');
    const v = trecho.match(RE_DINHEIRO);
    if (v) return num(v[1]);
  }
  return null;
}

const valorToken = (t) => (t == null || t === '-' || /^(Sim|N[ãa]o|SimN[ãa]o|N[ãa]o Retido|Retido)/i.test(t) ? null : num(String(t).replace(/%|R\$/g, '').trim()));
const dataBr = (s) => {
  const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};

/** Ordem de compra citada no documento ("ORDEM DE COMPRA 168.297", "OC: 2744", "Pedido de compra nº 123"). */
export function extrairOrdemCompra(texto) {
  const m = String(texto ?? '').match(/(?:ORDEM\s+DE\s+COMPRAS?|PEDIDO\s+DE\s+COMPRAS?|\bO\.\s?C\.|\bOC\b)\s*(?:N[º°o.]*\s*)?[:\-#]?\s*(\d{1,3}(?:\.\d{3})+|\d{3,9})(?![\d/]|[.,]\d)/i);
  return m ? m[1].replace(/\./g, '') : null;
}

function cnpjsNoTexto(texto) {
  return [...texto.matchAll(/\b([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2})\b/g)].map((m) => ({ cnpj: limparId(m[1]), pos: m.index })).filter((x) => cnpjValido(x.cnpj));
}

/**
 * Extração de NFS-e a partir do texto do PDF (DANFSe nacional, DANFSe municipais e layouts de prefeituras).
 * A chave nacional de 50 dígitos, quando presente, é a fonte mais confiável (prestador, número, município).
 */
export function extrairNFSePdf(texto, { cnpjsGrupo = new Set() } = {}) {
  const chave = encontrarChavesNFSe(texto)[0] ?? null;
  const ch = chave ? decomporChaveNFSe(chave) : null;
  const cnpjs = cnpjsNoTexto(texto);
  const posTomador = texto.search(/TOMADOR/i);
  const posPrestador = texto.search(/PRESTADOR/i);
  const tomador = (posTomador >= 0 ? cnpjs.find((c) => c.pos > posTomador && c.cnpj !== ch?.documento)?.cnpj : null)
    ?? cnpjs.find((c) => cnpjsGrupo.has(c.cnpj))?.cnpj ?? null;
  const prestador = ch?.documento
    ?? (posPrestador >= 0 ? cnpjs.find((c) => c.pos > posPrestador && c.cnpj !== tomador)?.cnpj : null)
    ?? cnpjs.find((c) => c.cnpj !== tomador && !cnpjsGrupo.has(c.cnpj))?.cnpj ?? null;

  // Nome do prestador: dentro do bloco do prestador, a primeira razão social com sufixo societário.
  const fimPrest = posTomador > Math.max(posPrestador, 0) ? posTomador : Math.max(posPrestador, 0) + 900;
  const blocoPrest = texto.slice(Math.max(posPrestador, 0), fimPrest);
  const nomePrest = [...blocoPrest.matchAll(/([A-ZÀ-Ú0-9][^\n:]{2,120}?\b(?:LTDA|S\.?\/?A|EIRELI|MEI?|EPP|SOCIEDADE [^\n]{0,40}|COOPERATIVA[^\n]{0,40})\b\.?)/gi)]
    .map((m) => m[1].replace(/^(?:Nome\s*\/\s*)?Raz[ãa]o(?: Social)?:?\s*/i, '').trim())
    .find((n) => !/NFS-?e|Prestador|Tomador/i.test(n)) ?? null;

  const numero = ch?.numero
    ?? texto.match(/N[ÚU]MERO DA (?:NFS-?E|NOTA)[^\n]*\n\s*(\d{1,15})\b/i)?.[1]
    ?? texto.match(/N[úu]mero \/ S[ée]rie[^\n]*\n[^\n]*?\d{2}\/\d{4}\s+(\d{1,15})\s*\/\s*\w+/i)?.[1]
    ?? texto.match(/N[º°o]\.?\s*(?:da\s*)?(?:NFS-?e|Nota)\s*:?\s*(\d{1,15})/i)?.[1] ?? null;

  const nac = texto.match(/DATA E HORA DA EMISS[ÃA]O DA NFS-?e\s*\n\s*\d+\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{2,4})/i);
  let emissao = nac ? dataBr(nac[2]) : null;
  if (!emissao) {
    const m = texto.match(/emiss[ãa]o/i);
    if (m) emissao = dataBr(texto.slice(m.index, m.index + 160).match(/\d{1,2}\/\d{1,2}\/\d{2,4}/)?.[0]);
  }
  emissao ??= dataBr(texto.match(/\d{2}\/\d{2}\/\d{4}/)?.[0]);

  const col = mapearColunas(texto);
  const total = valorToken(col.total) ?? primeiroValorApos(texto, [/VALOR TOTAL DA NFS-?e[^\n]*/i, /Vl\. do Servi[çc]o:/i, /Valor Total da Nota(?! Fiscal - IBS)/i, /Valor da Nota/i, /Total do\(s\) Servi[çc]o\(s\)/i, /Valor do\(s\) Servi[çc]o\(s\)/i, /VALOR DOS SERVI[ÇC]OS/i, /VALOR TOTAL DO SERVI[ÇC]O/i, /VALOR DA OPERA[ÇC][ÃA]O[^\n]*/i]);
  // ISS/alíquota com trava de sanidade (ISS municipal: até 5%; leitura acima disso é coluna errada)
  let iss = valorToken(col.iss) ?? primeiroValorApos(texto, [/ISSQN Apurado/i, /Valor do ISSQN/i, /Valor do ISS(?! Retido)/i], 120, 2);
  if (iss != null && total && iss > total * 0.1) iss = null;
  let aliquota = valorToken(col.aliquota) ?? num(texto.match(/Al[íi]quota[^\n%]{0,80}?\n?[^\n%]{0,40}?(\d{1,2}[.,]\d{1,4})\s*%/i)?.[1]);
  if (aliquota != null && aliquota > 10) aliquota = null;
  const flagRetido = String(col.iss_retido_flag ?? '');
  const issRetido = /^Retido|^Sim/i.test(flagRetido) || (valorToken(col.iss_retido_valor) ?? 0) > 0;
  const ret = {
    iss_retido: issRetido ? (valorToken(col.iss_retido_valor) ?? iss) : 0,
    irrf: valorToken(col.irrf), inss: valorToken(col.inss), csrf: valorToken(col.csrf),
    pis: valorToken(col.pis), cofins: valorToken(col.cofins), csll: valorToken(col.csll), outras: valorToken(col.outras_ret),
  };
  if (!ret.iss_retido && (valorToken(col.iss_ret_col) ?? 0) > 0) ret.iss_retido = valorToken(col.iss_ret_col);
  const somaRet = Math.round(Object.values(ret).reduce((a, v) => a + (v ?? 0), 0) * 100) / 100;
  // Líquido informado no documento vale mais que o calculado: PIS/COFINS podem aparecer só como informação (não retidos)
  const liquidoInformado = valorToken(col.liquido) ?? valorToken(col.total_menos_ibscbs) ?? primeiroValorApos(texto, [/\(=\)\s*Valor L[íi]quido(?=\s*(?:R\$\s*)?\d)/i], 40, 1);
  const liquido = liquidoInformado ?? (total != null ? Math.round((total - somaRet) * 100) / 100 : null);
  // Com líquido informado, o total retido é a diferença total − líquido (cobre retenções em linha corrida, ex.: "Vl. PIS: R$ ...")
  const retencoesTotal = liquidoInformado != null && total != null
    ? Math.max(0, Math.round((total - liquidoInformado) * 100) / 100)
    : somaRet;

  const vencimentos = [...texto.matchAll(/Vencimentos?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*-\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}))?/gi)]
    .map((m, i, a) => ({ numero: String(i + 1).padStart(3, '0'), vencimento: dataBr(m[1]), valor: num(m[2]) ?? (a.length === 1 ? liquido : null) }))
    .filter((d) => d.vencimento);
  const codigoServico = texto.match(/\b(\d{2}\.\d{2}\.\d{2})\b/)?.[1] ?? texto.match(/C[óo]digo (?:de )?Servi[çc]o[^\n]*\n?\s*(\d{4,6})/i)?.[1] ?? null;
  const descricao = texto.match(/(?:Descri[çc][ãa]o do Servi[çc]o|Discrimina[çc][ãa]o[^\n]*|Descrimina[çc][ãa]o[^\n]*)\s*\n([^\n]{3,300})/i)?.[1]?.trim() ?? null;

  const achou = { id: Boolean(numero), prestador: Boolean(prestador), tomador: Boolean(tomador), total: total != null, data: Boolean(emissao) };
  const confianca = (Object.values(achou).filter(Boolean).length / 5) * (ch ? 0.95 : 0.8);

  return {
    tipo: 'NFSE', modelo: ch ? 'NFSE-NAC' : 'NFSE-PDF', origem_dados: 'pdf_texto', confianca: Math.round(confianca * 100) / 100,
    ordem_compra: extrairOrdemCompra(texto),
    chave_acesso: ch ? `NFSE${ch.chave}` : null,
    numero, serie: null, data_emissao: emissao, data_entrada: null,
    natureza_operacao: 'Prestação de serviço', tipo_operacao: '1', finalidade: '1', protocolo: null, situacao_sefaz: 'desconhecida',
    competencia: ch ? `20${ch.aamm.slice(0, 2)}-${ch.aamm.slice(2)}` : null,
    municipio_ibge: ch?.municipio ?? null,
    emitente: { cnpj: prestador, nome: nomePrest, ie: null, uf: null, crt: null },
    destinatario: { cnpj: tomador, nome: null, ie: null, uf: null },
    totais: {
      v_prod: total, v_servicos: total, v_iss: iss, v_pis: ret.pis, v_cofins: ret.cofins, v_total: total,
      v_liquido: liquido, v_retencoes: retencoesTotal || null,
    },
    retencoes: ret,
    referencias: [],
    cobranca: vencimentos.length ? { fatura: null, duplicatas: vencimentos, pagamentos: [] } : null,
    itens: total != null ? [{
      n_item: 1, codigo: codigoServico, descricao, cfop: null, unidade: 'SV', quantidade: 1, valor_unitario: total, valor_total: total,
      impostos: { ISS: { cst: issRetido ? 'RETIDO' : null, base: valorToken(col.bc) ?? total, aliquota, valor: iss } },
    }] : [],
  };
}

/** Dados mínimos de um boleto: beneficiário, vencimento e valor (para vincular o vencimento à NFS-e). */
export function extrairBoleto(texto, { cnpjsGrupo = new Set() } = {}) {
  const venc = texto.match(/Vencimento[^\d]{0,120}?(\d{2}\/\d{2}\/\d{4})/i)?.[1];
  const valorM = texto.match(/Valor do Documento[\s\S]{0,160}?(\d{1,3}(?:\.\d{3})*,\d{2})/i);
  const beneficiario = cnpjsNoTexto(texto).find((c) => !cnpjsGrupo.has(c.cnpj))?.cnpj ?? null;
  return { vencimento: dataBr(venc), valor: valorM ? num(valorM[1]) : null, beneficiario };
}

/**
 * Extração heurística a partir do texto do DANFE/DACTE/NFS-e.
 * Resultado de baixa confiança: sempre sinalizado como "extraído de PDF".
 */
export function extrairDadosPdf(texto, tipoPdf) {
  const chaves = encontrarChaves(texto);
  const chave = chaves[0] || null;
  const partes = chave ? decomporChave(chave) : null;
  const cnpjs = [...new Set([...(texto.matchAll(/\b([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2})\b/g))]
    .map((m) => limparId(m[1])).filter(cnpjValido))];
  const emitenteCnpj = partes?.cnpj ?? cnpjs[0] ?? null;
  const destinatarioCnpj = cnpjs.find((c) => c !== emitenteCnpj) ?? null;
  const numeroTxt = texto.match(/N[º°o.]\s*[:.]?\s*((?:\d{3}\.){2}\d{3}|\d{1,9})/i)?.[1];
  const serieTxt = texto.match(/S[ÉE]RIE\s*[:.]?\s*(\d{1,3})/i)?.[1];
  // Data: coluna "DATA DA EMISSÃO" (última do cabeçalho do destinatário) ou rótulo seguido da data.
  const linhaEmissao = texto.split('\n').findIndex((l) => /DATA\s+(?:DA\s+|DE\s+)?EMISS[ÃA]O\s*$/i.test(l.trim()));
  const data = (linhaEmissao >= 0 ? texto.split('\n')[linhaEmissao + 1]?.match(/(\d{2}\/\d{2}\/\d{4})\s*$/)?.[1] : null)
    ?? texto.match(/EMISS[ÃA]O:?[^\d\n]{0,30}(\d{2}\/\d{2}\/\d{4})/i)?.[1]
    ?? texto.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1];
  const tipo = tipoPdf === 'dacte_pdf' ? 'CTE' : tipoPdf === 'nfse_pdf' ? 'NFSE' : 'NFE';
  const col = mapearColunas(texto, COLUNAS_DANFE);
  const colValor = (k) => valorToken(col[k]);
  const positivo = (v) => (v != null && v > 0 ? v : null);
  const vTotal = positivo(num(texto.match(/Valor Total:\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i)?.[1])) // canhoto
    ?? positivo(colValor('total')) ?? positivo(ultimaColuna(texto, /VALOR TOTAL DA NOTA/i))
    ?? valorApos(texto, ['VALOR TOTAL DA NOTA', 'V\\. TOTAL DA NOTA', 'VALOR TOTAL DO SERVI[ÇC]O', 'VALOR TOTAL DA PRESTA[ÇC][ÃA]O', 'VALOR L[ÍI]QUIDO', 'VALOR TOTAL']);
  // Emitente: canhoto "RECEBEMOS DE <EMITENTE> OS PRODUTOS..." ou razão social no bloco do emitente
  const canhoto = texto.match(/RECEBEMOS DE\s+(.+?)\s+OS (?:PRODUTOS|SERVI)/i)?.[1]?.trim();
  const nomeEmitente = (canhoto && !/RECEBIMENTO|IDENTIFICA[ÇC][ÃA]O|ASSINATURA/i.test(canhoto) ? canhoto : null)
    ?? texto.slice(Math.max(0, texto.search(/IDENTIFICA[ÇC][ÃA]O DO EMITENTE/i)), Math.max(0, texto.search(/IDENTIFICA[ÇC][ÃA]O DO EMITENTE/i)) + 500)
      .split('\n').map((l) => l.match(/([A-ZÀ-Ú0-9][^\n:]{2,100}?\b(?:LTDA|S\.?\/?A|EIRELI|ME|EPP)\b\.?)/)?.[1])
      .find((n) => n && !/RECEBIMENTO|IDENTIFICA[ÇC][ÃA]O|ASSINATURA|DANFE/i.test(n)) ?? null;
  const campos = {
    chave: Boolean(chave), numero: Boolean(partes?.numero || numeroTxt), emitente: Boolean(emitenteCnpj), total: vTotal != null,
  };
  const confianca = Object.values(campos).filter(Boolean).length / Object.keys(campos).length * 0.7; // teto 0,7 para heurística

  return {
    tipo,
    modelo: partes?.modelo ?? (tipo === 'NFSE' ? 'NFSE' : null),
    origem_dados: 'pdf_texto',
    confianca: Math.round(confianca * 100) / 100,
    chave_acesso: tipo === 'NFSE' ? null : chave,
    numero: partes?.numero ?? (numeroTxt ? String(Number(numeroTxt.replace(/\D/g, ''))) : null),
    serie: partes?.serie ?? serieTxt ?? null,
    data_emissao: data ? `${data.slice(6)}-${data.slice(3, 5)}-${data.slice(0, 2)}` : null,
    data_entrada: null,
    natureza_operacao: texto.match(/NATUREZA D[AE] OPERA[ÇC][ÃA]O\s*\n?\s*([^\n]{3,60})/i)?.[1]?.trim() ?? null,
    tipo_operacao: null, finalidade: null, protocolo: null, situacao_sefaz: 'desconhecida',
    emitente: { cnpj: emitenteCnpj, nome: nomeEmitente, ie: null, uf: null, crt: null },
    destinatario: { cnpj: destinatarioCnpj, nome: null, ie: null, uf: null },
    // Só valores lidos com segurança pelas colunas; o restante fica em branco até chegar o XML.
    totais: {
      v_prod: colValor('v_prod') ?? ultimaColuna(texto, /VALOR TOTAL DOS PRODUTOS/i),
      v_frete: colValor('frete'), v_seguro: colValor('seguro'), v_desconto: colValor('desconto'), v_outro: colValor('outras'),
      v_bc_icms: colValor('bc_icms'), v_icms: colValor('icms'), v_bc_st: colValor('bc_st'), v_icms_st: colValor('icms_st'), v_ipi: colValor('ipi'),
      v_total: vTotal,
    },
    referencias: [],
    itens: [],
    chaves_encontradas: chaves,
  };
}
