// Entradas lançadas no Senior: conferência Transação × CFOP (somente leitura no Senior; consultas para SQL Server).
//
// Campos (verificados na base):
//   transação usada ........ E440IPC.TNSPRO (produto) / E440ISC.TNSSER (serviço)
//   CFOP lançado no item ... E440IPC.NOPPRO / E440ISC.NOPSER
//   CFOP da transação ...... E001TNS.COMNAT (a transação "1556A" gera CFOP 1556)
//   CFOP do fornecedor ..... E000IPC.NOPPRO / E000ISC.NOPSER (XML recebido), pela chave de acesso + sequência do item
//
// Checagens por nota × transação × CFOP:
//  1. Transação × CFOP da nota do fornecedor: de-para cadastrado pelo fiscal; sem cadastro, histórico
//     (combinação usada em menos de 5% das vezes com a transação = incomum).
//  2. CFOP lançado no item × CFOP da transação.
//  3. CFOP × UF: 1xxx exige fornecedor da mesma UF da filial; 2xxx de outra UF.
//  4. Prefixo: CFOP 5xxx do fornecedor → entrada 1xxx; 6xxx → 2xxx; 7xxx → 3xxx.
import { all, get, insert, run, update } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { DESCRICAO_CFOP } from '../fiscal/tabelas.js';

const LIMIAR_INCOMUM = 0.05;   // combinação abaixo de 5% dos usos da transação
const MINIMO_BASE = 20;        // usos mínimos da transação para o histórico valer
const DIAS_HISTORICO = 120;

let historico = { em: 0, mapa: new Map(), porTns: new Map() };
const limpo = (v) => String(v ?? '').trim();

// Itens de produto e de serviço na mesma forma, com o CFOP do XML do fornecedor (OUTER APPLY: 1 linha por item)
const ITENS = `
  SELECT i.CODEMP, i.CODFIL, i.CODFOR, i.NUMNFC, i.CODSNF, 'P' AS TIPO, i.TNSPRO AS CODTNS, i.NOPPRO AS CFOPENT, i.VLRLIQ AS VALOR, x.NOPPRO AS CFOPFOR
  FROM E440IPC i
  JOIN E440NFC n0 ON n0.CODEMP = i.CODEMP AND n0.CODFIL = i.CODFIL AND n0.CODFOR = i.CODFOR AND n0.NUMNFC = i.NUMNFC AND n0.CODSNF = i.CODSNF
  OUTER APPLY (SELECT TOP 1 e.NOPPRO FROM E000IPC e WHERE e.CHVNEL = n0.CHVNEL AND e.SEQIPC = i.SEQIPC AND LEN(n0.CHVNEL) = 44) x
  WHERE n0.DATENT >= @desde AND n0.DATENT <= @ate
  UNION ALL
  SELECT i.CODEMP, i.CODFIL, i.CODFOR, i.NUMNFC, i.CODSNF, 'S' AS TIPO, i.TNSSER AS CODTNS, i.NOPSER AS CFOPENT, i.VLRLIQ AS VALOR, x.NOPSER AS CFOPFOR
  FROM E440ISC i
  JOIN E440NFC n0 ON n0.CODEMP = i.CODEMP AND n0.CODFIL = i.CODFIL AND n0.CODFOR = i.CODFOR AND n0.NUMNFC = i.NUMNFC AND n0.CODSNF = i.CODSNF
  OUTER APPLY (SELECT TOP 1 e.NOPSER FROM E000ISC e WHERE e.CHVNEL = n0.CHVNEL AND e.SEQISC = i.SEQISC AND LEN(n0.CHVNEL) = 44) x
  WHERE n0.DATENT >= @desde AND n0.DATENT <= @ate`;

/** Frequência transação × CFOP do fornecedor (cache de 12 h). */
async function carregarHistorico() {
  if (Date.now() - historico.em < 12 * 3600000 && historico.mapa.size) return historico;
  const linhas = await consultar(`SELECT x.CODTNS, x.CFOPFOR, COUNT(*) AS N FROM (${ITENS}) x WHERE x.CFOPFOR IS NOT NULL GROUP BY x.CODTNS, x.CFOPFOR`,
    new Date(Date.now() - DIAS_HISTORICO * 86400000), { ate: new Date() });
  const mapa = new Map(), porTns = new Map();
  for (const l of linhas) {
    const tns = limpo(l.CODTNS), cf = limpo(l.CFOPFOR);
    if (!tns || !cf) continue;
    mapa.set(`${tns}|${cf}`, Number(l.N));
    porTns.set(tns, (porTns.get(tns) ?? 0) + Number(l.N));
  }
  historico = { em: Date.now(), mapa, porTns };
  return historico;
}

