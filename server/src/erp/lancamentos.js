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

// ------------------------------------------------------------------ equipes e metas de lançamento
// Só o time de Escrita Fiscal tem meta; as demais pessoas que lançam nota aparecem como "Outros".
// Meta pela capacidade de trabalho:
//   minutos da jornada (saída − entrada − intervalo) × % de tempo produtivo ÷ minutos por nota = notas por dia
//   ex.: 08:00–17:48 com 1 h de almoço = 528 min × 85% ÷ 5 min = 89 notas/dia
// Cada pessoa pode ter jornada própria (minutos por dia e dias da semana, ex.: aprendiz) ou uma meta fixa.
// Feriados não são descontados.
const ESCRITA_FISCAL_PADRAO = ['NELIZI.SILVA', 'MICHELE.PAULUCCI', 'ITHALO.SILVA', 'AMANDA.MARQUES', 'ELZELI.SANTOS',
  'ANA.CLARA', 'GABRIELA.MARTINS', 'EMANUELLE.SILVA', 'ERICA.ARAUJO', 'CELINE.SILVA'];
const PARAMETROS_PADRAO = { minutos_por_nota: 5, entrada: '08:00', saida: '17:48', intervalo_min: 60, produtividade: 85, dias_semana: [1, 2, 3, 4, 5] };
// Emanuelle é aprendiz: 4 horas por dia, de segunda a quinta
const JORNADAS_PADRAO = { 'EMANUELLE.SILVA': { minutos_dia: 240, dias_semana: [1, 2, 3, 4] } };
export const EQUIPES = { fiscal: 'Escrita Fiscal', outros: 'Outros' };
const nomeChave = (n) => String(n ?? '').trim().toUpperCase();
const minutos = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Metas em vigor, time e a capacidade de cada pessoa. */
export function metasLancamento() {
  const cfg = getConfig('metas_lancamento', {}) ?? {};
  const par = { ...PARAMETROS_PADRAO, ...(cfg.parametros ?? {}) };
  const membros = cfg.escrita_fiscal ?? ESCRITA_FISCAL_PADRAO;
  const doTime = new Set(membros.map(nomeChave));
  const jornadas = Object.fromEntries(Object.entries(cfg.jornadas ?? JORNADAS_PADRAO).map(([n, j]) => [nomeChave(n), j]));
  const fixas = Object.fromEntries(Object.entries(cfg.pessoas ?? {}).map(([n, v]) => [nomeChave(n), v]));
  const minutosPadrao = Math.max(0, minutos(par.saida) - minutos(par.entrada) - Number(par.intervalo_min || 0));
  const porDia = (min) => Math.floor((min * (Number(par.produtividade) / 100)) / Number(par.minutos_por_nota || 5));
  const padrao = porDia(minutosPadrao);
  const equipeDe = (usuario) => (doTime.has(nomeChave(usuario)) ? 'fiscal' : 'outros');
  /** Jornada e meta diária de uma pessoa do time (null para quem não é do time). */
  const jornadaDe = (usuario) => {
    if (equipeDe(usuario) !== 'fiscal') return null;
    const j = jornadas[nomeChave(usuario)] ?? {};
    const min = j.minutos_dia ?? minutosPadrao;
    const fixa = fixas[nomeChave(usuario)];
    return { minutos_dia: min, dias_semana: j.dias_semana ?? par.dias_semana, meta_dia: fixa ?? porDia(min), meta_fixa: fixa != null, jornada_propria: Boolean(jornadas[nomeChave(usuario)]) };
  };
  return {
    parametros: par, minutos_jornada: minutosPadrao, padrao,
    calculo: `${Math.floor(minutosPadrao / 60)}h${String(minutosPadrao % 60).padStart(2, '0')} (${par.entrada}–${par.saida} − ${par.intervalo_min} min) × ${par.produtividade}% ÷ ${par.minutos_por_nota} min por nota`,
    escrita_fiscal: membros, jornadas: cfg.jornadas ?? JORNADAS_PADRAO, pessoas: cfg.pessoas ?? {},
    equipeDe, jornadaDe,
    metaDe: (usuario) => jornadaDe(usuario)?.meta_dia ?? null,
    /** Meta da pessoa numa data (0 se ela não trabalha nesse dia da semana). */
    metaNoDia: (usuario, dia) => {
      const j = jornadaDe(usuario);
      if (!j) return 0;
      return j.dias_semana.includes(new Date(`${dia}T12:00:00Z`).getUTCDay()) ? j.meta_dia : 0;
    },
  };
}
export const rotuloDias = (lista) => lista.map((d) => DIAS_SEMANA[d]).join(', ');

