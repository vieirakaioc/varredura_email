// Módulo de captura: lê as caixas, registra e-mails (sem duplicar) e envia anexos ao pipeline.
import { all, get, insert, run } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { dataHoraLocal, lerDataLocal } from '../util/data.js';
import { arquivoRelevante, processarArquivo, vincularBoletos } from '../processamento/ingestao.js';
import * as zoho from './zoho.js';
import * as imap from './imap.js';
import * as pasta from './pasta.js';

const PALAVRAS_FISCAIS = /\b(nf-?e|nfs-?e|ct-?e|nota fiscal|notas fiscais|danfe|dacte|xml|fatura|faturamento|nf\s*\d+|documento fiscal)\b/i;
const emAndamento = new Set();

export function relevanciaFiscal(assunto, nomesAnexos) {
  const temXml = nomesAnexos.some((n) => /\.(xml|zip)$/i.test(n));
  const temPdf = nomesAnexos.some((n) => /\.pdf$/i.test(n));
  if (temXml) return 'provavel';
  if (temPdf && PALAVRAS_FISCAIS.test(assunto || '')) return 'provavel';
  if (temPdf) return 'possivel';
  return 'improvavel';
}

function conector(caixa) {
  switch (caixa.provedor) {
    case 'zoho': return (desde) => zoho.listarMensagens(caixa, desde);
    case 'imap': return (desde) => imap.listarMensagens(caixa, desde);
    case 'pasta': return (desde) => pasta.listarMensagens(caixa, desde, config.captura.pastaImportacao);
    default: return null;
  }
}

/** Registra um e-mail e processa seus anexos. Idempotente por (caixa, id do provedor). */
export async function processarMensagem(caixa, m) {
  if (get('SELECT 1 FROM emails WHERE caixa_id = ? AND id_provedor = ?', [caixa.id, m.idProvedor])) return { novo: false };
  // Ao trocar a conta autorizada (modo membro), o id da mensagem muda: o mesmo e-mail é reconhecido
  // por remetente + assunto + horário de recebimento, e só o id é atualizado (sem reprocessar).
  const recebido = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.data) ? m.data : dataHoraLocal(new Date(m.data));
  const mesmo = get('SELECT id FROM emails WHERE caixa_id = ? AND remetente IS ? AND assunto IS ? AND data_recebimento = ?',
    [caixa.id, m.remetente ?? null, m.assunto ?? null, recebido]);
  if (mesmo) { run('UPDATE emails SET id_provedor = ? WHERE id = ?', [m.idProvedor, mesmo.id]); return { novo: false }; }

  const anexos = await m.carregarAnexos();
  // A mesma mensagem pode aparecer duas vezes na listagem (ou ser registrada por outra rotina durante o download)
  if (get('SELECT 1 FROM emails WHERE caixa_id = ? AND id_provedor = ?', [caixa.id, m.idProvedor])) return { novo: false };
  const relevantes = anexos.filter((a) => arquivoRelevante(a.nome));
  const duplicadoDe = m.internetMessageId
    ? get('SELECT id FROM emails WHERE internet_message_id = ? AND caixa_id <> ?', [m.internetMessageId, caixa.id]) : null;

  const emailId = insert('emails', {
    caixa_id: caixa.id, id_provedor: m.idProvedor, internet_message_id: m.internetMessageId, pasta: m.pasta,
    remetente: m.remetente, remetente_nome: m.remetenteNome, destinatarios: m.destinatarios, cc: m.cc, assunto: m.assunto,
    // conectores entregam ISO/Date; armazenamos no fuso local, como o restante do banco
    data_recebimento: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.data) ? m.data : dataHoraLocal(new Date(m.data)),
    qtd_anexos: anexos.length,
    relevancia_fiscal: relevanciaFiscal(m.assunto, anexos.map((a) => a.nome)),
    status: 'aguardando',
  });

  if (!relevantes.length) {
    run("UPDATE emails SET status = 'sem_nf', processado_em = datetime('now','localtime') WHERE id = ?", [emailId]);
    return { novo: true, emailId, documentos: 0 };
  }

  // XML/ZIP antes do PDF: permite vincular o DANFE ao documento lido do XML.
  relevantes.sort((a, b) => (/\.pdf$/i.test(a.nome) ? 1 : 0) - (/\.pdf$/i.test(b.nome) ? 1 : 0));
  const resultados = [];
  const erros = [];
  for (const a of relevantes) {
    try {
      const buffer = await a.baixar();
      resultados.push(...await processarArquivo({ buffer, nome: a.nome, emailId, origem: 'email' }));
    } catch (e) {
      erros.push(`${a.nome}: ${e.message}`);
      log('erro', 'captura', `Falha ao baixar/processar anexo ${a.nome} do e-mail ${emailId}: ${e.message}`);
    }
  }
  vincularBoletos(emailId);
  const docs = resultados.filter((r) => r.documentoId).length;
  for (const r of resultados.filter((x) => x.acao === 'erro')) erros.push(`anexo #${r.anexoId}: ${r.mensagem}`);
  const status = erros.length && !docs ? 'erro' : duplicadoDe && resultados.every((r) => r.acao === 'duplicado') ? 'duplicado' : docs ? 'processado' : 'sem_nf';
  run("UPDATE emails SET status = ?, erro = ?, processado_em = datetime('now','localtime') WHERE id = ?", [status, erros.join(' | ') || null, emailId]);
  return { novo: true, emailId, documentos: docs };
}

