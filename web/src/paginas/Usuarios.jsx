import { useState } from 'react';
import { api } from '../api.js';
import { Topo } from '../contexto.jsx';
import { Campo, Cartao, Carregando, data, Erro, Modal, PERFIS, Tabela, useDados, useToast } from '../ui.jsx';

const DESCRICAO = {
  admin: 'Acesso completo: cadastros, regras, caixas de e-mail, usuários e integrações.',
  fiscal: 'Visualiza, valida e aprova documentos; trata alertas e escrituração.',
  consulta: 'Somente visualização.',
  auditor: 'Visualização, histórico de decisões, relatórios e trilha de auditoria.',
  financeiro: 'Visualiza documentos e o painel de contas a pagar; registra programação e pagamento das duplicatas.',
};

function Formulario({ usuario, onFechar, onSalvo }) {
  const avisar = useToast();
  const [f, setF] = useState({ nome: usuario.nome ?? '', email: usuario.email ?? '', perfil: usuario.perfil ?? 'fiscal', senha: '', ativo: usuario.ativo ?? 1 });
  const salvar = async () => {
    try {
      if (usuario.id) await api.put(`/usuarios/${usuario.id}`, { nome: f.nome, perfil: f.perfil, ativo: Boolean(f.ativo), senha: f.senha || undefined });
      else await api.post('/usuarios', f);
      avisar('Usuário salvo.'); onSalvo();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={usuario.id ? 'Editar usuário' : 'Novo usuário'} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      <Campo rotulo="Nome"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Campo>
      <Campo rotulo="E-mail"><input value={f.email} disabled={Boolean(usuario.id)} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
      <Campo rotulo="Perfil de acesso"><select value={f.perfil} onChange={(e) => setF({ ...f, perfil: e.target.value })}>{Object.entries(PERFIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
      <div className="muted pequeno">{DESCRICAO[f.perfil]}</div>
      <Campo rotulo={usuario.id ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial'}><input type="password" value={f.senha} onChange={(e) => setF({ ...f, senha: e.target.value })} autoComplete="new-password" /></Campo>
      <div className="muted pequeno">Mínimo de 10 caracteres, com letras e números. As senhas são armazenadas apenas como hash (scrypt).</div>
      {usuario.id && <label className="check"><input type="checkbox" checked={Boolean(f.ativo)} onChange={(e) => setF({ ...f, ativo: e.target.checked })} />Usuário ativo</label>}
    </Modal>
  );
}

export default function Usuarios() {
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/usuarios'), []);
  const [editar, setEditar] = useState(null);
  return (
    <>
      <Topo titulo="Usuários e níveis de acesso"><button className="btn primario" onClick={() => setEditar({})}>Novo usuário</button></Topo>
      <div className="pagina">
        <Erro erro={erro} />
        <div className="grade grade-kpi">{Object.entries(PERFIS).map(([k, v]) => <div key={k} className="kpi"><span className="rotulo">{v}</span><span className="detalhe">{DESCRICAO[k]}</span></div>)}</div>
        <Cartao semPadding>
          {carregando ? <Carregando /> : (
            <Tabela linhas={dados} onClique={setEditar} colunas={[
              { campo: 'nome', titulo: 'Nome', render: (l) => <strong>{l.nome}</strong> },
              { campo: 'email', titulo: 'E-mail' },
              { campo: 'perfil', titulo: 'Perfil', render: (l) => <span className="tag azul">{PERFIS[l.perfil]}</span> },
              { campo: 'ultimo_login', titulo: 'Último acesso', render: (l) => data(l.ultimo_login, true) },
              { campo: 'ativo', titulo: 'Situação', render: (l) => (l.ativo ? <span className="badge sev-ok">Ativo</span> : <span className="badge sev-na">Inativo</span>) },
            ]} />
          )}
        </Cartao>
      </div>
      {editar && <Formulario usuario={editar} onFechar={() => setEditar(null)} onSalvo={() => { setEditar(null); recarregar(); }} />}
    </>
  );
}
