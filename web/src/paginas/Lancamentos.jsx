import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { useAuth } from '../contexto.jsx';
import { brl, BotaoExportar, Cartao, Carregando, data, Erro, Kpi, numero, useDados, useFiltrosLembrados } from '../ui.jsx';

const eixo = { fontSize: 11, fill: 'var(--texto-3)' };
// rótulo de dados em cima das colunas
const rotulo = { fontSize: 10, fill: 'var(--texto-2)', fontWeight: 600 };
const diaCurto = (v) => `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}`;
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mesAtual = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
const mesesDisponiveis = () => Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  return { valor: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rotulo: `${MESES[d.getMonth()]}/${d.getFullYear()}` };
});

const COLUNAS_PESSOAS = [
  { titulo: 'Pessoa', valor: (p) => p.usuario },
  { titulo: 'Bloco', valor: (p) => (p.equipe === 'fiscal' ? 'Escrita Fiscal' : 'Outros') },
  { titulo: 'Notas lançadas', tipo: 'numero', valor: (p) => p.notas },
  { titulo: 'Hoje', tipo: 'numero', valor: (p) => p.hoje },
  { titulo: 'Dias ativos', tipo: 'numero', valor: (p) => p.dias_ativos },
  { titulo: 'Média por dia', tipo: 'numero', valor: (p) => p.media_dia },
  { titulo: 'Meta por dia', tipo: 'numero', valor: (p) => p.meta_dia },
  { titulo: '% da meta', tipo: 'numero', valor: (p) => p.pct_meta },
  { titulo: 'Dias na meta', tipo: 'numero', valor: (p) => p.dias_na_meta },
  { titulo: 'Meta até hoje', tipo: 'numero', valor: (p) => p.meta_ate_hoje },
  { titulo: 'Meta do período', tipo: 'numero', valor: (p) => p.meta_periodo },
  { titulo: 'Primeiro lançamento', valor: (p) => p.primeira_hora },
  { titulo: 'Último lançamento', valor: (p) => p.ultima_hora },
  { titulo: 'Empresas atendidas', tipo: 'numero', valor: (p) => p.empresas },
  { titulo: '% a partir do XML', tipo: 'numero', valor: (p) => p.pct_com_xml },
  { titulo: 'Prazo médio (dias)', tipo: 'numero', valor: (p) => p.prazo_medio },
  { titulo: 'Valor lançado', tipo: 'moeda', valor: (p) => p.valor },
];

const COLUNAS_NOTAS = [
  { titulo: 'Lançada em', tipo: 'data', valor: (l) => l.geracao },
  { titulo: 'Hora', valor: (l) => l.horario },
  { titulo: 'Pessoa', valor: (l) => l.usuario },
  { titulo: 'Emp/Fil', valor: (l) => `${l.codemp}/${l.codfil}` },
  { titulo: 'Empresa', valor: (l) => l.empresa },
  { titulo: 'Número', valor: (l) => l.numero },
  { titulo: 'Série', valor: (l) => l.serie },
  { titulo: 'Fornecedor', valor: (l) => l.fornecedor },
  { titulo: 'Entrada', tipo: 'data', valor: (l) => l.entrada },
  { titulo: 'Valor', tipo: 'moeda', valor: (l) => l.valor },
  { titulo: 'Situação', valor: (l) => l.situacao_rotulo },
  { titulo: 'Origem', valor: (l) => (l.com_xml ? 'XML recebido' : 'Digitada') },
  { titulo: 'Dias até lançar', tipo: 'numero', valor: (l) => l.dias_ate_lancar },
];
/** Valor em reais abreviado para tabelas (o valor completo vai no title). */
const brlCompacto = (v) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e4) return `R$ ${Math.round(v / 1e3).toLocaleString('pt-BR')} mil`;
  return brl(v);
};
/** "seg, ter, qua, qui" → "seg–qui" (dias seguidos); senão a lista curta. */
const faixaDias = (texto) => {
  const d = String(texto ?? '').split(', ').filter(Boolean);
  return d.length > 2 ? `${d[0]}–${d[d.length - 1]}` : d.join('·');
};
const corMeta = (pct) => (pct >= 100 ? 'var(--status-bom)' : pct >= 80 ? 'var(--status-atencao)' : 'var(--status-critico)');

/** Barra de progresso da meta: trilho + % (verde ≥ 100%, amarelo ≥ 80%, vermelho abaixo). */
function BarraMeta({ pct, titulo }) {
  return (
    <span className="meta-barra" title={titulo ?? `${pct}% da meta até hoje`}>
      <span className="trilho"><i style={{ width: `${Math.min(100, pct)}%`, background: corMeta(pct) }} /></span>
      <span className="pct" style={{ color: pct >= 100 ? 'var(--ok)' : pct >= 80 ? 'var(--pend)' : 'var(--erro)' }}>{pct}%</span>
    </span>
  );
}

const CHAVE_RECOLHIDOS = 'lancamentos_blocos_recolhidos';
const ROTULO_FILTRO = { equipe: 'Bloco', dia: 'Dia', hora: 'Hora', usuario: 'Pessoa', empresa: 'Empresa', origem: 'Origem' };

/** Cor da célula do mapa de calor conforme a intensidade. */
const corCalor = (v, max) => (v === 0 ? 'var(--superficie-2)' : `color-mix(in srgb, var(--serie-1) ${Math.max(12, Math.round((v / max) * 100))}%, var(--superficie))`);

