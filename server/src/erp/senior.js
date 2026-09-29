// Conciliação com as notas de entrada lançadas no Senior (leitura direta no banco, usuário somente leitura).
// Credenciais apenas no .env. Nenhuma escrita é feita no banco do Senior.
//
// Consulta padrão (Senior G5/Sapiens): E440NFC = notas fiscais de entrada; E095FOR = fornecedores.
// Se o ambiente usar outras tabelas/colunas, defina SENIOR_SQL no .env mantendo os aliases da consulta padrão.
import { all, getConfig, insert, run, tx } from '../db/index.js';
import { log } from '../util/log.js';
import { dataHoraLocal } from '../util/data.js';

const env = process.env;
export const seniorConfigurado = () => Boolean(env.SENIOR_DB_TIPO && env.SENIOR_DB_HOST && env.SENIOR_DB_USUARIO);

// Aliases esperados: CODEMP, CODFIL, CODFOR, NUMNFC, CODSNF, CHVNEL, DATENT, DATEMI, VLRNFC, SITNFC, CNPJFOR
const SQL_PADRAO = `SELECT n.CODEMP, n.CODFIL, n.CODFOR, n.NUMNFC, n.CODSNF, n.CHVNEL, n.DATENT, n.DATEMI, n.VLRLIQ AS VLRNFC, n.SITNFC, f.CGCCPF AS CNPJFOR
FROM E440NFC n JOIN E095FOR f ON f.CODFOR = n.CODFOR
WHERE n.DATENT >= {desde}`;

// Títulos a pagar ligados a nota de entrada (FILNFC/NUMNFC). Situação: AB aberto, PE em pagamento, LQ pago, LS/LM baixado sem pagamento, CA cancelado.
const SQL_TITULOS = `SELECT t.CODEMP, t.CODFIL, t.CODFOR, t.NUMTIT, t.CODTPT, t.SITTIT, t.VCTPRO, t.VLRORI, t.VLRABE, t.ULTPGT, t.FILNFC, t.NUMNFC
FROM E501TCP t
WHERE t.NUMNFC <> 0 AND t.DATEMI >= {desde}`;

// OCs das notas lançadas (itens de serviço e de produto) e OCs em aberto (situação 1 = aberta, 2 = parcial) por fornecedor
const SQL_OCS_NOTAS = `SELECT DISTINCT n.CODEMP, n.CODFIL, n.CODFOR, n.NUMNFC, i.NUMOCP FROM E440ISC i
  JOIN E440NFC n ON n.CODEMP = i.CODEMP AND n.CODFIL = i.CODFIL AND n.CODFOR = i.CODFOR AND n.NUMNFC = i.NUMNFC AND n.CODSNF = i.CODSNF
  WHERE i.NUMOCP > 0 AND n.DATENT >= {desde}
UNION
SELECT DISTINCT n.CODEMP, n.CODFIL, n.CODFOR, n.NUMNFC, i.NUMOCP FROM E440IPC i
  JOIN E440NFC n ON n.CODEMP = i.CODEMP AND n.CODFIL = i.CODFIL AND n.CODFOR = i.CODFOR AND n.NUMNFC = i.NUMNFC AND n.CODSNF = i.CODSNF
  WHERE i.NUMOCP > 0 AND n.DATENT >= {desde}`;
const SQL_OCS_ABERTAS = `SELECT o.CODEMP, o.CODFIL, o.NUMOCP, o.DATEMI, o.VLRLIQ, o.VLRORI, o.SITOCP, f.CGCCPF AS CNPJFOR
FROM E420OCP o JOIN E095FOR f ON f.CODFOR = o.CODFOR
WHERE o.SITOCP IN (1, 2) AND o.DATEMI >= {desde}`;

export function grupoSituacao(sit) {
  const s = String(sit ?? '').trim().toUpperCase();
  if (s === 'LQ') return 'pago';
  if (s === 'PE') return 'em_pagamento';
  if (s === 'CA') return 'cancelado';
  if (s.startsWith('L')) return 'baixado_sem_pagamento';
  return 'aberto';
}

function sqlConsulta(dialeto, base = env.SENIOR_SQL || SQL_PADRAO) {
  return base.replaceAll('{desde}', dialeto === 'oracle' ? ':desde' : '@desde');
}

/**
 * Executa a consulta no Senior e devolve linhas com chaves em maiúsculas.
 * `extras`: parâmetros adicionais { nome: valor } (Date, número ou texto), usados como @nome / :nome.
 */