/** CFOPs de fornecedor mais usados com uma transação. */
export function usosDaTransacao(tns) {
  const total = historico.porTns.get(tns) ?? 0;
  return [...historico.mapa.entries()].filter(([k]) => k.startsWith(`${tns}|`))
    .map(([k, n]) => ({ cfop: k.split('|')[1], usos: n, pct: total ? n / total : 0 }))
    .sort((a, b) => b.usos - a.usos);
}

// ------------------------------------------------------------------ de-para (cadastro local)
const cfopsDe = (txt) => String(txt ?? '').split(/[\s,;]+/).map((c) => c.replace(/\D/g, '')).filter((c) => c.length === 4);
export const depara = () => all('SELECT * FROM transacao_cfop ORDER BY codtns');

export function salvarDepara({ codtns, cfops, observacao }, usuarioId) {
  const lista = [...new Set(cfopsDe(cfops))];
  const atual = get('SELECT id FROM transacao_cfop WHERE codtns = ?', [String(codtns)]);
  if (!lista.length) { if (atual) run('DELETE FROM transacao_cfop WHERE id = ?', [atual.id]); return null; }
  const dados = { codtns: String(codtns), cfops: lista.join(', '), observacao: observacao ?? null, atualizado_por: usuarioId, atualizado_em: new Date().toLocaleString('sv-SE') };
  if (atual) update('transacao_cfop', atual.id, dados); else insert('transacao_cfop', dados);
  return dados;
}

/** "Transação X com CFOP de fornecedor Y está correta": sem de-para ainda, parte dos CFOPs usuais do histórico. */
export function aceitarCombinacao(codtns, cfop, usuarioId) {
  const atual = get('SELECT cfops, observacao FROM transacao_cfop WHERE codtns = ?', [String(codtns)]);
  const base = atual ? cfopsDe(atual.cfops) : usosDaTransacao(String(codtns)).filter((u) => u.pct >= LIMIAR_INCOMUM).map((u) => u.cfop);
  return salvarDepara({ codtns, cfops: [...base, String(cfop)].join(', '), observacao: atual?.observacao ?? 'Criado a partir do histórico ao aceitar uma combinação' }, usuarioId);
}

// ------------------------------------------------------------------ checagens
const PREFIXO_ENTRADA = { 5: '1', 6: '2', 7: '3' };

export function avaliarLinha(l, { mapaDepara, hist }) {
  const achados = [];
  const tns = l.codtns, ent = l.cfop_entrada, forn = l.cfop_fornecedor;
  // 1. Transação × CFOP da nota do fornecedor
  if (forn) {
    const regra = mapaDepara.get(tns);
    if (regra) {
      if (!regra.includes(forn)) achados.push({ tipo: 'depara', grau: 'erro', texto: `Nota do fornecedor com CFOP ${forn} não é aceita na transação ${tns} (de-para: ${regra.join(', ')})` });
    } else {
      const total = hist.porTns.get(tns) ?? 0;
      const usos = hist.mapa.get(`${tns}|${forn}`) ?? 0;
      if (total >= MINIMO_BASE && usos / total < LIMIAR_INCOMUM) {
        const comuns = usosDaTransacao(tns).slice(0, 3).map((u) => `${u.cfop} (${Math.round(u.pct * 100)}%)`).join(', ');
        achados.push({ tipo: 'historico', grau: 'alerta', texto: `Incomum: transação ${tns} com nota de CFOP ${forn} em ${(usos / total * 100).toFixed(1)}% das vezes. Usual: ${comuns}` });
      }
    }
  }
  // 2. CFOP lançado × CFOP da transação
  if (ent && l.cfop_transacao && ent !== l.cfop_transacao) {
    achados.push({ tipo: 'transacao', grau: 'erro', texto: `Item lançado com CFOP ${ent}, mas a transação ${tns} é do CFOP ${l.cfop_transacao}` });
  }
  // 3. CFOP × UF (só mercadorias: em transporte/comunicação — CFOP x3xx — vale a UF da prestação, não a do fornecedor)
  const cfUf = ent || l.cfop_transacao;
  const mesmaUf = l.uf_fornecedor && l.uf_filial ? l.uf_fornecedor === l.uf_filial : null;
  if (/^[567]/.test(cfUf ?? '')) {
    achados.push({ tipo: 'uf', grau: 'erro', texto: `CFOP ${cfUf} é de saída, lançado em nota de entrada` });
  } else if (/^[12]/.test(cfUf ?? '') && cfUf[1] !== '3' && mesmaUf !== null && l.uf_fornecedor !== 'EX') {
    if (cfUf[0] === '1' && !mesmaUf) achados.push({ tipo: 'uf', grau: 'erro', texto: `CFOP ${cfUf} é de operação interna, mas o fornecedor é de ${l.uf_fornecedor} e a filial de ${l.uf_filial} (esperado 2xxx)` });
    if (cfUf[0] === '2' && mesmaUf) achados.push({ tipo: 'uf', grau: 'erro', texto: `CFOP ${cfUf} é interestadual, mas fornecedor e filial são de ${l.uf_filial} (esperado 1xxx)` });
  }
  // 4. Prefixo do CFOP do fornecedor × entrada
  if (forn && cfUf) {
    const esperado = PREFIXO_ENTRADA[forn[0]];
    if (esperado && cfUf[0] !== esperado) {
      // Compra presencial em outra UF: fornecedor emite como operação interna (5xxx) e a filial é de outro estado
      const presencial = forn[0] === '5' && cfUf[0] === '2' && mesmaUf === false;
      achados.push(presencial
        ? { tipo: 'fornecedor', grau: 'alerta', texto: `Compra presencial em outra UF: fornecedor (${l.uf_fornecedor}) emitiu CFOP interno ${forn} e a entrada foi lançada como ${cfUf}. Confirmar o critério com o fiscal.` }
        : { tipo: 'fornecedor', grau: 'erro', texto: `Fornecedor emitiu com CFOP ${forn}; a entrada deveria ser ${esperado}xxx (lançada ${cfUf})` });
    }
  }
  return achados;
}

