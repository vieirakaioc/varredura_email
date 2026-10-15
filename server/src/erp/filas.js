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

/** Compromisso gravado para o dia, com o realizado e a diferença. */
export async function painelDoDia(dia = hoje()) {
  const { painelLancamentos } = await import('./lancamentos.js');
  const combinados = all('SELECT * FROM compromissos_dia WHERE dia = ?', [dia]);
  const producao = await painelLancamentos({ de: dia, ate: dia, base: 'geracao' });
  const metas = metasLancamento();

  // Realizado por pessoa e categoria, só de quem é do time (integração e supervisão à parte)
  const realizado = new Map();
  for (const i of producao.itens ?? []) {
    const k = `${i.usuario}|${i.categoria}`;
    realizado.set(k, (realizado.get(k) ?? 0) + 1);
  }
  const chaves = new Set([...combinados.map((c) => `${c.usuario}|${c.categoria}`), ...realizado.keys()]);
  const linhas = [...chaves].map((k) => {
    const [usuario, categoria] = k.split('|');
    const c = combinados.find((x) => x.usuario === usuario && x.categoria === categoria);
    const feito = realizado.get(k) ?? 0;
    return {
      usuario, categoria, categoria_rotulo: CATEGORIAS[categoria] ?? categoria,
      equipe: metas.equipeDe(usuario),
      compromisso: c?.quantidade ?? null, sugerido: c?.sugerido ?? null, observacao: c?.observacao ?? null,
      realizado: feito,
      // Sem compromisso combinado não há diferença a cobrar: é "a definir", não zero
      diferenca: c?.quantidade != null ? feito - c.quantidade : null,
    };
  }).sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR') || b.realizado - a.realizado);

  const doTime = linhas.filter((l) => l.equipe === 'fiscal');
  const comCompromisso = doTime.filter((l) => l.compromisso != null);
  return {
    dia, dia_util: ehDiaUtil(dia), linhas,
    indicadores: {
      compromisso: comCompromisso.length ? comCompromisso.reduce((s, l) => s + l.compromisso, 0) : null,
      realizado_time: doTime.reduce((s, l) => s + l.realizado, 0),
      realizado_total: linhas.reduce((s, l) => s + l.realizado, 0),
      pessoas_com_compromisso: new Set(comCompromisso.map((l) => l.usuario)).size,
      // Cumprimento só existe se houver compromisso: denominador zero é "não se aplica"
      cumprimento: comCompromisso.length
        ? Math.round((comCompromisso.reduce((s, l) => s + Math.min(l.realizado, l.compromisso), 0)
          / comCompromisso.reduce((s, l) => s + l.compromisso, 0)) * 100)
        : null,
    },
    fonte: 'Lançamentos do Senior (E440NFC) por data de geração; compromisso registrado neste painel',
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