export async function consultar(sql, desde, extras = {}) {
  const tipo = (env.SENIOR_DB_TIPO || '').toLowerCase();
  if (tipo === 'mssql' || tipo === 'sqlserver') {
    const mssql = (await import('mssql')).default;
    // Pool próprio por consulta: mssql.connect() usa um pool global, e duas consultas ao mesmo tempo
    // derrubavam uma à outra ("Connection not yet open") quando a primeira o fechava.
    const pool = await new mssql.ConnectionPool({
      server: env.SENIOR_DB_HOST, port: Number(env.SENIOR_DB_PORTA || 1433), database: env.SENIOR_DB_NOME,
      user: env.SENIOR_DB_USUARIO, password: env.SENIOR_DB_SENHA,
      options: { encrypt: env.SENIOR_DB_CRIPTOGRAFAR === 'true', trustServerCertificate: true, readOnlyIntent: true },
      requestTimeout: 120000,
    }).connect();
    try {
      const req = pool.request();
      if (desde) req.input('desde', mssql.DateTime, desde);
      for (const [k, v] of Object.entries(extras)) {
        req.input(k, v instanceof Date ? mssql.DateTime : typeof v === 'number' ? mssql.Int : mssql.VarChar, v);
      }
      const r = await req.query(sql);
      return r.recordset.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k.toUpperCase(), v])));
    } finally { await pool.close(); }
  }
  if (tipo === 'oracle') {
    const oracledb = (await import('oracledb')).default;
    const con = await oracledb.getConnection({
      user: env.SENIOR_DB_USUARIO, password: env.SENIOR_DB_SENHA,
      connectString: `${env.SENIOR_DB_HOST}:${env.SENIOR_DB_PORTA || 1521}/${env.SENIOR_DB_NOME}`,
    });
    try {
      const r = await con.execute(sql, { ...(desde ? { desde } : {}), ...extras }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return r.rows.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k.toUpperCase(), v])));
    } finally { await con.close(); }
  }
  throw new Error('SENIOR_DB_TIPO deve ser "mssql" ou "oracle"');
}

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const numeroNota = (v) => String(Number(digitos(v)) || '');
// Datas do Senior não têm hora relevante: o driver do SQL Server as entrega à 00:00 UTC, então usamos a data UTC.
const dataIso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/** Testa a conexão e a consulta; devolve contagem, colunas e amostra (sem gravar nada). */
export async function testarSenior() {
  if (!seniorConfigurado()) throw new Error('Configure SENIOR_DB_TIPO, SENIOR_DB_HOST, SENIOR_DB_NOME, SENIOR_DB_USUARIO e SENIOR_DB_SENHA no .env');
  const tipo = (env.SENIOR_DB_TIPO || '').toLowerCase();
  const desde = new Date(Date.now() - 30 * 86400000);
  const linhas = await consultar(sqlConsulta(tipo === 'oracle' ? 'oracle' : 'mssql'), desde);
  return { registros_30_dias: linhas.length, colunas: Object.keys(linhas[0] ?? {}), amostra: linhas.slice(0, 3) };
}

/**
 * Concilia os documentos do Validador com os lançamentos de entrada do Senior.
 * Ordem de confiança: chave de acesso > CNPJ fornecedor + número + empresa/filial > CNPJ + número (único).
 */
export async function conciliarSenior() {
  if (!seniorConfigurado()) return { ignorado: 'Senior não configurado' };
  const tipo = (env.SENIOR_DB_TIPO || '').toLowerCase();
  const dias = Number(env.SENIOR_DIAS || 180);
  const desde = new Date(Date.now() - dias * 86400000);
  const dialeto = tipo === 'oracle' ? 'oracle' : 'mssql';
  const linhas = await consultar(sqlConsulta(dialeto), desde);
  let titulos = [];
  try { titulos = await consultar(sqlConsulta(dialeto, env.SENIOR_SQL_TITULOS || SQL_TITULOS), desde); } catch (e) { log('alerta', 'senior', `Títulos a pagar não lidos: ${e.message}`); }
  let ocsNotas = [], ocsAbertas = [];
  try {
    ocsNotas = await consultar(sqlConsulta(dialeto, SQL_OCS_NOTAS), desde);
    ocsAbertas = await consultar(sqlConsulta(dialeto, SQL_OCS_ABERTAS), new Date(Date.now() - 365 * 86400000));
  } catch (e) { log('alerta', 'senior', `Ordens de compra não lidas: ${e.message}`); }
  const resumo = aplicarConciliacao(linhas, desde, titulos, { ocsNotas, ocsAbertas });
  // Validador financeiro: reexecuta as regras nas notas cujos títulos mudaram
  if (resumo._revalidar?.length) {
    const { executarMotor } = await import('../fiscal/motor.js');
    for (const id of resumo._revalidar) executarMotor(id);
  }
  delete resumo._revalidar;
  return resumo;
}