/**
 * Entradas do período, uma linha por nota × transação × CFOP (itens somados).
 * filtros: de, ate (YYYY-MM-DD), codemp, codfil, codtns, cfop, fornecedor, so_divergencias
 */
export async function listarEntradas(filtros = {}) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  const hoje = new Date();
  // Datas em UTC ("Z"): sem isso o driver desloca 3 horas e o primeiro dia do período fica de fora
  const de = filtros.de ? new Date(`${filtros.de}T00:00:00Z`) : new Date(hoje.getTime() - 7 * 86400000);
  let ate = filtros.ate ? new Date(`${filtros.ate}T23:59:59Z`) : hoje;
  if (ate - de > 62 * 86400000) ate = new Date(de.getTime() + 62 * 86400000); // no máximo ~2 meses por consulta
  const extras = { ate };
  const cond = ['1 = 1'];
  if (filtros.codemp) { cond.push('n.CODEMP = @codemp'); extras.codemp = Number(filtros.codemp); }
  if (filtros.codfil) { cond.push('n.CODFIL = @codfil'); extras.codfil = Number(filtros.codfil); }
  if (filtros.codtns) { cond.push('x.CODTNS = @codtns'); extras.codtns = String(filtros.codtns); }
  if (filtros.cfop) { cond.push('(x.CFOPENT = @cfop OR x.CFOPFOR = @cfop)'); extras.cfop = String(filtros.cfop); }

  const sql = `SELECT n.CODEMP, n.CODFIL, n.CODFOR, n.NUMNFC, n.CODSNF, n.DATENT, n.DATEMI, n.CHVNEL,
      f.NOMFOR, f.CGCCPF, f.SIGUFS AS UFFOR, fi.SIGUFS AS UFFIL, fi.NOMFIL,
      x.TIPO, x.CODTNS, x.CFOPENT, x.CFOPFOR, MAX(t.DESTNS) AS DESTNS, MAX(t.COMNAT) AS CFOPTNS,
      COUNT(*) AS ITENS, SUM(x.VALOR) AS VALOR
    FROM (${ITENS}) x
    JOIN E440NFC n ON n.CODEMP = x.CODEMP AND n.CODFIL = x.CODFIL AND n.CODFOR = x.CODFOR AND n.NUMNFC = x.NUMNFC AND n.CODSNF = x.CODSNF
    JOIN E095FOR f ON f.CODFOR = n.CODFOR
    LEFT JOIN E070FIL fi ON fi.CODEMP = n.CODEMP AND fi.CODFIL = n.CODFIL
    LEFT JOIN E001TNS t ON t.CODEMP = n.CODEMP AND t.CODTNS = x.CODTNS
    WHERE ${cond.join(' AND ')}
    GROUP BY n.CODEMP, n.CODFIL, n.CODFOR, n.NUMNFC, n.CODSNF, n.DATENT, n.DATEMI, n.CHVNEL, f.NOMFOR, f.CGCCPF, f.SIGUFS, fi.SIGUFS, fi.NOMFIL,
      x.TIPO, x.CODTNS, x.CFOPENT, x.CFOPFOR`;
  const [linhas, hist] = await Promise.all([consultar(sql, de, extras), carregarHistorico()]);

  const mapaDepara = new Map(depara().map((d) => [d.codtns, cfopsDe(d.cfops)]));
  const dataIso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const busca = limpo(filtros.fornecedor).toLowerCase();
  const buscaNum = busca.replace(/\D/g, '');

  let itens = linhas.map((l) => {
    const linha = {
      codemp: l.CODEMP, codfil: l.CODFIL, filial: limpo(l.NOMFIL) || null, codfor: l.CODFOR,
      fornecedor: limpo(l.NOMFOR) || null, cnpj_fornecedor: String(l.CGCCPF ?? '').padStart(14, '0'),
      numero: l.NUMNFC, serie: limpo(l.CODSNF), entrada: dataIso(l.DATENT), emissao: dataIso(l.DATEMI), chave: limpo(l.CHVNEL) || null,
      tipo_item: l.TIPO === 'S' ? 'Serviço' : 'Produto', codtns: limpo(l.CODTNS), transacao: limpo(l.DESTNS) || null,
      cfop_transacao: limpo(l.CFOPTNS) || null, cfop_entrada: limpo(l.CFOPENT) || null, cfop_fornecedor: limpo(l.CFOPFOR) || null,
      uf_fornecedor: limpo(l.UFFOR) || null, uf_filial: limpo(l.UFFIL) || null,
      itens: Number(l.ITENS), valor: l.VALOR != null ? Number(l.VALOR) : null,
    };
    linha.cfop_entrada_descricao = DESCRICAO_CFOP[linha.cfop_entrada] ?? null;
    linha.cfop_fornecedor_descricao = DESCRICAO_CFOP[linha.cfop_fornecedor] ?? null;
    linha.achados = avaliarLinha(linha, { mapaDepara, hist });
    linha.situacao = linha.achados.some((a) => a.grau === 'erro') ? 'erro' : linha.achados.length ? 'alerta' : 'ok';
    return linha;
  });
  if (busca) itens = itens.filter((l) => (l.fornecedor ?? '').toLowerCase().includes(busca) || (buscaNum.length >= 4 && l.cnpj_fornecedor.includes(buscaNum)));
  const resumo = {
    linhas: itens.length, notas: new Set(itens.map((l) => `${l.codemp}|${l.codfil}|${l.codfor}|${l.numero}|${l.serie}`)).size,
    erros: itens.filter((l) => l.situacao === 'erro').length, alertas: itens.filter((l) => l.situacao === 'alerta').length,
    com_cfop_fornecedor: itens.filter((l) => l.cfop_fornecedor).length,
    por_tipo: ['depara', 'historico', 'transacao', 'uf', 'fornecedor'].map((t) => ({ tipo: t, qtd: itens.filter((l) => l.achados.some((a) => a.tipo === t)).length })),
    periodo: { de: de.toLocaleDateString('sv-SE'), ate: ate.toLocaleDateString('sv-SE') }, // datas locais (não UTC)
  };
  if (filtros.so_divergencias === '1') itens = itens.filter((l) => l.situacao !== 'ok');
  const ordem = { erro: 0, alerta: 1, ok: 2 };
  itens.sort((a, b) => (ordem[a.situacao] - ordem[b.situacao]) || String(b.entrada).localeCompare(String(a.entrada)));
  return { resumo, itens: itens.slice(0, 3000), truncado: itens.length > 3000 };
}

