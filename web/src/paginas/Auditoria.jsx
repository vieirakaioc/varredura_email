import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { Campo, Cartao, Carregando, data, Erro, Tabela, useDados } from '../ui.jsx';

export default function Auditoria() {
  const navegar = useNavigate();
  const { pode } = useAuth();
  const refs = useDados(() => api.get('/referencias'), []);
  const [f, setF] = useState({ usuario_id: '', acao: '', de: '', ate: '' });
  const [aplicado, setAplicado] = useState(f);
  const [aba, setAba] = useState('usuarios');
  const { dados, erro, carregando } = useDados(() => (aba === 'usuarios' ? api.get(`/auditoria${qs(aplicado)}`) : api.get('/logs-processamento')), [JSON.stringify(aplicado), aba]);
  return (
    <>
      <Topo titulo="Auditoria" descricao="Trilha imutável de todas as ações realizadas no sistema." />
      <div className="pagina">
        <Cartao semPadding>
          <div className="abas">
            <button className={aba === 'usuarios' ? 'ativa' : ''} onClick={() => setAba('usuarios')}>Ações de usuários</button>
            {pode('administrar') && <button className={aba === 'processamento' ? 'ativa' : ''} onClick={() => setAba('processamento')}>Log técnico de processamento</button>}
          </div>
          {aba === 'usuarios' && (
            <form className="filtros" style={{ padding: 14, borderBottom: '1px solid var(--borda)' }} onSubmit={(e) => { e.preventDefault(); setAplicado(f); }}>
              <Campo rotulo="Usuário"><select value={f.usuario_id} onChange={(e) => setF({ ...f, usuario_id: e.target.value })}><option value="">Todos</option>{refs.dados?.usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></Campo>
              <Campo rotulo="Ação contém"><input value={f.acao} onChange={(e) => setF({ ...f, acao: e.target.value })} placeholder="ex.: aprovar, regra, login" /></Campo>
              <Campo rotulo="De"><input type="date" value={f.de} onChange={(e) => setF({ ...f, de: e.target.value })} /></Campo>
              <Campo rotulo="Até"><input type="date" value={f.ate} onChange={(e) => setF({ ...f, ate: e.target.value })} /></Campo>
              <div className="acoes"><button className="btn primario">Filtrar</button></div>
            </form>
          )}
          <Erro erro={erro} />
          {carregando ? <Carregando /> : aba === 'usuarios' ? (
            <Tabela linhas={dados} onClique={(l) => l.entidade === 'documento' && l.entidade_id && navegar(`/documentos/${l.entidade_id}`)} colunas={[
              { campo: 'created_at', titulo: 'Data/hora', render: (l) => <span className="nowrap">{data(l.created_at, true)}</span> },
              { campo: 'usuario_nome', titulo: 'Usuário', render: (l) => l.usuario_nome ?? <span className="muted">Sistema / integração</span> },
              { campo: 'acao', titulo: 'Ação', render: (l) => <span className="mono">{l.acao}</span> },
              { campo: 'entidade', titulo: 'Entidade', render: (l) => (l.entidade ? `${l.entidade} #${l.entidade_id ?? ''}` : '—') },
              { campo: 'detalhes', titulo: 'Detalhes', render: (l) => <span className="mono pequeno" style={{ wordBreak: 'break-word' }}>{(l.detalhes ?? '').slice(0, 220)}</span> },
              { campo: 'ip', titulo: 'IP', render: (l) => <span className="mono pequeno">{l.ip ?? ''}</span> },
            ]} />
          ) : (
            <Tabela linhas={dados} colunas={[
              { campo: 'created_at', titulo: 'Data/hora', render: (l) => <span className="nowrap">{data(l.created_at, true)}</span> },
              { campo: 'nivel', titulo: 'Nível', render: (l) => <span className={`badge ${l.nivel === 'erro' ? 'sev-erro' : l.nivel === 'alerta' ? 'sev-alerta' : 'sev-na'}`}>{l.nivel}</span> },
              { campo: 'modulo', titulo: 'Módulo', render: (l) => <span className="tag">{l.modulo}</span> },
              { campo: 'mensagem', titulo: 'Mensagem', render: (l) => <span className="pequeno">{l.mensagem}</span> },
            ]} />
          )}
        </Cartao>
      </div>
    </>
  );
}
