// Pipeline de ingestão: arquivo -> identificação -> leitura -> documento -> motor fiscal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { all, get, getConfig, insert, run, tx, update } from '../db/index.js';
import { paths, config } from '../config.js';
import { log } from '../util/log.js';
import { processarXml } from './xml.js';
import { extrairTextoPdf, classificarTextoPdf, extrairDadosPdf, extrairNFSePdf, extrairBoleto, extrairOrdemCompra } from './pdf.js';
import { executarMotor } from '../fiscal/motor.js';
import { limparId } from '../fiscal/validadores.js';
import { CRT } from '../fiscal/tabelas.js';
import { dataHoraLocal } from '../util/data.js';

const EXT_ACEITAS = /\.(xml|pdf|zip)$/i;
export const arquivoRelevante = (nome, mime = '') => EXT_ACEITAS.test(nome || '') || /xml|pdf|zip/i.test(mime);

function salvarArquivo(buffer, sha, nome) {
  const ext = (path.extname(nome || '') || '.bin').toLowerCase().slice(0, 6);
  const rel = path.join(sha.slice(0, 2), `${sha}${ext}`);
  const abs = path.join(paths.anexos, rel);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
  }
  return rel;
}

export function lerArquivoAnexo(anexo) {
  return fs.readFileSync(path.join(paths.anexos, anexo.caminho));
}

function tipoPorConteudo(buffer, nome) {
  const ini = buffer.subarray(0, 512).toString('latin1').trimStart();
  if (ini.startsWith('%PDF')) return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (ini.startsWith('<')) return 'xml';
  const ext = path.extname(nome || '').toLowerCase();
  return { '.pdf': 'pdf', '.xml': 'xml', '.zip': 'zip' }[ext] ?? 'outro';
}

// ------------------------------------------------------------------ cadastro automático
function upsertFornecedor(emit) {
  const cnpj = limparId(emit.cnpj);
  if (!cnpj) return null;
  const f = get('SELECT * FROM fornecedores WHERE cnpj = ?', [cnpj]);
  const regime = emit.crt ? ({ '1': 'simples', '4': 'simples', '2': 'simples', '3': 'normal' }[emit.crt]) : null;
  if (!f) {
    return insert('fornecedores', {
      cnpj, razao_social: emit.nome, nome_fantasia: emit.fantasia, ie: emit.ie, uf: emit.uf, municipio: emit.municipio,
      crt: emit.crt, regime_tributario: regime ? `${regime}${emit.crt ? ` (CRT ${emit.crt} - ${CRT[emit.crt]})` : ''}` : null,
    });
  }
  // Atualiza apenas campos vazios (o cadastro manual prevalece).
  update('fornecedores', f.id, {
    razao_social: f.razao_social ?? emit.nome, nome_fantasia: f.nome_fantasia ?? emit.fantasia, ie: f.ie ?? emit.ie,
    uf: f.uf ?? emit.uf, municipio: f.municipio ?? emit.municipio, crt: emit.crt ?? f.crt,
    regime_tributario: f.regime_tributario ?? (regime ? `${regime} (CRT ${emit.crt} - ${CRT[emit.crt]})` : null),
    updated_at: dataHoraLocal(),
  });
  return f.id;
}

function empresaPorCnpj(cnpj) {
  const c = limparId(cnpj);
  return c ? get('SELECT id FROM empresas WHERE cnpj = ? AND ativo = 1', [c])?.id ?? null : null;
}

// ------------------------------------------------------------------ gravação do documento
function camposDocumento(n) {
  const t = n.totais || {};
  return {
    tipo: n.tipo, modelo: n.modelo, origem_dados: n.origem_dados, chave_acesso: n.chave_acesso || null,
    numero: n.numero, serie: n.serie, data_emissao: n.data_emissao, data_entrada: n.data_entrada,
    natureza_operacao: n.natureza_operacao, tipo_operacao: n.tipo_operacao, finalidade: n.finalidade,
    protocolo: n.protocolo, situacao_sefaz: n.situacao_sefaz,
    emitente_cnpj: limparId(n.emitente?.cnpj) || null, emitente_nome: n.emitente?.nome, emitente_ie: n.emitente?.ie,
    emitente_uf: n.emitente?.uf, emitente_municipio: n.emitente?.municipio, emitente_crt: n.emitente?.crt,
    destinatario_cnpj: limparId(n.destinatario?.cnpj) || null, destinatario_nome: n.destinatario?.nome,
    destinatario_ie: n.destinatario?.ie, destinatario_uf: n.destinatario?.uf,
    v_prod: t.v_prod, v_frete: t.v_frete, v_seguro: t.v_seguro, v_desconto: t.v_desconto, v_outro: t.v_outro,
    v_bc_icms: t.v_bc_icms, v_icms: t.v_icms, v_icms_deson: t.v_icms_deson, v_bc_st: t.v_bc_st, v_icms_st: t.v_icms_st,
    v_fcp: t.v_fcp, v_fcp_st: t.v_fcp_st, v_ipi: t.v_ipi, v_ipi_devol: t.v_ipi_devol, v_ii: t.v_ii, v_pis: t.v_pis,
    v_cofins: t.v_cofins, v_servicos: t.v_servicos, v_iss: t.v_iss, v_total: t.v_total,
    v_liquido: t.v_liquido ?? null, v_retencoes: t.v_retencoes ?? null,
    // XML: OC no pedido do item (xPed) ou na descrição/informações complementares
    oc_documento: n.ordem_compra ?? n.itens?.find((i) => i.pedido)?.pedido
      ?? extrairOrdemCompra([...(n.itens ?? []).map((i) => i.descricao), n.informacoes_complementares].filter(Boolean).join('\n')),
    qtd_itens: n.itens?.length ?? 0,
    dados_extraidos: JSON.stringify(n),
    confianca_extracao: n.confianca ?? null,
  };
}

