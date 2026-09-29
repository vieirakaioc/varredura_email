import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Topo } from '../contexto.jsx';
import { brl, Cartao, Campo, cnpj, data, Erro, PagamentoSenior, SeniorBadge, Status, STATUS, Tabela, TIPOS_DOC, useDados, NotaArquivo, BoletoInfo, OrdemCompra, BotaoExportar, textoOrdemCompra } from '../ui.jsx';

const CAMPOS_FILTRO = ['q', 'empresa_id', 'cnpj', 'fornecedor', 'de', 'ate', 'campo_data', 'numero', 'chave', 'cfop', 'status', 'tipo',
  'responsavel_id', 'caixa_id', 'recebido_de', 'recebido_ate'];
const ROTULOS_ESPECIAIS = { senior: 'Senior', sem_xml: 'Sem XML', duplicadas: 'Duplicadas', regra: 'Regra', categoria: 'Categoria', severidade: 'Severidade', atrasadas: 'Prazo vencido', cancelada: 'Canceladas', fornecedor_id: 'Fornecedor' };

const SENIOR = { lancada: 'Lançada', nao_lancada: 'Não lançada' };
const PAGAMENTO_SENIOR = { pago: 'Pago', em_pagamento: 'Em pagamento', aberto: 'A pagar' };
const COLUNAS_EXPORT = [
  { titulo: 'Status', valor: (l) => STATUS[l.status]?.rotulo ?? l.status },
  { titulo: 'Tipo', valor: (l) => TIPOS_DOC[l.tipo] ?? l.tipo },
  { titulo: 'Número', valor: (l) => l.numero },
  { titulo: 'Série', valor: (l) => l.serie },
  { titulo: 'Chave de acesso', valor: (l) => l.chave_acesso },
  { titulo: 'Fornecedor', valor: (l) => l.emitente_nome },
  { titulo: 'CNPJ fornecedor', valor: (l) => cnpj(l.emitente_cnpj) },
  { titulo: 'UF', valor: (l) => l.emitente_uf },
  { titulo: 'Empresa', valor: (l) => l.empresa_nome },
  { titulo: 'Emissão', tipo: 'data', valor: (l) => l.data_emissao },
  { titulo: 'Recebido em', tipo: 'data', valor: (l) => String(l.recebido_em ?? '').slice(0, 10) },
  { titulo: 'Valor bruto', tipo: 'moeda', valor: (l) => l.v_total },
  { titulo: 'Valor líquido', tipo: 'moeda', valor: (l) => l.v_liquido },
  { titulo: 'Erros', tipo: 'numero', valor: (l) => l.qtd_erros },
  { titulo: 'Alertas', tipo: 'numero', valor: (l) => l.qtd_alertas },
  { titulo: 'Senior', valor: (l) => SENIOR[l.senior_status] ?? '' },
  { titulo: 'Entrada no Senior', tipo: 'data', valor: (l) => l.senior_data_entrada },
  { titulo: 'Pagamento (Senior)', valor: (l) => PAGAMENTO_SENIOR[l.senior_pagamento] ?? '' },
  { titulo: 'Vencimento (Senior)', tipo: 'data', valor: (l) => l.senior_vencimento },
  { titulo: 'Pago em', tipo: 'data', valor: (l) => l.senior_data_pagamento },
  { titulo: 'Boleto', valor: (l) => (l.boleto_anexo_id ? 'arquivo recebido' : l.qtd_boletos > 0 ? 'vencimento da nota' : 'sem boleto') },
  { titulo: 'Vencimento do boleto', tipo: 'data', valor: (l) => l.boleto_vencimento },
  { titulo: 'Valor do boleto', tipo: 'moeda', valor: (l) => l.boleto_valor },
  { titulo: 'OC', valor: (l) => textoOrdemCompra(l) },
];

export function ResumoAlertas({ l }) {
  return (
    <span className="linha" style={{ gap: 4 }}>
      {l.qtd_erros > 0 && <span className="badge sev-erro" title="Erros">{l.qtd_erros} erro{l.qtd_erros > 1 ? 's' : ''}</span>}
      {l.qtd_alertas > 0 && <span className="badge sev-alerta" title="Alertas">{l.qtd_alertas} alerta{l.qtd_alertas > 1 ? 's' : ''}</span>}
      {l.qtd_conferencias > 0 && <span className="badge sev-conferencia" title="Pontos de conferência">{l.qtd_conferencias} conf.</span>}
      {!l.qtd_erros && !l.qtd_alertas && !l.qtd_conferencias && <span className="muted">—</span>}
    </span>
  );
}

