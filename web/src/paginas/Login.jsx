import { useState } from 'react';
import { Campo } from '../ui.jsx';

export default function Login({ onEntrar }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const enviar = async (e) => {
    e.preventDefault();
    setErro(null); setEnviando(true);
    try { await onEntrar(email, senha); } catch (x) { setErro(x.message); } finally { setEnviando(false); }
  };
  return (
    <div className="login">
      <form className="caixa" onSubmit={enviar}>
        <div className="linha">
          <div className="marca-logo" style={{ width: 40, height: 40 }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg></div>
          <div><h1 style={{ fontSize: 19 }}>Validador Fiscal</h1><div className="muted pequeno">Escrita Fiscal · Conferência de NFs recebidas</div></div>
        </div>
        <Campo rotulo="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></Campo>
        <Campo rotulo="Senha"><input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="current-password" required /></Campo>
        {erro && <div className="aviso erro">{erro}</div>}
        <button className="btn primario" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
        <p className="muted pequeno" style={{ margin: 0 }}>Acesso restrito à equipe fiscal. Todas as ações são registradas.</p>
      </form>
    </div>
  );
}