function gravarItens(documentoId, itens, cfopsConfirmados = {}) {
  run('DELETE FROM documento_itens WHERE documento_id = ?', [documentoId]);
  for (const it of itens || []) {
    const itemId = insert('documento_itens', {
      documento_id: documentoId, n_item: it.n_item, codigo: it.codigo, ean: it.ean, descricao: it.descricao,
      ncm: it.ncm, cest: it.cest, cfop: it.cfop, unidade: it.unidade, quantidade: it.quantidade,
      valor_unitario: it.valor_unitario, valor_total: it.valor_total, v_desconto: it.v_desconto, v_frete: it.v_frete,
      v_seguro: it.v_seguro, v_outro: it.v_outro, cfop_entrada: cfopsConfirmados[it.n_item] ?? null,
    });
    for (const [tributo, t] of Object.entries(it.impostos || {})) {
      if (!t) continue;
      insert('item_impostos', {
        item_id: itemId, tributo, cst: t.cst, origem: t.origem, modalidade_bc: t.modalidade_bc,
        base: t.base, aliquota: t.aliquota, valor: t.valor, reducao_bc: t.reducao_bc, mva: t.mva,
      });
    }
  }
}

/** Um cancelamento recebido prevalece sobre a situação lida do XML. */
function aplicarSituacaoEventos(documentoId) {
  if (get("SELECT 1 FROM documento_eventos WHERE documento_id = ? AND tp_evento IN ('110111','110112')", [documentoId])) {
    run("UPDATE documentos SET situacao_sefaz = 'cancelada' WHERE id = ?", [documentoId]);
  }
}

/** Grava as duplicatas preservando o controle de pagamento já registrado pelo usuário. */
function gravarDuplicatas(documentoId, cobranca) {
  const antes = Object.fromEntries(all('SELECT * FROM documento_duplicatas WHERE documento_id = ?', [documentoId]).map((d) => [d.numero, d]));
  run('DELETE FROM documento_duplicatas WHERE documento_id = ?', [documentoId]);
  for (const d of cobranca?.duplicatas ?? []) {
    const a = antes[d.numero];
    insert('documento_duplicatas', {
      documento_id: documentoId, numero: d.numero, vencimento: d.vencimento, valor: d.valor,
      status_pagamento: a?.status_pagamento ?? 'aberta', data_pagamento: a?.data_pagamento ?? null,
      atualizado_por: a?.atualizado_por ?? null, observacao: a?.observacao ?? null,
    });
  }
}

function registrarDuplicado(documentoId, anexoId, emailId) {
  insert('recebimentos_duplicados', { documento_id: documentoId, anexo_id: anexoId, email_id: emailId ?? null });
  run('UPDATE documentos SET qtd_recebimentos = qtd_recebimentos + 1 WHERE id = ?', [documentoId]);
}

