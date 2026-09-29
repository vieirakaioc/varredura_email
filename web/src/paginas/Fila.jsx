import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Cartao, cnpj, data, Erro, Kpi, Modal, numero, TIPOS_DOC, useDados, useToast, NotaArquivo, BoletoInfo, OrdemCompra, BotaoExportar, textoOrdemCompra } from '../ui.jsx';

// Motivos de "não lançar": um clique, sem digitar justificativa.
const MOTIVOS = [
  { acao: 'REPROVAR', rotulo: 'Nota duplicada', texto: 'Nota duplicada (já recebida/lançada anteriormente)' },
  { acao: 'REPROVAR', rotulo: 'Nota cancelada', texto: 'Nota cancelada pelo emitente' },
  { acao: 'REPROVAR', rotulo: 'Não é do grupo / empresa errada', texto: 'Nota emitida para empresa errada ou fora do grupo' },
  { acao: 'SOLICITAR_CORRECAO', rotulo: 'Pedir correção ao fornecedor', texto: 'Solicitada correção ao fornecedor' },
  { acao: 'NAO_FISCAL', rotulo: 'Não é nota fiscal', texto: 'Anexo não é documento fiscal a lançar' },
];

const hojeLocal = () => new Date().toLocaleDateString('sv-SE');
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

// Classificação usada no filtro e na etiqueta de urgência
function urgenciaDe(l) {
  const hoje = hojeLocal();
  if (l.proximo_vencimento) {
    const d = diasEntre(hoje, l.proximo_vencimento);
    return d < 0 ? 'vencida' : d <= 3 ? 'vence_3d' : 'no_prazo';
  }
  return diasEntre(String(l.recebido_em).slice(0, 10), hoje) >= 5 ? 'parada' : 'no_prazo';
}
// Dias em aberto = dias corridos desde que a nota chegou por e-mail
const diasAberto = (l) => Math.max(0, diasEntre(String(l.recebido_em).slice(0, 10), hojeLocal()));
const FAIXAS_ABERTO = [
  { id: '0', rotulo: 'Hoje', de: 0, ate: 0 },
  { id: '1-2', rotulo: '1–2 dias', de: 1, ate: 2 },
  { id: '3-5', rotulo: '3–5 dias', de: 3, ate: 5 },
  { id: '6-10', rotulo: '6–10 dias', de: 6, ate: 10 },
  { id: '11+', rotulo: '11+ dias', de: 11, ate: Infinity },
];
const faixaAberto = (l) => FAIXAS_ABERTO.find((x) => diasAberto(l) >= x.de && diasAberto(l) <= x.ate)?.id;
const SERIES_ABERTO = [
  { chave: 'vencida', rotulo: 'Boleto vencido', cor: 'var(--status-critico)' },
  { chave: 'vence_3d', rotulo: 'Vence em até 3 dias', cor: 'var(--status-atencao)' },
  { chave: 'demais', rotulo: 'Demais', cor: 'var(--serie-1)' },
];

function DicaAberto({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tooltip-grafico">
      <div className="t">Em aberto: {p.rotulo}</div>
      {SERIES_ABERTO.filter((s) => p[s.chave]).map((s) => <div key={s.chave}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.cor, marginRight: 6 }} />{s.rotulo}: <strong>{p[s.chave]}</strong></div>)}
      <div style={{ marginTop: 4 }}>Total: <strong>{p.total} nota(s) · {brl(p.valor)}</strong></div>
      <div className="muted pequeno">Clique para filtrar a lista</div>
    </div>
  );
}

