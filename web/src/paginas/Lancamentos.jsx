import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
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
  { titulo: 'Notas lançadas', tipo: 'numero', valor: (p) => p.notas },
  { titulo: 'Hoje', tipo: 'numero', valor: (p) => p.hoje },
  { titulo: 'Dias ativos', tipo: 'numero', valor: (p) => p.dias_ativos },
  { titulo: 'Média por dia', tipo: 'numero', valor: (p) => p.media_dia },
  { titulo: 'Primeiro lançamento', valor: (p) => p.primeira_hora },
  { titulo: 'Último lançamento', valor: (p) => p.ultima_hora },
  { titulo: 'Empresas atendidas', tipo: 'numero', valor: (p) => p.empresas },
  { titulo: '% a partir do XML', tipo: 'numero', valor: (p) => p.pct_com_xml },
  { titulo: 'Prazo médio (dias)', tipo: 'numero', valor: (p) => p.prazo_medio },
  { titulo: 'Valor lançado', tipo: 'moeda', valor: (p) => p.valor },
];

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
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ aba: 'lancamentos', ...f, [k]: v }).filter(([, x]) => x)));
  const { dados, erro, carregando, recarregar } = useDados(
    ({ forcar } = {}) => api.get(`/lancamentos${qs({ forcar: forcar ? '1' : '', mes, dias: mes ? '' : f.dias, usuario: f.usuario, base: f.base, situacoes: f.situacoes, empresa: f.empresa })}`),
    [f.mes, f.dias, f.usuario, f.base, f.situacoes, f.empresa], { automatico: false, memoria: 'lancamentos' },
  );
  const [horaDestaque, setHoraDestaque] = useState(null);
  const k = dados?.indicadores;
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
          </div>

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
            <Cartao titulo="Lançamentos por dia" sub="quantidade de notas por dia de lançamento">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dados.por_dia} margin={{ left: -18, right: 8, top: 22 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="dia" tickFormatter={diaCurto} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={8} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={44} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                    <div className="tooltip-grafico">
                      <div className="t">{data(payload[0].payload.dia)}</div>
                      <div><strong>{numero(payload[0].payload.notas)}</strong> nota(s) · {brl(payload[0].payload.valor)}</div>
                      <div className="muted pequeno">{numero(payload[0].payload.pessoas)} pessoa(s)</div>
                    </div>
                  ) : null)} />
                  <Bar isAnimationActive={false} dataKey="notas" name="Notas" radius={[4, 4, 0, 0]} maxBarSize={26}>
                    {dados.por_dia.map((d) => <Cell key={d.dia} fill={d.dia === k.melhor_dia?.dia ? 'var(--status-bom)' : 'var(--serie-1)'} />)}
                    <LabelList dataKey="notas" position="top" style={rotulo} formatter={(v) => (v ? numero(v) : '')} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Cartao>

            <Cartao titulo="Distribuição por hora" sub="quando a equipe lança">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dados.por_hora.filter((h) => h.notas > 0 || (h.hora >= 6 && h.hora <= 20))} margin={{ left: -18, right: 8, top: 22 }} barCategoryGap="14%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="rotulo" tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} interval={1} />
                  <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={44} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                    <div className="tooltip-grafico"><div className="t">{payload[0].payload.rotulo}</div><div><strong>{numero(payload[0].payload.notas)}</strong> nota(s)</div></div>
                  ) : null)} />
                  <Bar isAnimationActive={false} dataKey="notas" name="Notas" radius={[4, 4, 0, 0]} maxBarSize={22}
                    onMouseEnter={(e) => setHoraDestaque((e.payload ?? e).hora)} onMouseLeave={() => setHoraDestaque(null)}>
                    {dados.por_hora.filter((h) => h.notas > 0 || (h.hora >= 6 && h.hora <= 20)).map((h) => (
                      <Cell key={h.hora} fill={h.hora === k.pico_hora?.hora ? 'var(--pend)' : 'var(--serie-1)'} fillOpacity={horaDestaque == null || horaDestaque === h.hora ? 1 : 0.5} />
                    ))}
                    <LabelList dataKey="notas" position="top" style={rotulo} formatter={(v) => (v ? numero(v) : '')} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Cartao>
          </div>

          <Cartao titulo="Quem lança em cada hora" sub="10 pessoas com mais lançamentos · quanto mais escuro, mais notas">
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
                      <td className="pequeno">{p.usuario}</td>
                      {Array.from({ length: 18 }, (_, i) => i + 5).map((h) => (
                        <td key={h} className="num" style={{ padding: 0 }}>
                          <div title={`${p.usuario} · ${String(h).padStart(2, '0')}h: ${p.horas[h]} nota(s)`}
                            style={{ background: corCalor(p.horas[h], maxCalor), height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: p.horas[h] > maxCalor * 0.55 ? '#fff' : 'var(--texto-3)' }}>
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
            <Cartao titulo="Ranking da equipe" sub="notas lançadas no período" semPadding
              acoes={<BotaoExportar titulo="Lançamentos por pessoa" linhas={dados.pessoas} colunas={COLUNAS_PESSOAS} />}>
              <div className="tabela-wrap">
                <table className="tabela">
                  <thead><tr><th>Pessoa</th><th className="num">Notas</th><th className="num">Hoje</th><th className="num">Média/dia</th><th>Jornada</th><th className="num">Do XML</th><th className="num">Prazo</th><th className="num">Valor</th></tr></thead>
                  <tbody>
                    {dados.pessoas.map((p, i) => (
                      <tr key={p.usuario} className="clicavel" onClick={() => setFiltro('usuario', f.usuario === p.usuario ? '' : p.usuario)}>
                        <td><strong>{i + 1}º</strong> {p.usuario}<div className="muted pequeno">{p.dias_ativos} dia(s) · {p.empresas} empresa(s)</div></td>
                        <td className="num"><strong>{numero(p.notas)}</strong></td>
                        <td className="num">{p.hoje ? numero(p.hoje) : <span className="muted">—</span>}</td>
                        <td className="num">{numero(p.media_dia, 1)}</td>
                        <td className="pequeno nowrap">{p.primeira_hora} – {p.ultima_hora}</td>
                        <td className="num">{numero(p.pct_com_xml)}%</td>
                        <td className="num">{p.prazo_medio != null ? `${numero(p.prazo_medio, 1)}d` : '—'}</td>
                        <td className="num">{brl(p.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                  <div key={o.chave} className="linha entre" style={{ padding: '6px 0' }}>
                    <span className={`badge ${o.chave === 'xml' ? 'sev-ok' : 'sev-alerta'}`}>{o.rotulo}</span>
                    <strong>{numero(o.notas)}</strong>
                  </div>
                ))}
                <p className="muted pequeno" style={{ marginBottom: 0 }}>“Digitada” = não há XML correspondente no recebimento do Senior (nota digitada manualmente ou XML não importado).</p>
              </Cartao>
            </div>
          </div>
        </>
      )}
    </>
  );
}