/** Transações usadas nos últimos meses com a distribuição de CFOPs do fornecedor (base para o de-para). */
export async function resumoTransacoes() {
  const hist = await carregarHistorico();
  const nomes = new Map((await consultar('SELECT CODTNS, MAX(DESTNS) AS DESTNS, MAX(COMNAT) AS COMNAT FROM E001TNS GROUP BY CODTNS'))
    .map((t) => [limpo(t.CODTNS), { nome: limpo(t.DESTNS), cfop: limpo(t.COMNAT) }]));
  const cadastro = new Map(depara().map((d) => [d.codtns, d]));
  return [...hist.porTns.entries()].sort((a, b) => b[1] - a[1]).map(([tns, usos]) => ({
    codtns: tns, transacao: nomes.get(tns)?.nome ?? null, cfop_transacao: nomes.get(tns)?.cfop ?? null,
    usos, cfops: usosDaTransacao(tns).slice(0, 8), depara: cadastro.get(tns) ?? null,
  }));
}

/** Diagnóstico: confirma que as colunas usadas existem na base. */
export async function diagnosticoEsquema() {
  const linhas = await consultar(`SELECT UPPER(TABLE_NAME) AS T, UPPER(COLUMN_NAME) AS C FROM INFORMATION_SCHEMA.COLUMNS
    WHERE UPPER(TABLE_NAME) IN ('E440IPC','E440ISC','E000IPC','E000ISC','E001TNS')
      AND UPPER(COLUMN_NAME) IN ('TNSPRO','TNSSER','NOPPRO','NOPSER','SEQIPC','SEQISC','CHVNEL','COMNAT','DESTNS')`);
  return linhas.map((l) => `${l.T}.${l.C}`).sort();
}
