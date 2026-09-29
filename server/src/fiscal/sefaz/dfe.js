// Distribuição DF-e (SEFAZ Nacional): baixa os documentos e eventos destinados a cada CNPJ do grupo.
// É assim que o cancelamento feito pelo fornecedor DEPOIS da entrada chega até nós — ninguém precisa avisar.
//
// Serviço: NFeDistribuicaoDFe (ambiente nacional), autenticação por certificado A1 no TLS.
// A cada chamada a SEFAZ devolve até 50 documentos a partir do último NSU lido. A consulta é somente leitura.
import https from 'node:https';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { all, get, insert, run } from '../../db/index.js';
import { log } from '../../util/log.js';
import { dataHoraLocal } from '../../util/data.js';
import { materialTls, cnpjsComCertificado } from './certificados.js';

const URLS = {
  producao: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  homologacao: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
};
const AMBIENTE = process.env.SEFAZ_AMBIENTE === 'homologacao' ? 'homologacao' : 'producao';
const TP_AMB = AMBIENTE === 'homologacao' ? '2' : '1';
const UF_AUTOR = process.env.SEFAZ_UF_AUTOR || '52'; // 52 = GO (só identifica quem consulta)
const MAX_LOTES = Number(process.env.SEFAZ_LOTES_POR_CICLO || 8);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, removeNSPrefix: true });

const EVENTOS = {
  110111: 'Cancelamento', 110112: 'Cancelamento por substituição', 110110: 'Carta de correção',
  110140: 'EPEC', 210200: 'Confirmação da operação', 210210: 'Ciência da operação',
  210220: 'Desconhecimento da operação', 210240: 'Operação não realizada',
};
export const CANCELAMENTOS = ['110111', '110112'];

function envelope(cnpj, { nsu, chave }) {
  const consulta = chave ? `<consChNFe><chNFe>${chave}</chNFe></consChNFe>`
    : `<distNSU><ultNSU>${String(nsu).padStart(15, '0')}</ultNSU></distNSU>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
 <soap12:Body>
  <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
   <nfeDadosMsg>
    <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
     <tpAmb>${TP_AMB}</tpAmb><cUFAutor>${UF_AUTOR}</cUFAutor><CNPJ>${cnpj}</CNPJ>${consulta}
    </distDFeInt>
   </nfeDadosMsg>
  </nfeDistDFeInteresse>
 </soap12:Body>
</soap12:Envelope>`;
}

