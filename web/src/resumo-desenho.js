// Desenho do sumário executivo no canvas e a versão em texto. Sem React e sem JSX de propósito:
// é código puro, dá para abrir num .html e conferir o layout sem subir a aplicação.
//
// Formato do resumo:
//   {
//     titulo, periodo, rodape,
//     kpis:  [{ rotulo, valor, detalhe, tom }],
//     visao: [frases],
//     secoes: [
//       { tipo: 'serie',  titulo, sub, dias: [{ dia, recebidas, lancadas }], nota },
//       { tipo: 'barras', titulo, sub, itens: [{ rotulo, valor, detalhe, cor }] },
//       { tipo: 'lista',  titulo, sub, itens: [{ rotulo, valor, detalhe, tom }] },
//     ],
//   }
// tom: 'bom' | 'alerta' | 'critico' | 'neutro'
//
// O desenho é feito em duas passadas: primeiro cada bloco diz a altura que precisa, depois tudo é
// desenhado. Sem isso, qualquer bloco novo obrigava a refazer a conta da altura do slide na mão.
const LARGURA = 1080;
const MARGEM = 56;
const UTIL = LARGURA - MARGEM * 2;
const TONS = { bom: '#1a7f4b', alerta: '#b26a00', critico: '#c0392b', neutro: '#1f2d3d' };
const CINZA = '#6b7785';
const LINHA = '#e3e6ea';
const AZUL = '#2b6cb0';
const VERDE = '#1a7f4b';
const VERMELHO = '#c0392b';
const FONTE = 'system-ui, -apple-system, Segoe UI, sans-serif';
const fonte = (tamanho, peso = '') => `${peso} ${tamanho}px ${FONTE}`.trim();

const numeroBr = (v, casas = 0) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas }));

/** Quebra o texto em linhas que cabem na largura. */
function quebrar(ctx, texto, largura) {
  const linhas = [];
  for (const paragrafo of String(texto ?? '').split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(' ')) {
      const teste = atual ? `${atual} ${palavra}` : palavra;
      if (ctx.measureText(teste).width > largura && atual) { linhas.push(atual); atual = palavra; } else atual = teste;
    }
    linhas.push(atual);
  }
  return linhas;
}

/** Corta o texto com reticências quando não cabe. */
function cortar(ctx, texto, largura) {
  let t = String(texto ?? '');
  if (ctx.measureText(t).width <= largura) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > largura) t = t.slice(0, -1);
  return `${t}…`;
}

function caixa(ctx, x, y, l, a, raio = 14, fundo = '#f7f8fa', borda = LINHA) {
  ctx.beginPath();
  ctx.roundRect(x, y, l, a, raio);
  ctx.fillStyle = fundo; ctx.fill();
  ctx.strokeStyle = borda; ctx.lineWidth = 1.5; ctx.stroke();
}

function tituloSecao(ctx, y, titulo, sub) {
  ctx.fillStyle = '#111820';
  ctx.font = fonte(28, '700');
  ctx.fillText(titulo, MARGEM, y);
  if (sub) {
    const largura = ctx.measureText(titulo).width;
    ctx.fillStyle = CINZA;
    ctx.font = fonte(22);
    ctx.fillText(cortar(ctx, sub, UTIL - largura - 16), MARGEM + largura + 12, y + 6);
  }
  return y + 46;
}

// ------------------------------------------------------------------ blocos
// Cada bloco devolve { altura, desenhar(ctx, y) }.

function blocoKpis(ctx, kpis) {
  const colunas = 2;
  const alturaKpi = 158;
  const larguraKpi = (UTIL - 20) / colunas;
  const altura = Math.ceil(kpis.length / colunas) * (alturaKpi + 20);
  return {
    altura,
    desenhar(c, y) {
      kpis.forEach((kpi, i) => {
        const cx = MARGEM + (i % colunas) * (larguraKpi + 20);
        const cy = y + Math.floor(i / colunas) * (alturaKpi + 20);
        caixa(c, cx, cy, larguraKpi, alturaKpi);
        c.fillStyle = CINZA;
        c.font = fonte(22, '600');
        c.fillText(cortar(c, String(kpi.rotulo ?? '').toUpperCase(), larguraKpi - 44), cx + 22, cy + 20);
        c.fillStyle = TONS[kpi.tom] ?? TONS.neutro;
        c.font = fonte(50, '700');
        c.fillText(String(kpi.valor ?? '—'), cx + 22, cy + 52);
        if (kpi.detalhe) {
          c.fillStyle = CINZA;
          c.font = fonte(23);
          c.fillText(cortar(c, kpi.detalhe, larguraKpi - 44), cx + 22, cy + 112);
        }
      });
    },
  };
}

