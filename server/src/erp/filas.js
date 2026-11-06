// Operação por fila de tipo de nota (piloto de 16 a 30/10/2026).
//
// Duas coisas que não existem no Senior e passam a existir aqui, de forma agregada:
//   - a alocação: quem atende cada tipo de nota
//   - o compromisso do dia: quanto cada pessoa combinou entregar, por tipo
//
// Nada disso vira status ou apontamento por nota no ERP, como o plano pede. O compromisso é
// sugerido a partir das pendências em aberto e da meta de cada pessoa, e o gestor ajusta.
import { all, get, run, tx } from '../db/index.js';
import { CATEGORIAS } from './categorias.js';
import { metasLancamento } from './lancamentos.js';

export const PAPEIS = { titular: 'Titular', apoio: 'Apoio' };

/** Alocação atual: lista por categoria, com as pessoas de cada fila. */
export function listarFilas() {
  const linhas = all('SELECT categoria, usuario, papel FROM filas_escrita ORDER BY categoria, papel DESC, usuario');
  const metas = metasLancamento();
  const porCategoria = Object.entries(CATEGORIAS).map(([chave, rotulo]) => ({
    chave, rotulo,
    pessoas: linhas.filter((l) => l.categoria === chave).map((l) => ({ ...l, meta_dia: metas.metaDe(l.usuario) })),
  }));
  const alocadas = new Set(linhas.map((l) => l.usuario));
  return {
    categorias: porCategoria,
    // Quem do time ainda não está em fila nenhuma: o plano pede que nenhuma frente fique sem responsável
    sem_fila: metas.escrita_fiscal.filter((u) => !alocadas.has(u)),
    time: metas.escrita_fiscal.map((u) => ({ usuario: u, meta_dia: metas.metaDe(u) })),
    supervisao: metas.supervisao,
  };
}

/** Substitui a alocação inteira. `filas` = { categoria: [{ usuario, papel }] } */
export function salvarFilas(filas) {
  tx(() => {
    run('DELETE FROM filas_escrita');
    for (const [categoria, pessoas] of Object.entries(filas ?? {})) {
      if (!CATEGORIAS[categoria]) continue;
      for (const p of pessoas ?? []) {
        const usuario = String(p?.usuario ?? '').trim();
        if (!usuario) continue;
        run('INSERT OR REPLACE INTO filas_escrita (categoria, usuario, papel) VALUES (?, ?, ?)',
          [categoria, usuario, p.papel === 'apoio' ? 'apoio' : 'titular']);
      }
    }
  });
  return listarFilas();
}

const hoje = () => new Date().toLocaleDateString('sv-SE');
const ehDiaUtil = (dia) => { const d = new Date(`${dia}T12:00:00Z`).getUTCDay(); return d >= 1 && d <= 5; };

/**
 * Sugestão de compromisso do dia: distribui as pendências em aberto entre quem atende cada fila,
 * limitada pela meta diária de cada pessoa.
 *
 * A meta diária é referência provisória do piloto (37 notas/dia, 17 para jornada parcial) — não é
 * medida de esforço. Por isso a sugestão vem sempre acompanhada do que ela assume.
 */