/** Cria ou atualiza um documento a partir do resultado normalizado. Devolve { documentoId, acao }. */
export function ingerirDocumento(n, { anexoId, emailId, tipoArquivo }) {
  const ehXml = n.origem_dados === 'xml';
  const resultado = tx(() => {
    let existente = n.chave_acesso ? get('SELECT * FROM documentos WHERE chave_acesso = ?', [n.chave_acesso]) : null;
    // NFS-e: PDF e XML da mesma nota podem ter identificadores diferentes (chave nacional x número municipal):
    // prestador + número identifica a nota em qualquer dos dois formatos.
    if (!existente && (!ehXml || n.tipo === 'NFSE') && n.numero && n.emitente?.cnpj) {
      existente = get('SELECT * FROM documentos WHERE emitente_cnpj = ? AND numero = ? AND tipo = ? ORDER BY id LIMIT 1',
        [limparId(n.emitente.cnpj), n.numero, n.tipo]);
    }
    // PDF que não corresponde a nenhum documento, no mesmo e-mail de um único XML sem PDF:
    // vincula ao XML para que a regra XML_PDF_CORRESPONDENCIA aponte a divergência.
    if (!existente && !ehXml && emailId) {
      const candidatos = all(`SELECT DISTINCT d.* FROM anexos a JOIN documentos d ON d.id = a.documento_id
        WHERE a.email_id = ? AND d.origem_dados = 'xml' AND d.pdf_anexo_id IS NULL`, [emailId]);
      if (candidatos.length === 1) {
        update('documentos', candidatos[0].id, { pdf_anexo_id: anexoId });
        return { documentoId: candidatos[0].id, acao: 'pdf_vinculado', reabrir: false };
      }
    }
    // Dados do PDF não trazem nomes: completa a partir dos cadastros (sem alterar dados fiscais).
    if (!ehXml) {
      const f = n.emitente?.cnpj ? get('SELECT razao_social, uf FROM fornecedores WHERE cnpj = ?', [limparId(n.emitente.cnpj)]) : null;
      if (f) n.emitente = { ...n.emitente, nome: n.emitente.nome ?? f.razao_social, uf: n.emitente.uf ?? f.uf };
      const e = n.destinatario?.cnpj ? get('SELECT razao_social, uf FROM empresas WHERE cnpj = ?', [limparId(n.destinatario.cnpj)]) : null;
      if (e) n.destinatario = { ...n.destinatario, nome: n.destinatario.nome ?? e.razao_social, uf: n.destinatario.uf ?? e.uf };
    }

    if (existente) {
      // PDF chegou antes e agora chegou o XML: substitui os dados extraídos pelos do XML.
      if (ehXml && existente.origem_dados !== 'xml') {
        const cfops = Object.fromEntries(all('SELECT n_item, cfop_entrada FROM documento_itens WHERE documento_id = ? AND cfop_entrada IS NOT NULL', [existente.id]).map((r) => [r.n_item, r.cfop_entrada]));
        const campos = camposDocumento(n);
        // mantém a chave nacional (50 dígitos) lida do PDF quando o XML municipal só tem identificador sintético
        if (/^NFSE\d{50}$/.test(existente.chave_acesso ?? '') && !/^NFSE\d{50}$/.test(campos.chave_acesso ?? '')) campos.chave_acesso = existente.chave_acesso;
        update('documentos', existente.id, {
          ...campos, xml_anexo_id: anexoId, fornecedor_id: upsertFornecedor(n.emitente),
          empresa_id: empresaPorCnpj(n.destinatario?.cnpj), updated_at: dataHoraLocal(),
        });
        gravarItens(existente.id, n.itens, cfops);
        gravarDuplicatas(existente.id, n.cobranca);
        aplicarSituacaoEventos(existente.id);
        insert('decisoes', { documento_id: existente.id, acao: 'SISTEMA', justificativa: 'XML recebido: dados lidos do PDF substituídos pelos dados do XML', status_anterior: existente.status, status_novo: existente.status });
        return { documentoId: existente.id, acao: 'xml_complementou_pdf', reabrir: true };
      }
      if (!ehXml) {
        if (!existente.pdf_anexo_id) {
          const chaveNacional = /^NFSE\d{50}$/.test(n.chave_acesso ?? '') && !/^NFSE\d{50}$/.test(existente.chave_acesso ?? '') ? n.chave_acesso : undefined;
          update('documentos', existente.id, { pdf_anexo_id: anexoId, chave_acesso: chaveNacional });
          return { documentoId: existente.id, acao: 'pdf_vinculado', reabrir: false };
        }
        registrarDuplicado(existente.id, anexoId, emailId);
        return { documentoId: existente.id, acao: 'duplicado', reabrir: null };
      }
      // XML de NFS-e para nota já recebida em XML sem PDF é duplicidade; XML sobre XML idem.
      registrarDuplicado(existente.id, anexoId, emailId);
      return { documentoId: existente.id, acao: 'duplicado', reabrir: null };
    }

    const documentoId = insert('documentos', {
      ...camposDocumento(n),
      empresa_id: empresaPorCnpj(n.destinatario?.cnpj),
      fornecedor_id: upsertFornecedor(n.emitente),
      xml_anexo_id: ehXml ? anexoId : null,
      pdf_anexo_id: ehXml ? null : anexoId,
      email_id: emailId ?? null,
      recebido_em: (emailId && get('SELECT data_recebimento FROM emails WHERE id = ?', [emailId])?.data_recebimento) || dataHoraLocal(),
    });
    gravarItens(documentoId, n.itens);
    gravarDuplicatas(documentoId, n.cobranca);
    // Eventos que chegaram antes do documento
    if (n.chave_acesso) run('UPDATE documento_eventos SET documento_id = ? WHERE chave_acesso = ? AND documento_id IS NULL', [documentoId, n.chave_acesso]);
    aplicarSituacaoEventos(documentoId);
    insert('decisoes', { documento_id: documentoId, acao: 'SISTEMA', justificativa: `Documento criado a partir de ${tipoArquivo ?? n.origem_dados}`, status_novo: 'PENDENTE' });
    return { documentoId, acao: 'criado', reabrir: false };
  });

  run('UPDATE anexos SET documento_id = ?, status = ? WHERE id = ?', [resultado.documentoId, resultado.acao === 'duplicado' ? 'duplicado' : 'processado', anexoId]);
  if (resultado.reabrir !== null) executarMotor(resultado.documentoId, { reabrir: resultado.reabrir });
  return resultado;
}

function aplicarEvento(ev, anexoId) {
  const doc = ev.chave_acesso ? get('SELECT id, status FROM documentos WHERE chave_acesso = ?', [ev.chave_acesso]) : null;
  run(`INSERT OR IGNORE INTO documento_eventos (documento_id, chave_acesso, tp_evento, descricao, texto, data_evento, anexo_id)
    VALUES (?,?,?,?,?,?,?)`, [doc?.id ?? null, ev.chave_acesso, ev.tp_evento, ev.descricao, ev.texto, ev.data, anexoId]);
  const cancelamento = ['110111', '110112'].includes(ev.tp_evento) && ev.homologado !== false;
  if (doc) {
    if (cancelamento) {
      run("UPDATE documentos SET situacao_sefaz = 'cancelada' WHERE id = ?", [doc.id]);
      insert('decisoes', { documento_id: doc.id, acao: 'SISTEMA', justificativa: `Evento de cancelamento recebido: ${ev.texto ?? ''}`, status_anterior: doc.status });
    } else {
      insert('decisoes', { documento_id: doc.id, acao: 'SISTEMA', justificativa: `Evento ${ev.tp_evento} (${ev.descricao ?? ''}) recebido` });
    }
    executarMotor(doc.id, { reabrir: cancelamento });
  }
  run('UPDATE anexos SET status = ?, documento_id = ?, mensagem = ? WHERE id = ?',
    ['processado', doc?.id ?? null, doc ? `Evento ${ev.tp_evento} aplicado` : `Evento ${ev.tp_evento} para documento ainda não recebido (${ev.chave_acesso})`, anexoId]);
  return { documentoId: doc?.id ?? null, acao: 'evento' };
}

