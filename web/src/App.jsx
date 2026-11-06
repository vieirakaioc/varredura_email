import { Component, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, sessao } from './api.js';
import { BarraAtualizacao, Icone, PERFIS, carregarCopias, limparCopias } from './ui.jsx';
import { AuthCtx, Topo, useAuth } from './contexto.jsx';
import Login from './paginas/Login.jsx';
import Dashboard from './paginas/Dashboard.jsx';
import Documentos from './paginas/Documentos.jsx';
import Documento from './paginas/Documento.jsx';
import Caixas from './paginas/Caixas.jsx';
import Fornecedores from './paginas/Fornecedores.jsx';
import Empresas from './paginas/Empresas.jsx';
import Regras from './paginas/Regras.jsx';
import Relatorios from './paginas/Relatorios.jsx';
import Usuarios from './paginas/Usuarios.jsx';
import Auditoria from './paginas/Auditoria.jsx';
import Integracoes from './paginas/Integracoes.jsx';
import Sefaz from './paginas/Sefaz.jsx';
import Pendentes from './paginas/Pendentes.jsx';
import Carteira from './paginas/Carteira.jsx';
import MalhaFina from './paginas/MalhaFina.jsx';

// Menu enxuto: o dia a dia é o que falta lançar. O resto é configuração.
// Painel executivo e Fornecedores continuam acessíveis por link (/painel, /fornecedores), fora do menu.
// Notas a lançar, A pagar, Transação × CFOP e Enviar nota avulsa foram removidos do app:
// a situação de pagamento de cada NF agora aparece em "Todas as notas".
const MENU = [
  { grupo: 'Dia a dia' },
  { para: '/documentos', rotulo: 'Todas as notas', icone: 'docs' },
  { para: '/pendentes', rotulo: 'Pendentes de lançamento', icone: 'painel' },
  { para: '/sefaz', rotulo: 'Canceladas na SEFAZ', icone: 'auditoria' },
  { para: '/relatorios', rotulo: 'Relatórios (Excel)', icone: 'relatorio', permissao: 'relatorios' },
  { grupo: 'Configuração', permissao: 'administrar' },
  { para: '/caixas', rotulo: 'Caixas de e-mail', icone: 'email', permissao: 'administrar' },
  { para: '/empresas', rotulo: 'Empresas do grupo', icone: 'empresa', permissao: 'administrar' },
  { para: '/regras', rotulo: 'Regras e configurações', icone: 'regras', permissao: 'administrar' },
  { para: '/integracoes', rotulo: 'Integração Senior', icone: 'erp', permissao: 'administrar' },
  { para: '/usuarios', rotulo: 'Usuários', icone: 'usuarios', permissao: 'administrar' },
  { para: '/auditoria', rotulo: 'Auditoria', icone: 'auditoria', permissao: 'auditoria' },
];
const MENU_MEMBRO = [
  { para: '/carteira', rotulo: 'Carteira de notas', icone: 'fila' },
  { para: '/malha-fina', rotulo: 'Malha fina', icone: 'auditoria' },
];

function PaginaCarteira() {
  return <>
    <Topo titulo="Carteira de notas" descricao="Programação diária, prioridades e acompanhamento dos lançamentos." />
    <div className="pagina"><Carteira /></div>
  </>;
}

function PaginaMalhaFina() {
  return <>
    <Topo titulo="Malha fina" descricao="Planilhas da contabilidade e resultados da conferência no Senior." />
    <div className="pagina"><MalhaFina /></div>
  </>;
}

/**
 * Uma tela que quebra não pode derrubar o app inteiro nem ficar em branco: aqui o erro aparece
 * escrito, com a saída mais provável — descartar a cópia guardada daquela tela, que pode ter sido
 * gravada num formato antigo, e recarregar.
 */
class Blindagem extends Component {
  constructor(props) { super(props); this.state = { erro: null }; }

  static getDerivedStateFromError(erro) { return { erro }; }

  componentDidCatch(erro, info) { console.error('Falha ao montar a tela:', erro, info); }

  render() {
    const { erro } = this.state;
    if (!erro) return this.props.children;
    return (
      <div className="pagina">
        <div className="aviso erro">
          <strong>Esta tela não conseguiu abrir.</strong>
          <div className="mono pequeno" style={{ margin: '8px 0', wordBreak: 'break-word' }}>{String(erro?.message ?? erro)}</div>
          <div className="linha">
            <button className="btn" onClick={() => { limparCopias(); window.location.reload(); }}>
              Descartar a cópia guardada e recarregar
            </button>
            <span className="muted pequeno">O detalhe completo está no console do navegador (F12).</span>
          </div>
        </div>
      </div>
    );
  }
}