export default function Lancamentos() {
  useFiltrosLembrados('lancamentos', ['aba']);
  const [params, setParams] = useSearchParams();
  const f = {
    // padrão: mês vigente, por data de entrada da nota (é como a equipe acompanha e como saem os relatórios do Senior)
    mes: params.get('mes') ?? mesAtual(), dias: params.get('dias') ?? '30', usuario: params.get('usuario') ?? '',
    base: params.get('base') ?? 'entrada', situacoes: params.get('situacoes') ?? 'todas',
    empresa: params.get('empresa') ?? '',
    // filtros em cascata (clique nos gráficos)
    dia: params.get('dia') ?? '', hora: params.get('hora') ?? '', origem: params.get('origem') ?? '',
    equipe: params.get('equipe') ?? '',
  };
  // "periodo" é o marcador de "sem mês"; o valor vazio some da URL e voltaria para o mês vigente
  const mes = f.mes === 'periodo' ? '' : f.mes;
  const situacoesEscolhidas = f.situacoes.split(',').filter(Boolean);
  const alternarSituacao = (chave) => {
    const semTodas = situacoesEscolhidas.filter((s) => s !== 'todas');
    const nova = semTodas.includes(chave) ? semTodas.filter((s) => s !== chave) : [...semTodas, chave];
    setFiltro('situacoes', nova.length ? nova.join(',') : 'todas');
  };
  // mantém a aba ao trocar qualquer filtro (senão a tela volta para "pendentes")
  const setFiltros = (novos) => setParams(Object.fromEntries(Object.entries({ aba: 'lancamentos', ...f, ...novos }).filter(([, x]) => x !== '' && x != null)));
  const setFiltro = (k, v) => setFiltros({ [k]: v });
  // clicar de novo no que já está filtrado tira o filtro
  const alternar = (k, v) => setFiltro(k, String(f[k]) === String(v) ? '' : v);
  const ativos = ['equipe', 'dia', 'hora', 'usuario', 'empresa', 'origem'].filter((c) => f[c] !== '');
  const { permissoes } = useAuth();
  const podeMeta = permissoes.includes('administrar');
  const { dados, erro, carregando, recarregar, atualizar } = useDados(
    ({ forcar } = {}) => api.get(`/lancamentos${qs({ forcar: forcar ? '1' : '', mes, dias: mes ? '' : f.dias, usuario: f.usuario, base: f.base, situacoes: f.situacoes, empresa: f.empresa, dia: f.dia, hora: f.hora, origem: f.origem, equipe: f.equipe })}`),
    [f.mes, f.dias, f.usuario, f.base, f.situacoes, f.empresa, f.dia, f.hora, f.origem, f.equipe], { automatico: false, memoria: 'lancamentos' },
  );
  const [horaDestaque, setHoraDestaque] = useState(null);
  const [mostrar, setMostrar] = useState(300);
  // Busca na tabela de notas lançadas (sobre as notas já filtradas pelos gráficos)
  const [buscaNotas, setBuscaNotas] = useState('');
  const [situacaoNotas, setSituacaoNotas] = useState('');
  const [origemNotas, setOrigemNotas] = useState('');
  const [editandoMetas, setEditandoMetas] = useState(false);
  // Blocos do ranking recolhidos (lembrado neste navegador); "Outros" começa fechado por ser a lista maior
  const [recolhidos, setRecolhidos] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(CHAVE_RECOLHIDOS)) ?? ['outros']); } catch { return new Set(['outros']); }
  });
  const alternarBloco = (chave) => setRecolhidos((atual) => {
    const novo = new Set(atual);
    if (novo.has(chave)) novo.delete(chave); else novo.add(chave);
    try { localStorage.setItem(CHAVE_RECOLHIDOS, JSON.stringify([...novo])); } catch { /* sem storage */ }
    return novo;
  });
  const k = dados?.indicadores;
  const fiscais = (dados?.pessoas ?? []).filter((p) => p.equipe === 'fiscal');
  const notasFiltradas = (() => {
    const lista = dados?.itens ?? [];
    const termo = buscaNotas.trim().toLowerCase();
    const digitos = termo.replace(/\D/g, '');
    return lista.filter((l) => {
      if (situacaoNotas && l.situacao !== situacaoNotas) return false;
      if (origemNotas && (origemNotas === 'xml') !== Boolean(l.com_xml)) return false;
      if (!termo) return true;
      // número da nota, fornecedor, pessoa, empresa (nome ou código emp/fil), série ou valor
      const texto = `${l.numero} ${l.serie ?? ''} ${l.fornecedor ?? ''} ${l.usuario} ${l.empresa} ${l.codemp}/${l.codfil}`.toLowerCase();
      if (texto.includes(termo)) return true;
      if (digitos && String(l.numero) === digitos) return true;
      const valor = termo.replace(/r\$|\s|\./g, '').replace(',', '.');
      return Number(valor) > 0 && l.valor != null && Math.abs(l.valor - Number(valor)) < 0.01;
    });
  })();
  const buscandoNotas = Boolean(buscaNotas.trim() || situacaoNotas || origemNotas);
  const maxCalor = Math.max(1, ...(dados?.mapa_calor ?? []).flatMap((p) => p.horas));

  return (
    <>
      <Cartao>
        <div className="linha" style={{ gap: 10, flexWrap: 'wrap' }}>
          <select value={f.mes} onChange={(e) => setFiltro('mes', e.target.value)} aria-label="Mês">
            <option value="periodo">Por período (dias)</option>
            {mesesDisponiveis().map((m) => <option key={m.valor} value={m.valor}>{m.rotulo}</option>)}
          </select>
          <select value={f.dias} onChange={(e) => setFiltro('dias', e.target.value)} aria-label="Período" disabled={Boolean(mes)}>
            {[7, 15, 30, 60, 90].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
          </select>
          <select value={f.usuario} onChange={(e) => setFiltro('usuario', e.target.value)} aria-label="Pessoa">
            <option value="">Todas as pessoas</option>
            {(dados?.pessoas ?? []).map((p) => <option key={p.usuario} value={p.usuario}>{p.usuario} ({p.notas})</option>)}
          </select>
          <select value={f.empresa} onChange={(e) => setFiltro('empresa', e.target.value)} aria-label="Empresa">
            <option value="">Todas as empresas</option>
            {(dados?.empresas_disponiveis ?? []).map((e) => <option key={e.chave} value={e.chave}>{e.chave} · {e.rotulo} ({numero(e.notas)})</option>)}
          </select>
          <select value={f.base} onChange={(e) => setFiltro('base', e.target.value)} aria-label="Data base"
            title="Geração = quando a pessoa lançou. Entrada = data de entrada da nota (bate com o relatório do Senior filtrado por entrada).">
            <option value="geracao">Data do lançamento (geração)</option>
            <option value="entrada">Data de entrada da nota</option>
          </select>
          <button className="btn pequeno" onClick={recarregar}>Atualizar</button>
        </div>
        <div className="linha pequeno" style={{ gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <strong className="muted">Situação no Senior:</strong>
          <label className="linha" style={{ gap: 4 }} title="Sem filtro de situação (é o padrão)">
            <input type="checkbox" checked={situacoesEscolhidas.includes('todas')} onChange={() => setFiltro('situacoes', 'todas')} />
            Todas
          </label>
          {(dados?.por_situacao ?? []).map((s) => (
            <label key={s.chave} className="linha" style={{ gap: 4 }}
              title={s.chave === '2' ? 'Nota fechada — é o que sai nos relatórios do Senior' : s.chave === '1' ? 'Ainda em digitação, não fechada' : 'Cancelada no Senior'}>
              <input type="checkbox" checked={situacoesEscolhidas.includes(s.chave)} onChange={() => alternarSituacao(s.chave)} />
              {s.rotulo} ({numero(s.notas)})
            </label>
          ))}
          <span className="espaco" />
          {dados && <span className="muted pequeno">{data(dados.periodo.de)} a {data(dados.periodo.ate)} · por {dados.base === 'entrada' ? 'data de entrada' : 'data de lançamento'} · fonte: notas de entrada do Senior</span>}
        </div>
      </Cartao>

      {ativos.length > 0 && (
        <div className="linha pequeno" style={{ gap: 8, flexWrap: 'wrap' }}>
          <strong className="muted">Filtrando por:</strong>
          {ativos.map((c) => (
            <button key={c} className="btn pequeno ghost" onClick={() => setFiltro(c, '')} title="Tirar este filtro">
              {ROTULO_FILTRO[c]}: <strong>{c === 'dia' ? data(f.dia) : c === 'hora' ? `${String(f.hora).padStart(2, '0')}h` : c === 'origem' ? (f.origem === 'xml' ? 'XML recebido' : 'Digitada') : c === 'equipe' ? (f.equipe === 'fiscal' ? 'Escrita Fiscal' : 'Outros') : f[c]}</strong> ✕
            </button>
          ))}
          <button className="btn pequeno" onClick={() => setFiltros({ equipe: '', dia: '', hora: '', usuario: '', empresa: '', origem: '' })}>Limpar filtros</button>
          {carregando && <span className="muted">atualizando…</span>}
        </div>
      )}
      <Erro erro={erro} />
      {carregando && !dados ? <Carregando /> : k && (
        <>
          <div className="grade grade-kpi monetario quatro">
            <Kpi rotulo="Notas lançadas" valor={numero(k.notas)} detalhe={`${brl(k.valor)} · ${numero(k.com_xml ?? 0)} de XML`} cor="var(--serie-1)"
              titulo={`Todas as notas de entrada do período (${dados.base === 'entrada' ? 'pela data de entrada' : 'pela data do lançamento'}), inclusive digitadas. A aba Pendentes conta só as que vieram de XML recebido.`} />
            <Kpi rotulo="Lançadas hoje" titulo="Notas lançadas hoje (data do lançamento), de XML ou digitadas" valor={numero(k.hoje)} detalhe={`${numero(k.pessoas_hoje)} pessoa(s) lançando`} cor="var(--status-bom)" />
            <Kpi rotulo="Média por dia" valor={numero(k.media_dia, 1)} detalhe={k.melhor_dia ? `melhor dia: ${data(k.melhor_dia.dia)} (${numero(k.melhor_dia.notas)})` : ''} />
            <Kpi rotulo="Pico do dia" valor={k.pico_hora?.rotulo ?? '—'} detalhe={`${numero(k.pico_hora?.notas ?? 0)} notas nessa hora`} cor="var(--pend)" />
            <Kpi rotulo="Prazo médio do XML" valor={`${numero(k.prazo_medio ?? 0, 1)} dia(s)`} detalhe={`${numero(k.no_mesmo_dia ?? 0)}% lançadas no mesmo dia`} cor="var(--ok)" />
            <Kpi rotulo="Equipe no período" valor={numero(k.pessoas)} detalhe={`${numero(k.pct_com_xml)}% a partir do XML recebido`} />
{(() => {
              const fiscal = dados.por_equipe.find((e) => e.chave === 'fiscal');
              const pct = fiscal?.meta_ate_hoje ? Math.round((fiscal.notas / fiscal.meta_ate_hoje) * 100) : null;
              return (
                <>
                  <Kpi rotulo="Escrita Fiscal × meta até hoje" valor={pct != null ? `${numero(pct)}%` : '—'}
                    detalhe={`${numero(fiscal?.notas ?? 0)} de ${numero(fiscal?.meta_ate_hoje ?? 0)} notas · meta do período ${numero(fiscal?.meta_periodo ?? 0)}`}
                    cor={pct >= 100 ? 'var(--status-bom)' : pct >= 80 ? 'var(--status-atencao)' : 'var(--status-critico)'}
                    onClick={() => alternar('equipe', 'fiscal')}
                    titulo={`Meta pela capacidade: ${dados.metas.calculo} = ${numero(dados.metas.padrao)} notas/dia por pessoa, somada nos dias úteis de cada um. Clique para ver só o time.`} />
                  <Kpi rotulo="Escrita Fiscal: média por pessoa/dia" valor={numero(fiscal?.media_pessoa_dia ?? 0, 1)}
                    detalhe={`meta: ${numero(dados.metas.padrao)}/dia por pessoa`}
                    cor={(fiscal?.media_pessoa_dia ?? 0) >= dados.metas.padrao ? 'var(--status-bom)' : 'var(--status-atencao)'}
                    titulo={`Notas por pessoa do time em cada dia em que lançou. Meta: ${dados.metas.calculo}.`} />
                </>
              );
            })()}
          </div>

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
            <Cartao titulo="Lançamentos por dia" sub="clique num dia para filtrar · linha = meta de quem lançou no dia">
              <ResponsiveContainer width="100%" height={230}>
                <ComposedChart data={dados.por_dia} margin={{ left: 0, right: 8, top: 22 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="dia" tickFormatter={diaCurto} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={8} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={36} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                    <div className="tooltip-grafico">
                      <div className="t">{data(payload[0].payload.dia)}</div>
                      <div><strong>{numero(payload[0].payload.notas)}</strong> nota(s) · {brl(payload[0].payload.valor)}</div>
                      <div className="muted pequeno">{numero(payload[0].payload.pessoas)} pessoa(s){payload[0].payload.meta != null ? ` · meta ${numero(payload[0].payload.meta)}` : ''}</div>
                      <div className="muted pequeno">Clique para filtrar</div>
                    </div>
                  ) : null)} />
                  <Bar isAnimationActive={false} dataKey="notas" name="Notas" radius={[4, 4, 0, 0]} maxBarSize={26}
                    style={{ cursor: 'pointer' }} onClick={(e) => alternar('dia', (e.payload ?? e).dia)}>
                    {dados.por_dia.map((d) => (
                      <Cell key={d.dia} fill={d.meta != null && d.notas >= d.meta ? 'var(--status-bom)' : 'var(--serie-1)'}
                        fillOpacity={!f.dia || f.dia === d.dia ? 1 : 0.3} />
                    ))}
                    {/* com muitos dias o rótulo fica menor para os números não se encostarem */}
                    <LabelList dataKey="notas" position="top" offset={4} formatter={(v) => (v ? numero(v) : '')}
                      style={{ ...rotulo, fontSize: dados.por_dia.length > 16 ? 9 : 10 }} />
                  </Bar>
                  <Line isAnimationActive={false} type="stepAfter" dataKey="meta" name="Meta" stroke="var(--status-critico)" strokeDasharray="5 4" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Cartao>

            <Cartao titulo="Distribuição por hora" sub="clique numa hora para filtrar">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dados.por_hora.filter((h) => h.notas > 0 || (h.hora >= 6 && h.hora <= 20))} margin={{ left: 0, right: 8, top: 22 }} barCategoryGap="14%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="rotulo" tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} interval={1} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={36} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                    <div className="tooltip-grafico"><div className="t">{payload[0].payload.rotulo}</div><div><strong>{numero(payload[0].payload.notas)}</strong> nota(s)</div><div className="muted pequeno">Clique para filtrar</div></div>
                  ) : null)} />
                  <Bar isAnimationActive={false} dataKey="notas" name="Notas" radius={[4, 4, 0, 0]} maxBarSize={22}
                    style={{ cursor: 'pointer' }} onClick={(e) => alternar('hora', (e.payload ?? e).hora)}
                    onMouseEnter={(e) => setHoraDestaque((e.payload ?? e).hora)} onMouseLeave={() => setHoraDestaque(null)}>
                    {dados.por_hora.filter((h) => h.notas > 0 || (h.hora >= 6 && h.hora <= 20)).map((h) => (
                      <Cell key={h.hora} fill={h.hora === k.pico_hora?.hora ? 'var(--pend)' : 'var(--serie-1)'} fillOpacity={f.hora !== '' ? (Number(f.hora) === h.hora ? 1 : 0.3) : horaDestaque == null || horaDestaque === h.hora ? 1 : 0.5} />
                    ))}
                    <LabelList dataKey="notas" position="top" style={rotulo} formatter={(v) => (v ? numero(v) : '')} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Cartao>
          </div>

          <Cartao titulo="Ranking da equipe" sub="clique numa pessoa para filtrar" semPadding
            acoes={<div className="linha" style={{ gap: 6 }}>
              {podeMeta && <button className="btn pequeno ghost" onClick={() => setEditandoMetas((x) => !x)}>{editandoMetas ? 'Fechar metas' : 'Editar metas'}</button>}
              <BotaoExportar titulo="Lançamentos por pessoa" linhas={dados.pessoas} colunas={COLUNAS_PESSOAS} />
            </div>}>
            {editandoMetas && <EditorMetas metas={dados.metas} pessoas={dados.pessoas} aoSalvar={atualizar} />}
            {dados.por_equipe.map((eq) => {
              const lista = dados.pessoas.filter((p) => p.equipe === eq.chave);
              if (!lista.length) return null;
              const comMeta = eq.chave === 'fiscal';
              const aberto = !recolhidos.has(eq.chave);
              const filtrado = f.equipe === eq.chave;
              const pctBloco = comMeta && eq.meta_ate_hoje ? Math.round((eq.notas / eq.meta_ate_hoje) * 100) : null;
              return (
                <div key={eq.chave} style={{ opacity: f.equipe && !filtrado ? 0.55 : 1 }}>
                  <div className="bloco-topo" role="button" tabIndex={0} aria-expanded={aberto}
                    title={aberto ? 'Clique para ocultar este bloco' : 'Clique para mostrar este bloco'}
                    onClick={() => alternarBloco(eq.chave)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternarBloco(eq.chave); } }}>
                    <span className="titulo"><span className="seta" aria-hidden>▸</span>{eq.rotulo}</span>
                    <span className="resumo">
                      <span><strong>{numero(eq.pessoas)}</strong> pessoa(s)</span>
                      <span><strong>{numero(eq.notas)}</strong> nota(s)</span>
                      <span><strong>{numero(eq.media_pessoa_dia ?? 0, 1)}</strong> por pessoa/dia</span>
                      {pctBloco != null && <BarraMeta pct={pctBloco} titulo={`${numero(eq.notas)} de ${numero(eq.meta_ate_hoje)} (meta até hoje)`} />}
                      <button className="btn pequeno ghost" onClick={(e) => { e.stopPropagation(); alternar('equipe', eq.chave); }}
                        title={filtrado ? 'Tirar o filtro deste bloco' : 'Filtrar a tela inteira por este bloco'}>
                        {filtrado ? 'Tirar filtro' : 'Filtrar'}
                      </button>
                    </span>
                  </div>
                  {aberto && <div className="tabela-wrap">
                    <table className="tabela">
                      <thead>
                        <tr>
                          <th className="pos">#</th><th>Pessoa</th>{!comMeta && <th className="num">Dias</th>}<th className="num">Notas</th><th className="num">Hoje</th><th className="num">Média/dia</th>
                          {comMeta && <><th className="num">Meta/dia</th><th className="num" title="meta acumulada até hoje (soma da meta de cada dia útil)">Meta acum.</th><th>Atingido</th><th className="num" title="dias em que bateu a meta diária">Na meta</th></>}
                          <th title="primeiro e último lançamento do dia, em média">Horário</th><th className="num col-opcional" title="% lançadas a partir do XML recebido">XML</th><th className="num col-opcional" title="dias entre a chegada do XML e o lançamento">Prazo</th><th className="num">Valor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lista.map((p, i) => (
                          <tr key={p.usuario} className={`clicavel ${f.usuario === p.usuario ? 'selecionada' : ''}`} onClick={() => alternar('usuario', p.usuario)}>
                            <td className="pos">{i + 1}</td>
                            <td className="nowrap" style={{ fontWeight: 550 }} title={`${p.empresas} empresa(s) atendida(s)`}>{p.usuario}</td>
                            {!comMeta && <td className="num">{p.dias_ativos}</td>}
                            <td className="num"><strong>{numero(p.notas)}</strong></td>
                            <td className="num">{p.hoje ? numero(p.hoje) : <span className="muted">—</span>}</td>
                            <td className="num">{numero(p.media_dia, 1)}</td>
                            {comMeta && <>
                              <td className="num nowrap" title={p.meta_manual ? 'Meta fixa (manual)' : p.jornada ? `${Math.floor(p.jornada.minutos_dia / 60)}h${String(p.jornada.minutos_dia % 60).padStart(2, '0')} por dia · ${p.jornada.dias}` : ''}>
                                {p.jornada?.propria && <span className="tag" style={{ marginRight: 6 }}>{faixaDias(p.jornada.dias)}</span>}
                                {p.meta_dia != null ? numero(p.meta_dia) : '—'}{p.meta_manual ? ' ✎' : ''}
                              </td>
                              <td className="num" title={`meta do período inteiro: ${numero(p.meta_periodo ?? 0)}`}>{p.meta_ate_hoje != null ? numero(p.meta_ate_hoje) : '—'}</td>
                              <td>{p.pct_meta != null ? <BarraMeta pct={p.pct_meta} /> : <span className="muted">—</span>}</td>
                              <td className="num">{p.dias_na_meta != null ? <>{p.dias_na_meta}<span className="muted">/{p.dias_ativos}</span></> : '—'}</td>
                            </>}
                            <td className="nowrap muted">{p.primeira_hora}–{p.ultima_hora}</td>
                            <td className="num col-opcional">{numero(p.pct_com_xml)}%</td>
                            <td className="num col-opcional">{p.prazo_medio != null ? `${numero(p.prazo_medio, 1)}d` : '—'}</td>
                            <td className="num" title={brl(p.valor)}>{brlCompacto(p.valor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>}
                </div>
              );
            })}
          </Cartao>

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
            <Cartao className="preenche" titulo="Escrita Fiscal: média por dia × meta" sub={`meta ${numero(dados.metas.padrao)}/dia por pessoa`}>
              {/* cresce até a altura da coluna ao lado (Por empresa + Origem), sem deixar espaço vazio */}
              <div style={{ flex: 1, minHeight: Math.max(180, fiscais.length * 34 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fiscais} layout="vertical" margin={{ left: 8, right: 40, top: 4 }} barGap={2}>
                  <CartesianGrid horizontal={false} stroke="var(--grade)" />
                  <XAxis type="number" allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="usuario" tick={eixo} axisLine={false} tickLine={false} width={150} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                    <div className="tooltip-grafico">
                      <div className="t">{payload[0].payload.usuario}</div>
                      <div>Média: <strong>{numero(payload[0].payload.media_dia, 1)}</strong> nota(s)/dia</div>
                      <div>Meta: <strong>{payload[0].payload.meta_dia != null ? numero(payload[0].payload.meta_dia, 1) : '—'}</strong>{payload[0].payload.pct_meta != null ? ` · ${numero(payload[0].payload.pct_meta)}%` : ''}</div>
                      {payload[0].payload.dias_na_meta != null && <div className="muted pequeno">bateu a meta em {payload[0].payload.dias_na_meta} de {payload[0].payload.dias_ativos} dia(s)</div>}
                      <div className="muted pequeno">Clique para filtrar</div>
                    </div>
                  ) : null)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar isAnimationActive={false} dataKey="media_dia" name="Média por dia" fill="var(--status-bom)" radius={[0, 4, 4, 0]} maxBarSize={14}
                    style={{ cursor: 'pointer' }} onClick={(e) => alternar('usuario', (e.payload ?? e).usuario)}>
                    {fiscais.map((p) => (
                      <Cell key={p.usuario} fill={p.meta_dia == null ? 'var(--serie-1)' : p.media_dia >= p.meta_dia ? 'var(--status-bom)' : p.pct_meta >= 80 ? 'var(--status-atencao)' : 'var(--status-critico)'}
                        fillOpacity={!f.usuario || f.usuario === p.usuario ? 1 : 0.35} />
                    ))}
                    <LabelList dataKey="media_dia" position="right" style={rotulo} formatter={(v) => numero(v, 1)} />
                  </Bar>
                  <Bar isAnimationActive={false} dataKey="meta_dia" name="Meta" fill="var(--texto-3)" fillOpacity={0.35} radius={[0, 4, 4, 0]} maxBarSize={14} />
                </BarChart>
              </ResponsiveContainer>
              </div>
            </Cartao>

            <div className="coluna">
              <Cartao titulo="Por empresa" sub="notas lançadas" semPadding>
                <div style={{ padding: 12 }}>
                  {dados.por_empresa.map((x) => {
                    const max = Math.max(...dados.por_empresa.map((y) => y.notas), 1);
                    return (
                      <div key={x.chave} style={{ marginBottom: 8, cursor: 'pointer', opacity: f.empresa && f.empresa !== x.chave ? 0.45 : 1 }}
                        title={f.empresa === x.chave ? 'Clique para ver todas as empresas' : `Filtrar por ${x.rotulo}`}
                        onClick={() => setFiltro('empresa', f.empresa === x.chave ? '' : x.chave)}>
                        <div className="linha entre pequeno"><span className="truncar"><code className="muted">{x.chave}</code> {x.rotulo}</span><strong>{numero(x.notas)}</strong></div>
                        <div className="barra-progresso"><div style={{ width: `${(x.notas / max) * 100}%`, background: f.empresa === x.chave ? 'var(--status-bom)' : 'var(--serie-1)' }} /></div>
                      </div>
                    );
                  })}
                </div>
              </Cartao>
              <Cartao titulo="Origem do lançamento">
                {dados.por_origem.map((o) => (
                  <div key={o.chave} className="linha entre" style={{ padding: '6px 0', cursor: 'pointer', opacity: f.origem && f.origem !== o.chave ? 0.45 : 1 }}
                    title="Clique para filtrar" onClick={() => alternar('origem', o.chave)}>
                    <span className={`badge ${o.chave === 'xml' ? 'sev-ok' : 'sev-alerta'}`}>{o.rotulo}</span>
                    <strong>{numero(o.notas)}</strong>
                  </div>
                ))}
                <p className="muted pequeno" style={{ marginBottom: 0 }}>“Digitada” = não há XML correspondente no recebimento do Senior (nota digitada manualmente ou XML não importado).</p>
              </Cartao>
            </div>
          </div>

          <Cartao titulo="Quem lança em cada hora" sub="10 pessoas com mais lançamentos · clique numa célula para filtrar pessoa e hora">
            <div className="tabela-wrap">
              <table className="tabela" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 150 }}>Pessoa</th>
                    {Array.from({ length: 18 }, (_, i) => i + 5).map((h) => <th key={h} className="num" style={{ padding: '4px 2px' }}>{String(h).padStart(2, '0')}</th>)}
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.mapa_calor.map((p) => (
                    <tr key={p.usuario}>
                      <td className="pequeno clicavel" style={{ cursor: 'pointer', fontWeight: f.usuario === p.usuario ? 700 : undefined }} onClick={() => alternar('usuario', p.usuario)}>{p.usuario}</td>
                      {Array.from({ length: 18 }, (_, i) => i + 5).map((h) => (
                        <td key={h} className="num" style={{ padding: 0 }}>
                          <div title={`${p.usuario} · ${String(h).padStart(2, '0')}h: ${p.horas[h]} nota(s) · clique para filtrar`}
                            onClick={() => (f.usuario === p.usuario && String(f.hora) === String(h) ? setFiltros({ usuario: '', hora: '' }) : setFiltros({ usuario: p.usuario, hora: String(h) }))}
                            style={{ cursor: 'pointer', outline: f.usuario === p.usuario && String(f.hora) === String(h) ? '2px solid var(--texto)' : undefined, background: corCalor(p.horas[h], maxCalor), height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: p.horas[h] > maxCalor * 0.55 ? '#fff' : 'var(--texto-3)' }}>
                            {p.horas[h] || ''}
                          </div>
                        </td>
                      ))}
                      <td className="num"><strong>{numero(p.horas.reduce((s, x) => s + x, 0))}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Cartao>

          <HistoricoMensal />

          <Cartao titulo="Notas lançadas" sub="segue os filtros acima · clique na pessoa ou na empresa para filtrar" semPadding
            acoes={<BotaoExportar titulo="Notas lançadas" linhas={notasFiltradas} colunas={COLUNAS_NOTAS} />}>
            <div className="linha" style={{ padding: '10px 16px', borderBottom: '1px solid var(--borda)', gap: 8 }}>
              <input type="search" value={buscaNotas} onChange={(e) => { setBuscaNotas(e.target.value); setMostrar(300); }}
                placeholder="Buscar nota, fornecedor, pessoa, empresa ou valor" aria-label="Buscar notas lançadas" style={{ width: 340 }} />
              <select value={situacaoNotas} onChange={(e) => setSituacaoNotas(e.target.value)} aria-label="Situação">
                <option value="">Todas as situações</option>
                {Object.entries(dados.situacoes_disponiveis ?? {}).map(([c, r]) => <option key={c} value={c}>{r}</option>)}
              </select>
              <select value={origemNotas} onChange={(e) => setOrigemNotas(e.target.value)} aria-label="Origem">
                <option value="">XML e digitadas</option>
                <option value="xml">A partir do XML</option>
                <option value="manual">Digitadas</option>
              </select>
              {buscandoNotas && <button className="btn pequeno ghost" onClick={() => { setBuscaNotas(''); setSituacaoNotas(''); setOrigemNotas(''); }}>Limpar busca</button>}
              <span className="espaco" />
              <span className="muted pequeno">
                {buscandoNotas
                  ? <>{numero(notasFiltradas.length)} de {numero(dados.total_itens)} nota(s) · {brl(notasFiltradas.reduce((t, l) => t + (l.valor ?? 0), 0))}</>
                  : <>{numero(dados.total_itens)} nota(s) · {brl(k.valor)}</>}
              </span>
            </div>
            {dados.total_itens > dados.itens.length && buscandoNotas && (
              <div className="aviso atencao pequeno" style={{ margin: '8px 16px 0' }}>A busca olha as {numero(dados.itens.length)} notas mais recentes do período. Para achar as mais antigas, filtre o período ou a pessoa acima.</div>
            )}
            {!notasFiltradas.length ? <div className="vazio" style={{ padding: 30 }}>{buscandoNotas ? 'Nenhuma nota encontrada nesta busca.' : 'Nenhuma nota com estes filtros.'}</div> : (
              <div className="tabela-wrap" style={{ maxHeight: 520 }}>
                <table className="tabela">
                  <thead><tr><th>Lançada em</th><th>Hora</th><th>Pessoa</th><th>Empresa</th><th>Nota</th><th>Fornecedor</th><th title="data de entrada · dias entre o XML e o lançamento">Entrada</th><th className="num">Valor</th><th>Situação</th><th>Origem</th></tr></thead>
                  <tbody>
                    {notasFiltradas.slice(0, mostrar).map((l) => (
                      <tr key={`${l.codemp}|${l.codfil}|${l.numero}|${l.serie}|${l.fornecedor}|${l.geracao}|${l.horario}`}>
                        <td className="nowrap muted" style={{ cursor: 'pointer' }} onClick={() => alternar('dia', dados.base === 'entrada' ? l.entrada : l.geracao)}>{data(l.geracao)}</td>
                        <td className="nowrap clicavel" style={{ cursor: 'pointer' }} onClick={() => l.hora != null && alternar('hora', l.hora)}><strong>{l.horario ?? '—'}</strong></td>
                        <td className="nowrap" style={{ cursor: 'pointer' }} onClick={() => alternar('usuario', l.usuario)}>{l.usuario}</td>
                        <td className="nowrap" style={{ cursor: 'pointer' }} onClick={() => alternar('empresa', `${l.codemp}/${l.codfil}`)}><code className="muted">{l.codemp}/{l.codfil}</code> {l.empresa}</td>
                        <td className="nowrap"><strong>{l.numero}</strong>{l.serie ? <span className="muted">-{l.serie}</span> : null}</td>
                        <td style={{ maxWidth: 260 }}><span className="truncar" style={{ display: 'block' }} title={l.fornecedor ?? ''}>{l.fornecedor ?? '—'}</span></td>
                        <td className="nowrap" title={l.dias_ate_lancar == null ? '' : l.dias_ate_lancar === 0 ? 'lançada no mesmo dia do XML' : `lançada ${l.dias_ate_lancar} dia(s) após o XML`}>
                          {data(l.entrada)}{l.dias_ate_lancar != null && <span className="muted"> · {l.dias_ate_lancar === 0 ? 'mesmo dia' : `${l.dias_ate_lancar}d`}</span>}
                        </td>
                        <td className="num">{brl(l.valor)}</td>
                        <td><span className={`badge ${l.situacao === '2' ? 'sev-ok' : l.situacao === '3' ? 'sev-erro' : 'sev-alerta'}`}>{l.situacao_rotulo}</span></td>
                        <td>{l.com_xml ? 'XML' : <span className="muted">Digitada</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {notasFiltradas.length > mostrar && <div className="paginacao"><span>Exibindo {numero(mostrar)} de {numero(notasFiltradas.length)}</span><button className="btn pequeno" onClick={() => setMostrar((m) => m + 500)}>Mostrar mais</button></div>}
              </div>
            )}
          </Cartao>
        </>
      )}
    </>
  );
}

const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesCurto = (m) => `${NOMES_MES[Number(String(m).slice(5, 7)) - 1]}/${String(m).slice(2, 4)}`;

/** Últimos 12 meses do time × meta: serve para conferir se a meta (minutos por nota) é coerente. */
function HistoricoMensal() {
  const { dados, erro, carregando } = useDados(() => api.get('/lancamentos/historico'), [], { automatico: false, memoria: 'lancamentos-historico' });
  if (erro) return <Erro erro={erro} />;
  if (!dados) return carregando ? <Cartao titulo="Histórico mensal do time"><Carregando /></Cartao> : null;
  const m = dados.media_meses_completos;
  const par = dados.parametros;
  return (
    <Cartao titulo="Histórico mensal do time × meta" sub={`últimos 12 meses · pela data do lançamento · meta atual ${dados.calculo}`}>
      {m.meses > 0 && (
        <div className="aviso" style={{ marginBottom: 12 }}>
          Nos últimos <strong>{m.meses}</strong> meses completos, o time de Escrita Fiscal lançou em média <strong>{numero(m.notas_time)}</strong> notas por mês
          ({numero(m.media_pessoa_dia, 1)} por pessoa/dia), <strong>{numero(m.pct_meta)}%</strong> da meta atual.
          Na prática isso dá <strong>{numero(m.minutos_por_nota_real, 1)} min por nota</strong> (com {par.produtividade}% do tempo produtivo); a meta usa <strong>{numero(par.minutos_por_nota, 1)} min</strong>.
          {m.minutos_por_nota_real > par.minutos_por_nota * 1.15 ? ' A meta está acima do que o time vem entregando.'
            : m.minutos_por_nota_real < par.minutos_por_nota * 0.85 ? ' O time já entrega mais do que a meta pede: dá para apertar.' : ' A meta está coerente com o histórico.'}
        </div>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={dados.meses.map((x) => ({ ...x, rotulo: mesCurto(x.mes) + (x.parcial ? '*' : '') }))} margin={{ left: 0, right: 12, top: 22 }}>
          <CartesianGrid vertical={false} stroke="var(--grade)" />
          <XAxis dataKey="rotulo" tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} />
          <YAxis tick={eixo} axisLine={false} tickLine={false} width={52} />
          <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (() => {
            const x = payload[0].payload;
            return (
              <div className="tooltip-grafico">
                <div className="t">{x.rotulo}{x.parcial ? ' (até hoje)' : ''}</div>
                <div>Time: <strong>{numero(x.notas_time)}</strong> · meta {numero(x.meta)} ({numero(x.pct_meta ?? 0)}%)</div>
                <div>Outros: {numero(x.notas_outros)}</div>
                <div className="muted pequeno">{x.pessoas_time} pessoa(s) · {numero(x.media_pessoa_dia ?? 0, 1)}/pessoa/dia · {numero(x.minutos_por_nota_real ?? 0, 1)} min/nota</div>
              </div>
            );
          })() : null)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar isAnimationActive={false} dataKey="notas_time" name="Escrita Fiscal" stackId="n" fill="var(--serie-1)" maxBarSize={36}>
            <LabelList dataKey="notas_time" position="insideTop" style={{ ...rotulo, fill: '#fff' }} formatter={(v) => (v ? numero(v) : '')} />
          </Bar>
          <Bar isAnimationActive={false} dataKey="notas_outros" name="Outros" stackId="n" fill="var(--texto-3)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={36} />
          <Line isAnimationActive={false} type="monotone" dataKey="meta" name="Meta do time" stroke="var(--status-critico)" strokeDasharray="5 4" strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="tabela-wrap" style={{ marginTop: 8 }}>
        <table className="tabela" style={{ fontSize: 12 }}>
          <thead><tr><th>Mês</th><th className="num">Time</th><th className="num">Outros</th><th className="num">Pessoas</th><th className="num">Pessoa-dias</th><th className="num">Média/pessoa/dia</th><th className="num">Meta</th><th className="num">% meta</th><th className="num">Min/nota real</th></tr></thead>
          <tbody>
            {[...dados.meses].reverse().map((x) => (
              <tr key={x.mes}>
                <td>{mesCurto(x.mes)}{x.parcial ? <span className="muted"> (até hoje)</span> : ''}</td>
                <td className="num"><strong>{numero(x.notas_time)}</strong></td>
                <td className="num muted">{numero(x.notas_outros)}</td>
                <td className="num" title={x.time.map((p) => `${p.usuario}: ${p.notas} em ${p.dias} dia(s)`).join('\n')}>{x.pessoas_time}</td>
                <td className="num">{numero(x.pessoa_dias)}</td>
                <td className="num">{numero(x.media_pessoa_dia ?? 0, 1)}</td>
                <td className="num">{numero(x.meta)}</td>
                <td className="num">{x.pct_meta != null ? <span className={`badge ${x.pct_meta >= 100 ? 'sev-ok' : x.pct_meta >= 80 ? 'sev-alerta' : 'sev-erro'}`}>{numero(x.pct_meta)}%</span> : '—'}</td>
                <td className="num">{numero(x.minutos_por_nota_real ?? 0, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted pequeno" style={{ marginBottom: 0 }}>
        Meta do mês = dias úteis de cada pessoa do time que lançou no mês × meta diária dela (sem descontar feriados e férias).
        Min/nota real = tempo produtivo nos dias em que cada um lançou ÷ notas do time. Passe o mouse em “Pessoas” para ver quem entrou na conta.
      </p>
    </Cartao>
  );
}

const DIAS = [[1, 'S'], [2, 'T'], [3, 'Q'], [4, 'Q'], [5, 'S'], [6, 'S']];
const NOME_DIA = { 1: 'segunda', 2: 'terça', 3: 'quarta', 4: 'quinta', 5: 'sexta', 6: 'sábado' };
const horas = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;

/**
 * Metas pela capacidade: jornada padrão, % produtivo e tempo por nota; quem é do time de Escrita Fiscal;
 * e, por pessoa, jornada própria (horas por dia e dias da semana) ou uma meta fixa.
 */
function EditorMetas({ metas, pessoas, aoSalvar }) {
  const chave = (n) => String(n).trim().toUpperCase();
  const nomes = [...new Set([...metas.escrita_fiscal, ...pessoas.map((p) => p.usuario)])];
  const naTela = new Map(pessoas.map((p) => [chave(p.usuario), p]));
  const jornadaSalva = (n) => Object.entries(metas.jornadas ?? {}).find(([k]) => chave(k) === chave(n))?.[1];
  const fixaSalva = (n) => Object.entries(metas.pessoas ?? {}).find(([k]) => chave(k) === chave(n))?.[1];
  const [par, setPar] = useState({ ...metas.parametros });
  const [time, setTime] = useState(() => new Set(metas.escrita_fiscal.map(chave)));
  const [jornadas, setJornadas] = useState(() => Object.fromEntries(nomes.map((n) => {
    const j = jornadaSalva(n);
    return [n, { horas: j?.minutos_dia ? String(j.minutos_dia / 60) : '', dias: j?.dias_semana ?? null, fixa: fixaSalva(n) != null ? String(fixaSalva(n)) : '' }];
  })));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const setJ = (n, campo, v) => setJornadas((x) => ({ ...x, [n]: { ...x[n], [campo]: v } }));
  const alternarTime = (n) => setTime((t) => { const x = new Set(t); if (x.has(chave(n))) x.delete(chave(n)); else x.add(chave(n)); return x; });
  // prévia do cálculo com o que está digitado
  const min = (h) => { const [a, b] = String(h ?? '').split(':').map(Number); return (a || 0) * 60 + (b || 0); };
  const minPadrao = Math.max(0, min(par.saida) - min(par.entrada) - Number(par.intervalo_min || 0));
  const metaDe = (m) => Math.floor((m * (Number(par.produtividade) / 100)) / Number(par.minutos_por_nota || 5));
  const salvar = async () => {
    setSalvando(true); setErro(null);
    try {
      await api.put('/lancamentos/metas', {
        parametros: par,
        escrita_fiscal: nomes.filter((n) => time.has(chave(n))),
        jornadas: Object.fromEntries(nomes.map((n) => {
          const j = jornadas[n];
          return [n, time.has(chave(n)) && (j.horas || j.dias) ? { minutos_dia: j.horas ? Math.round(Number(String(j.horas).replace(',', '.')) * 60) : null, dias_semana: j.dias } : null];
        })),
        pessoas: Object.fromEntries(nomes.map((n) => [n, time.has(chave(n)) && jornadas[n].fixa !== '' ? Number(jornadas[n].fixa) : null])),
      });
      aoSalvar();
    } catch (e) { setErro(e); }
    setSalvando(false);
  };
  const ordenados = [...nomes].sort((x, y) => (time.has(chave(y)) - time.has(chave(x))) || x.localeCompare(y, 'pt-BR'));
  const campo = (k, props) => <input value={par[k] ?? ''} onChange={(e) => setPar((p) => ({ ...p, [k]: e.target.value }))} {...props} />;
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--borda)', background: 'var(--superficie-2)' }}>
      <strong className="pequeno">Jornada padrão do time de Escrita Fiscal</strong>
      <div className="linha pequeno" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <label className="linha" style={{ gap: 4 }}>Entrada {campo('entrada', { type: 'time', style: { width: 95 } })}</label>
        <label className="linha" style={{ gap: 4 }}>Saída {campo('saida', { type: 'time', style: { width: 95 } })}</label>
        <label className="linha" style={{ gap: 4 }}>Intervalo (min) {campo('intervalo_min', { type: 'number', min: 0, style: { width: 70 } })}</label>
        <label className="linha" style={{ gap: 4 }}>Tempo produtivo (%) {campo('produtividade', { type: 'number', min: 1, max: 100, style: { width: 70 } })}</label>
        <label className="linha" style={{ gap: 4 }}>Minutos por nota {campo('minutos_por_nota', { type: 'number', min: 0.5, step: 0.5, style: { width: 70 } })}</label>
      </div>
      <div className="pequeno" style={{ marginTop: 6 }}>
        = {horas(minPadrao)} × {par.produtividade}% ÷ {par.minutos_por_nota} min = <strong>{numero(metaDe(minPadrao))} notas/dia por pessoa</strong>, de {(par.dias_semana ?? []).map((d) => NOME_DIA[d]).join(', ')}
      </div>
      <div className="muted pequeno" style={{ marginTop: 10 }}>
        Marque quem é do time (só essas pessoas têm meta). Jornada própria: horas por dia e dias da semana (vazio = padrão). Meta fixa substitui o cálculo.
      </div>
      <div className="tabela-wrap" style={{ marginTop: 6, maxHeight: 360 }}>
        <table className="tabela" style={{ fontSize: 12 }}>
          <thead><tr><th>Time</th><th>Pessoa</th><th className="num">Média atual</th><th>Horas/dia</th><th>Dias da semana</th><th className="num">Meta fixa</th><th className="num">Meta/dia</th></tr></thead>
          <tbody>
            {ordenados.map((n) => {
              const noTime = time.has(chave(n));
              const j = jornadas[n];
              const p = naTela.get(chave(n));
              const dias = j.dias ?? par.dias_semana ?? [];
              const minutos = j.horas ? Math.round(Number(String(j.horas).replace(',', '.')) * 60) : minPadrao;
              return (
                <tr key={n} style={{ opacity: noTime ? 1 : 0.6 }}>
                  <td><input type="checkbox" checked={noTime} onChange={() => alternarTime(n)} /></td>
                  <td style={{ fontWeight: noTime ? 600 : undefined }}>{n}</td>
                  <td className="num">{p ? numero(p.media_dia, 1) : <span className="muted">—</span>}</td>
                  <td><input type="number" min="0" step="0.5" value={j.horas} placeholder={horas(minPadrao)} disabled={!noTime} style={{ width: 70 }} onChange={(e) => setJ(n, 'horas', e.target.value)} /></td>
                  <td className="nowrap">
                    {DIAS.map(([d, l]) => (
                      <label key={d} title={NOME_DIA[d]} style={{ marginRight: 4 }}>
                        <input type="checkbox" disabled={!noTime} checked={dias.includes(d)}
                          onChange={() => setJ(n, 'dias', dias.includes(d) ? dias.filter((x) => x !== d) : [...dias, d].sort())} />{l}
                      </label>
                    ))}
                  </td>
                  <td className="num"><input type="number" min="0" value={j.fixa} placeholder="—" disabled={!noTime} style={{ width: 60 }} onChange={(e) => setJ(n, 'fixa', e.target.value)} /></td>
                  <td className="num"><strong>{noTime ? numero(j.fixa !== '' ? Number(j.fixa) : metaDe(minutos)) : '—'}</strong></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="linha" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn pequeno" onClick={salvar} disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
        <span className="muted pequeno">{time.size} pessoa(s) no time · feriados não são descontados</span>
      </div>
      <Erro erro={erro} />
    </div>
  );
}
