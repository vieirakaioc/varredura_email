import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, sessao } from './api.js';
import { Icone, PERFIS } from './ui.jsx';
import { AuthCtx, useAuth } from './contexto.jsx';
import Login from './paginas/Login.jsx';
import Dashboard from './paginas/Dashboard.jsx';
import Documentos from './paginas/Documentos.jsx';
import Fila from './paginas/Fila.jsx';
import Documento from './paginas/Documento.jsx';
import Caixas from './paginas/Caixas.jsx';
import Fornecedores from './paginas/Fornecedores.jsx';
import Empresas from './paginas/Empresas.jsx';
import Regras from './paginas/Regras.jsx';
import Relatorios from './paginas/Relatorios.jsx';
import Usuarios from './paginas/Usuarios.jsx';
import Auditoria from './paginas/Auditoria.jsx';
import Importar from './paginas/Importar.jsx';
import Integracoes from './paginas/Integracoes.jsx';
import Financeiro from './paginas/Financeiro.jsx';
import Entradas from './paginas/Entradas.jsx';
import Sefaz from './paginas/Sefaz.jsx';
import Pendentes from './paginas/Pendentes.jsx';

// Menu enxuto: o dia a dia é "lançar" (fiscal) e "pagar" (financeiro). O resto é configuração.
// Painel executivo e Fornecedores continuam acessíveis por link (/painel, /fornecedores), fora do menu.
const MENU = [
  { grupo: 'Dia a dia' },
  { para: '/fila', rotulo: 'Notas a lançar', icone: 'fila', contador: true },
  { para: '/financeiro', rotulo: 'A pagar', icone: 'financeiro', permissao: 'financeiro' },
  { para: '/documentos', rotulo: 'Todas as notas', icone: 'docs' },
  { para: '/pendentes', rotulo: 'Pendentes de lançamento', icone: 'painel' },
  { para: '/entradas', rotulo: 'Transação × CFOP', icone: 'regras' },
  { para: '/sefaz', rotulo: 'Canceladas na SEFAZ', icone: 'auditoria' },
  { para: '/importar', rotulo: 'Enviar nota avulsa', icone: 'upload', permissao: 'decidir' },
  { para: '/relatorios', rotulo: 'Relatórios (Excel)', icone: 'relatorio', permissao: 'relatorios' },
  { grupo: 'Configuração', permissao: 'administrar' },
  { para: '/caixas', rotulo: 'Caixas de e-mail', icone: 'email', permissao: 'administrar' },
  { para: '/empresas', rotulo: 'Empresas do grupo', icone: 'empresa', permissao: 'administrar' },
  { para: '/regras', rotulo: 'Regras e configurações', icone: 'regras', permissao: 'administrar' },
  { para: '/integracoes', rotulo: 'Integração Senior', icone: 'erp', permissao: 'administrar' },
  { para: '/usuarios', rotulo: 'Usuários', icone: 'usuarios', permissao: 'administrar' },
  { para: '/auditoria', rotulo: 'Auditoria', icone: 'auditoria', permissao: 'auditoria' },
];

function Layout({ children }) {
  const { usuario, permissoes, sair } = useAuth();
  const [pendentes, setPendentes] = useState(null);
  const [saude, setSaude] = useState(null);
  useEffect(() => { api.get('/saude').then(setSaude).catch(() => {}); }, []);
  useEffect(() => {
    // Contador do menu = notas a lançar no Senior (ou pendências gerais, sem Senior)
    const carregar = () => api.get('/dashboard').then((d) => setPendentes(d.indicadores.nao_lancadas_senior || d.indicadores.aguardando_acao)).catch(() => {});
    carregar();
    const h = setInterval(carregar, 60000);
    window.addEventListener('dados-alterados', carregar);
    return () => { clearInterval(h); window.removeEventListener('dados-alterados', carregar); };
  }, []);
  return (
    <div className="app">
      <aside className="lateral">
        <div className="marca">
          <div className="marca-logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg></div>
          <div><strong>VALIDADOR FISCAL</strong><span>Controle de NFS-e</span></div>
        </div>
        <nav className="nav">
          {MENU.filter((m) => !m.permissao || permissoes.includes(m.permissao)).map((m, i) => (m.grupo
            ? <div key={i} className="nav-grupo">{m.grupo}</div>
            : (
              <NavLink key={m.para} to={m.para} end={m.fim} className={({ isActive }) => (isActive ? 'ativo' : '')}>
                <Icone nome={m.icone} />{m.rotulo}
                {m.contador && pendentes ? <span className="contador">{pendentes}</span> : null}
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
      <main className="conteudo">{children}</main>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState(() => (sessao.get()?.token ? { carregando: true } : null));
  const navegar = useNavigate();

  useEffect(() => {
    if (!sessao.get()?.token) return;
    api.get('/auth/me').then((r) => setAuth({ usuario: r.usuario, permissoes: r.permissoes })).catch(() => setAuth(null));
  }, []);
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
    setAuth(null);
    navegar('/');
  };

  if (!auth) return <Login onEntrar={entrar} />;
  if (auth.carregando) return <div className="carregando">Carregando…</div>;
  const pode = (p) => auth.permissoes.includes(p);

  return (
    <AuthCtx.Provider value={{ ...auth, sair, pode }}>
      <Layout>
        <Routes>
          {/* Tela inicial: a lista do que falta lançar; o painel executivo fica no menu */}
          <Route path="/" element={<Navigate to="/fila" replace />} />
          <Route path="/painel" element={<Dashboard />} />
          <Route path="/fila" element={<Fila />} />
          <Route path="/documentos" element={<Documentos />} />
          <Route path="/documentos/:id" element={<Documento />} />
          <Route path="/caixas" element={<Caixas />} />
          <Route path="/caixas/emails/:id" element={<Caixas />} />
          <Route path="/importar" element={<Importar />} />
          <Route path="/financeiro" element={<Financeiro />} />
          <Route path="/entradas" element={<Entradas />} />
          <Route path="/sefaz" element={<Sefaz />} />
          <Route path="/pendentes" element={<Pendentes />} />
          <Route path="/fornecedores" element={<Fornecedores />} />
          <Route path="/fornecedores/:id" element={<Fornecedores />} />
          <Route path="/empresas" element={<Empresas />} />
          <Route path="/regras" element={<Regras />} />
          <Route path="/relatorios" element={<Relatorios />} />
          <Route path="/auditoria" element={<Auditoria />} />
          <Route path="/usuarios" element={<Usuarios />} />
          <Route path="/integracoes" element={<Integracoes />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    </AuthCtx.Provider>
  );
}