export async function sugerirCompromisso(dia = hoje()) {
  const { painelPendentes } = await import('./pendentes.js');
  const pendentes = await painelPendentes({ dias: 'tudo', responsavel: 'fiscal' });
  const emAberto = Object.fromEntries((pendentes.por_categoria ?? []).map((c) => [c.chave, c.qtd]));
  const metas = metasLancamento();
  const filas = listarFilas();

  const itens = [];
  for (const cat of filas.categorias) {
    const pessoas = cat.pessoas.filter((p) => metas.metaNoDia(p.usuario, dia) > 0);
    if (!pessoas.length) continue;
    const fila = emAberto[cat.chave] ?? 0;
    // Titular primeiro; o apoio entra com metade da meta, porque também atende exceções
    const capacidade = pessoas.map((p) => ({
      ...p,
      capacidade: Math.round(metas.metaNoDia(p.usuario, dia) * (p.papel === 'apoio' ? 0.5 : 1)),
    }));
    const capacidadeTotal = capacidade.reduce((s, p) => s + p.capacidade, 0);
    for (const p of capacidade) {
      // Sem fila suficiente, ninguém recebe mais do que existe para fazer
      const fatia = capacidadeTotal ? Math.round((p.capacidade / capacidadeTotal) * Math.min(fila, capacidadeTotal)) : 0;
      itens.push({
        usuario: p.usuario, papel: p.papel, categoria: cat.chave, categoria_rotulo: cat.rotulo,
        capacidade: p.capacidade, sugerido: Math.max(0, fatia), fila_em_aberto: fila,
      });
    }
  }
  return {
    dia, dia_util: ehDiaUtil(dia),
    itens: itens.sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR') || b.sugerido - a.sugerido),
    em_aberto: emAberto,
    pendentes_total: pendentes.indicadores?.pendentes ?? null,
    atualizado_em: new Date().toISOString(),
    premissas: {
      meta_dia_padrao: metas.padrao, calculo: metas.calculo,
      aviso: 'Meta diária é referência provisória do piloto, não medida de esforço. Apoio entra com metade da meta.',
    },
  };
}

const FONTE_PRODUCAO = 'Senior · notas de entrada fechadas (E440NFC, situação 2), distintas por empresa, filial, fornecedor, número e série; data de lançamento DATGER';
const FONTE_PENDENCIAS = 'VIA do Senior (E000NFC) · entradas do grupo para a Escrita Fiscal, sem lançamento e sem cancelamento conhecido; não inclui planilhas da contabilidade';
const DATA_RECEBIMENTO_VIA = 'E000NFC.DATENT (data de recebimento no VIA)';
const nomeChave = (n) => String(n ?? '').trim().toUpperCase();