export async function sincronizarCaixa(caixaId) {
  if (emAndamento.has(caixaId)) return { ignorado: 'sincronização já em andamento' };
  const { reprocessamentoEmAndamento } = await import('../processamento/ingestao.js');
  if (reprocessamentoEmAndamento()) return { ignorado: 'reprocessamento em andamento' };
  const caixa = get('SELECT * FROM caixas_email WHERE id = ?', [caixaId]);
  const listar = caixa && conector(caixa);
  if (!listar) return { ignorado: 'caixa sem conector configurado' };
  emAndamento.add(caixaId);
  const inicio = Date.now();
  let novos = 0, documentos = 0;
  try {
    run("UPDATE caixas_email SET status = 'sincronizando' WHERE id = ?", [caixaId]);
    // Janela: desde a última sincronização (com margem de 1 dia) ou N dias retroativos.
    const base = caixa.ultima_sincronizacao ? new Date(lerDataLocal(caixa.ultima_sincronizacao).getTime() - 86400000)
      : caixa.sincronizar_desde ? new Date(caixa.sincronizar_desde)
        : new Date(Date.now() - config.captura.diasRetroativos * 86400000);
    for await (const m of listar(base)) {
      const r = await processarMensagem(caixa, m);
      if (r.novo) { novos++; documentos += r.documentos ?? 0; }
    }
    run("UPDATE caixas_email SET status = 'conectada', ultima_sincronizacao = datetime('now','localtime'), ultimo_erro = NULL WHERE id = ?", [caixaId]);
    log('info', 'captura', `${caixa.email}: ${novos} e-mail(s) novo(s), ${documentos} documento(s) em ${Math.round((Date.now() - inicio) / 1000)}s`);
    return { novos, documentos };
  } catch (e) {
    run("UPDATE caixas_email SET status = 'erro', ultimo_erro = ? WHERE id = ?", [e.message.slice(0, 500), caixaId]);
    log('erro', 'captura', `${caixa.email}: ${e.message}`);
    throw e;
  } finally {
    emAndamento.delete(caixaId);
  }
}

/**
 * Recupera e-mails que ficaram sem o registro dos anexos (qtd_anexos > 0 e nenhum anexo guardado):
 * apaga apenas o registro interno desses e-mails e os lê de novo no provedor (somente leitura — nada é
 * alterado na caixa). O processamento normal recria anexos e documentos.
 */
export async function recuperarEmailsSemAnexos() {
  const { executarExclusivo } = await import('../processamento/ingestao.js');
  return executarExclusivo(recuperarEmailsSemAnexosInterno);
}

