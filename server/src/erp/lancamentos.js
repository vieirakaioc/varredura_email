// Produtividade do lançamento de notas de entrada no Senior (E440NFC), por pessoa, dia e hora.
// Mesma origem da consulta de notas fiscais de entrada; somente leitura.
//
// HORGER são minutos desde a meia-noite (1081 = 18:01), conferido com o relógio do servidor.
// DATGER é a data em que a nota foi lançada.
import { getConfig, setConfig } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { ateOMinuto, comCache } from './cache.js';

// Situação da nota no Senior (E440NFC.SITNFC). Os relatórios do Senior costumam sair só com "Fechada".
const SITUACOES = { 1: 'Em digitação', 2: 'Fechada', 3: 'Cancelada' };
const LIMITE_ITENS = 10000;

// ------------------------------------------------------------------ metas de lançamento
// Meta automática = média da equipe de notas por pessoa em cada dia trabalhado, nos últimos 90 dias
// (notas não canceladas, pela data em que foram lançadas). Metas manuais (padrão e por pessoa) substituem a automática.
const DIAS_BASE_META = 90;
const SQL_MEDIA = `SELECT COUNT(*) AS PESSOA_DIAS, SUM(q.N) AS NOTAS FROM (
    SELECT n.USUGER, n.DATGER, COUNT(*) AS N FROM E440NFC n
    WHERE n.DATGER >= @desde AND n.DATGER <= @ate AND n.SITNFC <> '3'
    GROUP BY n.USUGER, n.DATGER) q`;
let mediaGuardada = { em: 0, valor: null };

/** Média histórica de notas por pessoa por dia trabalhado (cache de 12 horas). */
async function mediaHistorica() {
  if (Date.now() - mediaGuardada.em < 12 * 3600000) return mediaGuardada.valor;
  try {
    const [l] = await consultar(SQL_MEDIA, new Date(Date.now() - DIAS_BASE_META * 86400000), { ate: new Date() });
    const valor = Number(l?.PESSOA_DIAS) ? Math.round((Number(l.NOTAS) / Number(l.PESSOA_DIAS)) * 10) / 10 : null;
    mediaGuardada = { em: Date.now(), valor };
  } catch {
    mediaGuardada = { em: Date.now() - 11 * 3600000, valor: mediaGuardada.valor }; // tenta de novo em 1 hora
  }
  return mediaGuardada.valor;
}

/** Metas em vigor: manual quando cadastrada, senão a média histórica arredondada. */
export function metasLancamento(automatica) {
  const cfg = getConfig('metas_lancamento', {}) ?? {};
  const auto = automatica != null ? Math.max(1, Math.round(automatica)) : null;
  return {
    padrao: cfg.padrao ?? auto, padrao_manual: cfg.padrao != null,
    automatica, pessoas: cfg.pessoas ?? {}, base: `média da equipe por pessoa/dia nos últimos ${DIAS_BASE_META} dias`,
  };
}

/** Grava metas manuais. padrao: número ou null (volta para a automática); pessoas: { nome: número|null }. */
export function salvarMetas({ padrao, pessoas } = {}) {
  const cfg = getConfig('metas_lancamento', {}) ?? {};
  const num = (v) => (v === null || v === '' || v === undefined ? null : Number(v) > 0 ? Math.round(Number(v) * 10) / 10 : null);
  if (padrao !== undefined) cfg.padrao = num(padrao);
  cfg.pessoas = { ...(cfg.pessoas ?? {}) };
  for (const [nome, v] of Object.entries(pessoas ?? {})) {
    if (num(v) == null) delete cfg.pessoas[nome]; else cfg.pessoas[nome] = num(v);
  }
  setConfig('metas_lancamento', cfg);
  return metasLancamento(mediaGuardada.valor);
}

const SQL = `SELECT n.CODEMP, n.CODFIL, n.NUMNFC, n.CODSNF, n.DATENT, n.DATGER, n.HORGER, n.USUGER, n.VLRLIQ, n.SITNFC,
    u.NOMUSU, fi.SIGFIL, fi.NOMFIL, fo.NOMFOR,
    CASE WHEN x.CHVNEL IS NULL THEN 0 ELSE 1 END AS COM_XML,
    CASE WHEN x.CHVNEL IS NULL THEN NULL ELSE DATEDIFF(day, x.DATENT, n.DATGER) END AS DIAS_ATE_LANCAR
  FROM E440NFC n
  LEFT JOIN r999usu u ON u.CODUSU = n.USUGER
  LEFT JOIN E070FIL fi ON fi.CODEMP = n.CODEMP AND fi.CODFIL = n.CODFIL
  LEFT JOIN E095FOR fo ON fo.CODFOR = n.CODFOR
  LEFT JOIN E000NFC x ON x.CHVNEL = n.CHVNEL
  WHERE {campoData} >= @desde AND {campoData} <= @ate`;

