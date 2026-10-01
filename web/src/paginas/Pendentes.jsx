import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, BotaoExportar, COR_CATEGORIA, Cartao, Carregando, cnpj as fmtCnpj, data, Erro, filtrosLembrados, Kpi, numero, useDados, useFiltrosLembrados } from '../ui.jsx';
import Lancamentos from './Lancamentos.jsx';

const eixo = { fontSize: 11, fill: 'var(--texto-3)' };
const brlCurto = (v) => (Math.abs(v) >= 1000000 ? `R$ ${(v / 1000000).toFixed(1)} mi` : Math.abs(v) >= 1000 ? `R$ ${Math.round(v / 1000)} mil` : brl(v));
const diaCurto = (v) => `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}`;
// Código da empresa: "empresa/filial" do Senior; fora do grupo a identidade é o CNPJ
const codigoEmpresa = (chave) => (/^\d+\/\d+$/.test(String(chave)) ? String(chave) : fmtCnpj(chave));

const COR_FAIXA = ['var(--status-bom)', 'var(--serie-1)', 'var(--status-atencao)', '#e8833a', 'var(--status-critico)'];
// rótulo de dados nas colunas
const ROTULO = { fontSize: 10, fill: 'var(--texto-2)', fontWeight: 600 };
const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// Últimos 12 meses para o filtro de período
const MESES_FILTRO = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  return { valor: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rotulo: `${NOMES_MES[d.getMonth()]}/${d.getFullYear()}` };
});

// Cartões de ranking mostram os 5 primeiros; "Ver todas" abre o resto e o Excel leva a lista inteira
const TOP = 5;
const COLUNAS_CATEGORIA = [
  { titulo: 'Tipo de nota', valor: (x) => x.rotulo },
  { titulo: 'Notas pendentes', tipo: 'numero', valor: (x) => x.qtd },
  { titulo: 'Valor', tipo: 'moeda', valor: (x) => x.valor },
];
const COLUNAS_MOTIVO = [
  { titulo: 'Motivo', valor: (x) => x.rotulo },
  { titulo: 'Notas pendentes', tipo: 'numero', valor: (x) => x.qtd },
  { titulo: 'Valor', tipo: 'moeda', valor: (x) => x.valor },
];
const COLUNAS_EMPRESA = [
  { titulo: 'Emp/Fil', valor: (x) => codigoEmpresa(x.chave) },
  { titulo: 'Empresa', valor: (x) => x.rotulo },
  { titulo: 'Notas pendentes', tipo: 'numero', valor: (x) => x.qtd },
  { titulo: 'Valor', tipo: 'moeda', valor: (x) => x.valor },
];
const COLUNAS_FORNECEDOR = [
  { titulo: 'Fornecedor', valor: (x) => x.rotulo },
  { titulo: 'CNPJ', valor: (x) => fmtCnpj(x.chave) },
  { titulo: 'Notas pendentes', tipo: 'numero', valor: (x) => x.qtd },
  { titulo: 'Valor', tipo: 'moeda', valor: (x) => x.valor },
];

const COLUNAS_EXPORT = [
  { titulo: 'Recebida em', tipo: 'data', valor: (l) => l.recebido_em },
  { titulo: 'Dias parada', tipo: 'numero', valor: (l) => l.dias_parada },
  { titulo: 'Emissão', tipo: 'data', valor: (l) => l.emissao },
  { titulo: 'Documento', valor: (l) => l.especie_rotulo },
  { titulo: 'Número', valor: (l) => l.numero },
  { titulo: 'Chave de acesso', valor: (l) => l.chave },
  { titulo: 'Fornecedor', valor: (l) => l.fornecedor },
  { titulo: 'CNPJ fornecedor', valor: (l) => fmtCnpj(l.cnpj_fornecedor) },
  { titulo: 'Empresa destinatária', valor: (l) => l.empresa },
  { titulo: 'Emp/Fil', valor: (l) => (l.empresa_do_grupo ? `${l.codemp}/${l.codfil}` : '') },
  { titulo: 'UF', valor: (l) => l.uf },
  { titulo: 'Valor', tipo: 'moeda', valor: (l) => l.valor },
  { titulo: 'Situação', valor: (l) => l.situacao_rotulo },
  { titulo: 'Motivo', valor: (l) => (l.cancelada ? 'Cancelada na SEFAZ' : !l.empresa_do_grupo ? 'Destinatário fora do grupo' : !l.fornecedor_cadastrado ? 'Fornecedor não cadastrado' : !l.tem_itens ? 'XML sem itens' : !(l.valor > 0) ? 'Valor zerado' : '') },
  { titulo: 'Tipo', valor: (l) => (l.tipo_movimento === 'saida' ? 'Saída' : l.entrada_propria ? 'Entrada própria' : l.transferencia ? 'Transferência' : 'Entrada') },
  { titulo: 'Entrada no Senior', tipo: 'data', valor: (l) => l.entrada?.data },
  { titulo: 'Observação do XML', valor: (l) => l.observacao },
  { titulo: 'Tipo de nota', valor: (l) => l.categoria_rotulo },
  { titulo: 'Produto (1º item)', valor: (l) => l.produto },
  { titulo: 'Motivo de não lançar', valor: (l) => l.motivo_rotulo },
  { titulo: 'Observação do motivo', valor: (l) => l.motivo_obs },
  { titulo: 'Motivo informado por', valor: (l) => (l.motivo_por ? `${l.motivo_por} em ${data(l.motivo_em, true)}` : '') },
  { titulo: 'Responsável', valor: (l) => (l.responsavel === 'faturamento' ? 'Faturamento' : 'Escrita Fiscal') },
];

function Dica({ active, payload, label, sufixo }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip-grafico">
      <div className="t">{sufixo ? `${sufixo} ${label}` : label}</div>
      {payload.map((p) => <div key={p.dataKey}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color ?? p.fill, marginRight: 6 }} />{p.name}: <strong>{numero(p.value)}</strong></div>)}
    </div>
  );
}

export default function Pendentes() {
  const [params] = useSearchParams();
  return params.get('aba') === 'lancamentos' ? <ComAbas><Lancamentos /></ComAbas> : <ComAbas><PainelPendentes /></ComAbas>;
}