/** Resumo e gráfico de dias em aberto das notas da lista (respeita os filtros, exceto o de faixa). */
function PainelAberto({ notas, faixa, onFaixa, onVencidas }) {
  if (!notas.length) return null;
  const dados = FAIXAS_ABERTO.map((x) => {
    const daFaixa = notas.filter((l) => faixaAberto(l) === x.id);
    const conta = (u) => daFaixa.filter((l) => urgenciaDe(l) === u).length;
    return { id: x.id, rotulo: x.rotulo, vencida: conta('vencida'), vence_3d: conta('vence_3d'), demais: daFaixa.length - conta('vencida') - conta('vence_3d'), total: daFaixa.length, valor: daFaixa.reduce((s, l) => s + (l.v_liquido ?? l.v_total ?? 0), 0) };
  });
  const dias = notas.map(diasAberto);
  const media = dias.reduce((a, b) => a + b, 0) / dias.length;
  const paradas = notas.filter((l) => diasAberto(l) >= 6);
  const maisAntiga = notas.reduce((a, b) => (diasAberto(b) > diasAberto(a) ? b : a));
  const valorTotal = notas.reduce((s, l) => s + (l.v_liquido ?? l.v_total ?? 0), 0);
  const vencidas = notas.filter((l) => urgenciaDe(l) === 'vencida');
  return (
    <div className="grade" style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2.2fr)' }}>
      <div className="grade" style={{ gridTemplateColumns: '1fr 1fr', gap: 12, alignContent: 'start' }}>
        <Kpi rotulo="A lançar" valor={numero(notas.length)} detalhe={brl(valorTotal)} cor="var(--serie-1)" onClick={() => onFaixa('')} />
        <Kpi rotulo="Boleto vencido" valor={numero(vencidas.length)} detalhe={brl(vencidas.reduce((s, l) => s + (l.v_liquido ?? l.v_total ?? 0), 0))} cor="var(--status-critico)" onClick={onVencidas} />
        <Kpi rotulo="Paradas há 6+ dias" valor={numero(paradas.length)} detalhe={brl(paradas.reduce((s, l) => s + (l.v_liquido ?? l.v_total ?? 0), 0))} cor="var(--status-atencao)" onClick={() => onFaixa(paradas.length ? '6+' : '')} />
        <Kpi rotulo="Média em aberto" valor={`${numero(media, 1)} dia(s)`} detalhe={`mais antiga: NF ${maisAntiga.numero ?? '—'} · ${diasAberto(maisAntiga)}d`} />
      </div>
      <Cartao titulo="Dias em aberto" sub="desde a chegada por e-mail · clique numa barra para filtrar">
        <div className="grafico-legenda">
          {SERIES_ABERTO.map((s) => <span key={s.chave}><i style={{ background: s.cor }} />{s.rotulo}</span>)}
          {faixa && <button className="btn pequeno ghost" onClick={() => onFaixa('')}>Mostrar todas as faixas</button>}
        </div>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={dados} margin={{ left: -18, right: 8, top: 6 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--grade)" />
            <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: 'var(--texto-3)' }} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--texto-3)' }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={<DicaAberto />} />
            {SERIES_ABERTO.map((s, i) => (
              <Bar key={s.chave} isAnimationActive={false} dataKey={s.chave} name={s.rotulo} stackId="a" fill={s.cor} maxBarSize={56}
                radius={i === SERIES_ABERTO.length - 1 ? [4, 4, 0, 0] : 0} style={{ cursor: 'pointer' }}
                onClick={(e) => onFaixa((e.payload ?? e).id === faixa ? '' : (e.payload ?? e).id)}>
                {dados.map((d) => <Cell key={d.id} fillOpacity={!faixa || faixa === d.id || (faixa === '6+' && ['6-10', '11+'].includes(d.id)) ? 1 : 0.3} />)}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Cartao>
    </div>
  );
}

function DiasAberto({ l }) {
  const d = diasAberto(l);
  const cls = d >= 6 ? 'sev-erro' : d >= 3 ? 'sev-alerta' : 'sev-na';
  return <div><span className={`badge ${cls}`}>{d === 0 ? 'hoje' : `${d} dia${d > 1 ? 's' : ''}`}</span><div className="muted pequeno">desde {data(String(l.recebido_em).slice(0, 10))}</div></div>;
}

const COLUNAS_EXPORT = [
  { titulo: 'Vencimento', tipo: 'data', valor: (l) => l.proximo_vencimento },
  { titulo: 'Dias em aberto', tipo: 'numero', valor: (l) => diasAberto(l) },
  { titulo: 'Chegou em', tipo: 'data', valor: (l) => String(l.recebido_em ?? '').slice(0, 10) },
  { titulo: 'Número', valor: (l) => l.numero },
  { titulo: 'Tipo', valor: (l) => TIPOS_DOC[l.tipo] ?? l.tipo },
  { titulo: 'Emissão', tipo: 'data', valor: (l) => l.data_emissao },
  { titulo: 'Fornecedor', valor: (l) => l.emitente_nome },
  { titulo: 'CNPJ fornecedor', valor: (l) => cnpj(l.emitente_cnpj) },
  { titulo: 'Empresa', valor: (l) => l.empresa_nome },
  { titulo: 'A pagar (líquido)', tipo: 'moeda', valor: (l) => l.v_liquido ?? l.v_total },
  { titulo: 'Valor bruto', tipo: 'moeda', valor: (l) => l.v_total },
  { titulo: 'Boleto', valor: (l) => (l.boleto_anexo_id ? 'arquivo recebido' : l.qtd_boletos > 0 ? 'vencimento da nota' : 'sem boleto') },
  { titulo: 'Valor do boleto', tipo: 'moeda', valor: (l) => l.boleto_valor },
  { titulo: 'OC', valor: (l) => textoOrdemCompra(l) },
  { titulo: 'Atenção', valor: (l) => (temProblema(l) ? l.problema_principal ?? 'Verificar' : '') },
];

const temProblema = (l) => l.qtd_erros > 0 || l.situacao_sefaz === 'cancelada' || l.status === 'DUPLICADA';
const URGENCIAS = { vencida: 'Vencidas', vence_3d: 'Vencem em até 3 dias', parada: 'Paradas há 5+ dias', no_prazo: 'No prazo' };
const ORDENS = {
  urgencia: null,
  valor: (a, b) => (b.v_liquido ?? b.v_total ?? 0) - (a.v_liquido ?? a.v_total ?? 0),
  fornecedor: (a, b) => String(a.emitente_nome ?? '').localeCompare(String(b.emitente_nome ?? '')),
  empresa: (a, b) => String(a.empresa_nome ?? '').localeCompare(String(b.empresa_nome ?? '')),
  emissao: (a, b) => String(a.data_emissao ?? '').localeCompare(String(b.data_emissao ?? '')),
  aberto: (a, b) => String(a.recebido_em ?? '').localeCompare(String(b.recebido_em ?? '')), // mais antigas primeiro
};

function Urgencia({ l }) {
  const hoje = hojeLocal();
  const venc = l.proximo_vencimento;
  if (venc) {
    const d = diasEntre(hoje, venc);
    const cls = d < 0 ? 'sev-erro' : d <= 3 ? 'sev-alerta' : 'sev-na';
    return <div><span className={`badge ${cls}`}>{d < 0 ? `venceu há ${-d}d` : d === 0 ? 'vence hoje' : `vence em ${d}d`}</span><div className="muted pequeno">{data(venc)}</div></div>;
  }
  // Sem boleto/vencimento: o tempo de espera aparece na coluna "Em aberto"
  return <span className="muted pequeno" title="Nenhum vencimento informado (sem boleto e sem data na nota)">sem vencimento</span>;
}

function ModalNaoLancar({ nota, onFechar, onFeito }) {
  const avisar = useToast();
  const [enviando, setEnviando] = useState(false);
  const escolher = async (m) => {
    setEnviando(true);
    try { await api.post(`/documentos/${nota.id}/acoes`, { acao: m.acao, justificativa: m.texto }); avisar(`NF ${nota.numero}: ${m.rotulo.toLowerCase()}.`); onFeito(); } catch (e) { avisar(e.message, 'erro'); } finally { setEnviando(false); }
  };
  return (
    <Modal titulo={`Não lançar a NF ${nota.numero ?? ''}`} onFechar={onFechar}>
      <div className="muted pequeno">{nota.emitente_nome ?? nota.emitente_cnpj} · {brl(nota.v_liquido ?? nota.v_total)}</div>
      <div className="coluna" style={{ gap: 8 }}>
        {MOTIVOS.map((m) => <button key={m.rotulo} className="btn" style={{ justifyContent: 'flex-start' }} disabled={enviando} onClick={() => escolher(m)}>{m.rotulo}</button>)}
      </div>
      <div className="muted pequeno">A nota sai da fila e o motivo fica registrado no histórico, com seu nome e data.</div>
    </Modal>
  );
}

export default function Fila() {
  const navegar = useNavigate();
  const { usuario, pode } = useAuth();
  const [params, setParams] = useSearchParams();
  const [naoLancar, setNaoLancar] = useState(null);
  const senior = useDados(() => api.get('/senior'), []);
  // Padrão: o que falta lançar no Senior (quando a conciliação está ativa)
  const seniorAtivo = senior.dados?.configurado;
  const filtros = Object.fromEntries(params.entries());
  const visao = filtros.visao ?? (seniorAtivo ? 'a_lancar' : 'todas');
  const consulta = {
    ...(visao === 'a_lancar' ? { senior: 'nao_lancada' } : {}),
    ...(visao === 'minhas' ? { responsavel_id: String(usuario.id) } : {}),
    ...(visao === 'problemas' ? { severidade: 'erro' } : {}),
    ordem: 'urgencia',
    ...(filtros.q ? { q: filtros.q } : {}),
  };
  const { dados, erro, carregando, recarregar } = useDados(() => (senior.carregando ? Promise.resolve(null) : api.get(`/fila${qs(consulta)}`)), [JSON.stringify(consulta), senior.carregando]);
  const todos = dados?.itens ?? [];
  // Filtros locais (a lista da fila é pequena): urgência, fornecedor, empresa, atenção, tipo
  const f = { urg: filtros.urg ?? '', forn: filtros.forn ?? '', emp: filtros.emp ?? '', atencao: filtros.atencao ?? '', tipo: filtros.tipo ?? '', ab: filtros.ab ?? '', ord: filtros.ord ?? 'urgencia' };
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ ...filtros, visao, [k]: v }).filter(([, x]) => x)));
  const fornecedores = [...new Map(todos.map((l) => [l.emitente_cnpj, l.emitente_nome ?? l.emitente_cnpj])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const empresas = [...new Map(todos.filter((l) => l.empresa_id).map((l) => [String(l.empresa_id), l.empresa_nome])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  // O gráfico usa todos os filtros menos o de faixa de dias (para as outras barras continuarem visíveis)
  const semFaixa = todos.filter((l) => (!f.urg || urgenciaDe(l) === f.urg)
    && (!f.forn || l.emitente_cnpj === f.forn)
    && (!f.emp || (f.emp === 'sem' ? !l.empresa_id : String(l.empresa_id) === f.emp))
    && (!f.atencao || (f.atencao === 'com' ? temProblema(l) : !temProblema(l)))
    && (!f.tipo || l.tipo === f.tipo));
  const naFaixa = (l) => !f.ab || (f.ab === '6+' ? diasAberto(l) >= 6 : faixaAberto(l) === f.ab);
  const itens = semFaixa.filter(naFaixa);
  if (ORDENS[f.ord]) itens.sort(ORDENS[f.ord]);
  const contUrg = (k) => todos.filter((l) => urgenciaDe(l) === k).length;
  const totalPagar = itens.reduce((s, l) => s + (l.v_liquido ?? l.v_total ?? 0), 0);
  const algumFiltro = f.urg || f.forn || f.emp || f.atencao || f.tipo || f.ab;
  const aba = (id, rotulo) => <button className={visao === id ? 'ativa' : ''} onClick={() => setParams({ visao: id })}>{rotulo}</button>;
  const th = (rotulo, ord, classe) => (
    <th className={`ordenavel ${classe ?? ''}`} onClick={() => setFiltro('ord', ord === 'urgencia' ? '' : ord)} title="Ordenar">
      {rotulo}{f.ord === ord ? ' ▼' : ''}
    </th>
  );

  return (
    <>
      <Topo titulo={visao === 'a_lancar' ? 'Notas a lançar' : 'Fila de trabalho'}
        descricao={visao === 'a_lancar' ? 'Notas recebidas por e-mail que ainda não estão no Senior. Ao lançar, elas saem daqui sozinhas (em até 10 min).' : 'Documentos que precisam de alguma ação.'}>
        <form onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get('q'); setParams({ visao, ...(q ? { q } : {}) }); }}>
          <input name="q" defaultValue={filtros.q ?? ''} placeholder="Buscar NF, fornecedor, CNPJ…" style={{ width: 260 }} />
        </form>
      </Topo>
      <div className="pagina">
        <Erro erro={erro} />
        <PainelAberto notas={semFaixa} faixa={f.ab} onFaixa={(v) => setFiltro('ab', v)} onVencidas={() => setFiltro('urg', f.urg === 'vencida' ? '' : 'vencida')} />
        <Cartao semPadding>
          <div className="abas">
            {seniorAtivo && aba('a_lancar', `A lançar no Senior${visao === 'a_lancar' && dados ? ` (${todos.length})` : ''}`)}
            {aba('minhas', 'Minhas')}
            {aba('problemas', 'Com problema')}
            {aba('todas', 'Todas pendentes')}
          </div>
          <div className="filtros" style={{ padding: '12px 14px', borderBottom: '1px solid var(--borda)', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            <select value={f.urg} onChange={(e) => setFiltro('urg', e.target.value)} aria-label="Urgência">
              <option value="">Urgência: todas</option>
              {Object.entries(URGENCIAS).map(([k, v]) => <option key={k} value={k}>{v} ({contUrg(k)})</option>)}
            </select>
            <select value={f.ab} onChange={(e) => setFiltro('ab', e.target.value)} aria-label="Dias em aberto">
              <option value="">Em aberto: todas</option>
              {FAIXAS_ABERTO.map((x) => <option key={x.id} value={x.id}>{x.rotulo} ({semFaixa.filter((l) => faixaAberto(l) === x.id).length})</option>)}
              <option value="6+">6 dias ou mais ({semFaixa.filter((l) => diasAberto(l) >= 6).length})</option>
            </select>
            <select value={f.forn} onChange={(e) => setFiltro('forn', e.target.value)} aria-label="Fornecedor">
              <option value="">Fornecedor: todos ({fornecedores.length})</option>
              {fornecedores.map(([cnpjF, nome]) => <option key={cnpjF} value={cnpjF}>{nome}</option>)}
            </select>
            <select value={f.emp} onChange={(e) => setFiltro('emp', e.target.value)} aria-label="Empresa">
              <option value="">Empresa: todas ({empresas.length})</option>
              {empresas.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              {todos.some((l) => !l.empresa_id) && <option value="sem">Não identificada</option>}
            </select>
            <select value={f.atencao} onChange={(e) => setFiltro('atencao', e.target.value)} aria-label="Atenção">
              <option value="">Atenção: todas</option>
              <option value="com">Com problema ({todos.filter(temProblema).length})</option>
              <option value="sem">Sem problema</option>
            </select>
            <select value={f.tipo} onChange={(e) => setFiltro('tipo', e.target.value)} aria-label="Tipo">
              <option value="">Tipo: todos</option>
              {[...new Set(todos.map((l) => l.tipo))].map((t) => <option key={t} value={t}>{TIPOS_DOC[t] ?? t}</option>)}
            </select>
            <div className="linha" style={{ gap: 8 }}>
              {algumFiltro && <button className="btn pequeno ghost" onClick={() => setParams({ visao, ...(filtros.q ? { q: filtros.q } : {}) })}>Limpar filtros</button>}
              <span className="muted pequeno">{itens.length} nota(s) · {brl(totalPagar)}</span>
              <BotaoExportar titulo={visao === 'a_lancar' ? 'Notas a lançar' : 'Fila de trabalho'} linhas={itens} colunas={COLUNAS_EXPORT} />
            </div>
          </div>
          {carregando && !dados ? <div className="carregando">Carregando…</div> : !itens.length ? (
            <div className="vazio" style={{ padding: 48 }}><div style={{ fontSize: 28 }}>✓</div>{algumFiltro ? 'Nenhuma nota com esses filtros.' : 'Tudo em dia. Nenhuma nota nesta lista.'}</div>
          ) : (
            <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr>{th('Urgência', 'urgencia')}{th('Em aberto', 'aberto')}{th('Nota', 'emissao')}{th('Fornecedor', 'fornecedor')}{th('Empresa', 'empresa')}{th('A pagar', 'valor', 'num')}<th>Nota</th><th>Boleto</th><th>OC</th><th>Atenção</th><th /></tr></thead>
                <tbody>
                  {itens.map((l) => (
                    <tr key={l.id} className="clicavel" onClick={() => navegar(`/documentos/${l.id}`)}>
                      <td><Urgencia l={l} /></td>
                      <td className="nowrap"><DiasAberto l={l} /></td>
                      <td><strong>{l.numero ?? '—'}</strong><div className="muted pequeno">{TIPOS_DOC[l.tipo] ?? l.tipo} · emitida {data(l.data_emissao)}</div></td>
                      <td>{l.emitente_nome ?? <span className="muted" title="Nome do prestador não encontrado no PDF">{cnpj(l.emitente_cnpj)}</span>}</td>
                      <td className="pequeno">{l.empresa_nome ?? <span className="badge sev-erro">Não identificada</span>}</td>
                      <td className="num"><strong>{brl(l.v_liquido ?? l.v_total)}</strong>{l.v_liquido != null && l.v_total - l.v_liquido > 0.009 && <div className="muted pequeno" title="Valor da nota antes das retenções">bruto {brl(l.v_total)}</div>}</td>
                      <td><NotaArquivo l={l} /></td>
                      <td className="nowrap"><BoletoInfo l={l} /></td>
                      <td className="nowrap"><OrdemCompra l={l} /></td>
                      <td style={{ maxWidth: 260 }}>{temProblema(l)
                        ? <span className="badge sev-erro" title={l.problema_principal ?? ''}>{l.situacao_sefaz === 'cancelada' ? 'Cancelada' : l.status === 'DUPLICADA' ? 'Possível duplicada' : 'Verificar'}</span>
                        : <span className="muted">—</span>}
                        {l.qtd_erros > 0 && <div className="muted pequeno">{l.problema_principal}</div>}
                      </td>
                      <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                        {pode('decidir') && <button className="btn pequeno ghost" onClick={() => setNaoLancar(l)}>Não lançar</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Cartao>
      </div>
      {naoLancar && <ModalNaoLancar nota={naoLancar} onFechar={() => setNaoLancar(null)} onFeito={() => { setNaoLancar(null); recarregar(); }} />}
    </>
  );
}
