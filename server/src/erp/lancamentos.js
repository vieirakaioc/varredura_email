// Produtividade do lançamento de notas de entrada no Senior (E440NFC), por pessoa, dia e hora.
// Mesma origem da consulta de notas fiscais de entrada; somente leitura.
//
// HORGER são minutos desde a meia-noite (1081 = 18:01), conferido com o relógio do servidor.
// DATGER é a data em que a nota foi lançada.
import { consultar, seniorConfigurado } from './senior.js';
import { ateOMinuto, comCache } from './cache.js';

// Situação da nota no Senior (E440NFC.SITNFC). Os relatórios do Senior costumam sair só com "Fechada".
const SITUACOES = { 1: 'Em digitação', 2: 'Fechada', 3: 'Cancelada' };

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
  if (filtros.usuario) itens = itens.filter((i) => i.usuario === filtros.usuario);
  if (filtros.codemp) itens = itens.filter((i) => String(i.codemp) === String(filtros.codemp));
  // empresa = "codemp/codfil", como aparece na caixa de seleção.
  // Guardamos a lista sem esse filtro para a caixa e o cartão "Por empresa" seguirem mostrando todas.
  const antesEmpresa = itens;
  if (filtros.empresa) itens = itens.filter((i) => `${i.codemp}/${i.codfil}` === String(filtros.empresa));
  // situacoes = lista separada por vírgula (1,2,3) ou "todas"; padrão: todas, como está no Senior.
  // O contador por situação olha o período inteiro, para mostrar o que o filtro está deixando de fora.
  const doPeriodo = itens;
  const escolhidas = String(filtros.situacoes ?? 'todas').split(',').map((s) => s.trim()).filter(Boolean);
  const passaSituacao = (i) => escolhidas.includes('todas') || escolhidas.includes(i.situacao);
  itens = itens.filter(passaSituacao);

  const hoje = new Date().toLocaleDateString('sv-SE');
  const dias = [...new Set(itens.map((i) => i.dia))].sort();
  const porDia = dias.map((d) => {
    const doDia = itens.filter((i) => i.dia === d);
    return { dia: d, notas: doDia.length, valor: soma(doDia, (i) => i.valor), pessoas: new Set(doDia.map((i) => i.usuario)).size };
  });
  const porHora = Array.from({ length: 24 }, (_, h) => ({
    hora: h, rotulo: `${String(h).padStart(2, '0')}h`,
    notas: itens.filter((i) => i.hora === h).length,
  }));
  const pessoas = [...itens.reduce((m, i) => {
    const p = m.get(i.usuario) ?? { usuario: i.usuario, notas: 0, valor: 0, com_xml: 0, horas: [], dias: new Set(), prazos: [], empresas: new Set() };
    p.notas += 1; p.valor += i.valor ?? 0; p.com_xml += i.com_xml ? 1 : 0;
    if (i.hora != null) p.horas.push(i.hora + (i.minuto ?? 0) / 60);
    p.dias.add(i.dia); p.empresas.add(`${i.codemp}/${i.codfil}`);
    if (i.dias_ate_lancar != null) p.prazos.push(i.dias_ate_lancar);
    return m.set(i.usuario, p);
  }, new Map()).values()].map((p) => {
    const fmtHora = (v) => (v == null ? null : `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`);
    return {
      usuario: p.usuario, notas: p.notas, valor: Math.round(p.valor * 100) / 100,
      dias_ativos: p.dias.size, media_dia: Math.round((p.notas / p.dias.size) * 10) / 10,
      empresas: p.empresas.size,
      pct_com_xml: Math.round((p.com_xml / p.notas) * 100),
      primeira_hora: fmtHora(p.horas.length ? Math.min(...p.horas) : null),
      ultima_hora: fmtHora(p.horas.length ? Math.max(...p.horas) : null),
      prazo_medio: p.prazos.length ? Math.round(media(p.prazos) * 10) / 10 : null,
      hoje: itens.filter((i) => i.usuario === p.usuario && i.dia === hoje).length,
    };
  }).sort((a, b) => b.notas - a.notas);

  // Mapa de calor pessoa × hora (top 10 pessoas do período)
  const topPessoas = pessoas.slice(0, 10).map((p) => p.usuario);
  const mapaCalor = topPessoas.map((usuario) => ({
    usuario,
    horas: Array.from({ length: 24 }, (_, h) => itens.filter((i) => i.usuario === usuario && i.hora === h).length),
  }));

  // Sem o filtro de empresa: o cartão continua comparando todas e serve de atalho para filtrar
  const porEmpresa = [...antesEmpresa.filter(passaSituacao).reduce((m, i) => {
    const k = `${i.codemp}/${i.codfil}`;
    const a = m.get(k) ?? { chave: k, rotulo: i.empresa, notas: 0, valor: 0 };
    a.notas += 1; a.valor += i.valor ?? 0;
    return m.set(k, a);
  }, new Map()).values()].sort((a, b) => b.notas - a.notas);

  const porOrigem = [
    { chave: 'xml', rotulo: 'A partir do XML recebido', notas: itens.filter((i) => i.com_xml).length },
    { chave: 'manual', rotulo: 'Digitada (sem XML na base)', notas: itens.filter((i) => !i.com_xml).length },
  ];
  const porSituacao = Object.entries(SITUACOES).map(([chave, rotulo]) => ({
    chave, rotulo,
    notas: doPeriodo.filter((i) => i.situacao === chave).length,
    valor: soma(doPeriodo.filter((i) => i.situacao === chave), (i) => i.valor),
  })).filter((s) => s.notas > 0);
  const prazos = itens.map((i) => i.dias_ate_lancar).filter((v) => v != null);
  const doDiaHoje = itens.filter((i) => i.dia === hoje);

  return {
    periodo, base, situacoes: escolhidas.join(','), situacoes_disponiveis: SITUACOES,
    empresa: filtros.empresa ?? '',
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
    },
    por_dia: porDia, por_hora: porHora, pessoas, mapa_calor: mapaCalor, por_empresa: porEmpresa.slice(0, 12), por_origem: porOrigem,
    por_situacao: porSituacao,
    itens: itens.sort((a, b) => String(b.dia).localeCompare(String(a.dia)) || (b.hora ?? 0) - (a.hora ?? 0)).slice(0, 3000),
  };
}
