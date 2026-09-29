import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Campo, Cartao, Carregando, data, Erro, Kpi, Modal, numero, PagamentoSenior, SeniorBadge, Status, Tabela, useDados, useToast, NotaArquivo, OrdemCompra, BotaoExportar, textoOrdemCompra, cnpj } from '../ui.jsx';

const eixo = { fontSize: 11, fill: 'var(--texto-3)' };
const brlCurto = (v) => (Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil` : brl(v));
const PAGAMENTO = {
  aberta: { rotulo: 'Em aberto', cls: 'sev-alerta' }, programada: { rotulo: 'Programada', cls: 'st-AGUARDANDO_XML' },
  paga: { rotulo: 'Paga', cls: 'sev-ok' }, cancelada: { rotulo: 'Cancelada', cls: 'sev-na' },
};
const SITUACOES = [
  ['', 'Em aberto'], ['vencidas', 'Vencidas'], ['hoje', 'Vencem hoje'], ['7d', 'Próximos 7 dias'], ['30d', '8 a 30 dias'],
  ['divergencias', 'Divergências'], ['risco', 'Não lançadas'], ['programadas', 'Programadas'], ['pagas', 'Pagas'], ['bloqueados', 'Bloqueados'],
];

const PAGAMENTO_SENIOR = { pago: 'Pago', em_pagamento: 'Em pagamento', aberto: 'A pagar' };
const COLUNAS_EXPORT = [
  { titulo: 'Vencimento', tipo: 'data', valor: (l) => l.vencimento },
  { titulo: 'Dias para vencer', tipo: 'numero', valor: (l) => l.dias },
  { titulo: 'Fornecedor', valor: (l) => l.emitente_nome },
  { titulo: 'CNPJ fornecedor', valor: (l) => cnpj(l.emitente_cnpj) },
  { titulo: 'NF', valor: (l) => l.numero },
  { titulo: 'Parcela', valor: (l) => `${l.numero_dup ?? ''} de ${l.parcelas ?? ''}` },
  { titulo: 'Empresa', valor: (l) => l.empresa },
  { titulo: 'Valor', tipo: 'moeda', valor: (l) => l.valor },
  { titulo: 'Senior', valor: (l) => ({ lancada: 'Lançada', nao_lancada: 'Não lançada' }[l.senior_status] ?? '') },
  { titulo: 'Pagamento (Senior)', valor: (l) => PAGAMENTO_SENIOR[l.senior_pagamento] ?? '' },
  { titulo: 'Vencimento (Senior)', tipo: 'data', valor: (l) => l.senior_vencimento },
  { titulo: 'Pago em (Senior)', tipo: 'data', valor: (l) => l.senior_data_pagamento },
  { titulo: 'Situação do pagamento', valor: (l) => PAGAMENTO[l.status_pagamento]?.rotulo ?? l.status_pagamento },
  { titulo: 'Data do pagamento', tipo: 'data', valor: (l) => l.data_pagamento },
  { titulo: 'OC', valor: (l) => textoOrdemCompra(l) },
  { titulo: 'Divergência', valor: (l) => l.divergencia },
];

function Dica({ active, payload, label, titulo }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip-grafico">
      <div className="t">{titulo ? titulo(label, payload) : label}</div>
      {payload.map((p) => <div key={p.dataKey}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color ?? p.fill, marginRight: 6 }} />{p.name}: <strong>{brl(p.value)}</strong></div>)}
    </div>
  );
}

function Dias({ d, status }) {
  if (status === 'paga' || status === 'cancelada') return null;
  if (d < 0) return <span className="badge sev-erro">vencida há {-d} dia{d === -1 ? '' : 's'}</span>;
  if (d === 0) return <span className="badge sev-erro">vence hoje</span>;
  if (d <= 7) return <span className="badge sev-alerta">em {d} dia{d === 1 ? '' : 's'}</span>;
  return <span className="muted pequeno">em {d} dias</span>;
}

export function ModalPagamento({ titulo, onFechar, onFeito }) {
  const avisar = useToast();
  const [f, setF] = useState({ status_pagamento: titulo.status_pagamento === 'aberta' ? 'programada' : titulo.status_pagamento, data_pagamento: new Date().toLocaleDateString('sv-SE'), observacao: titulo.observacao ?? '' });
  const naoAprovada = titulo.status_fiscal !== 'APROVADA';
  const salvar = async () => {
    try { await api.post(`/duplicatas/${titulo.id}/pagamento`, f); avisar('Situação do título atualizada.'); onFeito(); } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={`Duplicata ${titulo.numero ?? ''} · NF ${titulo.nf ?? titulo.numero_nf ?? ''}`} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      <div className="definicoes">
        <div><span>Vencimento</span><strong>{data(titulo.vencimento)}</strong></div>
        <div><span>Valor</span><strong>{brl(titulo.valor)}</strong></div>
        <div><span>Situação fiscal da NF</span><Status s={titulo.status_fiscal} /></div>
      </div>
      {naoAprovada && ['paga', 'programada'].includes(f.status_pagamento) && (
        <div className="aviso atencao">A NF ainda <strong>não foi aprovada pela Escrita Fiscal</strong>. Programar ou pagar exige justificativa, que ficará registrada no histórico do documento.</div>
      )}
      <Campo rotulo="Situação do pagamento">
        <select value={f.status_pagamento} onChange={(e) => setF({ ...f, status_pagamento: e.target.value })}>
          {Object.entries(PAGAMENTO).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </select>
      </Campo>
      {f.status_pagamento === 'paga' && <Campo rotulo="Data do pagamento"><input type="date" value={f.data_pagamento} onChange={(e) => setF({ ...f, data_pagamento: e.target.value })} /></Campo>}
      <Campo rotulo={`Observação${naoAprovada && ['paga', 'programada'].includes(f.status_pagamento) ? ' (obrigatória)' : ''}`}><textarea value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></Campo>
    </Modal>
  );
}

export default function Financeiro() {
  const navegar = useNavigate();
  const { pode } = useAuth();
  const [params, setParams] = useSearchParams();
  const situacao = params.get('situacao') ?? '';
  const empresa = params.get('empresa_id') ?? '';
  const [fornecedor, setFornecedor] = useState('');
  const [buscaForn, setBuscaForn] = useState('');
  const [editar, setEditar] = useState(null);
  const [limite, setLimite] = useState(50);
  const refs = useDados(() => api.get('/referencias'), []);
  const painel = useDados(() => api.get(`/financeiro${qs({ empresa_id: empresa })}`), [empresa]);
  const titulos = useDados(() => api.get(`/financeiro/titulos${qs({ situacao, empresa_id: empresa, fornecedor: buscaForn })}`), [situacao, empresa, buscaForn]);
  const k = painel.dados?.indicadores;
  const ir = (s) => setParams(Object.fromEntries(Object.entries({ situacao: s, empresa_id: empresa }).filter(([, v]) => v)));
  const recarregar = () => { painel.recarregar(); titulos.recarregar(); };

  return (
    <>
      <Topo titulo="Financeiro · Contas a pagar" descricao="Boletos e parcelas das notas recebidas, conferidos com os títulos a pagar do Senior.">
        <select value={empresa} onChange={(e) => setParams(Object.fromEntries(Object.entries({ situacao, empresa_id: e.target.value }).filter(([, v]) => v)))} aria-label="Empresa">
          <option value="">Todas as empresas</option>
          {refs.dados?.empresas.filter((e) => e.qtd_docs).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social}</option>)}
        </select>
      </Topo>
      <div className="pagina">
        <Erro erro={painel.erro} />
        {!k ? <Carregando /> : (
          <>
            {k.risco_qtd > 0 && (
              <button className="aviso erro" style={{ border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => ir('risco')}>
                <strong style={{ fontSize: 15 }}>⚠</strong>
                <div><strong>{numero(k.risco_qtd)} boleto(s) · {brl(k.risco_valor)}</strong> vencem em até 7 dias (ou já venceram) e a nota <strong>ainda não foi lançada no Senior</strong>. Clique para ver e priorizar o lançamento antes do vencimento.</div>
              </button>
            )}
            {k.divergencias_qtd > 0 && (
              <button className="aviso atencao" style={{ border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => ir('divergencias')}>
                <strong style={{ fontSize: 15 }}>≠</strong>
                <div><strong>{numero(k.divergencias_qtd)} nota(s)</strong> com divergência entre boleto, nota e título no Senior (valor, vencimento ou pagamento). Clique para conferir antes de pagar.</div>
              </button>
            )}
            {/* Só o que muda decisão de pagamento; o resto fica nas abas da lista abaixo */}
            <div className="grade grade-kpi monetario">
              <Kpi rotulo="Vencidas" valor={brl(k.vencidas_valor)} detalhe={`${numero(k.vencidas_qtd)} título(s) em aberto`} cor="var(--erro)" onClick={() => ir('vencidas')} />
              <Kpi rotulo="Vencem hoje" valor={brl(k.hoje_valor)} detalhe={`${numero(k.hoje_qtd)} título(s)`} cor="var(--erro)" onClick={() => ir('hoje')} />
              <Kpi rotulo="Próximos 7 dias" valor={brl(k.prox7_valor)} detalhe={`${numero(k.prox7_qtd)} título(s)`} cor="var(--pend)" onClick={() => ir('7d')} />
              <Kpi rotulo="8 a 30 dias" valor={brl(k.prox30_valor)} detalhe={`${numero(k.prox30_qtd)} título(s)`} cor="var(--serie-1)" onClick={() => ir('30d')} />
              <Kpi rotulo="Total em aberto" valor={brl(k.aberto_valor)} detalhe={`${numero(k.aberto_qtd)} título(s)`} onClick={() => ir('')} />
              <Kpi rotulo="Divergências" valor={numero(k.divergencias_qtd)} detalhe="boleto × nota × Senior" cor="var(--pend)" onClick={() => ir('divergencias')} />
              {k.bloqueados_qtd > 0 && <Kpi rotulo="Bloqueados (não pagar)" valor={brl(k.bloqueados_valor)} detalhe={`${numero(k.bloqueados_qtd)} de NF rejeitada/duplicada/cancelada`} cor="var(--dup)" onClick={() => ir('bloqueados')} titulo="Títulos em aberto de NFs rejeitadas, duplicadas, não fiscais ou canceladas" />}
            </div>

            <div className="grade" style={{ gridTemplateColumns: '2fr 1fr' }}>
              <Cartao titulo="Fluxo de pagamentos" sub="próximos 30 dias · por situação fiscal da NF">
                <div className="grafico-legenda">
                  <span><i style={{ background: 'var(--status-bom)' }} />NF aprovada</span>
                  <span><i style={{ background: 'var(--status-atencao)' }} />NF aguardando validação fiscal</span>
                </div>
                {painel.dados.fluxo.length ? (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={painel.dados.fluxo} margin={{ left: 4, right: 8, top: 6 }} barCategoryGap="22%">
                      <CartesianGrid vertical={false} stroke="var(--grade)" />
                      <XAxis dataKey="dia" tickFormatter={(v) => `${v.slice(8, 10)}/${v.slice(5, 7)}`} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={10} />
                      <YAxis tick={eixo} axisLine={false} tickLine={false} tickFormatter={brlCurto} width={78} />
                      <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={<Dica titulo={(l) => `Vencimento ${data(l)}`} />} />
                      <Bar isAnimationActive={false} dataKey="aprovadas" name="NF aprovada" stackId="a" fill="var(--status-bom)" stroke="var(--superficie)" strokeWidth={1} maxBarSize={22} />
                      <Bar isAnimationActive={false} dataKey="pendentes_fiscal" name="NF aguardando validação" stackId="a" fill="var(--status-atencao)" stroke="var(--superficie)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="vazio">Nenhum vencimento nos próximos 30 dias.</div>}
              </Cartao>
              <Cartao titulo="Vencidos por faixa de atraso" sub="títulos em aberto">
                {painel.dados.aging.length ? painel.dados.aging.map((a) => {
                  const max = Math.max(...painel.dados.aging.map((x) => x.valor));
                  return (
                    <div key={a.faixa} style={{ marginBottom: 12 }}>
                      <div className="linha entre pequeno"><span>{a.faixa}</span><strong>{brl(a.valor)} <span className="muted">· {a.qtd}</span></strong></div>
                      <div className="barra-progresso"><div style={{ width: `${(a.valor / max) * 100}%`, background: 'var(--status-critico)' }} /></div>
                    </div>
                  );
                }) : <div className="aviso ok">✓ Nenhum título vencido em aberto.</div>}
              </Cartao>
            </div>

            <div className="grade grade-2">
              <Cartao titulo="Maiores fornecedores a pagar" sub="em aberto" semPadding>
                <Tabela linhas={painel.dados.fornecedores} onClique={(l) => { setFornecedor(l.fornecedor); setBuscaForn(l.fornecedor); }} vazio="Nada a pagar." colunas={[
                  { campo: 'fornecedor', titulo: 'Fornecedor', render: (l) => <strong>{l.fornecedor}</strong> },
                  { campo: 'qtd', titulo: 'Títulos', classe: 'num' },
                  { campo: 'vencido', titulo: 'Vencido', classe: 'num', render: (l) => (l.vencido ? <span style={{ color: 'var(--erro)', fontWeight: 600 }}>{brl(l.vencido)}</span> : '—') },
                  { campo: 'valor', titulo: 'Total', classe: 'num', render: (l) => brl(l.valor) },
                ]} />
              </Cartao>
              <Cartao titulo="A pagar por empresa" semPadding>
                <Tabela chave="empresa" linhas={painel.dados.porEmpresa} vazio="Nada a pagar." colunas={[
                  { campo: 'empresa', titulo: 'Empresa', render: (l) => <strong>{l.empresa}</strong> },
                  { campo: 'vencido', titulo: 'Vencido', classe: 'num', render: (l) => (l.vencido ? <span style={{ color: 'var(--erro)', fontWeight: 600 }}>{brl(l.vencido)}</span> : '—') },
                  { campo: 'valor', titulo: 'Total em aberto', classe: 'num', render: (l) => brl(l.valor) },
                ]} />
              </Cartao>
            </div>
          </>
        )}

        <Cartao semPadding>
          <div className="abas">
            {SITUACOES.map(([s, r]) => <button key={s} className={situacao === s ? 'ativa' : ''} onClick={() => ir(s)}>{r}</button>)}
          </div>
          <form className="linha" style={{ padding: 12, borderBottom: '1px solid var(--borda)' }} onSubmit={(e) => { e.preventDefault(); setBuscaForn(fornecedor); }}>
            <input value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} placeholder="Fornecedor ou CNPJ" style={{ flex: 1, maxWidth: 360 }} />
            <button className="btn">Filtrar</button>
            {buscaForn && <button type="button" className="btn ghost" onClick={() => { setFornecedor(''); setBuscaForn(''); }}>Limpar</button>}
            <span className="espaco" />
            {titulos.dados && <span className="sec">{titulos.dados.itens.length} título(s) · <strong>{brl(titulos.dados.total_valor)}</strong></span>}
            {titulos.dados && <BotaoExportar titulo={`A pagar - ${SITUACOES.find(([s]) => s === situacao)?.[1] ?? 'Em aberto'}`} linhas={titulos.dados.itens} colunas={COLUNAS_EXPORT} />}
          </form>
          <Erro erro={titulos.erro} />
          {titulos.carregando && !titulos.dados ? <Carregando /> : (
            <Tabela linhas={titulos.dados?.itens.slice(0, limite)} onClique={(l) => navegar(`/documentos/${l.documento_id}`)} vazio="Nenhum título nesta visão." colunas={[
              { campo: 'vencimento', titulo: 'Vencimento', render: (l) => <div><strong>{data(l.vencimento)}</strong><div><Dias d={l.dias} status={l.status_pagamento} /></div></div> },
              { campo: 'fornecedor', titulo: 'Fornecedor', render: (l) => l.emitente_nome ?? '—' },
              { campo: 'nf', titulo: 'NF / parcela', render: (l) => <span><strong>{l.numero}</strong><span className="muted"> · dup. {l.numero_dup} de {l.parcelas}</span></span> },
              { campo: 'empresa', titulo: 'Empresa', render: (l) => <span className="pequeno">{l.empresa ?? '—'}</span> },
              { campo: 'valor', titulo: 'Valor', classe: 'num', render: (l) => <strong>{brl(l.valor)}</strong> },
              { campo: 'nota_arquivo', titulo: 'Nota', render: (l) => <NotaArquivo l={l} /> },
              { campo: 'boleto', titulo: 'Boleto', render: (l) => (l.boleto_anexo_id ? <NotaArquivo l={{ pdf_anexo_id: l.boleto_anexo_id }} /> : <span className="muted pequeno" title="Vencimento lido da própria nota">da nota</span>) },
              { campo: 'oc', titulo: 'OC', classe: 'nowrap', render: (l) => <OrdemCompra l={l} /> },
              { campo: 'senior', titulo: 'Senior', render: (l) => (
                <div>
                  <span className="linha" style={{ gap: 4, flexWrap: 'wrap' }}><SeniorBadge s={l.senior_status} titulo={l.senior_ref} /><PagamentoSenior l={l} />{l.situacao_sefaz === 'cancelada' && <span className="badge sev-erro">NF cancelada</span>}</span>
                  {l.divergencia && <div className="pequeno" style={{ color: 'var(--pend)', marginTop: 2, maxWidth: 320 }}>≠ {l.divergencia}</div>}
                </div>
              ) },
              { campo: 'status_pagamento', titulo: 'Pagamento', render: (l) => <div><span className={`badge ${PAGAMENTO[l.status_pagamento]?.cls}`}>{PAGAMENTO[l.status_pagamento]?.rotulo}</span>{l.data_pagamento && <div className="muted pequeno">{data(l.data_pagamento)}</div>}</div> },
              { campo: 'acoes', titulo: '', render: (l) => (pode('pagamentos') ? <button className="btn pequeno" onClick={(e) => { e.stopPropagation(); setEditar({ ...l, nf: l.numero, numero: l.numero_dup ?? l.numero }); }}>Atualizar</button> : null) },
            ]} />
          )}
          {titulos.dados?.itens.length > limite && <div className="paginacao"><span>Exibindo {limite} de {titulos.dados.itens.length}</span><button className="btn pequeno" onClick={() => setLimite((l) => l + 100)}>Mostrar mais</button></div>}
        </Cartao>
      </div>
      {editar && <ModalPagamento titulo={editar} onFechar={() => setEditar(null)} onFeito={() => { setEditar(null); recarregar(); }} />}
    </>
  );
}