/** Cabeçalho comum das duas visões: o que falta lançar e quem está lançando. */
function ComAbas({ children }) {
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') ?? 'pendentes';
  // Cada aba lembra os próprios filtros: trocar de aba (ou de tela) não zera o que estava filtrado
  const trocarAba = (alvo) => {
    const p = new URLSearchParams(filtrosLembrados(alvo));
    if (alvo === 'lancamentos') p.set('aba', 'lancamentos'); else p.delete('aba');
    setParams(p);
  };
  return (
    <>
      <Topo titulo="Lançamento de notas" descricao="XMLs recebidos no Senior, o que falta lançar e a produtividade da equipe." />
      <div className="pagina">
        <div className="abas" style={{ padding: 0 }}>
          <button className={aba === 'pendentes' ? 'ativa' : ''} onClick={() => trocarAba('pendentes')}>Pendentes de lançamento</button>
          <button className={aba === 'lancamentos' ? 'ativa' : ''} onClick={() => trocarAba('lancamentos')}>Produtividade do lançamento</button>
        </div>
        {children}
      </div>
    </>
  );
}

function PainelPendentes() {
  useFiltrosLembrados('pendentes', ['aba']);
  const [params, setParams] = useSearchParams();
  const f = {
    dias: params.get('dias') ?? '60', mes: params.get('mes') ?? '',
    empresa: params.get('empresa') ?? '', especie: params.get('especie') ?? '', fornecedor: params.get('fornecedor') ?? '',
    incluir_terceiros: params.get('incluir_terceiros') ?? '', faixa: params.get('faixa') ?? '',
    tipo: params.get('tipo') ?? 'entradas',
    // quem lança: Escrita Fiscal (padrão) ou Faturamento (bagaço, madeira, cavaco...)
    responsavel: params.get('responsavel') ?? 'fiscal',
    motivo: params.get('motivo') ?? '', categoria: params.get('categoria') ?? '',
    situacoes: params.get('situacoes') ?? 'pendente,inconsistente,incompleta',
    sem_empresas: params.get('sem_empresas') ?? '',
  };
  const empresasExcluidas = f.sem_empresas.split(',').filter(Boolean);
  const alternarEmpresa = (chave) => {
    const nova = empresasExcluidas.includes(chave) ? empresasExcluidas.filter((e) => e !== chave) : [...empresasExcluidas, chave];
    setFiltro('sem_empresas', nova.join(','));
  };
  const situacoesEscolhidas = f.situacoes.split(',').filter(Boolean);
  const alternarSituacao = (chave) => {
    const nova = situacoesEscolhidas.includes(chave) ? situacoesEscolhidas.filter((s) => s !== chave) : [...situacoesEscolhidas, chave];
    setFiltro('situacoes', nova.join(',') || 'pendente');
  };
  const [busca, setBusca] = useState(f.fornecedor);
  const [mostrar, setMostrar] = useState(500);
  const [verTodasEmpresas, setVerTodasEmpresas] = useState(false);
  // gráfico chegada × lançamento: diário ou acumulado (lembrado neste navegador)
  const [visaoSerie, setVisaoSerie] = useState(() => { try { return localStorage.getItem('pendentes_visao_serie') ?? 'diario'; } catch { return 'diario'; } });
  const trocarVisaoSerie = (v) => { setVisaoSerie(v); try { localStorage.setItem('pendentes_visao_serie', v); } catch { /* sem storage */ } };
  const [verTodosFornecedores, setVerTodosFornecedores] = useState(false);
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ ...f, [k]: v }).filter(([, x]) => x !== '' && x != null)));
  const { permissoes } = useAuth();
  const podeMotivo = permissoes.includes('decidir');
  const { dados, erro, carregando, recarregar, atualizar } = useDados(
    ({ forcar } = {}) => api.get(`/pendentes-lancamento${qs({ forcar: forcar ? '1' : '', mes: f.mes, dias: f.mes ? '' : f.dias, tipo: f.tipo, situacoes: f.situacoes, empresa: f.empresa, sem_empresas: f.sem_empresas, especie: f.especie, fornecedor: f.fornecedor, incluir_terceiros: f.incluir_terceiros, responsavel: f.responsavel, motivo: f.motivo, categoria: f.categoria })}`),
    [f.mes, f.dias, f.tipo, f.situacoes, f.empresa, f.sem_empresas, f.especie, f.fornecedor, f.incluir_terceiros, f.responsavel, f.motivo, f.categoria], { automatico: false, memoria: 'pendentes' },
  );
  const k = dados?.indicadores;
  const itens = (dados?.itens ?? []).filter((l) => {
    if (!f.faixa) return true;
    const [de, ate] = f.faixa === '31+' ? [31, Infinity] : f.faixa.split('-').map(Number);
    return (l.dias_parada ?? 0) >= de && (l.dias_parada ?? 0) <= ate;
  });

  return (
    <>
      <Cartao>
        <div className="linha" style={{ gap: 14, flexWrap: 'wrap' }}>
          <select value={f.mes} onChange={(e) => setFiltro('mes', e.target.value)} aria-label="Mês">
            <option value="">Por período (dias)</option>
            {MESES_FILTRO.map((m) => <option key={m.valor} value={m.valor}>{m.rotulo}</option>)}
          </select>
          <select value={f.dias} onChange={(e) => setFiltro('dias', e.target.value)} aria-label="Período" disabled={Boolean(f.mes)}>
            {[15, 30, 60, 90, 180].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
            <option value="tudo">Tudo em aberto (sem limite de data)</option>
          </select>
          <div className="linha pequeno" style={{ gap: 8 }} title="Notas de bagaço, madeira, cavaco etc. são lançadas pelo Faturamento">
            <strong className="muted">Responsável:</strong>
            {[['fiscal', 'Escrita Fiscal'], ['faturamento', 'Faturamento'], ['todos', 'Todos']].map(([v, r]) => {
              const qtd = v === 'todos' ? null : dados?.por_responsavel?.find((x) => x.chave === v)?.qtd;
              return (
                <label key={v} className="linha" style={{ gap: 4 }}>
                  <input type="radio" name="responsavel" checked={f.responsavel === v} onChange={() => setFiltro('responsavel', v)} />{r}{qtd != null ? ` (${numero(qtd)})` : ''}
                </label>
              );
            })}
          </div>
          {/* mesmos filtros da tela do Senior: tipo e situação */}
          <div className="linha pequeno" style={{ gap: 8 }}>
            <strong className="muted">Tipo:</strong>
            {[['entradas', 'Entradas'], ['saidas', 'Saídas'], ['todos', 'Todos']].map(([v, r]) => (
              <label key={v} className="linha" style={{ gap: 4 }}>
                <input type="radio" name="tipo" checked={f.tipo === v} onChange={() => setFiltro('tipo', v)} />{r}
              </label>
            ))}
          </div>
          <div className="linha pequeno" style={{ gap: 8 }}>
            <strong className="muted">Situação:</strong>
            {(dados?.por_situacao ?? [{ chave: 'pendente', rotulo: 'Pendente' }, { chave: 'inconsistente', rotulo: 'Inconsistente' }, { chave: 'incompleta', rotulo: 'Incompleta' }, { chave: 'processada', rotulo: 'Processada' }]).map((s) => (
              <label key={s.chave} className="linha" style={{ gap: 4 }} title={s.chave === 'incompleta' ? 'Falta cadastro para lançar (fornecedor não cadastrado ou XML sem itens)' : s.chave === 'inconsistente' ? 'Cancelada na SEFAZ, destinatário fora do grupo ou valor zerado' : s.chave === 'processada' ? 'Já virou nota de entrada' : 'Pronta para lançar'}>
                <input type="checkbox" checked={situacoesEscolhidas.includes(s.chave)} onChange={() => alternarSituacao(s.chave)} />
                {s.rotulo}{s.qtd != null ? ` (${numero(s.qtd)})` : ''}
              </label>
            ))}
          </div>
          <button className="btn pequeno" onClick={recarregar}>Atualizar</button>
          <span className="espaco" />
          <span className="muted pequeno">Fonte: Via Recebimento de Documento Eletrônico (Senior)</span>
        </div>
        {/* Empresas: caixas de seleção para tirar da conta as que não são acompanhadas */}
        <details className="pequeno" style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>
            <strong className="muted">Empresas:</strong>{' '}
            {(() => {
              const lista = dados?.empresas_disponiveis ?? [];
              const fora = empresasExcluidas.map((c) => `${codigoEmpresa(c)} ${lista.find((e) => e.chave === c)?.rotulo ?? ''}`.trim()).join(', ');
              if (!empresasExcluidas.length) return 'todas';
              // enquanto os dados não chegam ainda não dá para dizer quantas são no total
              return lista.length ? `${numero(lista.length - empresasExcluidas.length)} de ${numero(lista.length)} — sem ${fora}` : `sem ${fora}`;
            })()}
          </summary>
          <div className="linha" style={{ gap: 8, marginTop: 6 }}>
            <button className="btn pequeno ghost" onClick={() => setFiltro('sem_empresas', '')} disabled={empresasExcluidas.length === 0}>Marcar todas</button>
            <button className="btn pequeno ghost" onClick={() => setFiltro('sem_empresas', (dados?.empresas_disponiveis ?? []).map((e) => e.chave).join(','))}>Desmarcar todas</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '4px 12px', marginTop: 8 }}>
            {(dados?.empresas_disponiveis ?? []).map((e) => (
              <label key={e.chave} className="linha" style={{ gap: 6 }} title={e.do_grupo ? `Empresa/filial ${e.chave}` : `Fora do grupo · CNPJ ${e.chave}`}>
                <input type="checkbox" checked={!empresasExcluidas.includes(e.chave)} onChange={() => alternarEmpresa(e.chave)} />
                <code className="muted">{codigoEmpresa(e.chave)}</code>
                <span className="truncar">{e.rotulo}</span>
                <span className="muted">({numero(e.qtd)})</span>
              </label>
            ))}
          </div>
        </details>
      </Cartao>
      <Erro erro={erro} />
      {dados && !dados.responsavel_identificado && (
        <div className="aviso atencao pequeno">Não encontrei no Senior a coluna de descrição dos itens do XML (tabela E000IPC): as notas do Faturamento (bagaço, madeira, cavaco) não estão sendo separadas. Abra o Diagnóstico e me envie a lista de colunas.</div>
      )}
        {carregando && !dados ? <Carregando /> : k && (
          <>
            <div className="grade grade-kpi monetario">
              <Kpi rotulo="Pendentes de lançamento" valor={numero(k.pendentes)} detalhe={brl(k.pendentes_valor)} cor="var(--status-critico)" onClick={() => setFiltro('situacoes', 'pendente,inconsistente,incompleta')} />
              <Kpi rotulo="Paradas há mais de 5 dias" valor={numero(k.paradas_mais_5)} detalhe={`mais antiga: ${k.mais_antiga} dia(s)`} cor="var(--status-atencao)" onClick={() => setFiltro('faixa', f.faixa ? '' : '6-10')} />
              <Kpi rotulo="Chegaram hoje" valor={numero(k.recebidas_hoje)} detalhe={`${numero(k.pendentes_hoje)} ainda sem lançar`} cor="var(--serie-1)" />
              {dados.tudo_aberto
                ? <Kpi rotulo="Mais antiga em aberto" valor={`${numero(k.mais_antiga)} dia(s)`} detalhe="sem limite de data" cor="var(--dup)" />
                : <>
                  <Kpi rotulo="Lançadas hoje (de XML)" titulo="Notas lançadas hoje no Senior a partir de um XML recebido, pela data do lançamento. A aba Produtividade conta também as digitadas." valor={numero(k.lancadas_hoje)} detalhe={`saldo do dia: ${k.recebidas_hoje - k.lancadas_hoje >= 0 ? '+' : ''}${numero(k.recebidas_hoje - k.lancadas_hoje)}`} cor="var(--status-bom)" />
                  <Kpi rotulo="XMLs do período já lançados" titulo="Dos XMLs recebidos no período (por data do XML), quantos já viraram nota de entrada. Não é o mesmo que 'notas lançadas no período' da aba Produtividade, que conta pela data de entrada e inclui as digitadas." valor={numero(k.lancadas)} detalhe={`${Math.round((k.lancadas / (k.total || 1)) * 100)}% do que chegou`} cor="var(--ok)" onClick={() => setFiltro('situacoes', 'processada')} />
                </>}
              {k.canceladas_pendentes > 0 && <Kpi rotulo="Canceladas na SEFAZ" valor={numero(k.canceladas_pendentes)} detalhe="pendentes que NÃO devem ser lançadas" cor="var(--dup)" />}
            </div>
            <div className="muted pequeno">
              {dados.tudo_aberto
                ? <>Fonte: <strong>todos</strong> os XMLs do recebimento do Senior que ainda não viraram nota de entrada, sem limite de data (a consulta já exclui as lançadas, por isso os cartões de “lançadas” não aparecem). </>
                : <>Fonte: XMLs recebidos no Senior entre {data(dados.periodo.de)} e {data(dados.periodo.ate)}, mais <strong>todos os ainda não lançados</strong> dos últimos 12 meses (para mais antigos, use “Tudo em aberto”). </>}
              Fora da conta: {numero(k.fora_do_grupo)} XML(s) entre terceiros e {numero(k.nossas_saidas)} documento(s) emitido(s) pelo próprio grupo.
            </div>

            {(f.empresa || f.especie || f.faixa || f.fornecedor || f.motivo || f.categoria) && (
              <div className="linha pequeno" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong className="muted">Filtrando por:</strong>
                {f.empresa && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => setFiltro('empresa', '')}>
                  Empresa: <strong>{codigoEmpresa(f.empresa)} {dados.por_empresa.find((x) => x.chave === f.empresa)?.rotulo ?? ''}</strong> ✕</button>}
                {f.categoria && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => setFiltro('categoria', '')}>
                  Tipo de nota: <strong>{dados.categorias?.[f.categoria] ?? f.categoria}</strong> ✕</button>}
                {f.motivo && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => setFiltro('motivo', '')}>
                  Motivo: <strong>{dados.por_motivo?.find((x) => x.chave === f.motivo)?.rotulo ?? f.motivo}</strong> ✕</button>}
                {f.especie && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => setFiltro('especie', '')}>Documento: <strong>{f.especie}</strong> ✕</button>}
                {f.faixa && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => setFiltro('faixa', '')}>Espera: <strong>{dados.aging.find((x) => x.id === f.faixa)?.rotulo ?? f.faixa}</strong> ✕</button>}
                {f.fornecedor && <button className="btn pequeno ghost" title="Tirar este filtro" onClick={() => { setBusca(''); setFiltro('fornecedor', ''); }}>Fornecedor: <strong>{f.fornecedor}</strong> ✕</button>}
                <button className="btn pequeno" onClick={() => { setBusca(''); setParams({ dias: f.dias, tipo: f.tipo, situacoes: f.situacoes, responsavel: f.responsavel, ...(f.sem_empresas ? { sem_empresas: f.sem_empresas } : {}), ...(f.mes ? { mes: f.mes } : {}) }); }}>Limpar filtros</button>
                {carregando && <span className="muted">atualizando…</span>}
              </div>
            )}

            <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
              <Cartao titulo="Chegada × lançamento"
                sub={visaoSerie === 'acumulado' ? 'últimos 21 dias · soma dia a dia: se o saldo sobe, as notas estão acumulando' : 'últimos 21 dias · XMLs recebidos por dia e notas lançadas por dia (a partir de XML)'}
                acoes={<div className="linha" style={{ gap: 2 }}>
                  {[['diario', 'Diário'], ['acumulado', 'Acumulado']].map(([v, r]) => (
                    <button key={v} className={`btn pequeno ${visaoSerie === v ? '' : 'ghost'}`} onClick={() => trocarVisaoSerie(v)}>{r}</button>
                  ))}
                </div>}>
                {visaoSerie === 'acumulado' ? <SerieAcumulada serie={dados.serie} /> : <>
                <div className="grafico-legenda">
                  <span><i style={{ background: 'var(--serie-1)' }} />Recebidas no dia</span>
                  <span><i style={{ background: 'var(--status-bom)' }} />Lançadas no dia</span>
                  <span><i style={{ background: 'var(--status-critico)', height: 2, borderRadius: 0, verticalAlign: 3 }} />Das recebidas no dia, ainda sem lançar</span>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={dados.serie.filter((d) => d.recebidas || d.lancadas)} margin={{ left: 0, right: 8, top: 20 }} barCategoryGap="18%" barGap={1}>
                    <CartesianGrid vertical={false} stroke="var(--grade)" />
                    <XAxis dataKey="dia" tickFormatter={diaCurto} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={6} />
                    <YAxis allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={36} />
                    <Tooltip content={<Dica sufixo="Dia" />} cursor={{ fill: 'var(--superficie-3)' }} />
                    <Bar isAnimationActive={false} dataKey="recebidas" name="Recebidas" fill="var(--serie-1)" radius={[3, 3, 0, 0]} maxBarSize={18}>
                      <LabelList dataKey="recebidas" position="top" style={{ ...ROTULO, fontSize: 9 }} formatter={(v) => (v ? numero(v) : '')} />
                    </Bar>
                    <Bar isAnimationActive={false} dataKey="lancadas" name="Lançadas" fill="var(--status-bom)" radius={[3, 3, 0, 0]} maxBarSize={18}>
                      <LabelList dataKey="lancadas" position="top" style={{ ...ROTULO, fontSize: 9 }} formatter={(v) => (v ? numero(v) : '')} />
                    </Bar>
                    <Line isAnimationActive={false} type="linear" dataKey="pendentes" name="Ainda sem lançar" stroke="var(--status-critico)" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2.5, fill: 'var(--status-critico)' }} />
                  </ComposedChart>
                </ResponsiveContainer>
                              </>}
              </Cartao>

              <Cartao titulo="Há quanto tempo esperam" sub="clique para filtrar a lista">
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={dados.aging} layout="vertical" margin={{ left: 8, right: 44, top: 6 }}>
                    <CartesianGrid horizontal={false} stroke="var(--grade)" />
                    <XAxis type="number" allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="rotulo" tick={eixo} axisLine={false} tickLine={false} width={104} />
                    <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
                      <div className="tooltip-grafico"><div className="t">{payload[0].payload.rotulo}</div>
                        <div><strong>{numero(payload[0].payload.qtd)}</strong> nota(s) · {brl(payload[0].payload.valor)}</div>
                        <div className="muted pequeno">Clique para filtrar</div>
                      </div>
                    ) : null)} />
                    <Bar isAnimationActive={false} dataKey="qtd" name="Notas" radius={[0, 4, 4, 0]} maxBarSize={26}
                      style={{ cursor: 'pointer' }} onClick={(e) => setFiltro('faixa', (e.payload ?? e).id === f.faixa ? '' : (e.payload ?? e).id)}>
                      {dados.aging.map((x, i) => <Cell key={x.id} fill={COR_FAIXA[i]} fillOpacity={!f.faixa || f.faixa === x.id ? 1 : 0.35} />)}
                      <LabelList dataKey="qtd" position="right" style={ROTULO} formatter={(v) => (v ? numero(v) : '')} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Cartao>
            </div>

            <Cartao titulo="Por que estão pendentes" sub="motivo informado pela equipe na lista abaixo · clique para filtrar" semPadding
              acoes={<BotaoExportar titulo="Pendentes por motivo" linhas={dados.por_motivo ?? []} colunas={COLUNAS_MOTIVO} />}>
              <div style={{ padding: '10px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '6px 24px' }}>
                {(dados.por_motivo ?? []).map((x) => {
                  const total = (dados.por_motivo ?? []).reduce((t, y) => t + y.qtd, 0) || 1;
                  const ativo = f.motivo === x.chave;
                  const semMotivo = x.chave === 'sem_motivo';
                  return (
                    <button key={x.chave} onClick={() => setFiltro('motivo', ativo ? '' : x.chave)}
                      style={{ background: 'none', border: 'none', padding: '3px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'inherit', opacity: !f.motivo || ativo ? 1 : 0.45 }}>
                      <div className="linha entre pequeno" style={{ flexWrap: 'nowrap' }}>
                        <span className="truncar" style={{ fontWeight: ativo ? 650 : undefined }} title={x.rotulo}>{semMotivo ? <em className="muted">{x.rotulo}</em> : x.rotulo}</span>
                        <span className="nowrap"><strong>{numero(x.qtd)}</strong> <span className="muted">· {Math.round((x.qtd / total) * 100)}% · {brlCurto(x.valor)}</span></span>
                      </div>
                      <div className="barra-progresso"><div style={{ width: `${(x.qtd / total) * 100}%`, background: semMotivo ? 'var(--status-neutro)' : ativo ? 'var(--status-critico)' : 'var(--status-atencao)' }} /></div>
                    </button>
                  );
                })}
                {!(dados.por_motivo ?? []).length && <div className="muted pequeno">Nada pendente.</div>}
              </div>
            </Cartao>

            <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr)' }}>
              <Cartao titulo="Pendentes por empresa" sub={f.empresa ? 'clique de novo para ver todas' : `top ${TOP} · clique para filtrar`} semPadding
                acoes={<BotaoExportar titulo="Pendentes por empresa" linhas={dados.por_empresa} colunas={COLUNAS_EMPRESA} />}>
                <div style={{ padding: 12 }}>
                  {dados.por_empresa.filter((x, i) => verTodasEmpresas || i < TOP || x.chave === f.empresa).map((x) => {
                    const max = Math.max(...dados.por_empresa.map((y) => y.qtd), 1);
                    const ativo = f.empresa === x.chave;
                    return (
                      <button key={x.chave} className="linha entre" onClick={() => setFiltro('empresa', ativo ? '' : x.chave)}
                        style={{ width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', opacity: !f.empresa || ativo ? 1 : 0.5 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="linha entre pequeno"><span className="truncar"><code className="muted">{codigoEmpresa(x.chave)}</code> {x.rotulo}</span><strong>{numero(x.qtd)}</strong></div>
                          <div className="barra-progresso"><div style={{ width: `${(x.qtd / max) * 100}%`, background: ativo ? 'var(--status-critico)' : 'var(--serie-1)' }} /></div>
                          <div className="muted pequeno">{brl(x.valor)}</div>
                        </div>
                      </button>
                    );
                  })}
                  {!dados.por_empresa.length && <div className="muted pequeno">Nada pendente no período.</div>}
                  {dados.por_empresa.length > TOP && (
                    <button className="btn pequeno ghost" style={{ marginTop: 6 }} onClick={() => setVerTodasEmpresas((v) => !v)}>
                      {verTodasEmpresas ? `Mostrar só as ${TOP} primeiras` : `Ver todas (${numero(dados.por_empresa.length)})`}
                    </button>
                  )}
                </div>
              </Cartao>

              <Cartao titulo="Por tipo de nota" semPadding
                acoes={<BotaoExportar titulo="Pendentes por tipo de nota" linhas={dados.por_categoria ?? []} colunas={COLUNAS_CATEGORIA} rotulo="Excel" />}>
                <div style={{ padding: 12 }}>
                  {(dados.por_categoria ?? []).map((x) => {
                    const max = Math.max(...(dados.por_categoria ?? []).map((y) => y.qtd), 1);
                    const ativo = f.categoria === x.chave;
                    return (
                      <button key={x.chave} onClick={() => setFiltro('categoria', ativo ? '' : x.chave)}
                        style={{ width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'inherit', opacity: !f.categoria || ativo ? 1 : 0.45 }}>
                        <div className="linha entre pequeno" style={{ flexWrap: 'nowrap' }}>
                          <span className="truncar" style={{ fontWeight: ativo ? 650 : undefined }}>{x.rotulo}</span>
                          <span className="nowrap"><strong>{numero(x.qtd)}</strong> <span className="muted">{brlCurto(x.valor)}</span></span>
                        </div>
                        <div className="barra-progresso"><div style={{ width: `${(x.qtd / max) * 100}%`, background: COR_CATEGORIA[x.chave] ?? 'var(--serie-1)' }} /></div>
                      </button>
                    );
                  })}
                  {!(dados.por_categoria ?? []).length && <div className="muted pequeno">Nada pendente.</div>}
                </div>
              </Cartao>

              <Cartao titulo="Fornecedores com mais pendências" sub={`top ${TOP}`} semPadding
                acoes={<BotaoExportar titulo="Fornecedores com mais pendências" linhas={dados.por_fornecedor} colunas={COLUNAS_FORNECEDOR} />}>
                <div className="tabela-wrap" style={{ maxHeight: verTodosFornecedores ? 420 : 'none' }}>
                  <table className="tabela">
                    <thead><tr><th>Fornecedor</th><th className="num">Notas</th><th className="num">Valor</th></tr></thead>
                    <tbody>
                      {dados.por_fornecedor.filter((x, i) => verTodosFornecedores || i < TOP).map((x) => (
                        <tr key={x.chave} className="clicavel" title={`CNPJ ${fmtCnpj(x.chave)}`} onClick={() => { setBusca(x.rotulo); setFiltro('fornecedor', x.rotulo); }}>
                          <td style={{ maxWidth: 280 }}><div className="truncar">{x.rotulo}</div></td>
                          <td className="num">{numero(x.qtd)}</td>
                          <td className="num">{brl(x.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {dados.por_fornecedor.length > TOP && (
                  <div style={{ padding: '6px 10px' }}>
                    <button className="btn pequeno ghost" onClick={() => setVerTodosFornecedores((v) => !v)}>
                      {verTodosFornecedores ? `Mostrar só os ${TOP} primeiros` : `Ver os ${numero(dados.por_fornecedor.length)} com mais pendências`}
                    </button>
                  </div>
                )}
              </Cartao>
            </div>
          </>
        )}

        <Diagnostico />

        <Cartao semPadding>
          <div className="linha" style={{ padding: 12, borderBottom: '1px solid var(--borda)', gap: 10, flexWrap: 'wrap' }}>
            <form onSubmit={(e) => { e.preventDefault(); setFiltro('fornecedor', busca); }}>
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Fornecedor ou CNPJ" style={{ width: 240 }} />
            </form>
            <label className="linha pequeno" style={{ gap: 6 }} title="A base do Senior também recebe XMLs entre terceiros, que não são pendência do grupo">
              <input type="checkbox" checked={f.incluir_terceiros === '1'} onChange={(e) => setFiltro('incluir_terceiros', e.target.checked ? '1' : '')} />Incluir XMLs de terceiros{k?.fora_do_grupo ? ` (${numero(k.fora_do_grupo)})` : ''}
            </label>
            {(f.empresa || f.especie || f.faixa || f.fornecedor || f.motivo || f.categoria) && (
              <button className="btn pequeno ghost" onClick={() => { setBusca(''); setParams({ dias: f.dias, tipo: f.tipo, situacoes: f.situacoes, responsavel: f.responsavel }); }}>Limpar filtros</button>
            )}
            <span className="espaco" />
            <span className="muted pequeno">{numero(itens.length)} nota(s){dados ? ` · ${brl(itens.reduce((s, l) => s + (l.valor ?? 0), 0))}` : ''}</span>
            <BotaoExportar titulo="Pendentes de lançamento" linhas={itens} colunas={COLUNAS_EXPORT} />
          </div>
          {carregando && !dados ? <Carregando /> : !itens.length ? (
            <div className="vazio" style={{ padding: 40 }}><div style={{ fontSize: 26 }}>✓</div>Nenhuma nota nesta visão.</div>
          ) : (
            <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr><th>Espera</th><th className="col-larga">Recebida</th><th>Documento</th><th>Produto</th><th>Fornecedor</th><th>Empresa destinatária</th><th className="num">Valor</th><th>Situação</th><th>Motivo de não lançar</th><th className="col-larga">Chave</th></tr></thead>
                <tbody>
                  {itens.slice(0, mostrar).map((l) => {
                    // motivo da situação: vai ao lado do selo, na mesma linha
                    const motivo = l.situacao === 'processada' ? `${data(l.entrada.data)} · NF ${l.entrada.numero}`
                      : l.situacao === 'inconsistente' ? (l.cancelada ? `cancelada na SEFAZ · ${data(l.cancelada_em)}` : !l.empresa_do_grupo ? 'destinatário fora do grupo' : 'valor zerado')
                        : l.situacao === 'incompleta' ? (!l.fornecedor_cadastrado ? 'fornecedor não cadastrado' : 'XML sem itens')
                          : l.tipo_movimento === 'saida' ? 'saída do grupo' : l.entrada_propria ? 'entrada própria' : l.transferencia ? 'transferência do grupo' : null;
                    const selo = { processada: 'sev-ok', inconsistente: 'sev-erro', incompleta: 'sev-alerta' }[l.situacao] ?? 'sev-conferencia';
                    return (
                      <tr key={l.chave}>
                        <td className="nowrap">
                          <span className={`badge ${l.dias_parada > 10 ? 'sev-erro' : l.dias_parada > 5 ? 'sev-alerta' : 'sev-na'}`}>
                            {l.dias_parada === 0 ? 'hoje' : `${l.dias_parada} dia${l.dias_parada > 1 ? 's' : ''}`}
                          </span>
                        </td>
                        <td className="nowrap muted col-larga">{data(l.recebido_em)}</td>
                        <td className="nowrap" title={`emitida em ${data(l.emissao)}`}><span className="tag azul">{l.especie_rotulo}</span> <strong>{l.numero}</strong></td>
                        <td style={{ maxWidth: 170 }} title={l.produto ?? ''}>
                          <div className="truncar">{l.produto ?? <span className="muted">—</span>}</div>
                          <div className="muted pequeno" style={{ color: COR_CATEGORIA[l.categoria] }}>{dados.categorias?.[l.categoria]}</div>
                        </td>
                        <td style={{ maxWidth: 220 }}>
                          <div className="truncar" title={l.fornecedor ?? ''}>{l.fornecedor ?? <span className="muted">não cadastrado</span>}</div>
                          <div className="muted pequeno mono">{fmtCnpj(l.cnpj_fornecedor)}</div>
                        </td>
                        <td className="nowrap" title={l.empresa_do_grupo ? `Empresa/filial ${l.codemp}/${l.codfil}` : `Fora do grupo · ${fmtCnpj(l.cnpj_destinatario)}`}>
                          {l.empresa_do_grupo ? <code className="muted">{l.codemp}/{l.codfil}</code> : null} {l.empresa}
                          {l.uf ? <span className="muted"> · {l.uf}</span> : null}
                        </td>
                        <td className="num">{brl(l.valor)}</td>
                        <td className="nowrap" title={motivo ?? ''}><span className={`badge ${selo}`}>{l.situacao_rotulo}</span>{motivo && <div className="muted pequeno truncar" style={{ maxWidth: 160 }}>{motivo}</div>}</td>
                        <td><MotivoNota nota={l} motivos={dados.motivos_disponiveis} pode={podeMotivo && !l.lancada} aoSalvar={atualizar} /></td>
                        <td className="mono muted nowrap col-larga" title={l.chave}>{l.chave?.slice(-12)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {itens.length > mostrar && <div className="paginacao"><span>Exibindo {numero(mostrar)} de {numero(itens.length)}</span><button className="btn pequeno" onClick={() => setMostrar((m) => m + 1000)}>Mostrar mais</button></div>}
              {dados?.truncado && <div className="paginacao"><span>A consulta tem {numero(dados.total_itens)} notas; a lista traz as {numero(dados.itens.length)} mais antigas. Use os filtros ou exporte para Excel.</span></div>}
            </div>
          )}
        </Cartao>
    </>
  );
}

/** Por que uma nota (chave) ou as notas de uma empresa/fornecedor (CNPJ) aparecem ou não na lista. */
function Diagnostico() {
  const [busca, setBusca] = useState('');
  const [res, setRes] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [soFora, setSoFora] = useState(true);
  const consultar = async (e) => {
    e.preventDefault();
    setCarregando(true); setErro(null);
    try { setRes(await api.get(`/pendentes-lancamento/diagnostico${qs({ busca })}`)); } catch (x) { setErro(x); setRes(null); }
    setCarregando(false);
  };
  const notas = (res?.notas ?? []).filter((n) => !soFora || !n.aparece_na_lista_padrao);
  return (
    <details className="cartao" style={{ padding: 12 }}>
      <summary style={{ cursor: 'pointer' }}><strong>Diagnóstico:</strong> <span className="muted">por que uma nota não aparece aqui?</span></summary>
      <form onSubmit={consultar} className="linha" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Chave de acesso ou CNPJ (ex.: da Biomassa)" style={{ width: 360 }} />
        <button className="btn pequeno" disabled={carregando}>{carregando ? 'Consultando…' : 'Consultar no Senior'}</button>
        <label className="linha pequeno" style={{ gap: 6 }}><input type="checkbox" checked={soFora} onChange={(e) => setSoFora(e.target.checked)} />Só as que ficam fora da lista</label>
      </form>
      <Erro erro={erro} />
      {res && (
        <div style={{ marginTop: 10 }}>
          {res.colunas_produto && <div className="muted pequeno">Itens do XML (E000IPC): descrição em <code>{res.colunas_produto.descricao ?? 'não encontrada'}</code>, NCM em <code>{res.colunas_produto.ncm ?? 'não encontrado'}</code>{!res.colunas_produto.descricao && res.colunas_produto.disponiveis?.length ? <> · colunas: {res.colunas_produto.disponiveis.join(', ')}</> : null}</div>}
          {res.filiais_com_este_cnpj.length > 0 && <div className="pequeno">Filiais do Senior com este CNPJ: {res.filiais_com_este_cnpj.map((f) => `${f.codemp}/${f.codfil} ${f.nome}`).join(', ')}</div>}
          <div className="muted pequeno">{numero(res.notas.length)} XML(s) no recebimento do Senior (últimos 300, sem limite de data) · {numero(res.notas.filter((n) => !n.aparece_na_lista_padrao).length)} fora da lista padrão</div>
          <div className="tabela-wrap" style={{ maxHeight: 360 }}>
            <table className="tabela">
              <thead><tr><th>Nota</th><th>Emitente → Destinatário</th><th>Produto</th><th>tpNF</th><th>Situação</th><th>Por que não aparece</th></tr></thead>
              <tbody>
                {notas.map((n) => (
                  <tr key={n.chave}>
                    <td className="nowrap"><strong>{n.numero}</strong><div className="muted pequeno">emitida {data(n.emissao)} · {brl(n.valor)}</div><div className="mono pequeno" title={n.chave}>{n.chave?.slice(-12)}</div></td>
                    <td className="pequeno">{n.emitente ?? fmtCnpj(n.cnpj_emitente)}<div className="muted">→ {n.empresa} ({fmtCnpj(n.cnpj_destinatario)})</div>
                      {n.entrada_propria && <div className="muted">entrada própria</div>}{n.transferencia && <div className="muted">transferência</div>}{n.emitida_pelo_grupo && !n.entrada_propria && !n.transferencia && <div className="muted">emitida pelo grupo</div>}</td>
                    <td className="pequeno" style={{ maxWidth: 200 }}><div className="truncar" title={n.produto ?? ''}>{n.produto ?? '—'}</div>{n.responsavel === 'faturamento' && <span className="tag">Faturamento</span>}</td>
                    <td className="pequeno">{String(n.tipope_no_xml ?? '—')}</td>
                    <td className="pequeno">{n.situacao}</td>
                    <td className="pequeno">{n.motivos.length ? n.motivos.join('; ') : <span className="muted">aparece (confira o período e os filtros)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </details>
  );
}

/** Motivo de a nota ainda não ter sido lançada: escolhido pela equipe, com observação opcional. */
function MotivoNota({ nota, motivos, pode, aoSalvar }) {
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const salvar = async (motivo, observacao) => {
    setSalvando(true); setErro(null);
    try { await api.put('/pendentes-lancamento/motivo', { chave: nota.chave, motivo, observacao }); aoSalvar(); } catch (e) { setErro(e.message); }
    setSalvando(false);
  };
  const escolher = (motivo) => {
    // "Outro" pede a explicação; nos demais a observação é opcional (botão ✎)
    const obs = motivo === 'outro' ? window.prompt('Descreva o motivo:', nota.motivo_obs ?? '') : nota.motivo_obs;
    if (motivo === 'outro' && obs === null) return;
    salvar(motivo, obs);
  };
  const quem = nota.motivo_por ? `${nota.motivo_por} · ${data(nota.motivo_em, true)}` : '';
  if (!pode) {
    return nota.motivo
      ? <span className="pequeno" title={[nota.motivo_obs, quem].filter(Boolean).join(' — ')}>{nota.motivo_rotulo}{nota.motivo_obs ? ' ✎' : ''}</span>
      : <span className="muted">—</span>;
  }
  return (
    <div className="linha" style={{ gap: 4, flexWrap: 'nowrap' }} title={[nota.motivo_obs, quem].filter(Boolean).join(' — ')}>
      <select value={nota.motivo ?? ''} disabled={salvando} onChange={(e) => escolher(e.target.value)}
        aria-label="Motivo de não lançar" style={{ fontSize: 12, padding: '3px 6px', maxWidth: 220, color: nota.motivo ? 'var(--texto)' : 'var(--texto-3)' }}>
        <option value="">— informar motivo —</option>
        {Object.entries(motivos ?? {}).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
      </select>
      {nota.motivo && (
        <button className="btn pequeno ghost" style={{ padding: '2px 6px' }} disabled={salvando}
          title={nota.motivo_obs ? `Observação: ${nota.motivo_obs}` : 'Acrescentar observação'}
          onClick={() => { const obs = window.prompt('Observação:', nota.motivo_obs ?? ''); if (obs !== null) salvar(nota.motivo, obs); }}>
          {nota.motivo_obs ? '✎' : '+obs'}
        </button>
      )}
      {erro && <span className="muted pequeno" style={{ color: 'var(--erro)' }}>{erro}</span>}
    </div>
  );
}

/**
 * Recebidas × lançadas somadas dia a dia nos últimos 21 dias. O saldo (recebidas − lançadas acumuladas)
 * subindo quer dizer que entra mais XML do que a equipe lança: notas acumulando.
 */
function SerieAcumulada({ serie }) {
  let rec = 0, lan = 0;
  const pontos = (serie ?? []).map((d) => {
    rec += d.recebidas; lan += d.lancadas;
    return { dia: d.dia, recebidas: rec, lancadas: lan, saldo: rec - lan };
  });
  const ultimo = pontos[pontos.length - 1] ?? { recebidas: 0, lancadas: 0, saldo: 0 };
  const primeiroSaldo = pontos.find((p) => p.recebidas || p.lancadas)?.saldo ?? 0;
  return (
    <>
      <div className="grafico-legenda">
        <span><i style={{ background: 'var(--serie-1)', height: 3, borderRadius: 0, verticalAlign: 3 }} />Recebidas (acumulado)</span>
        <span><i style={{ background: 'var(--status-bom)', height: 3, borderRadius: 0, verticalAlign: 3 }} />Lançadas (acumulado)</span>
        <span><i style={{ background: 'var(--status-critico)', opacity: 0.55 }} />Saldo: recebidas − lançadas (eixo à direita)</span>
        <span className="espaco" />
        <span>
          No período: <strong>{numero(ultimo.recebidas)}</strong> recebidas, <strong>{numero(ultimo.lancadas)}</strong> lançadas ·{' '}
          <strong style={{ color: ultimo.saldo > 0 ? 'var(--erro)' : 'var(--ok)' }}>{ultimo.saldo > 0 ? `+${numero(ultimo.saldo)} acumulando` : `${numero(ultimo.saldo)} (lançou mais do que chegou)`}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={pontos} margin={{ left: 0, right: 0, top: 20 }}>
          <CartesianGrid vertical={false} stroke="var(--grade)" />
          <XAxis dataKey="dia" tickFormatter={diaCurto} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={6} />
          <YAxis yAxisId="total" allowDecimals={false} tick={eixo} axisLine={false} tickLine={false} width={44} />
          <YAxis yAxisId="saldo" orientation="right" allowDecimals={false} tick={{ ...eixo, fill: 'var(--status-critico)' }} axisLine={false} tickLine={false} width={40} />
          <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={({ active, payload }) => (active && payload?.length ? (
            <div className="tooltip-grafico">
              <div className="t">Até {data(payload[0].payload.dia)}</div>
              <div>Recebidas: <strong>{numero(payload[0].payload.recebidas)}</strong></div>
              <div>Lançadas: <strong>{numero(payload[0].payload.lancadas)}</strong></div>
              <div>Saldo: <strong style={{ color: payload[0].payload.saldo > 0 ? 'var(--erro)' : 'var(--ok)' }}>{payload[0].payload.saldo > 0 ? '+' : ''}{numero(payload[0].payload.saldo)}</strong></div>
            </div>
          ) : null)} />
          <Bar yAxisId="saldo" isAnimationActive={false} dataKey="saldo" name="Saldo" maxBarSize={16} radius={[2, 2, 0, 0]}>
            {pontos.map((p) => <Cell key={p.dia} fill={p.saldo > 0 ? 'var(--status-critico)' : 'var(--status-bom)'} fillOpacity={0.45} />)}
            <LabelList dataKey="saldo" position="top" style={{ ...ROTULO, fontSize: 9, fill: 'var(--status-critico)' }} formatter={(v) => (v ? numero(v) : '')} />
          </Bar>
          <Line yAxisId="total" isAnimationActive={false} type="monotone" dataKey="recebidas" name="Recebidas" stroke="var(--serie-1)" strokeWidth={2.5} dot={false}>
            <LabelList dataKey="recebidas" position="top" style={{ ...ROTULO, fontSize: 9, fill: 'var(--serie-1)' }} formatter={(v) => v} content={(p) => (p.index === pontos.length - 1 ? <text x={p.x} y={p.y - 6} textAnchor="end" style={{ ...ROTULO, fill: 'var(--serie-1)' }}>{numero(p.value)}</text> : null)} />
          </Line>
          <Line yAxisId="total" isAnimationActive={false} type="monotone" dataKey="lancadas" name="Lançadas" stroke="var(--status-bom)" strokeWidth={2.5} dot={false}>
            <LabelList dataKey="lancadas" content={(p) => (p.index === pontos.length - 1 ? <text x={p.x} y={p.y + 14} textAnchor="end" style={{ ...ROTULO, fill: 'var(--ok)' }}>{numero(p.value)}</text> : null)} />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
      {primeiroSaldo !== ultimo.saldo && (
        <div className="muted pequeno">O saldo mostra só o movimento destes 21 dias; o total em aberto de antes está no cartão “Pendentes de lançamento”.</div>
      )}
    </>
  );
}
