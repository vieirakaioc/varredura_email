import { createContext, useContext } from 'react';

export const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function Topo({ titulo, descricao, children }) {
  return (
    <div className="topo">
      <div className="titulo"><h1>{titulo}</h1>{descricao && <p>{descricao}</p>}</div>
      {children}
    </div>
  );
}