function blocoVisao(ctx, visao) {
  ctx.font = fonte(26);
  const linhas = visao.flatMap((f) => quebrar(ctx, `• ${f}`, UTIL - 48));
  return {
    altura: 46 + linhas.length * 38 + 24,
    desenhar(c, y) {
      let yy = tituloSecao(c, y, 'Visão geral');
      c.font = fonte(26);
      c.fillStyle = '#2b3642';
      for (const linha of linhas) { c.fillText(linha, MARGEM + 4, yy); yy += 38; }
    },
  };
}

function blocoLista(ctx, secao) {
  const itens = secao.itens ?? [];
  return {
    altura: 46 + itens.length * 46 + 16,
    desenhar(c, y) {
      let yy = tituloSecao(c, y, secao.titulo, secao.sub);
      for (const d of itens) {
        c.strokeStyle = LINHA; c.lineWidth = 1;
        c.beginPath(); c.moveTo(MARGEM, yy + 38); c.lineTo(LARGURA - MARGEM, yy + 38); c.stroke();
        c.font = fonte(26, '700');
        const larguraValor = c.measureText(String(d.valor ?? '')).width;
        c.fillStyle = '#2b3642';
        c.font = fonte(26);
        c.fillText(cortar(c, String(d.rotulo ?? ''), UTIL - larguraValor - 40), MARGEM, yy + 2);
        c.font = fonte(26, '700');
        c.fillStyle = TONS[d.tom] ?? '#111820';
        c.textAlign = 'right';
        c.fillText(String(d.valor ?? ''), LARGURA - MARGEM, yy + 2);
        c.textAlign = 'left';
        yy += 46;
      }
    },
  };
}

function blocoBarras(ctx, secao) {
  const itens = (secao.itens ?? []).filter((i) => i.valor != null);
  const alturaItem = 64;
  const larguraRotulo = secao.largura_rotulo ?? 430;
  const maior = Math.max(...itens.map((i) => Number(i.valor) || 0), 1);
  return {
    altura: 46 + itens.length * alturaItem + 16,
    desenhar(c, y) {
      let yy = tituloSecao(c, y, secao.titulo, secao.sub);
      const x0 = MARGEM + larguraRotulo + 16;
      const larguraBarra = LARGURA - MARGEM - x0 - 150;
      for (const i of itens) {
        c.fillStyle = '#2b3642';
        c.font = fonte(25);
        c.fillText(cortar(c, String(i.rotulo ?? ''), larguraRotulo), MARGEM, yy + 4);
        const l = Math.max(3, (Number(i.valor) / maior) * larguraBarra);
        c.beginPath();
        c.roundRect(x0, yy, l, 26, 6);
        c.fillStyle = i.cor ?? AZUL;
        c.fill();
        c.fillStyle = '#111820';
        c.font = fonte(25, '700');
        c.fillText(numeroBr(i.valor), x0 + l + 14, yy + 2);
        if (i.detalhe) {
          c.fillStyle = CINZA;
          c.font = fonte(21);
          c.fillText(cortar(c, i.detalhe, larguraRotulo + larguraBarra), MARGEM, yy + 32);
        }
        yy += alturaItem;
      }
    },
  };
}

