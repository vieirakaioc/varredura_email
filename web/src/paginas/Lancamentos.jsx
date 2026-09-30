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
  const [editandoMetas, setEditandoMetas] = useState(false);
  const k = dados?.indicadores;
  const fiscais = (dados?.pessoas ?? []).filter((p) => p.equipe === 'fiscal');
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
          <div className="grade grade-kpi monetario">
            <Kpi rotulo="Notas lançadas" valor={numero(k.notas)} detalhe={brl(k.valor)} cor="var(--serie-1)" />
            <Kpi rotulo="Hoje" valor={numero(k.hoje)} detalhe={`${numero(k.pessoas_hoje)} pessoa(s) lançando`} cor="var(--status-bom)" />
            <Kpi rotulo="Média por dia" valor={numero(k.media_dia, 1)} detalhe={k.melhor_dia ? `melhor dia: ${data(k.melhor_dia.dia)} (${numero(k.melhor_dia.notas)})` : ''} />
            <Kpi rotulo="Pico do dia" valor={k.pico_hora?.rotulo ?? '—'} detalhe={`${numero(k.pico_hora?.notas ?? 0)} notas nessa hora`} cor="var(--pend)" />
            <Kpi rotulo="Prazo médio do XML" valor={`${numero(k.prazo_medio ?? 0, 1)} dia(s)`} detalhe={`${numero(k.no_mesmo_dia ?? 0)}% lançadas no mesmo dia`} cor="var(--ok)" />
            <Kpi rotulo="Equipe no período" valor={numero(k.pessoas)} detalhe={`${numero(k.pct_com_xml)}% a partir do XML recebido`} />
{(() => {
              const fiscal = dados.por_equipe.find((e) => e.chave === 'fiscal');
              return (
                <Kpi rotulo="Escrita Fiscal: média por pessoa/dia" valor={numero(fiscal?.media_pessoa_dia ?? 0, 1)}
                  detalhe={dados.metas.padrao != null ? `meta: ${numero(dados.metas.padrao, 1)}/dia${dados.metas.padrao_manual ? '' : ' (automática)'}` : 'sem meta'}
                  cor={dados.metas.padrao != null && (fiscal?.media_pessoa_dia ?? 0) >= dados.metas.padrao ? 'var(--status-bom)' : 'var(--status-atencao)'}
                  onClick={() => alternar('equipe', 'fiscal')}
                  titulo={`Notas por pessoa do time em cada dia trabalhado. Meta automática = ${dados.metas.base}${dados.metas.automatica != null ? ` (${numero(dados.metas.automatica, 1)})` : ''}. Clique para ver só o time.`} />
              );
            })()}
          </div>

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
            <Cartao titulo="Lançamentos por dia" sub="clique num dia para filtrar · linha = meta de quem lançou no dia">
              <ResponsiveContainer width="100%" height={230}>
                <ComposedChart data={dados.por_dia} margin={{ left: -18, right: 8, top: 22 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="dia" tickFormatter={diaCurto} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={8} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={44} />
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
                    <LabelList dataKey="notas" position="top" style={rotulo} formatter={(v) => (v ? numero(v) : '')} />
                  </Bar>
                  <Line isAnimationActive={false} type="stepAfter" dataKey="meta" name="Meta" stroke="var(--status-critico)" strokeDasharray="5 4" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Cartao>

            <Cartao titulo="Distribuição por hora" sub="clique numa hora para filtrar">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dados.por_hora.filter((h) => h.notas > 0 || (h.hora >= 6 && h.hora <= 20))} margin={{ left: -18, right: 8, top: 22 }} barCategoryGap="14%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="rotulo" tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} interval={1} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={44} />
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

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
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
                return (
                  <div key={eq.chave}>
                    <div className="linha entre" style={{ padding: '10px 12px', background: 'var(--superficie-2)', borderBottom: '1px solid var(--borda)', cursor: 'pointer', opacity: f.equipe && f.equipe !== eq.chave ? 0.5 : 1 }}
                      title="Clique para filtrar a tela por este bloco" onClick={() => alternar('equipe', eq.chave)}>
                      <strong>{eq.rotulo}</strong>
                      <span className="pequeno muted">
                        {numero(eq.pessoas)} pessoa(s) · {numero(eq.notas)} nota(s) · média {numero(eq.media_pessoa_dia ?? 0, 1)}/pessoa/dia
                        {comMeta && eq.meta != null ? <> · meta <strong>{numero(eq.meta, 1)}</strong></> : ''}
                      </span>
                    </div>
                    <div className="tabela-wrap">
                      <table className="tabela">
                        <thead><tr><th>Pessoa</th><th className="num">Notas</th><th className="num">Hoje</th><th className="num">Média/dia</th>{comMeta && <><th className="num">Meta/dia</th><th className="num">% meta</th></>}<th>Jornada</th><th className="num">Do XML</th><th className="num">Prazo</th><th className="num">Valor</th></tr></thead>
                        <tbody>
                          {lista.map((p, i) => (
                            <tr key={p.usuario} className="clicavel" style={{ background: f.usuario === p.usuario ? 'var(--superficie-3)' : undefined }} onClick={() => alternar('usuario', p.usuario)}>
                              <td><strong>{i + 1}º</strong> {p.usuario}<div className="muted pequeno">{p.dias_ativos} dia(s) · {p.empresas} empresa(s)</div></td>
                              <td className="num"><strong>{numero(p.notas)}</strong></td>
                              <td className="num">{p.hoje ? numero(p.hoje) : <span className="muted">—</span>}</td>
                              <td className="num">{numero(p.media_dia, 1)}</td>
                              {comMeta && <>
                                <td className="num" title={p.meta_manual ? 'Meta manual' : 'Meta padrão'}>{p.meta_dia != null ? numero(p.meta_dia, 1) : '—'}{p.meta_manual ? ' ✎' : ''}</td>
                                <td className="num">{p.pct_meta != null ? <span className={`badge ${p.pct_meta >= 100 ? 'sev-ok' : p.pct_meta >= 80 ? 'sev-alerta' : 'sev-erro'}`}>{numero(p.pct_meta)}%</span> : '—'}
                                  {p.dias_na_meta != null && <div className="muted pequeno">{p.dias_na_meta}/{p.dias_ativos} dia(s)</div>}</td>
                              </>}
                              <td className="pequeno nowrap">{p.primeira_hora} – {p.ultima_hora}</td>
                              <td className="num">{numero(p.pct_com_xml)}%</td>
                              <td className="num">{p.prazo_medio != null ? `${numero(p.prazo_medio, 1)}d` : '—'}</td>
                              <td className="num">{brl(p.valor)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
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

          <Cartao titulo="Escrita Fiscal: média por dia × meta" sub={`por pessoa do time · meta padrão ${dados.metas.padrao != null ? numero(dados.metas.padrao, 1) : '—'}/dia (${dados.metas.padrao_manual ? 'manual' : dados.metas.base})`}>
            <ResponsiveContainer width="100%" height={Math.max(180, fiscais.length * 34 + 40)}>
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
          </Cartao>

          <Cartao titulo="Notas lançadas" sub="segue os filtros acima · clique na pessoa ou na empresa para filtrar" semPadding
            acoes={<BotaoExportar titulo="Notas lançadas" linhas={dados.itens} colunas={COLUNAS_NOTAS} />}>
            <div className="linha pequeno" style={{ padding: '8px 12px', borderBottom: '1px solid var(--borda)' }}>
              <span className="muted">{numero(dados.total_itens)} nota(s) · {brl(k.valor)}</span>
            </div>
            {!dados.itens.length ? <div className="vazio" style={{ padding: 30 }}>Nenhuma nota com estes filtros.</div> : (
              <div className="tabela-wrap" style={{ maxHeight: 520 }}>
                <table className="tabela">
                  <thead><tr><th>Lançada em</th><th>Hora</th><th>Pessoa</th><th>Empresa</th><th>Nota</th><th>Fornecedor</th><th>Entrada</th><th className="num">Valor</th><th>Situação</th><th>Origem</th></tr></thead>
                  <tbody>
                    {dados.itens.slice(0, mostrar).map((l) => (
                      <tr key={`${l.codemp}|${l.codfil}|${l.numero}|${l.serie}|${l.fornecedor}|${l.geracao}|${l.horario}`}>
                        <td className="nowrap clicavel" style={{ cursor: 'pointer' }} onClick={() => alternar('dia', dados.base === 'entrada' ? l.entrada : l.geracao)}>{data(l.geracao)}</td>
                        <td className="nowrap clicavel" style={{ cursor: 'pointer' }} onClick={() => l.hora != null && alternar('hora', l.hora)}><strong>{l.horario ?? '—'}</strong></td>
                        <td className="clicavel pequeno" style={{ cursor: 'pointer' }} onClick={() => alternar('usuario', l.usuario)}>{l.usuario}</td>
                        <td className="clicavel pequeno" style={{ cursor: 'pointer' }} onClick={() => alternar('empresa', `${l.codemp}/${l.codfil}`)}><code className="muted">{l.codemp}/{l.codfil}</code> {l.empresa}</td>
                        <td className="nowrap"><strong>{l.numero}</strong>{l.serie ? <span className="muted">-{l.serie}</span> : null}</td>
                        <td className="pequeno" style={{ maxWidth: 240 }}>{l.fornecedor ?? '—'}</td>
                        <td className="nowrap pequeno">{data(l.entrada)}{l.dias_ate_lancar != null && <div className="muted">{l.dias_ate_lancar === 0 ? 'mesmo dia' : `${l.dias_ate_lancar}d após o XML`}</div>}</td>
                        <td className="num">{brl(l.valor)}</td>
                        <td className="pequeno"><span className={`badge ${l.situacao === '2' ? 'sev-ok' : l.situacao === '3' ? 'sev-erro' : 'sev-alerta'}`}>{l.situacao_rotulo}</span></td>
                        <td className="pequeno">{l.com_xml ? 'XML' : <span className="muted">Digitada</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dados.itens.length > mostrar && <div className="paginacao"><span>Exibindo {numero(mostrar)} de {numero(dados.itens.length)}</span><button className="btn pequeno" onClick={() => setMostrar((m) => m + 500)}>Mostrar mais</button></div>}
              </div>
            )}
          </Cartao>
        </>
      )}
    </>
  );
}

/**
 * Time de Escrita Fiscal (quem tem meta) e metas por dia: padrão do time e exceções por pessoa (vazio = padrão).
 * Quem não está no time aparece em "Outros", sem meta.
 */
function EditorMetas({ metas, pessoas, aoSalvar }) {
  const chave = (n) => String(n).trim().toUpperCase();
  // pessoas do período + membros do time que não lançaram nada no período
  const nomes = [...new Set([...pessoas.map((p) => p.usuario), ...metas.escrita_fiscal])];
  const naTela = new Map(pessoas.map((p) => [chave(p.usuario), p]));
  const [time, setTime] = useState(() => new Set(metas.escrita_fiscal.map(chave)));
  const [padrao, setPadrao] = useState(metas.padrao_manual ? String(metas.padrao) : '');
  const [porPessoa, setPorPessoa] = useState(() => Object.fromEntries(pessoas.map((p) => [p.usuario, p.meta_manual ? String(p.meta_dia) : ''])));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const alternarTime = (nome) => setTime((t) => { const n = new Set(t); if (n.has(chave(nome))) n.delete(chave(nome)); else n.add(chave(nome)); return n; });
  const salvar = async () => {
    setSalvando(true); setErro(null);
    try {
      await api.put('/lancamentos/metas', {
        padrao: padrao === '' ? null : Number(padrao),
        escrita_fiscal: nomes.filter((n) => time.has(chave(n))),
        pessoas: Object.fromEntries(Object.entries(porPessoa).map(([n, v]) => [n, v === '' || !time.has(chave(n)) ? null : Number(v)])),
      });
      aoSalvar();
    } catch (e) { setErro(e); }
    setSalvando(false);
  };
  const ordenados = [...nomes].sort((x, y) => (time.has(chave(y)) - time.has(chave(x))) || x.localeCompare(y, 'pt-BR'));
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--borda)', background: 'var(--superficie-2)' }}>
      <div className="linha pequeno" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>Meta padrão do time de Escrita Fiscal (notas por pessoa/dia):</strong>
        <input type="number" min="0" step="0.5" value={padrao} onChange={(e) => setPadrao(e.target.value)} style={{ width: 90 }}
          placeholder={metas.automatica != null ? String(Math.max(1, Math.round(metas.automatica))) : '—'} />
        <span className="muted">vazio = automática ({metas.automatica != null ? `${numero(metas.automatica, 1)}, ${metas.base}` : 'sem histórico'})</span>
      </div>
      <div className="muted pequeno" style={{ marginTop: 8 }}>Marque quem é do time de Escrita Fiscal. Só essas pessoas têm meta e entram na média automática; as demais ficam em “Outros”.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '4px 12px', marginTop: 6 }}>
        {ordenados.map((nome) => {
          const noTime = time.has(chave(nome));
          const p = naTela.get(chave(nome));
          return (
            <div key={nome} className="linha pequeno" style={{ gap: 6 }}>
              <label className="linha" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                <input type="checkbox" checked={noTime} onChange={() => alternarTime(nome)} />
                <span className="truncar" style={{ fontWeight: noTime ? 600 : undefined }}>{nome}</span>
              </label>
              <span className="muted">{p ? `média ${numero(p.media_dia, 1)}` : 'sem lançamento'}</span>
              <input type="number" min="0" step="0.5" value={porPessoa[nome] ?? ''} placeholder={noTime ? 'padrão' : '—'} disabled={!noTime} style={{ width: 70 }}
                onChange={(e) => setPorPessoa((x) => ({ ...x, [nome]: e.target.value }))} />
            </div>
          );
        })}
      </div>
      <div className="linha" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn pequeno" onClick={salvar} disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
        <span className="muted pequeno">{time.size} pessoa(s) no time · meta individual em branco = meta padrão</span>
      </div>
      <Erro erro={erro} />
    </div>
  );
}