function Layout({ children }) {
  const { usuario, permissoes, sair } = useAuth();
  const membro = usuario.perfil === 'membro';
  const [saude, setSaude] = useState(null);
  useEffect(() => { api.get('/saude').then(setSaude).catch(() => {}); }, []);
  return (
    <div className="app">
      <aside className="lateral">
        <div className="marca">
          <div className="marca-logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg></div>
          <div><strong>VALIDADOR FISCAL</strong><span>Controle de NFS-e</span></div>
        </div>
        <nav className="nav">
          {(membro ? MENU_MEMBRO : MENU).filter((m) => !m.permissao || permissoes.includes(m.permissao)).map((m, i) => (m.grupo
            ? <div key={i} className="nav-grupo">{m.grupo}</div>
            : (
              <NavLink key={m.para} to={m.para} end={m.fim} className={({ isActive }) => (isActive ? 'ativo' : '')}>
                <Icone nome={m.icone} />{m.rotulo}
              </NavLink>
            )))}
        </nav>
        <div className="lateral-rodape">
          <div className="usuario">{usuario.nome}</div>
          <div>{PERFIS[usuario.perfil]}</div>
          <button className="btn pequeno claro" onClick={sair}><Icone nome="sair" tam={14} />Sair</button>
          {saude?.versao && <div style={{ opacity: 0.6, fontSize: 11, marginTop: 6 }} title={`Servidor iniciado em ${saude.iniciado_em}`}>versão {saude.versao}{saude.branch ? ` · ${saude.branch}` : ''}</div>}
        </div>
      </aside>
      <main className="conteudo">
        <BarraAtualizacao />
        {children}
      </main>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState(() => (sessao.get()?.token ? { carregando: true } : null));
  // As telas só montam depois que as cópias guardadas estão na memória; senão cada uma
  // abriria em "Carregando" e iria buscar tudo de novo a cada F5.
  const [copiasProntas, setCopiasProntas] = useState(false);
  const navegar = useNavigate();
  const rota = useLocation();

  useEffect(() => { carregarCopias().then(() => setCopiasProntas(true), () => setCopiasProntas(true)); }, []);

  useEffect(() => {
    const token = sessao.get()?.token;
    if (!token) return undefined;
    let ativo = true;
    api.get('/auth/me').then((r) => {
      if (ativo && sessao.get()?.token === token) setAuth({ usuario: r.usuario, permissoes: r.permissoes });
    }).catch(() => { if (ativo && sessao.get()?.token === token) setAuth(null); });
    return () => { ativo = false; };
  }, []);
  useEffect(() => {
    if (!auth?.usuario?.id) return undefined;
    const token = sessao.get()?.token;
    let ativo = true;
    let consultando = false;
    const atualizarAcesso = async () => {
      if (consultando || !token || sessao.get()?.token !== token) return;
      consultando = true;
      try {
        const r = await api.get('/auth/me');
        if (ativo && sessao.get()?.token === token) setAuth({ usuario: r.usuario, permissoes: r.permissoes });
      } catch { /* A API encerra sessões expiradas; falhas temporárias mantêm a tela aberta. */ }
      finally { consultando = false; }
    };
    const aoVoltar = () => { if (!document.hidden) atualizarAcesso(); };
    const h = setInterval(atualizarAcesso, 30000);
    window.addEventListener('focus', atualizarAcesso);
    window.addEventListener('dados-alterados', atualizarAcesso);
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      ativo = false;
      clearInterval(h);
      window.removeEventListener('focus', atualizarAcesso);
      window.removeEventListener('dados-alterados', atualizarAcesso);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [auth?.usuario?.id]);
  useEffect(() => {
    const expirou = () => setAuth(null);
    window.addEventListener('sessao-expirada', expirou);
    return () => window.removeEventListener('sessao-expirada', expirou);
  }, []);

  const entrar = async (email, senha) => {
    const r = await api.post('/auth/login', { email, senha });
    sessao.set({ token: r.token });
    const me = await api.get('/auth/me');
    setAuth({ usuario: me.usuario, permissoes: me.permissoes });
  };
  const sair = async () => {
    await api.post('/auth/logout').catch(() => {});
    sessao.limpar();
    limparCopias(); // as telas guardadas são do usuário que saiu, não do próximo a entrar
    setAuth(null);
    navegar('/');
  };

  if (!auth) return <Login onEntrar={entrar} />;
  if (auth.carregando || !copiasProntas) return <div className="carregando">Carregando…</div>;
  const pode = (p) => auth.permissoes.includes(p);
  const membro = auth.usuario.perfil === 'membro';

  return (
    <AuthCtx.Provider value={{ ...auth, sair, pode }}>
      <Layout>
        <Blindagem key={rota.pathname}>
        <Routes>
          <Route path="/carteira" element={<PaginaCarteira />} />
          <Route path="/malha-fina" element={<PaginaMalhaFina />} />
          <Route path="/pendentes" element={<Pendentes />} />
          {membro ? <Route path="*" element={<Navigate to="/carteira" replace />} /> : <>
          {/* Tela inicial: o que falta lançar no Senior */}
          <Route path="/" element={<Navigate to="/pendentes" replace />} />
          <Route path="/painel" element={<Dashboard />} />
          <Route path="/documentos" element={<Documentos />} />
          <Route path="/documentos/:id" element={<Documento />} />
          <Route path="/caixas" element={<Caixas />} />
          <Route path="/caixas/emails/:id" element={<Caixas />} />
          <Route path="/sefaz" element={<Sefaz />} />
          <Route path="/fornecedores" element={<Fornecedores />} />
          <Route path="/fornecedores/:id" element={<Fornecedores />} />
          <Route path="/empresas" element={<Empresas />} />
          <Route path="/regras" element={<Regras />} />
          <Route path="/relatorios" element={<Relatorios />} />
          <Route path="/auditoria" element={<Auditoria />} />
          <Route path="/usuarios" element={<Usuarios />} />
          <Route path="/integracoes" element={<Integracoes />} />
          <Route path="*" element={<Navigate to="/" />} />
          </>}
        </Routes>
        </Blindagem>
      </Layout>
    </AuthCtx.Provider>
  );
}
