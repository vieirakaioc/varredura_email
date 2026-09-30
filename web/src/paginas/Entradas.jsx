import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Campo, Cartao, Carregando, cnpj, data, Erro, Kpi, numero, useDados, useToast, BotaoExportar } from '../ui.jsx';

const SITUACAO = {
  erro: { rotulo: 'Divergente', cls: 'sev-erro' },
  alerta: { rotulo: 'Verificar', cls: 'sev-alerta' },
  ok: { rotulo: 'OK', cls: 'sev-ok' },
};
const TIPOS = { depara: 'Fora do de-para', historico: 'Combinação incomum', transacao: 'CFOP ≠ transação', uf: 'CFOP × UF', fornecedor: 'Prefixo 5→1 / 6→2' };
const COLUNAS_CONFERENCIA = [
  { titulo: 'Situação', valor: (l) => SITUACAO[l.situacao]?.rotulo },
  { titulo: 'Entrada', tipo: 'data', valor: (l) => l.entrada },
  { titulo: 'Emissão', tipo: 'data', valor: (l) => l.emissao },
  { titulo: 'Empresa', tipo: 'numero', valor: (l) => l.codemp },
  { titulo: 'Filial', tipo: 'numero', valor: (l) => l.codfil },
  { titulo: 'Nome da filial', valor: (l) => l.filial },
  { titulo: 'NF', valor: (l) => l.numero },
  { titulo: 'Série', valor: (l) => l.serie },
  { titulo: 'Chave de acesso', valor: (l) => l.chave },
  { titulo: 'Tipo de item', valor: (l) => l.tipo_item },
  { titulo: 'Itens', tipo: 'numero', valor: (l) => l.itens },
  { titulo: 'Fornecedor', valor: (l) => l.fornecedor },
  { titulo: 'CNPJ fornecedor', valor: (l) => cnpj(l.cnpj_fornecedor) },
  { titulo: 'UF fornecedor', valor: (l) => l.uf_fornecedor },
  { titulo: 'UF filial', valor: (l) => l.uf_filial },
  { titulo: 'CFOP da nota (fornecedor)', valor: (l) => l.cfop_fornecedor },
  { titulo: 'Transação', valor: (l) => l.codtns },
  { titulo: 'Descrição da transação', valor: (l) => l.transacao },
  { titulo: 'CFOP da transação', valor: (l) => l.cfop_transacao },
  { titulo: 'CFOP lançado', valor: (l) => l.cfop_entrada },
  { titulo: 'Valor', tipo: 'moeda', valor: (l) => l.valor },
  { titulo: 'Apontamento', valor: (l) => l.achados.map((a) => a.texto).join(' | ') },
];
const COLUNAS_DEPARA = [
  { titulo: 'Transação', valor: (t) => t.codtns },
  { titulo: 'Descrição', valor: (t) => t.transacao },
  { titulo: 'CFOP da transação', valor: (t) => t.cfop_transacao },
  { titulo: 'Itens (120 dias)', tipo: 'numero', valor: (t) => t.usos },
  { titulo: 'CFOPs das notas recebidas', valor: (t) => t.cfops.map((c) => `${c.cfop} (${Math.round(c.pct * 100)}%)`).join(', ') },
  { titulo: 'CFOPs aceitos (de-para)', valor: (t) => t.depara?.cfops ?? '' },
];
const hoje = () => new Date().toLocaleDateString('sv-SE');
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('sv-SE');