/** Grava os títulos do Senior da nota e reflete o pagamento nas duplicatas do painel financeiro. */
function gravarTitulos(documentoId, lista) {
  const antes = all('SELECT numtit, situacao, vencimento, valor, valor_aberto, data_pagamento FROM senior_titulos WHERE documento_id = ? ORDER BY numtit', [documentoId]);
  const depois = lista.map((t) => ({
    numtit: String(t.NUMTIT ?? '').trim(), situacao: String(t.SITTIT ?? '').trim(), vencimento: dataIso(t.VCTPRO),
    valor: t.VLRORI != null ? Number(t.VLRORI) : null, valor_aberto: t.VLRABE != null ? Number(t.VLRABE) : null,
    data_pagamento: t.ULTPGT && dataIso(t.ULTPGT) > '1901-01-01' ? dataIso(t.ULTPGT) : null,
    codemp: String(t.CODEMP), codfil: String(t.CODFIL), codtpt: String(t.CODTPT ?? '').trim(),
  })).sort((a, b) => a.numtit.localeCompare(b.numtit));
  const assinatura = (arr) => JSON.stringify(arr.map((x) => [x.numtit, x.situacao, x.vencimento, x.valor, x.valor_aberto, x.data_pagamento]));
  if (assinatura(antes) === assinatura(depois)) return false;
  run('DELETE FROM senior_titulos WHERE documento_id = ?', [documentoId]);
  for (const t of depois) insert('senior_titulos', { documento_id: documentoId, ...t, situacao_grupo: grupoSituacao(t.situacao), atualizado_em: dataHoraLocal() });
  // Pagamento oficial do Senior vale para as duplicatas lidas da nota/boleto
  const ativos = depois.filter((t) => grupoSituacao(t.situacao) !== 'cancelado');
  if (ativos.length) {
    const tudoPago = ativos.every((t) => ['pago', 'baixado_sem_pagamento'].includes(grupoSituacao(t.situacao)));
    const emPagamento = ativos.some((t) => grupoSituacao(t.situacao) === 'em_pagamento');
    const dataPg = ativos.map((t) => t.data_pagamento).filter(Boolean).sort().pop() ?? null;
    if (tudoPago) run("UPDATE documento_duplicatas SET status_pagamento = 'paga', data_pagamento = COALESCE(?, data_pagamento), observacao = 'Baixa no Senior' WHERE documento_id = ?", [dataPg, documentoId]);
    else if (emPagamento) run("UPDATE documento_duplicatas SET status_pagamento = 'programada', observacao = 'Em pagamento no Senior' WHERE documento_id = ? AND status_pagamento = 'aberta'", [documentoId]);
  }
  return true;
}