export default function Documentos() {
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();
  const filtros = Object.fromEntries(params.entries());
  const [form, setForm] = useState(() => Object.fromEntries(CAMPOS_FILTRO.map((c) => [c, filtros[c] ?? ''])));
  const [avancado, setAvancado] = useState(false);
  const refs = useDados(() => api.get('/referencias'), []);
  const ordem = { campo: filtros.ordem ?? 'recebido', dir: filtros.dir ?? 'desc' };
  const pagina = Number(filtros.pagina ?? 1);
  const { dados, erro, carregando } = useDados(() => api.get(`/documentos${qs({ ...filtros, limite: 50 })}`), [params.toString()]);

  const aplicar = (extra = {}) => {
    const novo = { ...Object.fromEntries(Object.entries(filtros).filter(([k]) => !CAMPOS_FILTRO.includes(k))), ...form, ...extra, pagina: 1 };
    setParams(Object.fromEntries(Object.entries(novo).filter(([, v]) => v !== '' && v != null)));
  };
  const limpar = () => { setForm(Object.fromEntries(CAMPOS_FILTRO.map((c) => [c, '']))); setParams({}); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Listas e datas filtram na hora; campos de texto filtram ao apertar Enter
  const setJa = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); aplicar({ [k]: v }); };
  const ordenar = (campo) => setParams({ ...filtros, ordem: campo, dir: ordem.campo === campo && ordem.dir === 'desc' ? 'asc' : 'desc' });
  const especiais = Object.entries(filtros).filter(([k]) => ROTULOS_ESPECIAIS[k]);

  // CFOP só existe em NF-e/CT-e: some da tabela quando a página não tem nenhum
  const temCfop = dados?.itens.some((l) => l.cfops);
  const colunas = [
    { campo: 'status', titulo: 'Status', render: (l) => <Status s={l.status} />, ordenavel: true },
    { campo: 'tipo', titulo: 'Tipo', render: (l) => <span className="tag">{TIPOS_DOC[l.tipo] ?? l.tipo}</span> },
    { campo: 'numero', titulo: 'Número', render: (l) => <strong>{l.numero ?? '—'}{l.serie ? <span className="muted">/{l.serie}</span> : ''}</strong>, ordenavel: true },
    { campo: 'fornecedor', titulo: 'Fornecedor', ordenavel: true, render: (l) => <div><div>{l.emitente_nome ?? '—'}</div><div className="muted pequeno">{cnpj(l.emitente_cnpj)} · {l.emitente_uf ?? '—'}</div></div> },
    { campo: 'empresa_nome', titulo: 'Empresa', render: (l) => l.empresa_nome ?? <span className="badge sev-erro">Não identificada</span> },
    temCfop && { campo: 'cfops', titulo: 'CFOP', render: (l) => <span className="mono">{l.cfops ?? '—'}</span> },
    { campo: 'emissao', titulo: 'Emissão', ordenavel: true, render: (l) => data(l.data_emissao) },
    { campo: 'recebido', titulo: 'Recebido', ordenavel: true, render: (l) => data(l.recebido_em, true) },
    { campo: 'valor', titulo: 'Valor', classe: 'num', ordenavel: true, render: (l) => <div>{brl(l.v_total)}{l.v_liquido != null && Math.abs(l.v_liquido - l.v_total) > 0.009 && <div className="muted pequeno" title="Valor líquido (após retenções)">líq. {brl(l.v_liquido)}</div>}</div> },
    { campo: 'alertas', titulo: 'Ocorrências', render: (l) => <ResumoAlertas l={l} /> },
    { campo: 'senior', titulo: 'Senior', render: (l) => <span className="linha" style={{ gap: 4, flexWrap: 'wrap' }}><SeniorBadge s={l.senior_status} titulo={l.senior_ref} /><PagamentoSenior l={l} /></span> },
    { campo: 'nota_arquivo', titulo: 'Nota', render: (l) => <NotaArquivo l={l} /> },
    { campo: 'boleto', titulo: 'Boleto', classe: 'nowrap', render: (l) => <BoletoInfo l={l} /> },
    { campo: 'oc', titulo: 'OC', classe: 'nowrap', render: (l) => <OrdemCompra l={l} /> },
  ].filter(Boolean);

  return (
    <>
      <Topo titulo="Todas as notas" descricao="Tudo o que chegou pelos e-mails, com a situação no Senior (lançada e paga)." />
      <div className="pagina">
        <Cartao>
          <form onSubmit={(e) => { e.preventDefault(); aplicar(); }} className="coluna">
            <div className="filtros">
              <Campo rotulo="Busca livre" style={{ gridColumn: 'span 2' }}><input value={form.q} onChange={set('q')} placeholder="Número, chave, fornecedor, CNPJ…" /></Campo>
              <Campo rotulo="Empresa">
                <select value={form.empresa_id} onChange={setJa('empresa_id')}><option value="">Todas</option>{refs.dados?.empresas.filter((e) => e.qtd_docs).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social}</option>)}</select>
              </Campo>
              <Campo rotulo="Status">
                <select value={form.status} onChange={setJa('status')}><option value="">Todos</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}</select>
              </Campo>
              <Campo rotulo="Tipo de documento">
                <select value={form.tipo} onChange={setJa('tipo')}><option value="">Todos</option>{Object.entries(TIPOS_DOC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Campo>
              <Campo rotulo="Período de">
                <input type="date" value={form.de} onChange={setJa('de')} />
              </Campo>
              <Campo rotulo="até"><input type="date" value={form.ate} onChange={setJa('ate')} /></Campo>
              <Campo rotulo="Data de referência">
                <select value={form.campo_data} onChange={setJa('campo_data')}><option value="">Emissão</option><option value="recebimento">Recebimento</option></select>
              </Campo>
              {avancado && (
                <>
                  <Campo rotulo="Fornecedor"><input value={form.fornecedor} onChange={set('fornecedor')} placeholder="Nome ou CNPJ" /></Campo>
                  <Campo rotulo="CNPJ (emitente ou destinatário)"><input value={form.cnpj} onChange={set('cnpj')} /></Campo>
                  <Campo rotulo="Número da NF"><input value={form.numero} onChange={set('numero')} /></Campo>
                  <Campo rotulo="Chave de acesso"><input value={form.chave} onChange={set('chave')} /></Campo>
                  <Campo rotulo="CFOP"><input value={form.cfop} onChange={set('cfop')} maxLength={4} /></Campo>
                  <Campo rotulo="Responsável">
                    <select value={form.responsavel_id} onChange={setJa('responsavel_id')}><option value="">Todos</option><option value="nenhum">Sem responsável</option>{refs.dados?.usuarios.filter((u) => ['admin', 'fiscal'].includes(u.perfil)).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
                  </Campo>
                  <Campo rotulo="Conta de e-mail">
                    <select value={form.caixa_id} onChange={setJa('caixa_id')}><option value="">Todas</option>{refs.dados?.caixas.map((c) => <option key={c.id} value={c.id}>{c.email}</option>)}</select>
                  </Campo>
                  <Campo rotulo="Recebido de"><input type="date" value={form.recebido_de} onChange={setJa('recebido_de')} /></Campo>
                  <Campo rotulo="Recebido até"><input type="date" value={form.recebido_ate} onChange={setJa('recebido_ate')} /></Campo>
                </>
              )}
            </div>
            <div className="linha">
              <button className="btn primario" type="submit">Filtrar</button>
              <button className="btn" type="button" onClick={limpar}>Limpar</button>
              <button className="btn ghost" type="button" onClick={() => setAvancado((a) => !a)}>{avancado ? 'Menos filtros' : 'Mais filtros'}</button>
              {especiais.map(([k, v]) => (
                <span key={k} className="tag azul">{ROTULOS_ESPECIAIS[k]}{v !== '1' ? `: ${v}` : ''}
                  <button type="button" className="btn ghost pequeno" style={{ padding: '0 4px' }} onClick={() => { const n = { ...filtros }; delete n[k]; setParams(n); }} aria-label="Remover filtro">✕</button>
                </span>
              ))}
            </div>
          </form>
        </Cartao>
        <Erro erro={erro} />
        <Cartao titulo="Resultado" sub={dados ? `${dados.total} documento(s)` : ''} semPadding
          acoes={<BotaoExportar titulo="Todas as notas" colunas={COLUNAS_EXPORT} linhas={async () => {
            // todas as páginas do filtro atual (500 por vez)
            const todas = [];
            for (let p = 1; ; p++) {
              const r = await api.get(`/documentos${qs({ ...filtros, limite: 500, pagina: p })}`);
              todas.push(...r.itens);
              if (todas.length >= r.total || !r.itens.length) break;
            }
            return todas;
          }} />}>
          {carregando && !dados ? <div className="carregando">Carregando…</div> : (
            <>
              <Tabela colunas={colunas} linhas={dados?.itens} onClique={(l) => navegar(`/documentos/${l.id}`)} ordem={ordem} onOrdenar={ordenar} vazio="Nenhum documento com esses filtros." />
              {dados && dados.total > dados.limite && (
                <div className="paginacao">
                  <span>Página {pagina} de {Math.ceil(dados.total / dados.limite)}</span>
                  <div className="linha">
                    <button className="btn pequeno" disabled={pagina <= 1} onClick={() => setParams({ ...filtros, pagina: pagina - 1 })}>Anterior</button>
                    <button className="btn pequeno" disabled={pagina * dados.limite >= dados.total} onClick={() => setParams({ ...filtros, pagina: pagina + 1 })}>Próxima</button>
                  </div>
                </div>
              )}
            </>
          )}
        </Cartao>
      </div>
    </>
  );
}