// ------------------------------------------------------------------ entrada principal
// Escopo configurável (Configurações gerais): quais tipos de documento o sistema controla.
export const TIPOS_DOCUMENTO = { NFSE: 'NFS-e (serviços)', NFE: 'NF-e / DANFE', NFCE: 'NFC-e', CTE: 'CT-e / DACTE' };
export const tipoNoEscopo = (tipo) => (getConfig('tipos_documento_aceitos', Object.keys(TIPOS_DOCUMENTO)) ?? []).includes(tipo);
function foraDoEscopo(anexoId, tipoDetectado, tipoDoc) {
  const msg = `Fora do escopo configurado: ${TIPOS_DOCUMENTO[tipoDoc] ?? tipoDoc} não é controlado por este sistema`;
  run("UPDATE anexos SET status = 'ignorado', tipo_detectado = ?, mensagem = ? WHERE id = ?", [tipoDetectado, msg, anexoId]);
  return [{ anexoId, tipo: tipoDetectado, acao: 'fora_do_escopo', mensagem: msg }];
}

/**
 * Processa um arquivo (anexo de e-mail, upload manual ou item de ZIP).
 * Devolve lista de resultados { anexoId, tipo, documentoId?, acao, mensagem? }.
 */
export async function processarArquivo({ buffer, nome, mime, emailId = null, origem = 'email', anexoPaiId = null }) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const tipoBruto = tipoPorConteudo(buffer, nome);
  const anexoId = insert('anexos', {
    email_id: emailId, nome_arquivo: nome || `arquivo.${tipoBruto}`, mime, tamanho: buffer.length, sha256: sha,
    caminho: salvarArquivo(buffer, sha, nome || `arquivo.${tipoBruto}`), origem, anexo_pai_id: anexoPaiId,
  });

  try {
    if (!buffer.length) {
      run("UPDATE anexos SET status = 'ignorado', tipo_detectado = 'outro', mensagem = 'Arquivo vazio (0 bytes) enviado pelo remetente' WHERE id = ?", [anexoId]);
      return [{ anexoId, tipo: 'outro', acao: 'ignorado', mensagem: 'Arquivo vazio' }];
    }
    // Mesmo arquivo já processado antes (ex.: mesmo e-mail enviado às duas caixas).
    const anterior = get("SELECT id, documento_id, tipo_detectado FROM anexos WHERE sha256 = ? AND id <> ? AND documento_id IS NOT NULL AND status IN ('processado','duplicado') ORDER BY id LIMIT 1", [sha, anexoId]);
    if (anterior && tipoBruto !== 'zip') {
      registrarDuplicado(anterior.documento_id, anexoId, emailId);
      run("UPDATE anexos SET status = 'duplicado', tipo_detectado = ?, documento_id = ?, mensagem = ? WHERE id = ?",
        [anterior.tipo_detectado, anterior.documento_id, `Arquivo idêntico ao anexo #${anterior.id}`, anexoId]);
      return [{ anexoId, tipo: anterior.tipo_detectado, documentoId: anterior.documento_id, acao: 'duplicado' }];
    }

    if (tipoBruto === 'zip') {
      run("UPDATE anexos SET tipo_detectado = 'zip' WHERE id = ?", [anexoId]);
      const entradas = unzipSync(new Uint8Array(buffer));
      const resultados = [];
      const nomes = Object.keys(entradas).filter((n) => !n.endsWith('/') && arquivoRelevante(n))
        .sort((a, b) => (a.toLowerCase().endsWith('.xml') ? 0 : 1) - (b.toLowerCase().endsWith('.xml') ? 0 : 1));
      for (const n of nomes) {
        resultados.push(...await processarArquivo({ buffer: Buffer.from(entradas[n]), nome: path.basename(n), emailId, origem: 'zip', anexoPaiId: anexoId }));
      }
      run('UPDATE anexos SET status = ?, mensagem = ? WHERE id = ?', ['processado', `${nomes.length} arquivo(s) no ZIP`, anexoId]);
      return resultados;
    }

    if (tipoBruto === 'xml') {
      const r = processarXml(buffer);
      run('UPDATE anexos SET tipo_detectado = ? WHERE id = ?', [r.tipo, anexoId]);
      const tipoXml = r.documento?.tipo ?? (r.evento ? 'NFE' : null);
      if (tipoXml && !tipoNoEscopo(tipoXml)) return foraDoEscopo(anexoId, r.tipo, tipoXml);
      if (r.documento) {
        const res = ingerirDocumento(r.documento, { anexoId, emailId, tipoArquivo: r.tipo });
        return [{ anexoId, tipo: r.tipo, ...res }];
      }
      if (r.evento) return [{ anexoId, tipo: r.tipo, ...aplicarEvento(r.evento, anexoId) }];
      run("UPDATE anexos SET status = 'ignorado', mensagem = ? WHERE id = ?", [r.motivo, anexoId]);
      return [{ anexoId, tipo: r.tipo, acao: 'ignorado', mensagem: r.motivo }];
    }

    if (tipoBruto === 'pdf') {
      let texto = '';
      try { texto = (await extrairTextoPdf(buffer)).texto; } catch (e) { log('alerta', 'pdf', `Falha ao ler PDF ${nome}: ${e.message}`); }
      let tipoPdf = classificarTextoPdf(texto);
      run('UPDATE anexos SET tipo_detectado = ?, texto_extraido = ? WHERE id = ?', [tipoPdf, texto.slice(0, 200000) || null, anexoId]);
      if (tipoPdf === 'boleto_pdf') {
        run("UPDATE anexos SET status = 'ignorado', mensagem = 'Boleto (vencimento vinculado à nota do mesmo e-mail, quando houver)' WHERE id = ?", [anexoId]);
        return [{ anexoId, tipo: tipoPdf, acao: 'boleto' }];
      }
      const tipoDoPdf = { danfe_pdf: 'NFE', dacte_pdf: 'CTE', nfse_pdf: 'NFSE' }[tipoPdf];
      if (tipoDoPdf && !tipoNoEscopo(tipoDoPdf)) return foraDoEscopo(anexoId, tipoPdf, tipoDoPdf);
      let dados = tipoPdf === 'nfse_pdf'
        ? extrairNFSePdf(texto, { cnpjsGrupo: new Set(all('SELECT cnpj FROM empresas').map((e) => e.cnpj)) })
        : ['danfe_pdf', 'dacte_pdf'].includes(tipoPdf) ? extrairDadosPdf(texto, tipoPdf) : null;
      if (dados?.tipo === 'NFSE' && !dados.numero && dados.totais.v_total == null) dados = null; // ex.: demonstrativo sem dados da nota

      // IA como camada auxiliar: PDF escaneado, desconhecido ou leitura heurística fraca.
      const precisaIa = tipoPdf === 'pdf_sem_texto' || (dados && dados.confianca < 0.5 && !dados.chave_acesso);
      if (precisaIa && config.ia.habilitada) {
        try {
          const { extrairPdfComIA } = await import('../ia/ia.js');
          const viaIa = await extrairPdfComIA(buffer, nome);
          if (viaIa?.documento && !tipoNoEscopo(viaIa.documento.tipo)) return foraDoEscopo(anexoId, viaIa.tipoPdf, viaIa.documento.tipo);
          if (viaIa?.documento) {
            dados = viaIa.documento;
            tipoPdf = viaIa.tipoPdf;
            run('UPDATE anexos SET tipo_detectado = ? WHERE id = ?', [tipoPdf, anexoId]);
          } else if (viaIa && !viaIa.fiscal) {
            tipoPdf = 'pdf_desconhecido';
          }
        } catch (e) {
          log('alerta', 'ia', `Extração por IA falhou para ${nome}: ${e.message}`);
        }
      }
      if (!dados) {
        const msg = tipoPdf === 'pdf_sem_texto'
          ? `PDF sem texto (digitalizado)${config.ia.habilitada ? '' : '. Habilite a camada de IA para leitura por OCR inteligente'}`
          : 'PDF não identificado como documento fiscal';
        run("UPDATE anexos SET status = 'ignorado', mensagem = ? WHERE id = ?", [msg, anexoId]);
        return [{ anexoId, tipo: tipoPdf, acao: 'ignorado', mensagem: msg }];
      }
      const res = ingerirDocumento(dados, { anexoId, emailId, tipoArquivo: tipoPdf });
      return [{ anexoId, tipo: tipoPdf, ...res }];
    }

    run("UPDATE anexos SET status = 'ignorado', tipo_detectado = 'outro', mensagem = 'Formato não suportado' WHERE id = ?", [anexoId]);
    return [{ anexoId, tipo: 'outro', acao: 'ignorado' }];
  } catch (e) {
    log('erro', 'ingestao', `Erro ao processar ${nome}: ${e.message}`, { anexoId });
    run("UPDATE anexos SET status = 'erro', mensagem = ? WHERE id = ?", [e.message.slice(0, 500), anexoId]);
    return [{ anexoId, tipo: tipoBruto, acao: 'erro', mensagem: e.message }];
  }
}