async function recuperarEmailsSemAnexosInterno() {
  const perdidos = all(`SELECT e.id, e.caixa_id, e.data_recebimento FROM emails e
    WHERE e.qtd_anexos > 0 AND e.relevancia_fiscal <> 'improvavel' AND NOT EXISTS (SELECT 1 FROM anexos a WHERE a.email_id = e.id)`);
  if (!perdidos.length) return { recuperados: 0 };
  const porCaixa = new Map();
  for (const p of perdidos) {
    if (!porCaixa.has(p.caixa_id)) porCaixa.set(p.caixa_id, []);
    porCaixa.get(p.caixa_id).push(p);
  }
  let relidos = 0, documentos = 0;
  for (const [caixaId, lista] of porCaixa) {
    const caixa = get('SELECT * FROM caixas_email WHERE id = ?', [caixaId]);
    const listar = caixa && conector(caixa);
    if (!listar) continue;
    const ids = lista.map((p) => p.id);
    run(`UPDATE documentos SET email_id = NULL WHERE email_id IN (${ids.map(() => '?').join(',')})`, ids);
    run(`DELETE FROM recebimentos_duplicados WHERE email_id IN (${ids.map(() => '?').join(',')})`, ids);
    run(`DELETE FROM emails WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const desde = new Date(lerDataLocal(lista.map((p) => p.data_recebimento).sort()[0]).getTime() - 86400000);
    for await (const m of listar(desde)) {
      const r = await processarMensagem(caixa, m);
      if (r.novo) { relidos++; documentos += r.documentos ?? 0; }
    }
  }
  const { vincularBoletosSoltos } = await import('../processamento/ingestao.js');
  vincularBoletosSoltos();
  log('info', 'captura', `Recuperação: ${perdidos.length} e-mail(s) sem anexos, ${relidos} relido(s) do provedor, ${documentos} documento(s)`);
  return { sem_anexos: perdidos.length, relidos, documentos };
}

/** Reprocessa e-mails com erro (anexos ficam salvos localmente; o e-mail em si não é tocado). */
export async function reprocessarEmail(emailId) {
  const anexos = all('SELECT * FROM anexos WHERE email_id = ? AND anexo_pai_id IS NULL', [emailId]);
  const { lerArquivoAnexo } = await import('../processamento/ingestao.js');
  let docs = 0;
  for (const a of anexos) {
    if (a.status !== 'erro') { if (a.documento_id) docs++; continue; }
    run("UPDATE anexos SET status = 'ignorado', mensagem = 'Substituído por reprocessamento' WHERE id = ?", [a.id]);
    const r = await processarArquivo({ buffer: lerArquivoAnexo(a), nome: a.nome_arquivo, mime: a.mime, emailId, origem: a.origem });
    docs += r.filter((x) => x.documentoId).length;
  }
  run("UPDATE emails SET status = ?, erro = NULL, processado_em = datetime('now','localtime') WHERE id = ?", [docs ? 'processado' : 'sem_nf', emailId]);
  return { documentos: docs };
}

let timer;
export function iniciarAgendador() {
  if (!config.captura.habilitada) { log('info', 'captura', 'Captura automática desabilitada'); return; }
  const ciclo = async () => {
    const { reprocessamentoEmAndamento } = await import('../processamento/ingestao.js');
    if (reprocessamentoEmAndamento()) { log('info', 'captura', 'Ciclo adiado: reprocessamento em andamento'); return; }
    for (const c of all("SELECT id FROM caixas_email WHERE ativo = 1 AND provedor IN ('zoho','imap','pasta') AND (oauth_token_enc IS NOT NULL OR provedor <> 'zoho')")) {
      try { await sincronizarCaixa(c.id); } catch { /* registrado em log */ }
    }
    // Boletos que vieram em e-mail separado da nota
    try {
      const { vincularBoletosSoltos } = await import('../processamento/ingestao.js');
      vincularBoletosSoltos();
    } catch (e) { log('erro', 'ingestao', `Vínculo de boletos avulsos falhou: ${e.message}`); }
    // Eventos da SEFAZ (cancelamento de NF-e pelo fornecedor). A SEFAZ bloqueia consultas seguidas:
    // o próprio módulo controla o intervalo por CNPJ.
    try {
      const { atualizarTodos } = await import('../fiscal/sefaz/dfe.js');
      await atualizarTodos();
    } catch (e) { log('erro', 'sefaz', `Distribuição DF-e falhou: ${e.message}`); }
    // Depois da leitura dos e-mails, confere no Senior o que já foi lançado.
    try {
      const { conciliarSenior, seniorConfigurado } = await import('../erp/senior.js');
      if (seniorConfigurado()) await conciliarSenior();
    } catch (e) { log('erro', 'senior', `Conciliação falhou: ${e.message}`); }
  };
  timer = setInterval(ciclo, config.captura.intervaloMin * 60000);
  setTimeout(ciclo, 5000);
  log('info', 'captura', `Agendador iniciado: a cada ${config.captura.intervaloMin} min`);
}
export const pararAgendador = () => clearInterval(timer);
