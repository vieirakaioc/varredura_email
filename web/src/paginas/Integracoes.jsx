import { useState } from 'react';
import { api } from '../api.js';
import { Topo } from '../contexto.jsx';
import { Campo, Cartao, Carregando, data, Erro, Kpi, Modal, numero, Tabela, useDados, useToast } from '../ui.jsx';

function CartaoSenior() {
  const avisar = useToast();
  const { dados, recarregar } = useDados(() => api.get('/senior'), []);
  const [teste, setTeste] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const rodar = async (fn) => { setOcupado(true); try { await fn(); } catch (e) { avisar(e.message, 'erro'); } finally { setOcupado(false); recarregar(); } };
  if (!dados) return null;
  const u = dados.ultima;
  return (
    <Cartao titulo="Senior · conciliação das notas de entrada" sub="leitura direta no banco (somente leitura)"
      acoes={dados.configurado && <>
        <button className="btn pequeno" disabled={ocupado} onClick={() => rodar(async () => setTeste(await api.post('/senior/testar')))}>Testar conexão</button>
        <button className="btn pequeno primario" disabled={ocupado} onClick={() => rodar(async () => { const r = await api.post('/senior/conciliar'); avisar(`${r.lancadas} lançada(s), ${r.nao_lancadas} não lançada(s) no Senior.`); })}>{ocupado ? 'Consultando…' : 'Conciliar agora'}</button>
      </>}>
      {!dados.configurado ? (
        <div className="coluna pequeno">
          <div className="aviso atencao">Conexão com o Senior ainda não configurada. Peça à TI um <strong>usuário somente leitura</strong> no banco do Senior e preencha no arquivo <code>.env</code> do servidor (as credenciais nunca vão para o banco do sistema):</div>
          <pre className="json">{`SENIOR_DB_TIPO=mssql        # ou oracle
SENIOR_DB_HOST=servidor-do-banco
SENIOR_DB_PORTA=1433         # 1521 no Oracle
SENIOR_DB_NOME=nome_do_banco # no Oracle: service name
SENIOR_DB_USUARIO=usuario_leitura
SENIOR_DB_SENHA=********`}</pre>
          <div>Depois de salvar, reinicie o sistema e use <strong>Testar conexão</strong>. A consulta padrão lê as notas de entrada (tabela E440NFC com fornecedores E095FOR); se o ambiente for diferente, ajustamos pelo <code>SENIOR_SQL</code>.</div>
        </div>
      ) : (
        <div className="coluna">
          <div className="grade grade-kpi">
            <Kpi rotulo="Lançadas no Senior" valor={numero(dados.lancadas)} cor="var(--ok)" />
            <Kpi rotulo="Não lançadas" valor={numero(dados.nao_lancadas)} cor="var(--pend)" />
            <Kpi rotulo="Ainda não conferidas" valor={numero(dados.nao_verificadas)} />
          </div>
          <div className="muted pequeno">Banco: {dados.tipo} · {u ? `última conciliação ${data(u.em, true)}: ${u.lancamentos_senior} lançamento(s) lido(s) do Senior, ${u.aprovadas_automaticamente} nota(s) saíram da fila` : 'ainda não conciliado'} · a conciliação roda junto com a leitura dos e-mails (a cada 10 min).</div>
          {teste && (
            <div className="aviso info pequeno">
              Conexão OK: {teste.registros_30_dias} nota(s) de entrada nos últimos 30 dias. Colunas: {teste.colunas.join(', ') || '—'}
              <pre className="json" style={{ marginTop: 8 }}>{JSON.stringify(teste.amostra, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </Cartao>
  );
}

export default function Integracoes() {
  const avisar = useToast();
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/integracoes'), []);
  const [nova, setNova] = useState(null);
  const [chave, setChave] = useState(null);
  const criar = async () => {
    try { const r = await api.post('/integracoes', nova); setNova(null); setChave(r.chave); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };
  const base = `${window.location.origin}/api/erp/v1`;
  return (
    <>
      <Topo titulo="Integração com ERP" descricao="API para o ERP buscar documentos aprovados e confirmar a importação.">
        <button className="btn primario" onClick={() => setNova({ nome: '', sistema: 'generico' })}>Nova chave de API</button>
      </Topo>
      <div className="pagina">
        <Erro erro={erro} />
        <CartaoSenior />
        {carregando ? <Carregando /> : (
          <>
            <div className="grade grade-kpi"><Kpi rotulo="Aprovadas aguardando integração" valor={numero(dados.pendentes)} cor="var(--pend)" /></div>
            <Cartao titulo="Chaves de acesso" semPadding>
              <Tabela linhas={dados.integracoes} vazio="Nenhuma integração criada." colunas={[
                { campo: 'nome', titulo: 'Nome', render: (l) => <strong>{l.nome}</strong> },
                { campo: 'sistema', titulo: 'Sistema', render: (l) => dados.sistemas[l.sistema] ?? l.sistema },
                { campo: 'chave_prefixo', titulo: 'Chave', render: (l) => <span className="mono">{l.chave_prefixo}…</span> },
                { campo: 'ultimo_uso', titulo: 'Último uso', render: (l) => data(l.ultimo_uso, true) },
                { campo: 'ativo', titulo: 'Situação', render: (l) => <button className={`btn pequeno ${l.ativo ? '' : 'primario'}`} onClick={async () => { await api.put(`/integracoes/${l.id}`, { ativo: !l.ativo }); recarregar(); }}>{l.ativo ? 'Revogar' : 'Reativar'}</button> },
              ]} />
            </Cartao>
            <Cartao titulo="Como o ERP consome a API">
              <div className="coluna pequeno">
                <div>Autenticação: header <code>X-API-Key: &lt;chave&gt;</code>. Somente documentos <strong>aprovados</strong> são entregues; CFOP de entrada é o confirmado pelo usuário.</div>
                <pre className="json">{`GET  ${base}/documentos?status=APROVADA&erp_status=pendente&limite=100
GET  ${base}/documentos/{id}
POST ${base}/documentos/{id}/confirmar   {"sucesso": true, "referencia": "NUNOTA 12345"}`}</pre>
                <div>O formato de saída depende do adaptador da chave: <strong>Genérico</strong> (JSON canônico com cabeçalho, itens, tributos e aprovação) ou os esboços <strong>Senior</strong> / <strong>Sankhya</strong> (mapeamento a validar com a equipe de cada ERP, em <code>server/src/erp/adaptadores.js</code>).</div>
              </div>
            </Cartao>
          </>
        )}
      </div>
      {nova && (
        <Modal titulo="Nova chave de API" onFechar={() => setNova(null)} rodape={<><button className="btn" onClick={() => setNova(null)}>Cancelar</button><button className="btn primario" disabled={!nova.nome} onClick={criar}>Criar</button></>}>
          <Campo rotulo="Nome (ex.: ERP Senior produção)"><input value={nova.nome} onChange={(e) => setNova({ ...nova, nome: e.target.value })} /></Campo>
          <Campo rotulo="Formato / sistema"><select value={nova.sistema} onChange={(e) => setNova({ ...nova, sistema: e.target.value })}>{Object.entries(dados.sistemas).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        </Modal>
      )}
      {chave && (
        <Modal titulo="Chave criada" onFechar={() => setChave(null)} rodape={<button className="btn primario" onClick={() => setChave(null)}>Já copiei</button>}>
          <div className="aviso atencao">Copie a chave agora. Por segurança, apenas o hash é armazenado e ela não será exibida novamente.</div>
          <pre className="json" style={{ userSelect: 'all' }}>{chave}</pre>
        </Modal>
      )}
    </>
  );
}