/**
 * Boletos do e-mail -> vencimento da NFS-e do mesmo e-mail (quando a nota não traz vencimento próprio).
 * Vincula pelo valor (líquido ou total) ou pelo número da nota citado no boleto/nome do arquivo.
 */
export function vincularBoletos(emailId) {
  if (!emailId) return 0;
  const boletos = all("SELECT id, nome_arquivo, texto_extraido FROM anexos WHERE email_id = ? AND tipo_detectado = 'boleto_pdf'", [emailId]);
  if (!boletos.length) return 0;
  const notas = all(`SELECT DISTINCT d.* FROM anexos a JOIN documentos d ON d.id = a.documento_id WHERE a.email_id = ? AND d.tipo = 'NFSE'`, [emailId]);
  if (!notas.length) return 0;
  const grupo = new Set(all('SELECT cnpj FROM empresas').map((e) => e.cnpj));
  // Outros documentos do e-mail que não são as NFS-e controladas (ex.: DANFE de peças fora do escopo)
  const idsNotas = new Set(notas.map((n) => n.id));
  const outrosTextos = all("SELECT documento_id, nome_arquivo, texto_extraido FROM anexos WHERE email_id = ? AND tipo_detectado <> 'boleto_pdf' AND texto_extraido IS NOT NULL", [emailId])
    .filter((a) => !idsNotas.has(a.documento_id));
  const perto = (a, v) => a != null && v != null && Math.abs(a - v) <= 0.05;
  // Boletos com valor igual ao de uma nota são atribuídos primeiro; os demais depois (evita que o boleto
  // de outra nota "tome" a NFS-e só por citar o número dela — fornecedores agrupam cobranças: "NFS01523-1/2")
  const lidos = boletos.map((b) => ({ b, bol: extrairBoleto(b.texto_extraido ?? '', { cnpjsGrupo: grupo }) }))
    .filter((x) => x.bol.vencimento)
    .sort((x, y) => Number(notas.some((n) => perto(n.v_liquido, y.bol.valor) || perto(n.v_total, y.bol.valor)))
      - Number(notas.some((n) => perto(n.v_liquido, x.bol.valor) || perto(n.v_total, x.bol.valor))));
  let vinculados = 0;
  const usadas = new Set();
  for (const { b, bol } of lidos) {
    const valorBate = (n) => perto(n.v_liquido, bol.valor) || perto(n.v_total, bol.valor);
    // O valor do boleto aparece em outro documento do e-mail e em nenhuma NFS-e: o boleto é daquele documento
    const valorTxt = bol.valor != null ? bol.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
    const deOutroDoc = valorTxt && !notas.some(valorBate) && outrosTextos.find((a) => a.texto_extraido.includes(valorTxt));
    if (deOutroDoc) {
      run("UPDATE anexos SET documento_id = NULL, status = 'processado', mensagem = ? WHERE id = ?",
        [`Boleto de R$ ${valorTxt} (venc. ${bol.vencimento}) é de outro documento do e-mail: ${deOutroDoc.nome_arquivo} tem o mesmo valor. Não vinculado à NFS-e.`, b.id]);
      continue;
    }
    // Número da nota citado no boleto ("Nº do documento") ou no nome do arquivo ("BOL NFSE198.pdf"),
    // ignorando o prefixo de ano das NFS-e municipais
    const citaNumero = (n) => {
      const num = String(Number(String(n.numero ?? '').replace(/^20\d{2}(?=\d{5,}$)/, '')) || '');
      return num.length >= 2 && new RegExp(`(?<!\\d)0*${num}(?!\\d)`).test(`${b.nome_arquivo ?? ''}\n${b.texto_extraido ?? ''}`);
    };
    // Só vincula boleto que é desta nota: valor igual (líquido ou total) ou número da nota citado.
    // E-mails com NF-e de peças + NFS-e trazem boletos das duas; o boleto da NF-e não pode ir para a NFS-e.
    const livres = notas.filter((n) => !usadas.has(n.id));
    const alvo = livres.find((n) => valorBate(n) && citaNumero(n))
      ?? livres.find((n) => n.emitente_cnpj === bol.beneficiario && valorBate(n))
      ?? livres.find(valorBate)
      ?? livres.find(citaNumero)
      ?? notas.find((n) => valorBate(n) && citaNumero(n))
      ?? notas.find(valorBate)
      ?? notas.find(citaNumero)
      ?? (notas.length === 1 && bol.valor == null ? notas[0] : null);
    if (alvo) usadas.add(alvo.id);
    if (!alvo) {
      const lista = notas.map((n) => `${n.numero} (${n.v_liquido ?? n.v_total})`).join(', ');
      run("UPDATE anexos SET documento_id = NULL, status = 'processado', mensagem = ? WHERE id = ?",
        [`Boleto de ${bol.valor ?? '?'} com vencimento ${bol.vencimento} não vinculado: valor e número não batem com a(s) NFS-e do e-mail [${lista}] — provavelmente é de outra nota (ex.: NF-e de peças)`, b.id]);
      continue;
    }
    // Mesmo vencimento e mesmo valor = mesma parcela (ex.: já lida da nota); valor diferente é outra parcela
    const valorDup = bol.valor ?? alvo.v_liquido ?? alvo.v_total;
    if (!get('SELECT 1 FROM documento_duplicatas WHERE documento_id = ? AND vencimento = ? AND abs(COALESCE(valor, 0) - ?) <= 0.05', [alvo.id, bol.vencimento, valorDup ?? 0])) {
      const seq = get('SELECT COUNT(*) AS n FROM documento_duplicatas WHERE documento_id = ?', [alvo.id]).n + 1;
      insert('documento_duplicatas', { documento_id: alvo.id, numero: `BOL-${seq}`, vencimento: bol.vencimento, valor: valorDup, observacao: 'Vencimento lido do boleto enviado junto com a nota' });
    }
    run("UPDATE anexos SET documento_id = ?, status = 'processado', mensagem = ? WHERE id = ?", [alvo.id, `Boleto: vencimento ${bol.vencimento} vinculado à NFS-e ${alvo.numero}${valorBate(alvo) ? '' : ' (pelo número citado; valor diferente da nota)'}`, b.id]);
    executarMotor(alvo.id); // prazo e prioridade passam a considerar o vencimento
    vinculados++;
  }
  return vinculados;
}