const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const horaDe = (h) => (h == null ? null : Math.min(23, Math.floor(Number(h) / 60)));  // minutos do dia -> hora
const minutoDe = (h) => (h == null ? null : Math.round(Number(h) % 60));
const media = (lista) => (lista.length ? lista.reduce((s, x) => s + x, 0) / lista.length : null);
const soma = (lista, f) => Math.round(lista.reduce((s, x) => s + (f(x) ?? 0), 0) * 100) / 100;

/**
 * Painel de lançamentos: quem lançou, quando e quanto.
 * filtros: de, ate (AAAA-MM-DD), dias (padrão 30), mes (AAAA-MM), usuario, codemp
 */
export async function painelLancamentos(filtros = {}) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  const mes = /^\d{4}-\d{2}$/.test(String(filtros.mes ?? '')) ? String(filtros.mes) : null;
  const periodo = mes
    ? { de: `${mes}-01`, ate: new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).toLocaleDateString('sv-SE') }
    : {
      de: filtros.de ?? new Date(Date.now() - (Number(filtros.dias) || 30) * 86400000).toLocaleDateString('sv-SE'),
      ate: filtros.ate ?? new Date().toLocaleDateString('sv-SE'),
    };
  // Base do período e do agrupamento por dia:
  //   geracao = quando a pessoa lançou (produtividade)
  //   entrada = data de entrada da nota (bate com os relatórios do Senior filtrados por entrada)
  const base = filtros.base === 'entrada' ? 'entrada' : 'geracao';
  const campoData = base === 'entrada' ? 'n.DATENT' : 'n.DATGER';
  // "Z": o driver converte para UTC; sem isso o período andava 3 horas e perdia o primeiro dia
  const de = new Date(`${periodo.de}T00:00:00Z`);
  const ate = new Date(`${periodo.ate}T23:59:59Z`);
  // Pessoa, empresa e situação são filtrados abaixo, sobre estas linhas: cache de um minuto por período
  const linhas = await comCache(
    `lancamentos|${base}|${ateOMinuto(de)}|${ateOMinuto(ate)}`,
    filtros.forcar === '1' ? 0 : 60_000,
    () => consultar(SQL.replaceAll('{campoData}', campoData), de, { ate }),
  );

  let itens = linhas.map((l) => ({
    codemp: l.CODEMP, codfil: l.CODFIL,
    empresa: String(l.SIGFIL ?? '').trim() || String(l.NOMFIL ?? '').trim() || `Emp ${l.CODEMP}/${l.CODFIL}`,
    numero: l.NUMNFC, serie: String(l.CODSNF ?? '').trim() || null,
    fornecedor: String(l.NOMFOR ?? '').trim() || null,
    entrada: iso(l.DATENT), geracao: iso(l.DATGER),
    situacao: String(l.SITNFC ?? '').trim(),
    situacao_rotulo: SITUACOES[String(l.SITNFC ?? '').trim()] ?? `Situação ${String(l.SITNFC ?? '').trim() || '?'}`,
    dia: base === 'entrada' ? iso(l.DATENT) : iso(l.DATGER),
    hora: horaDe(l.HORGER), minuto: minutoDe(l.HORGER),
    usuario: String(l.NOMUSU ?? '').trim() || `Usuário ${l.USUGER}`,
    valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null,
    com_xml: l.COM_XML === 1,
    dias_ate_lancar: l.DIAS_ATE_LANCAR != null ? Math.max(0, Number(l.DIAS_ATE_LANCAR)) : null,
  }));
  // Filtros em cascata: cada clique num gráfico vira um filtro (dia, hora, pessoa, empresa, origem, situação).
  // Cada gráfico é montado com todos os filtros MENOS o dele, para continuar mostrando as outras barras
  // (a selecionada fica destacada) e permitir trocar a escolha.
  const escolhidas = String(filtros.situacoes ?? 'todas').split(',').map((s) => s.trim()).filter(Boolean);
  const filtroHora = filtros.hora !== undefined && filtros.hora !== '' ? Number(filtros.hora) : null;
  const testes = {
    usuario: (i) => !filtros.usuario || i.usuario === filtros.usuario,
    codemp: (i) => !filtros.codemp || String(i.codemp) === String(filtros.codemp),
    // empresa = "codemp/codfil", como aparece na caixa de seleção
    empresa: (i) => !filtros.empresa || `${i.codemp}/${i.codfil}` === String(filtros.empresa),
    situacao: (i) => escolhidas.includes('todas') || escolhidas.includes(i.situacao),
    dia: (i) => !filtros.dia || i.dia === filtros.dia,
    hora: (i) => filtroHora == null || i.hora === filtroHora,
    origem: (i) => !filtros.origem || (filtros.origem === 'xml' ? i.com_xml : !i.com_xml),
  };
  const todos = itens;
  const semFiltro = (...exceto) => todos.filter((i) => Object.entries(testes).every(([k, t]) => exceto.includes(k) || t(i)));
  itens = semFiltro();

  const hoje = new Date().toLocaleDateString('sv-SE');
  const paraDias = semFiltro('dia');
  const dias = [...new Set(paraDias.map((i) => i.dia))].sort();
  const metas = metasLancamento(await mediaHistorica());
  const metaDe = (usuario) => metas.pessoas[usuario] ?? metas.padrao;
  const porDia = dias.map((d) => {
    const doDia = paraDias.filter((i) => i.dia === d);
    const quem = [...new Set(doDia.map((i) => i.usuario))];
    return {
      dia: d, notas: doDia.length, valor: soma(doDia, (i) => i.valor), pessoas: quem.length,
      // meta do dia = soma das metas de quem lançou nesse dia
      meta: metas.padrao != null ? Math.round(quem.reduce((s, u) => s + (metaDe(u) ?? 0), 0) * 10) / 10 : null,
    };
  });
  const paraHoras = semFiltro('hora');
  const porHora = Array.from({ length: 24 }, (_, h) => ({
    hora: h, rotulo: `${String(h).padStart(2, '0')}h`,
    notas: paraHoras.filter((i) => i.hora === h).length,
  }));
  const paraPessoas = semFiltro('usuario');
  const pessoas = [...paraPessoas.reduce((m, i) => {
    const p = m.get(i.usuario) ?? { usuario: i.usuario, notas: 0, valor: 0, com_xml: 0, horas: [], dias: new Map(), prazos: [], empresas: new Set() };
    p.notas += 1; p.valor += i.valor ?? 0; p.com_xml += i.com_xml ? 1 : 0;
    if (i.hora != null) p.horas.push(i.hora + (i.minuto ?? 0) / 60);
    p.dias.set(i.dia, (p.dias.get(i.dia) ?? 0) + 1); p.empresas.add(`${i.codemp}/${i.codfil}`);
    if (i.dias_ate_lancar != null) p.prazos.push(i.dias_ate_lancar);
    return m.set(i.usuario, p);
  }, new Map()).values()].map((p) => {
    const fmtHora = (v) => (v == null ? null : `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`);
    const mediaDia = Math.round((p.notas / p.dias.size) * 10) / 10;
    const meta = metaDe(p.usuario);
    return {
      usuario: p.usuario, notas: p.notas, valor: Math.round(p.valor * 100) / 100,
      dias_ativos: p.dias.size, media_dia: mediaDia,
      meta_dia: meta, meta_manual: metas.pessoas[p.usuario] != null,
      pct_meta: meta ? Math.round((mediaDia / meta) * 100) : null,
      dias_na_meta: meta ? [...p.dias.values()].filter((n) => n >= meta).length : null,
      empresas: p.empresas.size,
      pct_com_xml: Math.round((p.com_xml / p.notas) * 100),
      primeira_hora: fmtHora(p.horas.length ? Math.min(...p.horas) : null),
      ultima_hora: fmtHora(p.horas.length ? Math.max(...p.horas) : null),
      prazo_medio: p.prazos.length ? Math.round(media(p.prazos) * 10) / 10 : null,
      hoje: p.dias.get(hoje) ?? 0,
    };
  }).sort((a, b) => b.notas - a.notas);

  // Mapa de calor pessoa × hora (top 10 pessoas): clicar numa célula filtra pessoa e hora juntas
  const paraCalor = semFiltro('usuario', 'hora');
  const topPessoas = pessoas.slice(0, 10).map((p) => p.usuario);
  const mapaCalor = topPessoas.map((usuario) => ({
    usuario,
    horas: Array.from({ length: 24 }, (_, h) => paraCalor.filter((i) => i.usuario === usuario && i.hora === h).length),
  }));

  const porEmpresa = [...semFiltro('empresa', 'codemp').reduce((m, i) => {
    const k = `${i.codemp}/${i.codfil}`;
    const a = m.get(k) ?? { chave: k, rotulo: i.empresa, notas: 0, valor: 0 };
    a.notas += 1; a.valor += i.valor ?? 0;
    return m.set(k, a);
  }, new Map()).values()].sort((a, b) => b.notas - a.notas);

  const paraOrigem = semFiltro('origem');
  const porOrigem = [
    { chave: 'xml', rotulo: 'A partir do XML recebido', notas: paraOrigem.filter((i) => i.com_xml).length },
    { chave: 'manual', rotulo: 'Digitada (sem XML na base)', notas: paraOrigem.filter((i) => !i.com_xml).length },
  ];
  // O contador por situação ignora o próprio filtro, para mostrar o que ele está deixando de fora
  const doPeriodo = semFiltro('situacao');
  const porSituacao = Object.entries(SITUACOES).map(([chave, rotulo]) => ({
    chave, rotulo,
    notas: doPeriodo.filter((i) => i.situacao === chave).length,
    valor: soma(doPeriodo.filter((i) => i.situacao === chave), (i) => i.valor),
  })).filter((s) => s.notas > 0);
  const prazos = itens.map((i) => i.dias_ate_lancar).filter((v) => v != null);
  const doDiaHoje = itens.filter((i) => i.dia === hoje);
  const pessoaDias = new Set(itens.map((i) => `${i.usuario}|${i.dia}`)).size;

  return {
    periodo, base, situacoes: escolhidas.join(','), situacoes_disponiveis: SITUACOES,
    empresa: filtros.empresa ?? '',
    filtros_ativos: { usuario: filtros.usuario || null, empresa: filtros.empresa || null, dia: filtros.dia || null, hora: filtroHora, origem: filtros.origem || null },
    metas: { padrao: metas.padrao, automatica: metas.automatica, padrao_manual: metas.padrao_manual, base: metas.base },
    empresas_disponiveis: [...porEmpresa].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    indicadores: {
      notas: itens.length, valor: soma(itens, (i) => i.valor),
      hoje: doDiaHoje.length, hoje_valor: soma(doDiaHoje, (i) => i.valor),
      pessoas: pessoas.length, pessoas_hoje: new Set(doDiaHoje.map((i) => i.usuario)).size,
      media_dia: porDia.length ? Math.round((itens.length / porDia.length) * 10) / 10 : 0,
      melhor_dia: porDia.reduce((max, d) => (d.notas > (max?.notas ?? 0) ? d : max), null),
      pico_hora: porHora.reduce((max, h) => (h.notas > (max?.notas ?? 0) ? h : max), null),
      prazo_medio: prazos.length ? Math.round(media(prazos) * 10) / 10 : null,
      no_mesmo_dia: prazos.length ? Math.round((prazos.filter((p) => p === 0).length / prazos.length) * 100) : null,
      pct_com_xml: itens.length ? Math.round((itens.filter((i) => i.com_xml).length / itens.length) * 100) : 0,
      // produtividade: notas por pessoa em cada dia trabalhado
      media_pessoa_dia: pessoaDias ? Math.round((itens.length / pessoaDias) * 10) / 10 : null,
      total_periodo: todos.length,
    },
    por_dia: porDia, por_hora: porHora, pessoas, mapa_calor: mapaCalor, por_empresa: porEmpresa.slice(0, 12), por_origem: porOrigem,
    por_situacao: porSituacao,
    // Lista das notas lançadas (com os filtros em cascata), mais recentes primeiro
    itens: itens.sort((a, b) => String(b.geracao).localeCompare(String(a.geracao)) || ((b.hora ?? 0) * 60 + (b.minuto ?? 0)) - ((a.hora ?? 0) * 60 + (a.minuto ?? 0)))
      .slice(0, LIMITE_ITENS).map((i) => ({ ...i, horario: i.hora != null ? `${String(i.hora).padStart(2, '0')}:${String(i.minuto ?? 0).padStart(2, '0')}` : null })),
    total_itens: itens.length,
  };
}