/** Cruza as linhas lidas do Senior com os documentos (separado da consulta para poder ser testado). */
export function aplicarConciliacao(linhas, desde, titulos = [], { ocsNotas = null, ocsAbertas = null } = {}) {
  // OCs: das notas lançadas (pela chave da nota) e em aberto (por CNPJ do fornecedor + empresa)
  const ocsPorNota = new Map();
  for (const o of ocsNotas ?? []) {
    const k = `${o.CODEMP}|${o.CODFIL}|${o.CODFOR}|${o.NUMNFC}`;
    if (!ocsPorNota.has(k)) ocsPorNota.set(k, new Set());
    ocsPorNota.get(k).add(String(o.NUMOCP));
  }
  const ocsPorFornecedor = new Map();
  for (const o of ocsAbertas ?? []) {
    const k = digitos(o.CNPJFOR).padStart(14, '0');
    if (!ocsPorFornecedor.has(k)) ocsPorFornecedor.set(k, []);
    ocsPorFornecedor.get(k).push({ numocp: String(o.NUMOCP), codemp: String(o.CODEMP), codfil: String(o.CODFIL), emissao: dataIso(o.DATEMI), valor: o.VLRLIQ != null ? Number(o.VLRLIQ) : null, valor_original: o.VLRORI != null ? Number(o.VLRORI) : null, parcial: Number(o.SITOCP) === 2 });
  }
  const lerOcs = ocsNotas != null;
  /** OCs em aberto do fornecedor na mesma empresa; a de valor igual ao da nota vem primeiro. */
  const ocsSugeridas = (cnpj, cod, d) => {
    const lista = (ocsPorFornecedor.get(cnpj) ?? []).filter((o) => !cod.codemp || o.codemp === cod.codemp);
    const valorNota = [d.v_total, d.v_liquido].filter((v) => v != null);
    return lista.map((o) => ({ ...o, citada_na_nota: o.numocp === d.oc_documento, mesma_filial: cod.codfil ? o.codfil === cod.codfil : null, bate_valor: valorNota.some((v) => o.valor != null && Math.abs(o.valor - v) <= 0.05) }))
      .sort((a, b) => (b.citada_na_nota - a.citada_na_nota) || (b.bate_valor - a.bate_valor) || ((b.mesma_filial ?? 0) - (a.mesma_filial ?? 0)) || String(b.emissao).localeCompare(String(a.emissao)))
      .slice(0, 5);
  };
  // Títulos indexados pela nota de entrada a que pertencem: empresa|filial da NF|fornecedor|número da NF
  const titulosPorNota = new Map();
  for (const t of titulos) {
    const k = `${t.CODEMP}|${t.FILNFC || t.CODFIL}|${t.CODFOR}|${t.NUMNFC}`;
    if (!titulosPorNota.has(k)) titulosPorNota.set(k, []);
    titulosPorNota.get(k).push(t);
  }
  const revalidar = [];
  const porChave = new Map(), porFilial = new Map(), porCnpjNumero = new Map();
  for (const l of linhas) {
    const reg = {
      codemp: String(l.CODEMP ?? ''), codfil: String(l.CODFIL ?? ''), numero: numeroNota(l.NUMNFC), serie: l.CODSNF,
      chave: digitos(l.CHVNEL), cnpj: digitos(l.CNPJFOR).padStart(14, '0'), entrada: dataIso(l.DATENT), valor: l.VLRNFC != null ? Number(l.VLRNFC) : null,
      situacao: l.SITNFC, chaveTitulos: `${l.CODEMP}|${l.CODFIL}|${l.CODFOR}|${l.NUMNFC}`,
    };
    if (reg.chave.length >= 44) porChave.set(reg.chave, reg);
    porFilial.set(`${reg.cnpj}|${reg.numero}|${reg.codemp}|${reg.codfil}`, reg);
    const k = `${reg.cnpj}|${reg.numero}`;
    porCnpjNumero.set(k, porCnpjNumero.has(k) ? 'ambiguo' : reg);
  }

  // Códigos Senior das empresas (cadastrados a partir da planilha de filiais)
  const codigos = new Map(all('SELECT id, regras_especificas FROM empresas').map((e) => {
    const r = JSON.parse(e.regras_especificas || '{}');
    return [e.id, { codemp: String(r.codigo_empresa_erp ?? ''), codfil: String(r.codigo_filial_erp ?? '') }];
  }));

  const aprovarAoLancar = getConfig('senior_lancada_aprova', true);
  const docs = all("SELECT * FROM documentos WHERE status NOT IN ('REJEITADA','NAO_FISCAL') AND COALESCE(data_emissao, recebido_em) >= ?", [dataIso(desde)]);
  let lancadas = 0, pendentes = 0, aprovadas = 0, comTitulo = 0;
  tx(() => {
    for (const d of docs) {
      const chave = digitos(d.chave_acesso);
      const cod = codigos.get(d.empresa_id) ?? {};
      const cnpj = digitos(d.emitente_cnpj).padStart(14, '0');
      // NFS-e municipais usam "ano + sequência" (2026000001523); o Senior guarda só a sequência (campo inteiro).
      const numeros = [numeroNota(d.numero)];
      if (/^20\d{2}\d{5,}$/.test(numeros[0])) numeros.push(String(Number(numeros[0].slice(4))));
      let achado = null, criterio = null;
      if (chave.length >= 44 && porChave.has(chave)) { achado = porChave.get(chave); criterio = 'chave de acesso'; }
      for (const numero of numeros) {
        if (achado) break;
        if (cod.codemp && porFilial.has(`${cnpj}|${numero}|${cod.codemp}|${cod.codfil}`)) { achado = porFilial.get(`${cnpj}|${numero}|${cod.codemp}|${cod.codfil}`); criterio = 'CNPJ + número + filial'; }
        else if (porCnpjNumero.get(`${cnpj}|${numero}`) && porCnpjNumero.get(`${cnpj}|${numero}`) !== 'ambiguo') { achado = porCnpjNumero.get(`${cnpj}|${numero}`); criterio = 'CNPJ + número'; }
      }

      if (achado) {
        lancadas++;
        const ref = `Emp ${achado.codemp} / Fil ${achado.codfil} · NF ${achado.numero}${achado.serie ? `-${achado.serie}` : ''} · entrada ${achado.entrada ?? '—'} (${criterio})`;
        const mudou = d.senior_status !== 'lancada';
        run("UPDATE documentos SET senior_status = 'lancada', senior_ref = ?, senior_data_entrada = ?, senior_verificado_em = ? WHERE id = ?",
          [ref, achado.entrada, dataHoraLocal(), d.id]);
        if (mudou && aprovarAoLancar && ['PENDENTE', 'INCONSISTENTE', 'AGUARDANDO_XML', 'CORRECAO_SOLICITADA'].includes(d.status)) {
          run("UPDATE documentos SET status = 'APROVADA', decidido_em = ? WHERE id = ?", [dataHoraLocal(), d.id]);
          insert('decisoes', { documento_id: d.id, acao: 'SISTEMA', justificativa: `Lançada no Senior: ${ref}`, status_anterior: d.status, status_novo: 'APROVADA' });
          aprovadas++;
        } else if (mudou) {
          insert('decisoes', { documento_id: d.id, acao: 'SISTEMA', justificativa: `Lançada no Senior: ${ref}` });
        }
        if (lerOcs) {
          const ocs = [...(ocsPorNota.get(achado.chaveTitulos) ?? [])];
          run('UPDATE documentos SET senior_ocs = ? WHERE id = ?', [ocs.length ? JSON.stringify({ origem: 'lancada', ocs: ocs.map((numocp) => ({ numocp })) }) : null, d.id]);
        }
        if (titulos.length) {
          const lista = titulosPorNota.get(achado.chaveTitulos) ?? [];
          if (lista.length) comTitulo++;
          if (gravarTitulos(d.id, lista) || mudou) revalidar.push(d.id);
        }
      } else {
        pendentes++;
        if (titulos.length && gravarTitulos(d.id, [])) revalidar.push(d.id);
        if (lerOcs) {
          const ocs = ocsSugeridas(cnpj, cod, d);
          run('UPDATE documentos SET senior_ocs = ? WHERE id = ?', [ocs.length ? JSON.stringify({ origem: 'aberta', ocs }) : null, d.id]);
        }
        run("UPDATE documentos SET senior_status = 'nao_lancada', senior_ref = NULL, senior_data_entrada = NULL, senior_verificado_em = ? WHERE id = ?", [dataHoraLocal(), d.id]);
      }
    }
  });
  // Uma vez por dia revalida as notas com título, para o alerta de "vencido em aberto" acompanhar a data
  const hoje = dataHoraLocal().slice(0, 10);
  if (titulos.length && getConfig('senior_titulos_revalidado_em', null) !== hoje) {
    for (const r of all('SELECT DISTINCT documento_id FROM senior_titulos')) if (!revalidar.includes(r.documento_id)) revalidar.push(r.documento_id);
    run("INSERT INTO configuracoes (chave, valor) VALUES ('senior_titulos_revalidado_em', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [JSON.stringify(hoje)]);
  }
  const pagas = titulos.length ? all("SELECT COUNT(DISTINCT documento_id) n FROM senior_titulos WHERE situacao_grupo = 'pago'")[0].n : 0;
  const resumo = { lancamentos_senior: linhas.length, titulos_senior: titulos.length, documentos: docs.length, lancadas, com_titulo: comTitulo, com_pagamento: pagas, nao_lancadas: pendentes, aprovadas_automaticamente: aprovadas, em: dataHoraLocal(), _revalidar: revalidar };
  run("INSERT INTO configuracoes (chave, valor) VALUES ('senior_ultima_conciliacao', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [JSON.stringify({ ...resumo, _revalidar: undefined })]);
  log('info', 'senior', `Conciliação: ${lancadas} lançadas, ${pendentes} não lançadas (${linhas.length} lançamentos lidos do Senior)`);
  return resumo;
}

export const ultimaConciliacao = () => getConfig('senior_ultima_conciliacao', null);
