import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Cartao, Carregando, data, Erro, Kpi, numero, Severidade, useDados } from '../ui.jsx';

// Gráfico de status usa a paleta de status (sempre com legenda + rótulo); rankings usam a série 1.
const SERIES_STATUS = [
  { chave: 'aprovadas', rotulo: 'Aprovadas', cor: 'var(--status-bom)' },
  { chave: 'pendentes', rotulo: 'Pendentes', cor: 'var(--status-atencao)' },
  { chave: 'inconsistentes', rotulo: 'Com inconsistência', cor: 'var(--status-critico)' },
  { chave: 'outras', rotulo: 'Duplicadas/rejeitadas', cor: 'var(--status-neutro)' },
];
const eixo = { fontSize: 11, fill: 'var(--texto-3)' };

function DicaGrafico({ active, payload, label, formatar = (v) => v, titulo }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip-grafico">
      <div className="t">{titulo ? titulo(label, payload) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color ?? p.fill, marginRight: 6 }} />{p.name}: <strong>{formatar(p.value)}</strong></div>
      ))}
    </div>
  );
}

function Ranking({ dados, campo, rotulo, valor, onClique, altura = 260 }) {
  if (!dados?.length) return <div className="vazio">Sem ocorrências no período.</div>;
  const d = dados.map((x) => ({ ...x, _rotulo: String(x[rotulo]).length > 34 ? `${String(x[rotulo]).slice(0, 33)}…` : x[rotulo] }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, Math.min(altura, d.length * 30 + 30))}>
      <BarChart data={d} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke="var(--grade)" />
        <XAxis type="number" tick={eixo} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="_rotulo" width={210} tick={{ ...eixo, fill: 'var(--texto-2)' }} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} />
        <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={<DicaGrafico titulo={(l, p) => p[0]?.payload?.[rotulo]} />} />
        <Bar isAnimationActive={false} dataKey={campo} name={valor} fill="var(--serie-1)" radius={[0, 4, 4, 0]} maxBarSize={18} onClick={onClique ? (e) => onClique(e.payload ?? e) : undefined} style={{ cursor: onClique ? 'pointer' : 'default' }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Dashboard() {
  const navegar = useNavigate();
  const [empresa, setEmpresa] = useState('');
  const refs = useDados(() => api.get('/referencias'), []);
  const { dados: d, erro, carregando } = useDados(() => api.get(`/dashboard${qs({ empresa_id: empresa })}`), [empresa]);
  const { pode } = useAuth();
  const fin = useDados(() => (pode('financeiro') ? api.get(`/financeiro${qs({ empresa_id: empresa })}`) : Promise.resolve(null)), [empresa]);
  const ir = (filtro) => navegar(`/documentos${qs({ ...filtro, empresa_id: empresa })}`);

  return (
    <>
      <Topo titulo="Painel executivo" descricao="O que chegou, o que foi identificado, o que está correto e o que precisa da sua ação.">
        <select value={empresa} onChange={(e) => setEmpresa(e.target.value)} aria-label="Empresa">
          <option value="">Todas as empresas</option>
          {refs.dados?.empresas.filter((e) => e.qtd_docs).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social}</option>)}
        </select>
      </Topo>
      <div className="pagina">
        <Erro erro={erro} />
        {carregando && !d ? <Carregando /> : d && (
          <>
            <div className="hero">
              <div className="hero-principal">
                <div className="eyebrow">Hoje · {data(d.hoje)}</div>
                <div className="numeros">
                  <div><div className="n">{d.indicadores.recebidas_hoje ?? 0}</div><div className="l">NFs recebidas hoje</div></div>
                  <div><div className="n">{d.indicadores.aguardando_validacao ?? 0}</div><div className="l">Aguardando validação</div></div>
                  <div><div className="n">{d.indicadores.aprovadas ?? 0}</div><div className="l">Aprovadas (total)</div></div>
                  <div><div className="n">{d.indicadores.inconsistentes ?? 0}</div><div className="l">Com inconsistências</div></div>
                </div>
                <div className="l" style={{ color: '#cfdbee', fontSize: 12.5 }}>
                  {numero(d.indicadores.aguardando_acao)} documentos aguardando ação · {brl(d.indicadores.valor_pendente)} em valor
                </div>
              </div>
              <Cartao titulo="Pendências prioritárias" sub="clique para abrir a lista" semPadding>
                {d.pendencias.length ? d.pendencias.map((p, i) => (
                  <button key={i} className="pendencia" onClick={() => ir(p.filtro)}>
                    <span className="qtd">{p.quantidade}</span>
                    <span style={{ flex: 1 }}>{p.titulo}</span>
                    <Severidade s={p.severidade} />
                  </button>
                )) : <div className="vazio">Nenhuma pendência. Tudo em dia. ✓</div>}
              </Cartao>
            </div>

            <div className="grade grade-kpi">
              <Kpi rotulo="NFs recebidas" valor={numero(d.indicadores.recebidas)} detalhe={`${numero(d.indicadores.recebidas_mes)} no mês`} cor="var(--serie-1)" onClick={() => ir({})} />
              <Kpi rotulo="NFs processadas" valor={numero(d.indicadores.processadas)} detalhe={`${numero(d.indicadores.processadas_hoje)} hoje · ${numero(d.indicadores.processadas_mes)} no mês`} cor="var(--serie-1)" />
              <Kpi rotulo="Aguardando validação" valor={numero(d.indicadores.aguardando_validacao)} cor="var(--pend)" onClick={() => ir({ status: 'PENDENTE' })} />
              <Kpi rotulo="Aprovadas" valor={numero(d.indicadores.aprovadas)} detalhe={`${numero(d.indicadores.aprovadas_hoje)} hoje`} cor="var(--ok)" onClick={() => ir({ status: 'APROVADA' })} />
              <Kpi rotulo="Com inconsistência" valor={numero(d.indicadores.inconsistentes)} cor="var(--erro)" onClick={() => ir({ status: 'INCONSISTENTE' })} />
              <Kpi rotulo="Rejeitadas" valor={numero(d.indicadores.rejeitadas)} cor="var(--rej)" onClick={() => ir({ status: 'REJEITADA' })} />
              <Kpi rotulo="Duplicadas" valor={numero(d.indicadores.duplicadas)} detalhe={`${numero(d.indicadores.recebimentos_duplicados)} recebimento(s) repetido(s)`} cor="var(--dup)" onClick={() => ir({ duplicadas: '1' })} />
              <Kpi rotulo="Sem XML" valor={numero(d.indicadores.sem_xml)} cor="var(--xml)" onClick={() => ir({ sem_xml: '1' })} />
              <Kpi rotulo="Aguardando ação" valor={numero(d.indicadores.aguardando_acao)} detalhe={`${numero(d.indicadores.atrasadas)} com prazo vencido`} cor="var(--pend)" onClick={() => navegar('/fila?visao=todas')} />
              {(d.indicadores.nao_lancadas_senior > 0 || d.indicadores.lancadas_senior > 0) && (
                <Kpi rotulo="Não lançadas no Senior" valor={numero(d.indicadores.nao_lancadas_senior)} detalhe={`${numero(d.indicadores.lancadas_senior)} já lançadas`} cor="var(--pend)" onClick={() => navegar('/fila?visao=a_lancar')} />
              )}
              <Kpi rotulo="Correção solicitada" valor={numero(d.indicadores.correcao_solicitada)} cor="var(--corr)" onClick={() => ir({ status: 'CORRECAO_SOLICITADA' })} />
            </div>

            {fin.dados && (
              <Cartao titulo="Financeiro · contas a pagar" sub="duplicatas das NFs recebidas" acoes={<button className="btn pequeno" onClick={() => navegar('/financeiro')}>Abrir painel financeiro</button>}>
                <div className="grade grade-kpi monetario">
                  <Kpi rotulo="Vencidas em aberto" valor={brl(fin.dados.indicadores.vencidas_valor)} detalhe={`${numero(fin.dados.indicadores.vencidas_qtd)} título(s)`} cor="var(--erro)" onClick={() => navegar('/financeiro?situacao=vencidas')} />
                  <Kpi rotulo="Vencem hoje" valor={brl(fin.dados.indicadores.hoje_valor)} detalhe={`${numero(fin.dados.indicadores.hoje_qtd)} título(s)`} cor="var(--erro)" onClick={() => navegar('/financeiro?situacao=hoje')} />
                  <Kpi rotulo="Próximos 7 dias" valor={brl(fin.dados.indicadores.prox7_valor)} detalhe={`${numero(fin.dados.indicadores.prox7_qtd)} título(s)`} cor="var(--pend)" onClick={() => navegar('/financeiro?situacao=7d')} />
                  <Kpi rotulo="Vencendo sem aprovação fiscal" valor={brl(fin.dados.indicadores.risco_valor)} detalhe={`${numero(fin.dados.indicadores.risco_qtd)} título(s) em até 7 dias`} cor="var(--erro)" onClick={() => navegar('/financeiro?situacao=risco')} titulo="Títulos vencidos ou vencendo em 7 dias cuja NF ainda não foi aprovada" />
                  <Kpi rotulo="Total em aberto" valor={brl(fin.dados.indicadores.aberto_valor)} detalhe={`${numero(fin.dados.indicadores.aberto_qtd)} título(s)`} onClick={() => navegar('/financeiro')} />
                </div>
              </Cartao>
            )}

            <Cartao titulo="NFs por dia" sub="recebimento · últimos 30 dias">
              <div className="grafico-legenda">
                {SERIES_STATUS.map((s) => <span key={s.chave}><i style={{ background: s.cor }} />{s.rotulo}</span>)}
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={d.graficos.porDia} margin={{ left: -18, right: 8, top: 6 }} barCategoryGap="22%">
                  <CartesianGrid vertical={false} stroke="var(--grade)" />
                  <XAxis dataKey="dia" tickFormatter={(v) => v.slice(8, 10) + '/' + v.slice(5, 7)} tick={eixo} axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} minTickGap={12} />
                  <YAxis tick={eixo} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={<DicaGrafico titulo={(l) => data(l)} />} />
                  {SERIES_STATUS.map((s, i) => (
                    <Bar isAnimationActive={false} key={s.chave} dataKey={s.chave} name={s.rotulo} stackId="a" fill={s.cor} stroke="var(--superficie)" strokeWidth={1}
                      radius={i === SERIES_STATUS.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={22} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </Cartao>

            <div className="grade grade-2">
              <Cartao titulo="Inconsistências por tipo" sub="alertas abertos · NFs afetadas">
                <Ranking dados={d.graficos.porTipoInconsistencia} campo="documentos" rotulo="nome" valor="NFs afetadas" onClique={(x) => ir({ regra: x.regra_codigo })} />
              </Cartao>
              <Cartao titulo="Fornecedores com mais ocorrências" sub="NFs com erro ou alerta">
                <Ranking dados={d.graficos.fornecedoresOcorrencias} campo="documentos" rotulo="fornecedor" valor="NFs com ocorrência" onClique={(x) => navegar(`/fornecedores/${x.id}`)} />
              </Cartao>
            </div>

            <div className="grade grade-2">
              <Cartao titulo="NFs por empresa">
                <Ranking dados={d.graficos.porEmpresa} campo="total" rotulo="empresa" valor="NFs" />
              </Cartao>
              <Cartao titulo="Caixas de entrada" acoes={<button className="btn pequeno" onClick={() => navegar('/caixas')}>Abrir</button>}>
                <div className="grade grade-kpi" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 14 }}>
                  <Kpi rotulo="E-mails recebidos" valor={numero(d.emails.recebidos)} />
                  <Kpi rotulo="Sem NF" valor={numero(d.emails.sem_nf)} />
                  <Kpi rotulo="Com erro" valor={numero(d.emails.com_erro)} cor={d.emails.com_erro ? 'var(--erro)' : undefined} />
                </div>
                {d.caixas.map((c) => (
                  <div key={c.id} className="linha" style={{ padding: '6px 0', borderTop: '1px solid var(--borda)' }}>
                    <strong style={{ flex: 1 }}>{c.email}</strong>
                    <span className="tag">{c.provedor}</span>
                    <span className={`badge ${c.status === 'conectada' ? 'sev-ok' : c.status === 'erro' ? 'sev-erro' : 'sev-na'}`}>{c.status}</span>
                    <span className="muted pequeno">{c.ultima_sincronizacao ? `sinc. ${data(c.ultima_sincronizacao, true)}` : 'nunca sincronizada'}</span>
                  </div>
                ))}
              </Cartao>
            </div>
          </>
        )}
      </div>
    </>
  );
}