/** Agregação pura: um documento do ERP vale uma nota, na sua data de lançamento. */
export function agregarProducaoDia({ itens = [], combinados = [], escritaFiscal = [], supervisao = [], disponivel = true, dia } = {}) {
  const supervisores = new Set(supervisao.map(nomeChave));
  const time = new Set(escritaFiscal.map(nomeChave));
  const equipeDe = (usuario) => supervisores.has(nomeChave(usuario)) ? 'supervisao' : time.has(nomeChave(usuario)) ? 'fiscal' : 'outros';
  const distintos = new Map();
  if (disponivel) for (const [n, i] of itens.entries()) {
    if (String(i.situacao).trim() !== '2' || (dia && i.geracao !== dia)) continue;
    const campos = [i.codemp, i.codfil, i.codfor, i.numero, i.serie ?? ''];
    // O caminho de produção sempre fornece a identidade completa. O fallback evita
    // agrupar documentos diferentes quando uma fonte de teste/legada não a possui.
    const completa = campos.slice(0, 4).every((v) => v != null && String(v).trim() !== '');
    const identidade = completa ? JSON.stringify(campos.map((v) => String(v).trim()))
      : i.chave ? `chave:${i.chave}` : `linha:${n}`;
    if (!distintos.has(identidade)) distintos.set(identidade, i);
  }
  const documentos = [...distintos.values()];
  const realizado = new Map();
  for (const i of documentos) {
    const k = JSON.stringify([nomeChave(i.usuario), i.categoria]);
    realizado.set(k, (realizado.get(k) ?? 0) + 1);
  }
  const compromissos = new Map(combinados.map((c) => [JSON.stringify([nomeChave(c.usuario), c.categoria]), c]));
  const pessoas = new Map([...combinados, ...documentos].map((i) => [nomeChave(i.usuario), String(i.usuario ?? '').trim()]));
  const chaves = new Set([...compromissos.keys(), ...realizado.keys()]);
  const linhas = [...chaves].map((k) => {
    const [nome, categoria] = JSON.parse(k);
    const usuario = pessoas.get(nome) ?? nome;
    const c = compromissos.get(k);
    const feito = disponivel ? (realizado.get(k) ?? 0) : null;
    const compromisso = c?.quantidade != null && Number.isFinite(Number(c.quantidade)) ? Number(c.quantidade) : null;
    return {
      usuario, categoria, categoria_rotulo: CATEGORIAS[categoria] ?? categoria,
      equipe: equipeDe(usuario),
      compromisso, sugerido: c?.sugerido ?? null, observacao: c?.observacao ?? null,
      realizado: feito,
      diferenca: disponivel && compromisso != null ? feito - compromisso : null,
      cumprimento: disponivel && compromisso > 0 ? Math.round((feito / compromisso) * 100) : null,
    };
  }).sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR') || (b.realizado ?? 0) - (a.realizado ?? 0));
  const doTime = linhas.filter((l) => l.equipe === 'fiscal');
  const comCompromisso = doTime.filter((l) => l.compromisso != null);
  const compromisso = comCompromisso.length ? comCompromisso.reduce((s, l) => s + l.compromisso, 0) : null;
  const composicao = [...documentos.reduce((m, i) => {
    const c = m.get(i.categoria) ?? { chave: i.categoria, rotulo: CATEGORIAS[i.categoria] ?? i.categoria, notas: 0 };
    c.notas += 1;
    return m.set(i.categoria, c);
  }, new Map()).values()].map((c) => ({ ...c, percentual: Math.round((c.notas / documentos.length) * 1000) / 10 }))
    .sort((a, b) => b.notas - a.notas || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  return {
    linhas,
    indicadores: {
      compromisso,
      realizado_time: disponivel ? doTime.reduce((s, l) => s + l.realizado, 0) : null,
      realizado_total: disponivel ? documentos.length : null,
      pessoas_com_compromisso: new Set(comCompromisso.map((l) => l.usuario)).size,
      // Cada pessoa/tipo fecha no máximo o próprio compromisso; excesso em uma
      // fila não compensa a falta em outra. Sem denominador não há percentual.
      cumprimento: disponivel && compromisso > 0
        ? Math.round((comCompromisso.reduce((s, l) => s + Math.min(l.realizado, l.compromisso), 0)
          / compromisso) * 100)
        : null,
    },
    notas_lancadas: {
      total: disponivel ? documentos.length : null,
      time: disponivel ? documentos.filter((i) => equipeDe(i.usuario) === 'fiscal').length : null,
      supervisao: disponivel ? documentos.filter((i) => equipeDe(i.usuario) === 'supervisao').length : null,
      outros: disponivel ? documentos.filter((i) => equipeDe(i.usuario) === 'outros').length : null,
      fonte: FONTE_PRODUCAO, estado: disponivel ? 'ok' : 'indisponivel',
    },
    composicao,
  };
}

/** Agregação pura do VIA atual. A idade usa somente DATENT, sem inferir chegada pela emissão. */
export function agregarPendenciasDashboard(itens, consultadoEm) {
  if (itens == null) return {
    pendencias: { total: null, por_tipo: [], consultado_em: null, fonte: FONTE_PENDENCIAS, estado: 'indisponivel' },
    antigos: { itens: [], sem_data: null, total_com_data: null, data_referencia: DATA_RECEBIMENTO_VIA, estado: 'indisponivel' },
  };
  const distintos = new Map();
  for (const i of itens) {
    if (i.origem !== 'senior' || !i.empresa_do_grupo || i.responsavel !== 'fiscal'
      || i.tipo_movimento !== 'entrada' || i.nossa_saida || i.lancada || i.cancelada) continue;
    const chave = String(i.chave ?? '').trim();
    if (chave && !distintos.has(chave)) distintos.set(chave, i);
  }
  const notas = [...distintos.values()];
  const porTipo = [...notas.reduce((m, i) => {
    const c = m.get(i.categoria) ?? { chave: i.categoria, rotulo: CATEGORIAS[i.categoria] ?? i.categoria, qtd: 0 };
    c.qtd += 1;
    return m.set(i.categoria, c);
  }, new Map()).values()].sort((a, b) => b.qtd - a.qtd || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  const diaConsulta = new Date(consultadoEm).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const comData = [];
  for (const i of notas) {
    const recebido = String(i.recebido_via_em ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recebido) || recebido > diaConsulta) continue;
    const dataRecebida = new Date(`${recebido}T12:00:00Z`);
    if (!Number.isFinite(dataRecebida.getTime()) || dataRecebida.toISOString().slice(0, 10) !== recebido) continue;
    comData.push({
      chave: i.chave, numero: i.numero, fornecedor: i.fornecedor, empresa: i.empresa,
      categoria_rotulo: CATEGORIAS[i.categoria] ?? i.categoria,
      recebido_em: recebido,
      dias: Math.round((new Date(`${diaConsulta}T12:00:00Z`) - dataRecebida) / 86400000),
    });
  }
  comData.sort((a, b) => a.recebido_em.localeCompare(b.recebido_em) || String(a.numero).localeCompare(String(b.numero), 'pt-BR', { numeric: true }));
  return {
    pendencias: { total: notas.length, por_tipo: porTipo, consultado_em: consultadoEm, fonte: FONTE_PENDENCIAS, estado: 'ok' },
    antigos: { itens: comData.slice(0, 20), sem_data: notas.length - comData.length, total_com_data: comData.length, data_referencia: DATA_RECEBIMENTO_VIA, estado: 'ok' },
  };
}

/** Compromisso do dia com produção fechada e a fotografia atual, independente do dia escolhido, do VIA. */
export async function painelDoDia(dia = hoje(), { forcar = false } = {}) {
  const { painelLancamentos } = await import('./lancamentos.js');
  const { painelPendentes } = await import('./pendentes.js');
  const combinados = all('SELECT * FROM compromissos_dia WHERE dia = ?', [dia]);
  const metas = metasLancamento();
  const [producao, pendencias] = await Promise.allSettled([
    painelLancamentos({ de: dia, ate: dia, base: 'geracao', situacoes: '2', forcar: forcar ? '1' : '' }, { documentosDistintos: true, completo: true }),
    painelPendentes({ dias: 'tudo', responsavel: 'fiscal', incluir_nfse: '0', forcar: forcar ? '1' : '' }, { snapshotDashboard: true }),
  ]);
  const agregado = agregarProducaoDia({
    dia, combinados, itens: producao.status === 'fulfilled' ? producao.value.itens : [],
    escritaFiscal: metas.escrita_fiscal, supervisao: metas.supervisao, disponivel: producao.status === 'fulfilled',
  });
  const snapshot = agregarPendenciasDashboard(pendencias.status === 'fulfilled' ? pendencias.value.itens : null,
    pendencias.status === 'fulfilled' ? pendencias.value.consultado_em : null);
  const avisos = [];
  if (producao.status === 'rejected') avisos.push('Não foi possível consultar os lançamentos do Senior. Produção e cumprimento estão indisponíveis; os compromissos gravados foram preservados.');
  if (pendencias.status === 'rejected') avisos.push('Não foi possível consultar o VIA do Senior. Pendências atuais e documentos mais antigos estão indisponíveis.');
  return {
    dia, dia_util: ehDiaUtil(dia), linhas: agregado.linhas, indicadores: agregado.indicadores,
    dashboard: { notas_lancadas: agregado.notas_lancadas, composicao: agregado.composicao, ...snapshot, avisos },
    fonte: `${FONTE_PRODUCAO}; compromisso registrado neste painel`,
    atualizado_em: new Date().toISOString(),
  };
}

/** Grava o compromisso do dia. `itens` = [{ usuario, categoria, quantidade, sugerido, observacao }] */
export function salvarCompromisso(dia, itens, usuarioId) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dia)) ? dia : hoje();
  tx(() => {
    run('DELETE FROM compromissos_dia WHERE dia = ?', [d]);
    for (const i of itens ?? []) {
      const q = Number(i?.quantidade);
      if (!(q > 0) || !i?.usuario || !i?.categoria) continue;
      run(`INSERT INTO compromissos_dia (dia, usuario, categoria, quantidade, sugerido, observacao, usuario_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [d, String(i.usuario).trim(), String(i.categoria).trim(), Math.round(q),
        Number.isFinite(Number(i.sugerido)) ? Math.round(Number(i.sugerido)) : null,
        String(i.observacao ?? '').trim() || null, usuarioId ?? null]);
    }
  });
  return { dia: d, gravados: get('SELECT COUNT(*) AS n FROM compromissos_dia WHERE dia = ?', [d]).n };
}