/**
 * Boletos que chegaram em e-mail separado da nota (ou antes/depois dela): procura a NFS-e do mesmo
 * fornecedor (CNPJ do beneficiário = prestador) recebida até 60 dias antes/depois e ainda sem boleto.
 * Só vincula com evidência — valor igual ou número da nota citado — e com uma única candidata.
 */
export function vincularBoletosSoltos() {
  const soltos = all(`SELECT a.id, a.nome_arquivo, a.texto_extraido, COALESCE(e.data_recebimento, a.created_at) AS recebido
    FROM anexos a LEFT JOIN emails e ON e.id = a.email_id WHERE a.tipo_detectado = 'boleto_pdf' AND a.documento_id IS NULL`);
  if (!soltos.length) return 0;
  const grupo = new Set(all('SELECT cnpj FROM empresas').map((e) => e.cnpj));
  let vinculados = 0;
  for (const b of soltos) {
    const bol = extrairBoleto(b.texto_extraido ?? '', { cnpjsGrupo: grupo });
    if (!bol.vencimento || !bol.beneficiario) continue;
    const texto = `${b.nome_arquivo ?? ''}\n${b.texto_extraido ?? ''}`;
    const candidatas = all(`SELECT d.* FROM documentos d
      WHERE d.tipo = 'NFSE' AND d.emitente_cnpj = ? AND d.status NOT IN ('REJEITADA','NAO_FISCAL')
        AND abs(julianday(d.recebido_em) - julianday(?)) <= 60
        AND NOT EXISTS (SELECT 1 FROM anexos x WHERE x.documento_id = d.id AND x.tipo_detectado = 'boleto_pdf')`, [bol.beneficiario, b.recebido]);
    const perto = (a, v) => a != null && v != null && Math.abs(a - v) <= 0.05;
    const valorBate = (n) => perto(n.v_liquido, bol.valor) || perto(n.v_total, bol.valor);
    const citaNumero = (n) => {
      const num = String(Number(String(n.numero ?? '').replace(/^20\d{2}(?=\d{5,}$)/, '')) || '');
      return num.length >= 2 && new RegExp(`(?<!\\d)0*${num}(?!\\d)`).test(texto);
    };
    // Evidência mais forte primeiro; empate (duas notas iguais do mesmo fornecedor) fica sem vínculo
    const nivel = (lista) => (lista.length === 1 ? lista[0] : null);
    const ambos = candidatas.filter((n) => valorBate(n) && citaNumero(n));
    const alvo = ambos.length ? nivel(ambos) : nivel(candidatas.filter(citaNumero)) ?? nivel(candidatas.filter(valorBate));
    if (!alvo) continue;
    if (!get('SELECT 1 FROM documento_duplicatas WHERE documento_id = ? AND vencimento = ?', [alvo.id, bol.vencimento])) {
      const seq = get('SELECT COUNT(*) AS n FROM documento_duplicatas WHERE documento_id = ?', [alvo.id]).n + 1;
      insert('documento_duplicatas', { documento_id: alvo.id, numero: `BOL-${seq}`, vencimento: bol.vencimento, valor: bol.valor ?? alvo.v_liquido ?? alvo.v_total, observacao: 'Vencimento lido de boleto recebido em outro e-mail' });
    }
    run("UPDATE anexos SET documento_id = ?, status = 'processado', mensagem = ? WHERE id = ?",
      [alvo.id, `Boleto (outro e-mail): vencimento ${bol.vencimento} vinculado à NFS-e ${alvo.numero} pelo fornecedor e ${valorBate(alvo) ? 'valor' : 'número da nota'}`, b.id]);
    executarMotor(alvo.id);
    vinculados++;
  }
  if (vinculados) log('info', 'ingestao', `${vinculados} boleto(s) de outros e-mails vinculados às notas`);
  return vinculados;
}

