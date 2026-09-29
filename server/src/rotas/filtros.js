import { limparId } from '../fiscal/validadores.js';

const lista = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',')).filter(Boolean);

/**
 * Monta cláusula WHERE para documentos (alias d) a partir da query string.
 * Filtros: empresa_id, cnpj, fornecedor, fornecedor_id, de, ate, campo_data (emissao|recebimento),
 * numero, chave, cfop, status, tipo, responsavel_id, caixa_id, recebido_de, recebido_ate, q, severidade, regra
 */
export function filtroDocumentos(q) {
  const w = [];
  const p = {};
  if (q.empresa_id) { w.push('d.empresa_id = :empresa_id'); p.empresa_id = Number(q.empresa_id); }
  if (q.cnpj) { w.push('(d.emitente_cnpj LIKE :cnpj OR d.destinatario_cnpj LIKE :cnpj)'); p.cnpj = `%${limparId(q.cnpj)}%`; }
  if (q.fornecedor_id) { w.push('d.fornecedor_id = :fornecedor_id'); p.fornecedor_id = Number(q.fornecedor_id); }
  if (q.fornecedor) { w.push('(d.emitente_nome LIKE :fornecedor OR d.emitente_cnpj LIKE :fornecedor_cnpj)'); p.fornecedor = `%${q.fornecedor}%`; p.fornecedor_cnpj = `%${limparId(q.fornecedor) || '#'}%`; }
  const campoData = q.campo_data === 'recebimento' ? 'd.recebido_em' : 'd.data_emissao';
  if (q.de) { w.push(`substr(${campoData},1,10) >= :de`); p.de = q.de; }
  if (q.ate) { w.push(`substr(${campoData},1,10) <= :ate`); p.ate = q.ate; }
  if (q.recebido_de) { w.push('substr(d.recebido_em,1,10) >= :recebido_de'); p.recebido_de = q.recebido_de; }
  if (q.recebido_ate) { w.push('substr(d.recebido_em,1,10) <= :recebido_ate'); p.recebido_ate = q.recebido_ate; }
  if (q.numero) { w.push('d.numero = :numero'); p.numero = String(Number(String(q.numero).replace(/\D/g, '')) || q.numero); }
  if (q.chave) { w.push('d.chave_acesso LIKE :chave'); p.chave = `%${String(q.chave).replace(/\s/g, '')}%`; }
  if (q.cfop) { w.push('EXISTS (SELECT 1 FROM documento_itens i WHERE i.documento_id = d.id AND (i.cfop = :cfop OR i.cfop_entrada = :cfop))'); p.cfop = String(q.cfop); }
  const status = lista(q.status);
  if (status.length) { w.push(`d.status IN (${status.map((_, i) => `:st${i}`).join(',')})`); status.forEach((s, i) => { p[`st${i}`] = s; }); }
  const tipos = lista(q.tipo);
  if (tipos.length) { w.push(`d.tipo IN (${tipos.map((_, i) => `:tp${i}`).join(',')})`); tipos.forEach((s, i) => { p[`tp${i}`] = s; }); }
  if (q.responsavel_id === 'nenhum') w.push('d.responsavel_id IS NULL');
  else if (q.responsavel_id) { w.push('d.responsavel_id = :responsavel_id'); p.responsavel_id = Number(q.responsavel_id); }
  if (q.caixa_id) { w.push('EXISTS (SELECT 1 FROM emails e WHERE e.id = d.email_id AND e.caixa_id = :caixa_id)'); p.caixa_id = Number(q.caixa_id); }
  if (q.senior === 'lancada') w.push("d.senior_status = 'lancada'");
  if (q.senior === 'nao_lancada') w.push("d.senior_status = 'nao_lancada'");
  if (q.sem_xml === '1') w.push("d.origem_dados <> 'xml' AND d.tipo <> 'NFSE'");
  if (q.duplicadas === '1') w.push("(d.status = 'DUPLICADA' OR d.qtd_recebimentos > 1)");
  if (q.regra) { w.push("EXISTS (SELECT 1 FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.regra_codigo = :regra)"); p.regra = q.regra; }
  if (q.categoria) { w.push("EXISTS (SELECT 1 FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.categoria = :categoria)"); p.categoria = q.categoria; }
  if (q.atrasadas === '1') w.push("d.prazo < date('now','localtime') AND d.status IN ('PENDENTE','INCONSISTENTE','DUPLICADA','AGUARDANDO_XML','CORRECAO_SOLICITADA')");
  if (q.cancelada === '1') w.push("d.situacao_sefaz = 'cancelada'");
  if (q.severidade) { w.push("EXISTS (SELECT 1 FROM inconsistencias x WHERE x.documento_id = d.id AND x.status = 'aberta' AND x.severidade = :sev)"); p.sev = q.severidade; }
  if (q.q) {
    w.push('(d.numero LIKE :q OR d.chave_acesso LIKE :q OR d.emitente_nome LIKE :q OR d.destinatario_nome LIKE :q OR d.emitente_cnpj LIKE :qd)');
    p.q = `%${q.q}%`; p.qd = `%${limparId(q.q) || '#'}%`;
  }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

const ORDENACOES = {
  recebido: 'd.recebido_em', emissao: 'd.data_emissao', valor: 'd.v_total', numero: 'CAST(d.numero AS INTEGER)',
  fornecedor: 'd.emitente_nome', status: 'd.status', prioridade: 'd.prioridade', prazo: 'd.prazo',
  // só na fila (usa o alias proximo_vencimento): o que vence/expira primeiro vem primeiro
  urgencia: 'COALESCE(proximo_vencimento, d.prazo)',
};
export function ordenacao(q, padrao = 'recebido') {
  const col = ORDENACOES[q.ordem] ?? ORDENACOES[padrao];
  const dir = q.dir === 'asc' ? 'ASC' : q.dir === 'desc' ? 'DESC' : (['prioridade', 'prazo', 'urgencia'].includes(q.ordem) ? 'ASC' : 'DESC');
  return `ORDER BY ${col} ${dir} NULLS LAST, d.id DESC`;
}