/** Chegada × lançamento: duas linhas acumuladas e o saldo do período em destaque. */
function blocoSerie(ctx, secao) {
  const dias = secao.dias ?? [];
  const alturaGrafico = 260;
  return {
    altura: 46 + alturaGrafico + 76,
    desenhar(c, y) {
      let yy = tituloSecao(c, y, secao.titulo, secao.sub);
      const x0 = MARGEM + 70;
      const x1 = LARGURA - MARGEM;
      const yTopo = yy;
      const yBase = yy + alturaGrafico;

      let acumuladoR = 0; let acumuladoL = 0;
      const pontos = dias.map((d) => {
        acumuladoR += Number(d.recebidas) || 0;
        acumuladoL += Number(d.lancadas) || 0;
        return { dia: d.dia, recebidas: acumuladoR, lancadas: acumuladoL };
      });
      const maior = Math.max(...pontos.map((p) => p.recebidas), 1);
      const px = (i) => x0 + (pontos.length > 1 ? (i / (pontos.length - 1)) * (x1 - x0) : 0);
      const py = (v) => yBase - (v / maior) * (alturaGrafico - 30);

      // grade e escala
      c.strokeStyle = LINHA; c.lineWidth = 1;
      c.fillStyle = CINZA; c.font = fonte(20);
      for (let i = 0; i <= 3; i += 1) {
        const v = (maior / 3) * i;
        const yg = py(v);
        c.beginPath(); c.moveTo(x0, yg); c.lineTo(x1, yg); c.stroke();
        c.textAlign = 'right';
        c.fillText(numeroBr(Math.round(v)), x0 - 12, yg - 10);
        c.textAlign = 'left';
      }

      const linha = (campo, cor) => {
        c.beginPath();
        pontos.forEach((p, i) => (i ? c.lineTo(px(i), py(p[campo])) : c.moveTo(px(i), py(p[campo]))));
        c.strokeStyle = cor; c.lineWidth = 4; c.stroke();
        const ultimo = pontos.at(-1);
        if (!ultimo) return;
        c.fillStyle = cor; c.font = fonte(23, '700');
        c.textAlign = 'right';
        c.fillText(numeroBr(ultimo[campo]), x1, py(ultimo[campo]) - 34);
        c.textAlign = 'left';
      };
      linha('recebidas', AZUL);
      linha('lancadas', VERDE);

      // eixo dos dias: só as pontas, para não embolar
      c.fillStyle = CINZA; c.font = fonte(20);
      if (pontos.length) {
        c.fillText(String(pontos[0].dia ?? '').slice(8, 10) + '/' + String(pontos[0].dia ?? '').slice(5, 7), x0, yBase + 12);
        const fim = pontos.at(-1).dia ?? '';
        c.textAlign = 'right';
        c.fillText(`${String(fim).slice(8, 10)}/${String(fim).slice(5, 7)}`, x1, yBase + 12);
        c.textAlign = 'left';
      }

      yy = yBase + 46;
      const saldo = (pontos.at(-1)?.recebidas ?? 0) - (pontos.at(-1)?.lancadas ?? 0);
      c.font = fonte(24);
      c.fillStyle = AZUL; c.fillText('—', MARGEM, yy); c.fillStyle = '#2b3642';
      c.fillText(` recebidas ${numeroBr(pontos.at(-1)?.recebidas ?? 0)}`, MARGEM + 20, yy);
      const meio = MARGEM + 300;
      c.fillStyle = VERDE; c.fillText('—', meio, yy); c.fillStyle = '#2b3642';
      c.fillText(` lançadas ${numeroBr(pontos.at(-1)?.lancadas ?? 0)}`, meio + 20, yy);
      c.font = fonte(24, '700');
      c.fillStyle = saldo > 0 ? VERMELHO : VERDE;
      c.textAlign = 'right';
      c.fillText(`saldo ${saldo > 0 ? '+' : ''}${numeroBr(saldo)}`, LARGURA - MARGEM, yy);
      c.textAlign = 'left';
    },
  };
}