/**
 * Aplica uma mudança de escopo sem mexer nos documentos dos tipos que continuam no escopo:
 * - tipos desmarcados: os documentos saem do controle (os anexos continuam guardados, marcados "fora do escopo");
 * - tipos marcados: reprocessa apenas os anexos que tinham sido ignorados por estarem fora do escopo.
 */
export async function aplicarEscopo() {
  const aceitos = getConfig('tipos_documento_aceitos', Object.keys(TIPOS_DOCUMENTO));
  const marcadores = aceitos.map(() => '?').join(',');
  const fora = all(`SELECT id, tipo FROM documentos WHERE tipo NOT IN (${marcadores})`, aceitos);
  tx(() => {
    for (const d of fora) {
      run("UPDATE anexos SET documento_id = NULL, status = 'ignorado', mensagem = ? WHERE documento_id = ?",
        [`Fora do escopo configurado: ${TIPOS_DOCUMENTO[d.tipo] ?? d.tipo} não é controlado por este sistema`, d.id]);
      run('DELETE FROM recebimentos_duplicados WHERE documento_id = ?', [d.id]);
      run('UPDATE documentos SET duplicado_de_id = NULL WHERE duplicado_de_id = ?', [d.id]);
      run('DELETE FROM documentos WHERE id = ?', [d.id]);
    }
  });
  // Anexos antes descartados por escopo cujo tipo agora é aceito
  const pendentes = all("SELECT * FROM anexos WHERE status = 'ignorado' AND mensagem LIKE 'Fora do escopo%' AND anexo_pai_id IS NULL ORDER BY email_id, id")
    .filter((a) => aceitos.includes({ danfe_pdf: 'NFE', nfe_xml: 'NFE', evento_xml: 'NFE', dacte_pdf: 'CTE', cte_xml: 'CTE', nfse_pdf: 'NFSE', nfse_xml: 'NFSE' }[a.tipo_detectado]));
  let incluidos = 0;
  const emails = new Set();
  for (const a of pendentes) {
    const caminho = path.join(paths.anexos, a.caminho);
    if (!fs.existsSync(caminho)) continue;
    const buffer = fs.readFileSync(caminho);
    run('DELETE FROM anexos WHERE id = ?', [a.id]);
    const r = await processarArquivo({ buffer, nome: a.nome_arquivo, mime: a.mime, emailId: a.email_id, origem: a.origem });
    incluidos += r.filter((x) => x.documentoId).length;
    if (a.email_id) emails.add(a.email_id);
  }
  // Situação dos e-mails
  const afetados = new Set([...emails, ...all('SELECT DISTINCT email_id FROM anexos WHERE email_id IS NOT NULL').map((x) => x.email_id)]);
  for (const emailId of afetados) {
    vincularBoletos(emailId);
    const temDoc = get('SELECT 1 FROM anexos WHERE email_id = ? AND documento_id IS NOT NULL', [emailId]);
    run("UPDATE emails SET status = ? WHERE id = ? AND status IN ('processado','sem_nf')", [temDoc ? 'processado' : 'sem_nf', emailId]);
  }
  run('DELETE FROM fornecedores WHERE id NOT IN (SELECT DISTINCT fornecedor_id FROM documentos WHERE fornecedor_id IS NOT NULL)');
  return { removidos: fora.length, incluidos };
}