/**
 * Grava a configuração das metas. Campos opcionais:
 *   parametros: { minutos_por_nota, entrada, saida, intervalo_min, produtividade, dias_semana }
 *   escrita_fiscal: [nomes]
 *   jornadas: { nome: { minutos_dia, dias_semana } | null }   (null = jornada padrão)
 *   pessoas: { nome: número | null }                           (meta fixa; null = pela jornada)
 */
export function salvarMetas({ parametros, escrita_fiscal: time, jornadas, pessoas } = {}) {
  const cfg = getConfig('metas_lancamento', {}) ?? {};
  const num = (v) => (v === null || v === '' || v === undefined || !(Number(v) > 0) ? null : Math.round(Number(v) * 10) / 10);
  const dias = (l) => (Array.isArray(l) ? [...new Set(l.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : null);
  if (parametros) {
    const p = { ...PARAMETROS_PADRAO, ...(cfg.parametros ?? {}) };
    if (num(parametros.minutos_por_nota)) p.minutos_por_nota = num(parametros.minutos_por_nota);
    if (num(parametros.produtividade)) p.produtividade = Math.min(100, num(parametros.produtividade));
    if (/^\d{1,2}:\d{2}$/.test(parametros.entrada ?? '')) p.entrada = parametros.entrada;
    if (/^\d{1,2}:\d{2}$/.test(parametros.saida ?? '')) p.saida = parametros.saida;
    if (parametros.intervalo_min !== undefined && Number(parametros.intervalo_min) >= 0) p.intervalo_min = Number(parametros.intervalo_min);
    if (dias(parametros.dias_semana)?.length) p.dias_semana = dias(parametros.dias_semana);
    cfg.parametros = p;
  }
  if (Array.isArray(time)) cfg.escrita_fiscal = [...new Set(time.map((n) => String(n).trim()).filter(Boolean))];
  if (jornadas) {
    cfg.jornadas = { ...(cfg.jornadas ?? JORNADAS_PADRAO) };
    for (const [nome, j] of Object.entries(jornadas)) {
      const min = num(j?.minutos_dia), ds = dias(j?.dias_semana);
      if (!j || (!min && !ds?.length)) delete cfg.jornadas[nome];
      else cfg.jornadas[nome] = { ...(min ? { minutos_dia: min } : {}), ...(ds?.length ? { dias_semana: ds } : {}) };
    }
  }
  cfg.pessoas = { ...(cfg.pessoas ?? {}) };
  for (const [nome, v] of Object.entries(pessoas ?? {})) {
    if (num(v) == null) delete cfg.pessoas[nome]; else cfg.pessoas[nome] = num(v);
  }
  delete cfg.padrao; // meta padrão manual antiga: agora vem da jornada
  setConfig('metas_lancamento', cfg);
  const { equipeDe, jornadaDe, metaDe, metaNoDia, ...r } = metasLancamento();
  return r;
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
  const metas = metasLancamento();
  const { metaDe, equipeDe, jornadaDe, metaNoDia } = metas;
  // Dias do período até hoje (a meta "até hoje" não cobra dias que ainda não chegaram)
  const hojeIso = new Date().toLocaleDateString('sv-SE');
  const diasPeriodo = [];
  for (let d = new Date(`${periodo.de}T12:00:00Z`); d.toISOString().slice(0, 10) <= periodo.ate; d.setUTCDate(d.getUTCDate() + 1)) diasPeriodo.push(d.toISOString().slice(0, 10));
  const diasAteHoje = diasPeriodo.filter((d) => d <= hojeIso);
  const metaPessoa = (usuario, lista) => lista.reduce((s, d) => s + metaNoDia(usuario, d), 0);
  const testes = {
    equipe: (i) => !filtros.equipe || equipeDe(i.usuario) === filtros.equipe,
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
  const porDia = dias.map((d) => {
    const doDia = paraDias.filter((i) => i.dia === d);
    const quem = [...new Set(doDia.map((i) => i.usuario))];
    return {
      dia: d, notas: doDia.length, valor: soma(doDia, (i) => i.valor), pessoas: quem.length,
      // meta do dia = soma das metas de quem lançou nesse dia
      // capacidade do time nesse dia (todos do time que trabalham nesse dia da semana)
      meta: metas.escrita_fiscal.reduce((s, u) => s + metaNoDia(u, d), 0) || null,
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
    const jornada = jornadaDe(p.usuario);
    const esperado = meta != null ? metaPessoa(p.usuario, diasAteHoje) : null;
    return {
      usuario: p.usuario, notas: p.notas, valor: Math.round(p.valor * 100) / 100,
      dias_ativos: p.dias.size, media_dia: mediaDia,
      equipe: equipeDe(p.usuario),
      meta_dia: meta, meta_manual: Boolean(jornada?.meta_fixa),
      jornada: jornada ? { minutos_dia: jornada.minutos_dia, dias: rotuloDias(jornada.dias_semana), propria: jornada.jornada_propria } : null,
      // meta até hoje = soma da meta de cada dia útil dela no período até hoje; % = lançado ÷ essa meta
      meta_ate_hoje: esperado, meta_periodo: meta != null ? metaPessoa(p.usuario, diasPeriodo) : null,
      pct_meta: esperado ? Math.round((p.notas / esperado) * 100) : null,
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
  // Resumo por equipe (ignora o próprio filtro de equipe, para os dois blocos aparecerem sempre)
  const porEquipe = Object.entries(EQUIPES).map(([chave, rotulo]) => {
    const lista = semFiltro('equipe').filter((i) => equipeDe(i.usuario) === chave);
    const pd = new Set(lista.map((i) => `${i.usuario}|${i.dia}`)).size;
    return {
      chave, rotulo, notas: lista.length, valor: soma(lista, (i) => i.valor),
      pessoas: new Set(lista.map((i) => i.usuario)).size,
      media_pessoa_dia: pd ? Math.round((lista.length / pd) * 10) / 10 : null,
      ...(chave === 'fiscal' ? {
        meta_dia_pessoa: metas.padrao,
        meta_periodo: metas.escrita_fiscal.reduce((s, u) => s + metaPessoa(u, diasPeriodo), 0),
        meta_ate_hoje: metas.escrita_fiscal.reduce((s, u) => s + metaPessoa(u, diasAteHoje), 0),
      } : {}),
    };
  });

  return {
    periodo, base, situacoes: escolhidas.join(','), situacoes_disponiveis: SITUACOES,
    empresa: filtros.empresa ?? '',
    filtros_ativos: { equipe: filtros.equipe || null, usuario: filtros.usuario || null, empresa: filtros.empresa || null, dia: filtros.dia || null, hora: filtroHora, origem: filtros.origem || null },
    metas: {
      padrao: metas.padrao, calculo: metas.calculo, parametros: metas.parametros, minutos_jornada: metas.minutos_jornada,
      escrita_fiscal: metas.escrita_fiscal, jornadas: metas.jornadas, pessoas: metas.pessoas,
      // time completo com a jornada de cada um (inclusive quem não lançou nada no período)
      time: metas.escrita_fiscal.map((u) => ({ usuario: u, ...jornadaDe(u), dias: rotuloDias(jornadaDe(u).dias_semana), meta_periodo: metaPessoa(u, diasPeriodo), meta_ate_hoje: metaPessoa(u, diasAteHoje) })),
    },
    por_equipe: porEquipe,
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