/** Chamada SOAP com o certificado do CNPJ (mTLS). Devolve o XML de resposta. */
function chamarSefaz(cnpj, corpo) {
  const { pfx, passphrase } = materialTls(cnpj);
  const url = new URL(URLS[AMBIENTE]);
  return new Promise((ok, erro) => {
    const req = https.request({
      host: url.host, path: url.pathname, method: 'POST', pfx, passphrase, minVersion: 'TLSv1.2',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) },
      timeout: 60000,
    }, (res) => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { txt += c; });
      res.on('end', () => (res.statusCode === 200 ? ok(txt) : erro(new Error(`SEFAZ respondeu ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado na SEFAZ')));
    req.on('error', (e) => erro(new Error(/certificate|PFX|mac verify/i.test(e.message) ? `Certificado recusado: ${e.message}` : e.message)));
    req.end(corpo);
  });
}

const texto = (v) => (v == null ? null : String(v).trim() || null);
const dataIso = (v) => (v ? String(v).slice(0, 10) : null);

/** Interpreta um documento do lote (resumo de NF-e, NF-e completa, resumo de evento ou evento). */
export function interpretar(xml, cnpj, nsu) {
  const d = parser.parse(xml);
  const resNFe = d.resNFe;
  const nfe = d.nfeProc?.NFe?.infNFe ?? d.NFe?.infNFe;
  const evento = d.procEventoNFe?.evento?.infEvento ?? d.evento?.infEvento;
  const resEvento = d.resEvento;
  if (resNFe) {
    return { tipo: 'resumo', chave: texto(resNFe.chNFe), tp_evento: null, descricao: 'Resumo de NF-e destinada ao CNPJ',
      data_evento: dataIso(resNFe.dhEmi), emitente_cnpj: texto(resNFe.CNPJ), emitente_nome: texto(resNFe.xNome),
      valor: resNFe.vNF ? Number(resNFe.vNF) : null, data_emissao: dataIso(resNFe.dhEmi), protocolo: texto(resNFe.nProt) };
  }
  if (nfe) {
    const chave = texto(d.nfeProc?.protNFe?.infProt?.chNFe) ?? String(nfe['@Id'] ?? '').replace(/\D/g, '');
    return { tipo: 'resumo', chave, tp_evento: null, descricao: 'NF-e destinada ao CNPJ',
      data_evento: dataIso(nfe.ide?.dhEmi), emitente_cnpj: texto(nfe.emit?.CNPJ), emitente_nome: texto(nfe.emit?.xNome),
      numero: texto(nfe.ide?.nNF), serie: texto(nfe.ide?.serie), valor: nfe.total?.ICMSTot?.vNF ? Number(nfe.total.ICMSTot.vNF) : null,
      data_emissao: dataIso(nfe.ide?.dhEmi), protocolo: texto(d.nfeProc?.protNFe?.infProt?.nProt) };
  }
  const ev = evento ?? resEvento;
  if (ev) {
    const tp = texto(ev.tpEvento);
    return { tipo: 'evento', chave: texto(ev.chNFe), tp_evento: tp,
      descricao: EVENTOS[tp] ?? texto(ev.xEvento) ?? `Evento ${tp}`,
      data_evento: dataIso(ev.dhEvento ?? ev.dhRegEvento), protocolo: texto(ev.nProt ?? d.procEventoNFe?.retEvento?.infEvento?.nProt),
      justificativa: texto(ev.detEvento?.xJust ?? ev.detEvento?.xCorrecao),
      emitente_cnpj: texto(ev.CNPJ ?? ev.CNPJDest) };
  }
  log('alerta', 'sefaz', `Documento DF-e não reconhecido (NSU ${nsu}, CNPJ ${cnpj})`);
  return null;
}

/** Grava o que veio da SEFAZ e reflete o cancelamento nos documentos do sistema. */
function registrar(doc, cnpj, nsu) {
  if (!doc?.chave) return false;
  const existe = get('SELECT 1 FROM sefaz_eventos WHERE chave = ? AND tp_evento IS ? AND nsu = ?', [doc.chave, doc.tp_evento ?? null, String(nsu)]);
  if (existe) return false;
  insert('sefaz_eventos', { ...doc, cnpj_destinatario: cnpj, nsu: String(nsu) });
  if (CANCELAMENTOS.includes(doc.tp_evento)) {
    // Nota nossa (recebida por e-mail) com a mesma chave passa a constar como cancelada
    const nossos = all("SELECT id FROM documentos WHERE replace(chave_acesso, 'NFSE', '') = ?", [doc.chave]);
    for (const n of nossos) run("UPDATE documentos SET situacao_sefaz = 'cancelada' WHERE id = ?", [n.id]);
    log('alerta', 'sefaz', `NF-e cancelada na SEFAZ: chave ${doc.chave}${nossos.length ? ` (documento ${nossos.map((n) => n.id).join(', ')})` : ''}`);
  }
  return true;
}

const controle = (cnpj) => get('SELECT * FROM dfe_controle WHERE cnpj = ?', [cnpj])
  ?? (insert('dfe_controle', { cnpj }), get('SELECT * FROM dfe_controle WHERE cnpj = ?', [cnpj]));

/**
 * Consulta a Distribuição DF-e de um CNPJ a partir do último NSU lido.
 * cStat: 137 = nenhum documento novo; 138 = documentos localizados; 656 = consumo indevido (aguardar 1 h).
 */
export async function consultarCnpj(cnpj, { maxLotes = MAX_LOTES, forcar = false } = {}) {
  const c = controle(cnpj);
  const agora = dataHoraLocal();
  if (c.proxima_consulta && c.proxima_consulta > agora) return { cnpj, ignorado: `aguardando liberação da SEFAZ até ${c.proxima_consulta}` };
  // A SEFAZ recusa consultas repetidas ("consumo indevido"): mais de 1 hora entre ciclos por CNPJ
  const limite = get("SELECT datetime('now','localtime','-65 minutes') AS t").t;
  if (!forcar && c.ultima_consulta && c.ultima_consulta > limite) return { cnpj, ignorado: `consultado às ${c.ultima_consulta.slice(11, 16)}` };
  let ultNSU = c.ult_nsu ?? '0', novos = 0, lotes = 0, status = null, maxNSU = c.max_nsu;
  try {
    for (; lotes < maxLotes; lotes++) {
      const resposta = await chamarSefaz(cnpj, envelope(cnpj, { nsu: ultNSU }));
      const ret = parser.parse(resposta)?.Envelope?.Body?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult?.retDistDFeInt;
      if (!ret) throw new Error('Resposta da SEFAZ em formato inesperado');
      status = `${ret.cStat} ${ret.xMotivo ?? ''}`.trim();
      maxNSU = texto(ret.maxNSU) ?? maxNSU;
      // 656 "consumo indevido" não é erro: a SEFAZ só aceita uma consulta por hora quando não há novidade
      if (String(ret.cStat) === '656') {
        run("UPDATE dfe_controle SET proxima_consulta = datetime('now','localtime','+1 hour'), ultimo_aviso = ?, ultima_consulta = ? WHERE cnpj = ?",
          [`Aguardando a janela de 1 hora da SEFAZ (${agora.slice(11, 16)})`, agora, cnpj]);
        return { cnpj, aguardando: true, status };
      }
      if (!['137', '138'].includes(String(ret.cStat))) throw new Error(status);
      const lote = ret.loteDistDFeInt?.docZip;
      let noLote = 0;
      for (const doc of [lote].flat().filter(Boolean)) {
        const xml = zlib.gunzipSync(Buffer.from(doc['#text'], 'base64')).toString('utf8');
        if (registrar(interpretar(xml, cnpj, doc['@NSU']), cnpj, doc['@NSU'])) noLote++;
        ultNSU = String(Math.max(Number(ultNSU), Number(doc['@NSU'])));
      }
      novos += noLote;
      run('UPDATE dfe_controle SET ult_nsu = ?, max_nsu = ?, ultima_consulta = ?, ultimo_status = ?, ultimo_erro = NULL, ultimo_aviso = NULL, documentos = documentos + ?, proxima_consulta = NULL WHERE cnpj = ?',
        [ultNSU, maxNSU, agora, status, noLote, cnpj]);
      if (String(ret.cStat) === '137' || Number(ultNSU) >= Number(maxNSU ?? 0)) break; // em dia
    }
    return { cnpj, novos, lotes: lotes + 1, ult_nsu: ultNSU, max_nsu: maxNSU, status };
  } catch (e) {
    run("UPDATE dfe_controle SET ultima_consulta = ?, ultimo_erro = ?, proxima_consulta = datetime('now','localtime','+15 minutes') WHERE cnpj = ?", [agora, e.message.slice(0, 400), cnpj]);
    run('UPDATE certificados_digitais SET ultimo_erro = ? WHERE cnpj = ?', [e.message.slice(0, 400), cnpj]);
    log('erro', 'sefaz', `Distribuição DF-e ${cnpj}: ${e.message}`);
    return { cnpj, erro: e.message };
  }
}

/** Percorre todos os CNPJs com certificado válido (usado pelo agendador e pelo botão "Atualizar agora"). */
export async function atualizarTodos({ forcar = false } = {}) {
  const cnpjs = cnpjsComCertificado();
  if (!cnpjs.length) return { ignorado: 'Nenhum certificado digital cadastrado' };
  const resultados = [];
  for (const cnpj of cnpjs) resultados.push(await consultarCnpj(cnpj, { forcar }));
  const novos = resultados.reduce((s, r) => s + (r.novos ?? 0), 0);
  const erros = resultados.filter((r) => r.erro).length;
  log('info', 'sefaz', `Distribuição DF-e: ${cnpjs.length} CNPJ(s), ${novos} documento(s) novo(s), ${erros} com erro`);
  return { cnpjs: cnpjs.length, novos, erros, em: dataHoraLocal(), resultados };
}

/** Consulta pontual de uma chave (botão "Conferir na SEFAZ" numa nota). */
export async function consultarChave(cnpj, chave) {
  const resposta = await chamarSefaz(cnpj, envelope(cnpj, { chave }));
  const ret = parser.parse(resposta)?.Envelope?.Body?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult?.retDistDFeInt;
  const docs = [ret?.loteDistDFeInt?.docZip].flat().filter(Boolean)
    .map((doc) => interpretar(zlib.gunzipSync(Buffer.from(doc['#text'], 'base64')).toString('utf8'), cnpj, doc['@NSU']))
    .filter(Boolean);
  for (const [i, d] of docs.entries()) registrar(d, cnpj, `chave-${chave}-${i}`);
  return { status: `${ret?.cStat} ${ret?.xMotivo ?? ''}`.trim(), documentos: docs };
}
