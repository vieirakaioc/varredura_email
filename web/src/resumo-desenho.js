// Desenho do sumário executivo no canvas e a versão em texto. Sem React e sem JSX de propósito:
// é código puro, dá para abrir num .html e conferir o layout sem subir a aplicação.
//
// Formato do resumo:
//   { titulo, periodo, visao: [frases], kpis: [{ rotulo, valor, detalhe, tom }],
//     destaques: [{ rotulo, valor, tom }], titulo_destaques, rodape }
// tom: 'bom' | 'alerta' | 'critico' | 'neutro'
const LARGURA = 1080;
const MARGEM = 56;
const TONS = {
  bom: '#1a7f4b', alerta: '#b26a00', critico: '#c0392b', neutro: '#1f2d3d',
};
const CINZA = '#6b7785';
const LINHA = '#e3e6ea';

/** Quebra o texto em linhas que cabem na largura, devolvendo as linhas prontas. */
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

function caixa(ctx, x, y, l, a, raio = 14, fundo = '#f7f8fa', borda = LINHA) {
  ctx.beginPath();
  ctx.roundRect(x, y, l, a, raio);
  ctx.fillStyle = fundo; ctx.fill();
  ctx.strokeStyle = borda; ctx.lineWidth = 1.5; ctx.stroke();
}

/** Desenha o resumo e devolve o canvas. A altura sai do conteúdo. */
export function desenharResumo(resumo) {
  const kpis = resumo.kpis ?? [];
  const destaques = resumo.destaques ?? [];
  const visao = resumo.visao ?? [];
  const colunas = 2;
  const alturaKpi = 158;
  const larguraKpi = (LARGURA - MARGEM * 2 - 20) / colunas;

  // Primeira passada só para medir o texto da visão geral
  const medidor = document.createElement('canvas').getContext('2d');
  medidor.font = '26px system-ui, -apple-system, Segoe UI, sans-serif';
  const linhasVisao = visao.flatMap((f) => quebrar(medidor, `• ${f}`, LARGURA - MARGEM * 2 - 48));

  const alturaCabecalho = 186;
  const alturaGrade = Math.ceil(kpis.length / colunas) * (alturaKpi + 20);
  const alturaVisao = linhasVisao.length ? 56 + linhasVisao.length * 38 + 28 : 0;
  const alturaDestaques = destaques.length ? 52 + destaques.length * 46 + 18 : 0;
  const altura = alturaCabecalho + alturaGrade + alturaVisao + alturaDestaques + 108;

  const canvas = document.createElement('canvas');
  const escala = 2;  // 2x: fica nítido quando abrem a imagem no celular
  canvas.width = LARGURA * escala;
  canvas.height = altura * escala;
  const ctx = canvas.getContext('2d');
  ctx.scale(escala, escala);
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LARGURA, altura);

  // Cabeçalho
  ctx.fillStyle = '#0f3d2e';
  ctx.fillRect(0, 0, LARGURA, 8);
  let y = 44;
  ctx.fillStyle = CINZA;
  ctx.font = '600 22px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('VALIDADOR FISCAL · SUMÁRIO EXECUTIVO', MARGEM, y);
  y += 36;
  ctx.fillStyle = '#111820';
  ctx.font = '700 46px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(resumo.titulo ?? 'Resumo', MARGEM, y);
  y += 58;
  ctx.fillStyle = CINZA;
  ctx.font = '26px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(resumo.periodo ?? '', MARGEM, y);
  y = alturaCabecalho;

  // Indicadores
  kpis.forEach((kpi, i) => {
    const cx = MARGEM + (i % colunas) * (larguraKpi + 20);
    const cy = y + Math.floor(i / colunas) * (alturaKpi + 20);
    caixa(ctx, cx, cy, larguraKpi, alturaKpi);
    ctx.fillStyle = CINZA;
    ctx.font = '600 22px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(kpi.rotulo ?? '').toUpperCase(), cx + 22, cy + 20);
    ctx.fillStyle = TONS[kpi.tom] ?? TONS.neutro;
    ctx.font = '700 50px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(kpi.valor ?? '—'), cx + 22, cy + 52);
    if (kpi.detalhe) {
      ctx.fillStyle = CINZA;
      ctx.font = '23px system-ui, -apple-system, Segoe UI, sans-serif';
      const [linha] = quebrar(ctx, kpi.detalhe, larguraKpi - 44);
      ctx.fillText(linha, cx + 22, cy + 112);
    }
  });
  y += alturaGrade + 8;

  // Visão geral
  if (linhasVisao.length) {
    ctx.fillStyle = '#111820';
    ctx.font = '700 28px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('Visão geral', MARGEM, y);
    y += 46;
    ctx.font = '26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = '#2b3642';
    for (const linha of linhasVisao) { ctx.fillText(linha, MARGEM + 4, y); y += 38; }
    y += 24;
  }

  // Destaques
  if (destaques.length) {
    ctx.fillStyle = '#111820';
    ctx.font = '700 28px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(resumo.titulo_destaques ?? 'Para olhar primeiro', MARGEM, y);
    y += 44;
    for (const d of destaques) {
      ctx.strokeStyle = LINHA; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(MARGEM, y + 38); ctx.lineTo(LARGURA - MARGEM, y + 38); ctx.stroke();
      ctx.fillStyle = '#2b3642';
      ctx.font = '26px system-ui, -apple-system, Segoe UI, sans-serif';
      const [rotulo] = quebrar(ctx, String(d.rotulo ?? ''), LARGURA - MARGEM * 2 - 300);
      ctx.fillText(rotulo, MARGEM, y + 2);
      ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = TONS[d.tom] ?? '#111820';
      ctx.textAlign = 'right';
      ctx.fillText(String(d.valor ?? ''), LARGURA - MARGEM, y + 2);
      ctx.textAlign = 'left';
      y += 46;
    }
    y += 16;
  }

  // Rodapé
  ctx.fillStyle = CINZA;
  ctx.font = '21px system-ui, -apple-system, Segoe UI, sans-serif';
  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  for (const linha of quebrar(ctx, `${resumo.rodape ?? ''}  ·  gerado em ${agora}`, LARGURA - MARGEM * 2)) {
    ctx.fillText(linha, MARGEM, y); y += 28;
  }
  return canvas;
}

/** Mesmo conteúdo em texto, com a formatação do WhatsApp (*negrito*). */
export function textoResumo(resumo) {
  const partes = [`*${resumo.titulo ?? 'Resumo'}*`];
  if (resumo.periodo) partes.push(resumo.periodo);
  partes.push('');
  for (const k of resumo.kpis ?? []) partes.push(`*${k.valor}* — ${k.rotulo}${k.detalhe ? ` (${k.detalhe})` : ''}`);
  if (resumo.visao?.length) { partes.push('', ...(resumo.visao ?? []).map((f) => `• ${f}`)); }
  if (resumo.destaques?.length) {
    partes.push('', `*${resumo.titulo_destaques ?? 'Para olhar primeiro'}*`);
    for (const d of resumo.destaques) partes.push(`${d.rotulo} — ${d.valor}`);
  }
  if (resumo.rodape) partes.push('', resumo.rodape);
  partes.push(`Gerado em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
  return partes.join('\n');
}

