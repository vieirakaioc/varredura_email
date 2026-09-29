import { useState } from 'react';
import { api, baixar, qs } from '../api.js';
import { Topo } from '../contexto.jsx';
import { brl, Campo, Cartao, Carregando, data, Erro, numero, Tabela, useDados, useToast } from '../ui.jsx';

const fmt = (v, tipo) => (tipo === 'moeda' ? brl(v) : tipo === 'data' ? data(v) : tipo === 'decimal' ? numero(v, 2) : tipo === 'numero' ? numero(v) : (v ?? '—'));

export default function Relatorios() {
  const avisar = useToast();
  const lista = useDados(() => api.get('/relatorios'), []);
  const refs = useDados(() => api.get('/referencias'), []);
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toLocaleDateString('sv-SE');
  const [sel, setSel] = useState('recebidas_periodo');
  const [f, setF] = useState({ de: inicioMes, ate: hoje.toLocaleDateString('sv-SE'), empresa_id: '' });
  const [aplicado, setAplicado] = useState(f);
  const rel = useDados(() => api.get(`/relatorios/${sel}${qs(aplicado)}`), [sel, JSON.stringify(aplicado)]);
  const exportar = async (formato) => {
    try { await baixar(`/relatorios/${sel}${qs({ ...aplicado, formato })}`, `${sel}.${formato}`); } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <>
      <Topo titulo="Relatórios" descricao="Indicadores fiscais com exportação para Excel e CSV." />
      <div className="pagina">
        <div className="grade" style={{ gridTemplateColumns: 'minmax(220px, 280px) 1fr' }}>
          <Cartao titulo="Relatórios" semPadding>
            {lista.dados?.map((r) => (
              <button key={r.id} className="pendencia" onClick={() => setSel(r.id)} style={sel === r.id ? { background: 'var(--marca-suave)' } : undefined}>
                <div><strong>{r.titulo}</strong><div className="muted pequeno">{r.descricao}</div></div>
              </button>
            ))}
          </Cartao>
          <div className="coluna">
            <Cartao>
              <form className="filtros" onSubmit={(e) => { e.preventDefault(); setAplicado(f); }}>
                <Campo rotulo="Recebidas de"><input type="date" value={f.de} onChange={(e) => setF({ ...f, de: e.target.value })} /></Campo>
                <Campo rotulo="até"><input type="date" value={f.ate} onChange={(e) => setF({ ...f, ate: e.target.value })} /></Campo>
                <Campo rotulo="Empresa"><select value={f.empresa_id} onChange={(e) => setF({ ...f, empresa_id: e.target.value })}><option value="">Todas</option>{refs.dados?.empresas.filter((e) => e.qtd_docs).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social}</option>)}</select></Campo>
                <div className="acoes"><button className="btn primario">Aplicar</button></div>
              </form>
            </Cartao>
            <Erro erro={rel.erro} />
            <Cartao titulo={rel.dados?.titulo ?? ''} sub={rel.dados ? `${numero(rel.dados.total)} linha(s)${rel.dados.total > rel.dados.linhas.length ? ` · exibindo ${rel.dados.linhas.length}` : ''}` : ''}
              acoes={<><button className="btn pequeno" onClick={() => exportar('xlsx')}>Exportar Excel</button><button className="btn pequeno" onClick={() => exportar('csv')}>Exportar CSV</button></>} semPadding>
              {rel.carregando ? <Carregando /> : rel.dados && (
                <Tabela chave="_i" linhas={rel.dados.linhas.map((l, i) => ({ ...l, _i: i }))} vazio="Sem dados no período."
                  colunas={rel.dados.colunas.map((c) => ({ campo: c.campo, titulo: c.titulo, classe: ['moeda', 'numero', 'decimal'].includes(c.tipo) ? 'num' : '', render: (l) => fmt(l[c.campo], c.tipo) }))} />
              )}
            </Cartao>
          </div>
        </div>
      </div>
    </>
  );
}
