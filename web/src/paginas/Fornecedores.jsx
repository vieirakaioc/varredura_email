import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Campo, Cartao, Carregando, cnpj, data, Erro, Kpi, numero, Status, Tabela, useDados, useToast } from '../ui.jsx';

function Detalhe({ id }) {
  const navegar = useNavigate();
  const avisar = useToast();
  const { pode } = useAuth();
  const refs = useDados(() => api.get('/referencias'), []);
  const { dados, erro, recarregar } = useDados(() => api.get(`/fornecedores/${id}`), [id]);
  const [form, setForm] = useState(null);
  if (erro) return <Erro erro={erro} />;
  if (!dados) return <Carregando />;
  const f = dados.fornecedor;
  const p = dados.perfil;
  const edit = form ?? { tipo_fornecedor: f.tipo_fornecedor ?? '', regime_tributario: f.regime_tributario ?? '', nome_fantasia: f.nome_fantasia ?? '', observacoes: f.observacoes ?? '' };
  const salvar = async () => {
    try { await api.put(`/fornecedores/${id}`, edit); avisar('Fornecedor atualizado. Documentos em aberto foram revalidados.'); setForm(null); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <div className="coluna">
      <div className="linha"><button className="btn ghost" onClick={() => navegar('/fornecedores')}>← Todos os fornecedores</button></div>
      <Cartao titulo={f.razao_social} sub={`${cnpj(f.cnpj)} · ${f.municipio ?? ''}/${f.uf ?? ''}`}>
        <div className="form-grade">
          <Campo rotulo="Nome fantasia"><input value={edit.nome_fantasia} onChange={(e) => setForm({ ...edit, nome_fantasia: e.target.value })} disabled={!pode('cadastros')} /></Campo>
          <Campo rotulo="Tipo de fornecedor (destinação da mercadoria)">
            <select value={edit.tipo_fornecedor} onChange={(e) => setForm({ ...edit, tipo_fornecedor: e.target.value })} disabled={!pode('cadastros')}>
              <option value="">Não classificado</option>
              {Object.entries(refs.dados?.tipos_fornecedor ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Regime tributário"><input value={edit.regime_tributario} onChange={(e) => setForm({ ...edit, regime_tributario: e.target.value })} disabled={!pode('cadastros')} /></Campo>
          <Campo rotulo="IE"><input value={f.ie ?? ''} disabled /></Campo>
          <Campo rotulo="Observações" style={{ gridColumn: '1 / -1' }}><textarea value={edit.observacoes} onChange={(e) => setForm({ ...edit, observacoes: e.target.value })} disabled={!pode('cadastros')} /></Campo>
        </div>
        {pode('cadastros') && form && <div className="linha fim" style={{ marginTop: 10 }}><button className="btn" onClick={() => setForm(null)}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></div>}
        <p className="muted pequeno">O tipo do fornecedor orienta a sugestão de CFOP de entrada (revenda, insumo, uso e consumo, ativo) e as regras de DIFAL/CIAP.</p>
      </Cartao>
      <div className="grade grade-kpi">
        <Kpi rotulo="NFs recebidas" valor={numero(dados.documentos.length)} />
        <Kpi rotulo="Valor médio" valor={brl(p?.valor_medio)} />
        <Kpi rotulo="Maior valor" valor={brl(p?.valor_max)} />
        <Kpi rotulo="NFs com erro" valor={numero(dados.documentos.filter((x) => x.qtd_erros > 0).length)} cor="var(--erro)" />
      </div>
      <div className="grade grade-3">
        <Cartao titulo="CFOPs normalmente utilizados">
          {p?.cfops.length ? p.cfops.map((c) => (
            <div key={c.cfop} className="linha" style={{ marginBottom: 6 }}>
              <span className="mono" style={{ width: 44 }} title={refs.dados?.cfops[c.cfop]}>{c.cfop}</span>
              <div className="barra-progresso" style={{ flex: 1 }}><div style={{ width: `${c.pct}%` }} /></div>
              <span className="num pequeno" style={{ width: 90 }}>{c.docs} NF · {c.pct}%</span>
            </div>
          )) : <div className="muted">Sem histórico.</div>}
        </Cartao>
        <Cartao titulo="Produtos normalmente fornecidos">
          {p?.ncms.slice(0, 10).map((n) => <div key={n.ncm} className="pequeno" style={{ marginBottom: 4 }}><span className="mono">{n.ncm}</span> · {n.exemplo} <span className="muted">({n.itens} itens · {brl(n.preco_medio)} médio)</span></div>)}
        </Cartao>
        <Cartao titulo="Histórico de inconsistências">
          {dados.ocorrencias.length ? dados.ocorrencias.map((o) => <div key={o.regra_codigo} className="linha pequeno" style={{ marginBottom: 4 }}><strong style={{ width: 28 }}>{o.qtd}</strong><span style={{ flex: 1 }}>{o.regra_violada}</span></div>) : <div className="muted">Nenhuma ocorrência.</div>}
        </Cartao>
      </div>
      <Cartao titulo="Histórico de NFs" semPadding>
        <Tabela linhas={dados.documentos} onClique={(l) => navegar(`/documentos/${l.id}`)} colunas={[
          { campo: 'numero', titulo: 'NF', render: (l) => <strong>{l.numero}</strong> },
          { campo: 'tipo', titulo: 'Tipo' },
          { campo: 'data_emissao', titulo: 'Emissão', render: (l) => data(l.data_emissao) },
          { campo: 'recebido_em', titulo: 'Recebido', render: (l) => data(l.recebido_em, true) },
          { campo: 'v_total', titulo: 'Valor', classe: 'num', render: (l) => brl(l.v_total) },
          { campo: 'qtd_erros', titulo: 'Erros', classe: 'num', render: (l) => (l.qtd_erros ? <span className="badge sev-erro">{l.qtd_erros}</span> : '—') },
          { campo: 'status', titulo: 'Status', render: (l) => <Status s={l.status} /> },
        ]} />
      </Cartao>
    </div>
  );
}

export default function Fornecedores() {
  const { id } = useParams();
  const navegar = useNavigate();
  const [busca, setBusca] = useState('');
  const [q, setQ] = useState('');
  const refs = useDados(() => api.get('/referencias'), []);
  const { dados, erro, carregando } = useDados(() => (id ? Promise.resolve(null) : api.get(`/fornecedores${qs({ q })}`)), [q, id]);
  return (
    <>
      <Topo titulo="Fornecedores" descricao="Cadastro criado automaticamente a partir das NFs, com perfil de comportamento fiscal." />
      <div className="pagina">
        {id ? <Detalhe id={id} /> : (
          <Cartao semPadding>
            <form className="linha" style={{ padding: 14, borderBottom: '1px solid var(--borda)' }} onSubmit={(e) => { e.preventDefault(); setQ(busca); }}>
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por razão social, fantasia ou CNPJ" style={{ flex: 1, maxWidth: 420 }} />
              <button className="btn primario">Buscar</button>
            </form>
            <Erro erro={erro} />
            {carregando ? <Carregando /> : (
              <Tabela linhas={dados} onClique={(l) => navegar(`/fornecedores/${l.id}`)} colunas={[
                { campo: 'razao_social', titulo: 'Fornecedor', render: (l) => <div><strong>{l.nome_fantasia || l.razao_social}</strong><div className="muted pequeno">{l.razao_social}</div></div> },
                { campo: 'cnpj', titulo: 'CNPJ', render: (l) => <span className="mono">{cnpj(l.cnpj)}</span> },
                { campo: 'uf', titulo: 'UF / Município', render: (l) => `${l.uf ?? '—'} · ${l.municipio ?? ''}` },
                { campo: 'regime', titulo: 'Regime', render: (l) => <span className="pequeno">{l.regime_tributario ?? '—'}</span> },
                { campo: 'tipo', titulo: 'Tipo', render: (l) => (l.tipo_fornecedor ? <span className="tag">{refs.dados?.tipos_fornecedor[l.tipo_fornecedor]}</span> : <span className="badge sev-alerta">Classificar</span>) },
                { campo: 'qtd_nfs', titulo: 'NFs', classe: 'num' },
                { campo: 'valor_total', titulo: 'Valor total', classe: 'num', render: (l) => brl(l.valor_total) },
                { campo: 'nfs_com_erro', titulo: 'NFs c/ erro', classe: 'num', render: (l) => (l.nfs_com_erro ? <span className="badge sev-erro">{l.nfs_com_erro}</span> : '—') },
                { campo: 'ultima_nf', titulo: 'Última NF', render: (l) => data(l.ultima_nf) },
              ]} />
            )}
          </Cartao>
        )}
      </div>
    </>
  );
}