/**
 * Refaz a identificação de todos os anexos já baixados (arquivos locais), por exemplo após mudar o escopo
 * de tipos de documento ou melhorar os leitores. Os e-mails não são lidos de novo.
 * ATENÇÃO: descarta documentos, decisões e alertas atuais (derivados) e os recria a partir dos arquivos.
 */
// Trava global: reprocessamento e ciclo automático (captura/conciliação) não podem rodar ao mesmo tempo
let reprocessando = false;
export const reprocessamentoEmAndamento = () => reprocessando;

/** Executa uma rotina pesada (reprocessar, recuperar e-mails) com o ciclo automático pausado. */
export async function executarExclusivo(fn) {
  if (reprocessando) throw new Error('Já existe um reprocessamento/recuperação em andamento');
  reprocessando = true;
  try { return await fn(); } finally { reprocessando = false; }
}

export const reprocessarTodosAnexos = () => executarExclusivo(reprocessarTodosAnexosInterno);

async function reprocessarTodosAnexosInterno() {
  const originais = all('SELECT * FROM anexos WHERE anexo_pai_id IS NULL ORDER BY email_id, id');
  const arquivos = originais.map((a) => ({ ...a, buffer: fs.existsSync(path.join(paths.anexos, a.caminho)) ? lerArquivoAnexo(a) : null }));
  tx(() => {
    run('UPDATE anexos SET documento_id = NULL');
    run('DELETE FROM recebimentos_duplicados');
    run('DELETE FROM documento_eventos');
    run('DELETE FROM documentos');
    run('DELETE FROM anexos');
  });
  const porEmail = new Map();
  for (const a of arquivos) { if (!porEmail.has(a.email_id)) porEmail.set(a.email_id, []); porEmail.get(a.email_id).push(a); }
  let documentos = 0;
  for (const [emailId, lista] of porEmail) {
    lista.sort((a, b) => (/\.pdf$/i.test(a.nome_arquivo) ? 1 : 0) - (/\.pdf$/i.test(b.nome_arquivo) ? 1 : 0));
    const resultados = [];
    for (const a of lista) {
      // Nunca perder o registro do anexo: sem arquivo ou com falha, o registro original volta com a mensagem do erro
      const restaurar = (mensagem) => {
        const { id, buffer, documento_id, ...resto } = a;
        insert('anexos', { ...resto, documento_id: null, status: 'erro', mensagem });
      };
      if (!a.buffer) { restaurar('Arquivo local não encontrado no reprocessamento'); continue; }
      try {
        resultados.push(...await processarArquivo({ buffer: a.buffer, nome: a.nome_arquivo, mime: a.mime, emailId, origem: a.origem }));
      } catch (e) {
        log('erro', 'ingestao', `Reprocessamento: falha no anexo ${a.nome_arquivo} (e-mail ${emailId}): ${e.message}`);
        if (!get('SELECT 1 FROM anexos WHERE email_id IS ? AND nome_arquivo = ? AND anexo_pai_id IS NULL', [emailId, a.nome_arquivo])) restaurar(`Falha no reprocessamento: ${e.message}`);
      }
    }
    try { vincularBoletos(emailId); } catch (e) { log('erro', 'ingestao', `Vínculo de boletos do e-mail ${emailId} falhou: ${e.message}`); }
    const docs = resultados.filter((r) => r.documentoId).length;
    documentos += docs;
    if (emailId) {
      const erros = resultados.filter((r) => r.acao === 'erro').map((r) => `anexo #${r.anexoId}: ${r.mensagem}`);
      run('UPDATE emails SET status = ?, erro = ? WHERE id = ?', [erros.length && !docs ? 'erro' : docs ? 'processado' : 'sem_nf', erros.join(' | ') || null, emailId]);
    }
  }
  try { vincularBoletosSoltos(); } catch (e) { log('erro', 'ingestao', `Vínculo de boletos avulsos falhou: ${e.message}`); }
  run('DELETE FROM fornecedores WHERE id NOT IN (SELECT DISTINCT fornecedor_id FROM documentos WHERE fornecedor_id IS NOT NULL)');
  return { anexos: arquivos.length, documentos };
}

/** Reprocessa um documento a partir do arquivo original (preserva CFOPs de entrada confirmados). */
export async function reprocessarDocumento(documentoId) {
  const doc = get('SELECT * FROM documentos WHERE id = ?', [documentoId]);
  const anexo = doc.xml_anexo_id ? get('SELECT * FROM anexos WHERE id = ?', [doc.xml_anexo_id]) : null;
  if (anexo) {
    const r = processarXml(lerArquivoAnexo(anexo));
    if (r.documento) {
      tx(() => {
        const cfops = Object.fromEntries(all('SELECT n_item, cfop_entrada FROM documento_itens WHERE documento_id = ? AND cfop_entrada IS NOT NULL', [documentoId]).map((x) => [x.n_item, x.cfop_entrada]));
        const campos = camposDocumento(r.documento);
        delete campos.chave_acesso;
        update('documentos', documentoId, { ...campos, empresa_id: empresaPorCnpj(r.documento.destinatario?.cnpj), fornecedor_id: upsertFornecedor(r.documento.emitente) });
        gravarItens(documentoId, r.documento.itens, cfops);
        gravarDuplicatas(documentoId, r.documento.cobranca);
        aplicarSituacaoEventos(documentoId);
      });
    }
  }
  return executarMotor(documentoId, { reabrir: true });
}