function Conferencia() {
  const avisar = useToast();
  const { pode } = useAuth();
  const [params, setParams] = useSearchParams();
  const filtros = { de: params.get('de') ?? diasAtras(7), ate: params.get('ate') ?? hoje(), empresa: params.get('empresa') ?? '', codtns: params.get('codtns') ?? '', cfop: params.get('cfop') ?? '', fornecedor: params.get('fornecedor') ?? '', so_divergencias: params.get('so_divergencias') ?? '1', tipo: params.get('tipo') ?? '' };
  const [form, setForm] = useState(filtros);
  const refs = useDados(() => api.get('/referencias'), []);
  const empresas = (refs.dados?.empresas ?? []).filter((e) => e.codemp);
  const emp = empresas.find((e) => String(e.id) === filtros.empresa);
  const consulta = { de: filtros.de, ate: filtros.ate, codemp: emp?.codemp, codfil: emp?.codfil, codtns: filtros.codtns, cfop: filtros.cfop, fornecedor: filtros.fornecedor, so_divergencias: filtros.so_divergencias };
  const { dados, erro, carregando, recarregar } = useDados(() => api.get(`/entradas${qs(consulta)}`), [JSON.stringify(consulta)], { automatico: false, memoria: 'entradas' });
  const aplicar = (extra = {}) => setParams(Object.fromEntries(Object.entries({ ...form, ...extra }).filter(([, v]) => v !== '' && v != null)));
  const setJa = (k) => (e) => { const v = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value; setForm((f) => ({ ...f, [k]: v })); aplicar({ [k]: v }); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const aceitar = async (l) => {
    try {
      await api.post(`/entradas/depara/${encodeURIComponent(l.codtns)}/aceitar`, { cfop: l.cfop_fornecedor });
      avisar(`Nota com CFOP ${l.cfop_fornecedor} aceita na transação ${l.codtns}. O de-para dessa transação foi criado/atualizado.`);
      recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  const r = dados?.resumo;
  const itens = (dados?.itens ?? []).filter((l) => !filtros.tipo || l.achados.some((a) => a.tipo === filtros.tipo));

  return (
    <>
      <Cartao>
        <form className="filtros" onSubmit={(e) => { e.preventDefault(); aplicar(); }}>
          <Campo rotulo="Entrada de"><input type="date" value={form.de} onChange={setJa('de')} /></Campo>
          <Campo rotulo="até"><input type="date" value={form.ate} onChange={setJa('ate')} /></Campo>
          <Campo rotulo="Empresa / filial">
            <select value={form.empresa} onChange={setJa('empresa')}>
              <option value="">Todas</option>
              {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social} ({e.codemp}/{e.codfil})</option>)}
            </select>
          </Campo>
          <Campo rotulo="Transação"><input value={form.codtns} onChange={set('codtns')} placeholder="Código (Enter)" /></Campo>
          <Campo rotulo="CFOP (entrada ou nota)"><input value={form.cfop} onChange={set('cfop')} maxLength={4} placeholder="Ex.: 1556 ou 5656 (Enter)" /></Campo>
          <Campo rotulo="Fornecedor"><input value={form.fornecedor} onChange={set('fornecedor')} placeholder="Nome ou CNPJ (Enter)" /></Campo>
          <Campo rotulo="Mostrar">
            <label className="linha" style={{ gap: 6, height: 34 }}><input type="checkbox" checked={form.so_divergencias === '1'} onChange={setJa('so_divergencias')} />Só divergências</label>
          </Campo>
          <button type="submit" style={{ display: 'none' }} />
        </form>
        <p className="muted pequeno" style={{ margin: '8px 0 0' }}>Consulta direta no Senior (somente leitura), até 62 dias por vez. Uma linha por nota × transação × CFOP (itens somados).</p>
      </Cartao>

      <Erro erro={erro} />
      {carregando && !dados ? <Carregando /> : r && (
        <>
          <div className="grade grade-kpi">
            <Kpi rotulo="Notas no período" valor={numero(r.notas)} detalhe={`${numero(r.linhas)} combinação(ões) transação × CFOP`} cor="var(--serie-1)" />
            <Kpi rotulo="Divergentes" valor={numero(r.erros)} detalhe="de-para, transação, UF ou prefixo" cor="var(--status-critico)" onClick={() => aplicar({ so_divergencias: '1', tipo: '' })} />
            <Kpi rotulo="Verificar" valor={numero(r.alertas)} detalhe="combinação incomum no histórico" cor="var(--status-atencao)" />
            {r.por_tipo.map((t) => (
              <Kpi key={t.tipo} rotulo={TIPOS[t.tipo]} valor={numero(t.qtd)} detalhe={filtros.tipo === t.tipo ? 'filtrando · clique para limpar' : 'clique para filtrar'}
                onClick={() => aplicar({ tipo: filtros.tipo === t.tipo ? '' : t.tipo, so_divergencias: '1' })} />
            ))}
          </div>
          <div className="muted pequeno">CFOP da nota do fornecedor lido do XML importado no Senior em {numero(r.com_cfop_fornecedor)} de {numero(r.linhas)} linha(s). Sem XML (ex.: NFS-e), a conferência é só por transação e UF.</div>
          <Cartao semPadding>
            <div className="linha entre" style={{ padding: '10px 14px', borderBottom: '1px solid var(--borda)' }}>
              <span className="sec">{numero(itens.length)} linha(s) · {data(r.periodo.de)} a {data(r.periodo.ate)}{dados.truncado ? ' · exibindo as 3.000 primeiras' : ''}</span>
              <BotaoExportar titulo="Transação x CFOP" linhas={itens} colunas={COLUNAS_CONFERENCIA} />
            </div>
            {!itens.length ? <div className="vazio" style={{ padding: 40 }}>✓ Nenhuma divergência nesse filtro.</div> : (
              <div className="tabela-wrap">
                <table className="tabela">
                  <thead><tr><th>Situação</th><th>Entrada</th><th>Emp/Fil</th><th>NF</th><th>Fornecedor</th><th>CFOP da nota (fornecedor)</th><th>Transação usada</th><th>CFOP lançado</th><th className="num">Valor</th><th>Apontamento</th><th /></tr></thead>
                  <tbody>
                    {itens.map((l, i) => (
                      <tr key={`${l.codemp}-${l.codfil}-${l.codfor}-${l.numero}-${l.serie}-${l.codtns}-${l.cfop_entrada}-${l.cfop_fornecedor}-${i}`}>
                        <td><span className={`badge ${SITUACAO[l.situacao].cls}`}>{SITUACAO[l.situacao].rotulo}</span></td>
                        <td className="nowrap">{data(l.entrada)}<div className="muted pequeno">emissão {data(l.emissao)}</div></td>
                        <td className="pequeno nowrap">{l.codemp}/{l.codfil}{l.filial ? <div className="muted">{l.filial}</div> : null}</td>
                        <td className="nowrap"><strong>{l.numero}</strong>{l.serie ? <span className="muted">-{l.serie}</span> : null}<div className="muted pequeno">{l.tipo_item} · {l.itens} item(ns)</div></td>
                        <td style={{ maxWidth: 240 }}>{l.fornecedor ?? '—'}<div className="muted pequeno">{cnpj(l.cnpj_fornecedor)} · {l.uf_fornecedor ?? '—'}{l.uf_filial ? ` → filial ${l.uf_filial}` : ''}</div></td>
                        <td style={{ maxWidth: 200 }}>{l.cfop_fornecedor ? <><strong className="mono">{l.cfop_fornecedor}</strong><div className="muted pequeno">{l.cfop_fornecedor_descricao ?? ''}</div></> : <span className="muted" title="Sem XML importado no Senior para esta nota">—</span>}</td>
                        <td style={{ maxWidth: 220 }}><strong className="mono">{l.codtns}</strong><div className="muted pequeno">{l.transacao ?? ''}{l.cfop_transacao ? ` · CFOP ${l.cfop_transacao}` : ''}</div></td>
                        <td style={{ maxWidth: 200 }}><strong className="mono">{l.cfop_entrada ?? '—'}</strong><div className="muted pequeno">{l.cfop_entrada_descricao ?? ''}</div></td>
                        <td className="num">{brl(l.valor)}</td>
                        <td style={{ maxWidth: 360 }} className="pequeno">
                          {l.achados.length ? l.achados.map((a, k) => <div key={k} style={{ color: a.grau === 'erro' ? 'var(--erro)' : 'var(--pend)' }}>• {a.texto}</div>) : <span className="muted">—</span>}
                        </td>
                        <td className="nowrap">
                          {pode('decidir') && l.achados.some((a) => a.tipo === 'historico' || a.tipo === 'depara') && (
                            <button className="btn pequeno ghost" title="Registrar no de-para que esta transação aceita este CFOP" onClick={() => aceitar(l)}>Aceitar combinação</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Cartao>
        </>
      )}
    </>
  );
}

function Depara() {
  const avisar = useToast();
  const { pode } = useAuth();
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/entradas/transacoes'), [], { automatico: false, memoria: 'transacoes' });
  const [edicao, setEdicao] = useState({});
  const [busca, setBusca] = useState('');
  const salvar = async (t) => {
    try {
      await api.put(`/entradas/depara/${encodeURIComponent(t.codtns)}`, { cfops: edicao[t.codtns] ?? t.depara?.cfops ?? '' });
      avisar(`De-para da transação ${t.codtns} salvo.`);
      setEdicao((e) => { const n = { ...e }; delete n[t.codtns]; return n; });
      recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  const lista = (dados ?? []).filter((t) => !busca || `${t.codtns} ${t.transacao ?? ''}`.toLowerCase().includes(busca.toLowerCase()));
  return (
    <Cartao semPadding>
      <div className="linha" style={{ padding: 12, borderBottom: '1px solid var(--borda)', gap: 12 }}>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar transação" style={{ maxWidth: 300 }} />
        <BotaoExportar titulo="De-para de transacoes" linhas={lista} colunas={COLUNAS_DEPARA} />
        <span className="muted pequeno">Transações usadas nos últimos 120 dias e os CFOPs das notas dos fornecedores que chegaram com cada uma. Informe os CFOPs de nota aceitos (separados por vírgula); em branco = conferência pelo histórico.</span>
      </div>
      <Erro erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="tabela-wrap">
          <table className="tabela">
            <thead><tr><th>Transação</th><th className="num">Itens (120d)</th><th>CFOPs das notas recebidas com a transação</th><th>CFOPs de nota aceitos (de-para)</th><th /></tr></thead>
            <tbody>
              {lista.map((t) => {
                const valor = edicao[t.codtns] ?? t.depara?.cfops ?? '';
                const sugestao = t.cfops.filter((c) => c.pct >= 0.05).map((c) => c.cfop).join(', ');
                return (
                  <tr key={t.codtns}>
                    <td style={{ maxWidth: 260 }}><strong className="mono">{t.codtns}</strong><div className="muted pequeno">{t.transacao ?? ''}</div></td>
                    <td className="num">{numero(t.usos)}</td>
                    <td className="pequeno">{t.cfops.map((c) => <span key={c.cfop} className={`tag ${c.pct < 0.05 ? '' : 'azul'}`} style={{ marginRight: 4 }} title={`${c.usos} item(ns)`}>{c.cfop} · {Math.round(c.pct * 100)}%</span>)}</td>
                    <td>
                      {pode('decidir') ? (
                        <div className="linha" style={{ gap: 6 }}>
                          <input value={valor} onChange={(e) => setEdicao((x) => ({ ...x, [t.codtns]: e.target.value }))} placeholder="Ex.: 5656, 6656" style={{ width: 200 }} />
                          {!valor && sugestao && <button className="btn pequeno ghost" onClick={() => setEdicao((x) => ({ ...x, [t.codtns]: sugestao }))} title="Preencher com os CFOPs usados em 5% ou mais das vezes">Usar sugestão</button>}
                        </div>
                      ) : <span className="mono">{t.depara?.cfops ?? '—'}</span>}
                    </td>
                    <td>{pode('decidir') && edicao[t.codtns] !== undefined && <button className="btn pequeno primario" onClick={() => salvar(t)}>Salvar</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

export default function Entradas() {
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') ?? 'conferencia';
  return (
    <>
      <Topo titulo="Entradas · Transação × CFOP" descricao="Notas de entrada lançadas no Senior, conferindo se a transação usada combina com o CFOP." />
      <div className="pagina">
        <div className="abas" style={{ padding: 0 }}>
          <button className={aba === 'conferencia' ? 'ativa' : ''} onClick={() => setParams({})}>Conferência</button>
          <button className={aba === 'depara' ? 'ativa' : ''} onClick={() => setParams({ aba: 'depara' })}>De-para de transações</button>
        </div>
        {aba === 'depara' ? <Depara /> : <Conferencia />}
      </div>
    </>
  );
}