/** Desenha o resumo e devolve o canvas. A altura sai do conteúdo. */
export function desenharResumo(resumo) {
  const medidor = document.createElement('canvas').getContext('2d');
  medidor.textBaseline = 'top';

  const secoes = [...(resumo.secoes ?? [])];
  // `destaques` é a forma antiga; vira uma seção de lista no fim
  if (resumo.destaques?.length) {
    secoes.push({ tipo: 'lista', titulo: resumo.titulo_destaques ?? 'Para olhar primeiro', itens: resumo.destaques });
  }

  const blocos = [];
  if (resumo.kpis?.length) blocos.push(blocoKpis(medidor, resumo.kpis));
  if (resumo.visao?.length) blocos.push(blocoVisao(medidor, resumo.visao));
  for (const s of secoes) {
    if (!s) continue;
    if (s.tipo === 'serie' && s.dias?.length) blocos.push(blocoSerie(medidor, s));
    else if (s.tipo === 'barras' && s.itens?.length) blocos.push(blocoBarras(medidor, s));
    else if (s.itens?.length) blocos.push(blocoLista(medidor, s));
  }

  const alturaCabecalho = 186;
  medidor.font = fonte(21);
  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const linhasRodape = quebrar(medidor, `${resumo.rodape ?? ''}  ·  gerado em ${agora}`, UTIL);
  const altura = alturaCabecalho + blocos.reduce((t, b) => t + b.altura, 0) + linhasRodape.length * 28 + 54;

  const canvas = document.createElement('canvas');
  const escala = 2;  // 2x: fica nítido quando abrem a imagem no celular
  canvas.width = LARGURA * escala;
  canvas.height = altura * escala;
  const ctx = canvas.getContext('2d');
  ctx.scale(escala, escala);
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LARGURA, altura);

  ctx.fillStyle = '#0f3d2e';
  ctx.fillRect(0, 0, LARGURA, 8);
  let y = 44;
  ctx.fillStyle = CINZA;
  ctx.font = fonte(22, '600');
  ctx.fillText('VALIDADOR FISCAL · SUMÁRIO EXECUTIVO', MARGEM, y);
  y += 36;
  ctx.fillStyle = '#111820';
  ctx.font = fonte(46, '700');
  ctx.fillText(cortar(ctx, resumo.titulo ?? 'Resumo', UTIL), MARGEM, y);
  y += 58;
  ctx.fillStyle = CINZA;
  ctx.font = fonte(26);
  ctx.fillText(cortar(ctx, resumo.periodo ?? '', UTIL), MARGEM, y);

  y = alturaCabecalho;
  for (const bloco of blocos) { bloco.desenhar(ctx, y); y += bloco.altura; }

  y += 18;
  ctx.fillStyle = CINZA;
  ctx.font = fonte(21);
  for (const linha of linhasRodape) { ctx.fillText(linha, MARGEM, y); y += 28; }
  return canvas;
}

/** Mesmo conteúdo em texto, com a formatação do WhatsApp (*negrito*). */
export function textoResumo(resumo) {
  const partes = [`*${resumo.titulo ?? 'Resumo'}*`];
  if (resumo.periodo) partes.push(resumo.periodo);
  partes.push('');
  for (const k of resumo.kpis ?? []) partes.push(`*${k.valor}* — ${k.rotulo}${k.detalhe ? ` (${k.detalhe})` : ''}`);
  if (resumo.visao?.length) partes.push('', ...resumo.visao.map((f) => `• ${f}`));

  const secoes = [...(resumo.secoes ?? [])];
  if (resumo.destaques?.length) secoes.push({ titulo: resumo.titulo_destaques ?? 'Para olhar primeiro', itens: resumo.destaques });
  for (const s of secoes) {
    if (!s) continue;
    if (s.tipo === 'serie') {
      const r = (s.dias ?? []).reduce((t, d) => t + (Number(d.recebidas) || 0), 0);
      const l = (s.dias ?? []).reduce((t, d) => t + (Number(d.lancadas) || 0), 0);
      partes.push('', `*${s.titulo}*`, `Recebidas ${numeroBr(r)} · lançadas ${numeroBr(l)} · saldo ${r - l > 0 ? '+' : ''}${numeroBr(r - l)}`);
      continue;
    }
    if (!s.itens?.length) continue;
    partes.push('', `*${s.titulo}*`);
    for (const i of s.itens) partes.push(`${i.rotulo} — ${typeof i.valor === 'number' ? numeroBr(i.valor) : i.valor}${i.detalhe ? ` (${i.detalhe})` : ''}`);
  }

  if (resumo.rodape) partes.push('', resumo.rodape);
  partes.push(`Gerado em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
  return partes.join('\n');
}
