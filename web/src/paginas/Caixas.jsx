import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, baixar, qs } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, Campo, Cartao, Carregando, data, Erro, Icone, Modal, Status, Tabela, TIPOS_DOC, useDados, useToast } from '../ui.jsx';

const STATUS_EMAIL = {
  processado: { rotulo: 'Processado', cls: 'sev-ok' },
  sem_nf: { rotulo: 'Sem NF', cls: 'sev-na' },
  erro: { rotulo: 'Com erro', cls: 'sev-erro' },
  aguardando: { rotulo: 'Aguardando', cls: 'sev-alerta' },
  duplicado: { rotulo: 'Duplicado', cls: 'sev-na' },
};
const StatusEmail = ({ s }) => <span className={`badge ${STATUS_EMAIL[s]?.cls ?? 'sev-na'}`}>{STATUS_EMAIL[s]?.rotulo ?? s}</span>;

function CaixasConectadas() {
  const { pode } = useAuth();
  const avisar = useToast();
  const [params, setParams] = useSearchParams();
  const { dados, erro, recarregar } = useDados(() => api.get('/caixas'), []);
  const [sinc, setSinc] = useState({});
  const [editar, setEditar] = useState(null);

  useEffect(() => {
    if (params.get('oauth') === 'ok') { avisar('Caixa conectada ao Zoho Mail com sucesso.'); setParams({}); }
    if (params.get('oauth') === 'erro') { avisar(`Falha na autorização: ${params.get('msg')}`, 'erro'); setParams({}); }
  }, [params, avisar, setParams]);

  const conectar = async (c) => {
    try { const r = await api.post(`/caixas/${c.id}/oauth`); window.location.href = r.url; } catch (e) { avisar(e.message, 'erro'); }
  };
  const [trocando, setTrocando] = useState(false);
  const trocarConta = async () => {
    try { const r = await api.post('/caixas/oauth-todas'); window.location.href = r.url; } catch (e) { avisar(e.message, 'erro'); }
  };
  const contas = [...new Set((dados?.caixas ?? []).map((c) => c.conta_autorizada).filter(Boolean))];
  const sincronizar = async (c) => {
    setSinc((s) => ({ ...s, [c.id]: true }));
    try { const r = await api.post(`/caixas/${c.id}/sincronizar`); avisar(r.ignorado ? `Não sincronizada: ${r.ignorado}` : `${r.novos} e-mail(s) novo(s), ${r.documentos} documento(s).`); recarregar(); } catch (e) { avisar(e.message, 'erro'); recarregar(); } finally { setSinc((s) => ({ ...s, [c.id]: false })); }
  };

  return (
    <Cartao titulo="Contas monitoradas" sub={dados ? `leitura a cada ${dados.intervalo_min} min · somente leitura (nenhum e-mail é movido, excluído ou marcado)` : ''}
      acoes={pode('administrar') && (
        <div className="linha" style={{ gap: 8 }}>
          {dados?.zoho_configurado && <button className="btn pequeno" onClick={() => setTrocando(true)}>Trocar conta autorizada</button>}
          <button className="btn pequeno" onClick={() => setEditar({})}>Adicionar caixa</button>
        </div>
      )}>
      <Erro erro={erro} />
      {contas.length > 0 && <div className="muted pequeno" style={{ marginBottom: 10 }}>Leitura autorizada por: <strong>{contas.join(', ')}</strong></div>}
      {trocando && (
        <Modal titulo="Trocar a conta que autoriza a leitura" onFechar={() => setTrocando(false)}
          rodape={<><button className="btn" onClick={() => setTrocando(false)}>Cancelar</button><button className="btn primario" onClick={trocarConta}>Ir para o login do Zoho</button></>}>
          <p style={{ marginTop: 0 }}>A nova pessoa faz o login no Zoho <strong>uma vez</strong> e a autorização passa a valer para <strong>todas as caixas ativas</strong>. Nenhuma senha é guardada no sistema.</p>
          <ol className="pequeno" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Antes, saia do Zoho neste navegador (ou abra o sistema numa janela anônima), para o login ser da pessoa certa.</li>
            <li>A pessoa precisa ser <strong>membro das caixas compartilhadas</strong> no Zoho ({(dados?.caixas ?? []).map((c) => c.email).join(', ')}).</li>
            <li>Ela entra com o e-mail e a senha dela na tela do Zoho e clica em <strong>Aceitar</strong>.</li>
            <li>De volta aqui, confira em cada caixa “lida via …” com o e-mail dela. Se aparecer aviso de que ela não recebe os e-mails de alguma caixa, peça ao TI para incluí-la como membro.</li>
          </ol>
          <p className="muted pequeno" style={{ marginBottom: 0 }}>Os e-mails já lidos não são processados de novo.</p>
        </Modal>
      )}
      {dados && !dados.zoho_configurado && pode('administrar') && (
        <div className="aviso atencao" style={{ marginBottom: 12 }}>
          <div>Integração Zoho ainda não configurada. Crie um cliente “Server-based Application” em <strong>api-console.zoho.com</strong> com a URL de redirecionamento <code>{dados.redirect_uri}</code> e defina <code>ZOHO_CLIENT_ID</code> / <code>ZOHO_CLIENT_SECRET</code> no <code>.env</code>. Escopos solicitados (somente leitura): contas, pastas e mensagens.</div>
        </div>
      )}
      <div className="grade grade-2">
        {dados?.caixas.map((c) => (
          <div key={c.id} className="kpi" style={{ '--kpi-cor': c.status === 'conectada' ? 'var(--ok)' : c.status === 'erro' ? 'var(--erro)' : 'var(--borda-forte)' }}>
            <div className="linha"><Icone nome="email" /><strong style={{ flex: 1 }}>{c.email}</strong><span className="tag">{c.provedor}</span>
              <span className={`badge ${c.status === 'conectada' ? 'sev-ok' : c.status === 'erro' ? 'sev-erro' : c.status === 'sincronizando' ? 'sev-alerta' : 'sev-na'}`}>{c.status}</span></div>
            <div className="detalhe">{c.total_emails} e-mail(s) registrados · {c.emails_erro} com erro · {c.ultima_sincronizacao ? `última leitura ${data(c.ultima_sincronizacao, true)}` : 'nunca sincronizada'}</div>
            {c.conta_autorizada && (
              <div className="detalhe">
                {c.filtro_destinatario
                  ? <>Caixa compartilhada lida via <strong>{c.conta_autorizada}</strong> (membro) · somente e-mails endereçados a {c.email}</>
                  : <>Conta autorizada: <strong>{c.conta_autorizada}</strong></>}
              </div>
            )}
            {c.ultimo_erro && <div className="aviso erro pequeno">{c.ultimo_erro}</div>}
            <div className="linha" style={{ marginTop: 6 }}>
              {pode('administrar') && c.provedor === 'zoho' && <button className="btn pequeno primario" onClick={() => conectar(c)}>{c.autorizada ? 'Reautorizar' : 'Conectar (OAuth)'}</button>}
              {pode('decidir') && <button className="btn pequeno" disabled={sinc[c.id]} onClick={() => sincronizar(c)}><Icone nome="sync" tam={14} />{sinc[c.id] ? 'Lendo…' : 'Ler agora'}</button>}
              {pode('administrar') && c.autorizada ? <button className="btn pequeno ghost" onClick={async () => { try { const r = await api.post(`/caixas/${c.id}/verificar`); avisar(r.modo === 'membro' ? `Conectada via ${r.conta} (caixa compartilhada).` : `Conectada: ${r.conta}.`); } catch (e) { avisar(e.message, 'erro'); } recarregar(); }}>Verificar conexão</button> : null}
              {pode('administrar') && c.autorizada ? <button className="btn pequeno ghost" onClick={async () => { await api.post(`/caixas/${c.id}/desconectar`); recarregar(); }}>Desconectar</button> : null}
              {pode('administrar') && <button className="btn pequeno ghost" onClick={() => setEditar(c)}>Configurar</button>}
            </div>
          </div>
        ))}
      </div>
      {editar && <ModalCaixa caixa={editar} onFechar={() => setEditar(null)} onSalvo={() => { setEditar(null); recarregar(); }} />}
    </Cartao>
  );
}

function ModalCaixa({ caixa, onFechar, onSalvo }) {
  const avisar = useToast();
  const [f, setF] = useState({ email: caixa.email ?? '', provedor: caixa.provedor ?? 'zoho', pastas: caixa.pastas ? JSON.parse(caixa.pastas).join(', ') : '', sincronizar_desde: caixa.sincronizar_desde ?? '', ativo: caixa.ativo ?? 1 });
  const salvar = async () => {
    try {
      if (caixa.id) await api.put(`/caixas/${caixa.id}`, f); else await api.post('/caixas', f);
      onSalvo();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={caixa.id ? `Configurar ${caixa.email}` : 'Adicionar caixa de e-mail'} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      {!caixa.id && <Campo rotulo="E-mail"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>}
      <Campo rotulo="Conector">
        <select value={f.provedor} onChange={(e) => setF({ ...f, provedor: e.target.value })}>
          <option value="zoho">Zoho Mail — API oficial + OAuth (recomendado)</option>
          <option value="imap">IMAP somente leitura (senha de aplicativo no .env)</option>
          <option value="pasta">Pasta local (.eml / XML / PDF)</option>
          <option value="manual">Manual (somente upload)</option>
        </select>
      </Campo>
      <Campo rotulo="Pastas lidas (separadas por vírgula; padrão Inbox)"><input value={f.pastas} onChange={(e) => setF({ ...f, pastas: e.target.value })} placeholder="Inbox, NFe" /></Campo>
      <Campo rotulo="Ler e-mails a partir de (primeira leitura)"><input type="date" value={f.sincronizar_desde} onChange={(e) => setF({ ...f, sincronizar_desde: e.target.value })} /></Campo>
      <label className="check"><input type="checkbox" checked={Boolean(f.ativo)} onChange={(e) => setF({ ...f, ativo: e.target.checked })} />Caixa ativa (lida pelo agendador)</label>
      {f.provedor === 'imap' && <div className="aviso info pequeno">Credenciais IMAP nunca ficam no banco. Defina no .env: <code>IMAP_{(f.email || 'EMAIL').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SENHA</code> (senha de aplicativo do Zoho).</div>}
    </Modal>
  );
}

function DetalheEmail({ id, onFechar }) {
  const navegar = useNavigate();
  const avisar = useToast();
  const { pode } = useAuth();
  const { dados, erro, recarregar } = useDados(() => api.get(`/emails/${id}`), [id]);
  return (
    <Modal titulo="E-mail → Anexos → NF identificada → Validação" onFechar={onFechar} largo>
      <Erro erro={erro} />
      {!dados ? <Carregando /> : (
        <>
          <div className="definicoes">
            <div><span>Assunto</span><strong>{dados.email.assunto}</strong></div>
            <div><span>Remetente</span><strong>{dados.email.remetente_nome} &lt;{dados.email.remetente}&gt;</strong></div>
            <div><span>Caixa / destinatários</span><strong>{dados.email.caixa}</strong><div className="muted pequeno">{dados.email.destinatarios}{dados.email.cc ? ` · cc ${dados.email.cc}` : ''}</div></div>
            <div><span>Recebido em</span><strong>{data(dados.email.data_recebimento, true)}</strong></div>
            <div><span>Status do processamento</span><StatusEmail s={dados.email.status} /></div>
            <div><span>ID no provedor</span><strong className="mono pequeno">{dados.email.id_provedor}</strong></div>
          </div>
          {dados.email.erro && <div className="aviso erro">{dados.email.erro}</div>}
          {dados.mesma_mensagem_em.length > 0 && <div className="aviso atencao">O mesmo e-mail também chegou em: {dados.mesma_mensagem_em.map((m) => m.caixa).join(', ')}. Os documentos não foram duplicados.</div>}
          <table className="tabela">
            <thead><tr><th>Anexo</th><th>Identificação</th><th>NF identificada</th><th>Validação</th><th /></tr></thead>
            <tbody>
              {dados.anexos.map((a) => (
                <tr key={a.id}>
                  <td><div className="mono pequeno">{a.anexo_pai_id ? '↳ ' : ''}{a.nome_arquivo}</div><div className="muted pequeno">{a.status}{a.mensagem ? ` · ${a.mensagem}` : ''}</div></td>
                  <td><span className="tag">{a.tipo_detectado ?? '—'}</span></td>
                  <td>{a.documento_id ? <div><strong>{TIPOS_DOC[a.doc_tipo]} {a.doc_numero}</strong>{a.doc_serie ? `/${a.doc_serie}` : ''}<div className="muted pequeno">{a.doc_emitente} · {brl(a.doc_valor)}</div></div> : <span className="muted">—</span>}</td>
                  <td>{a.documento_id ? <div className="linha"><Status s={a.doc_status} />{a.doc_erros > 0 && <span className="badge sev-erro">{a.doc_erros} erro(s)</span>}</div> : null}</td>
                  <td className="nowrap">
                    <button className="btn pequeno ghost" onClick={() => baixar(`/anexos/${a.id}/arquivo`, a.nome_arquivo, /\.pdf$/i.test(a.nome_arquivo))}><Icone nome="download" tam={14} /></button>
                    {a.documento_id && <button className="btn pequeno" onClick={() => navegar(`/documentos/${a.documento_id}`)}>Validar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!dados.anexos.length && <div className="muted">Nenhum anexo de documento fiscal (XML/PDF/ZIP) neste e-mail.</div>}
          {pode('decidir') && dados.email.status === 'erro' && <div className="linha fim"><button className="btn" onClick={async () => { try { await api.post(`/emails/${id}/reprocessar`); avisar('Reprocessado.'); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }}>Reprocessar anexos</button></div>}
        </>
      )}
    </Modal>
  );
}

export default function Caixas() {
  const { id } = useParams();
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();
  const filtros = Object.fromEntries([...params.entries()].filter(([k]) => !['oauth', 'msg'].includes(k)));
  const [form, setForm] = useState({ remetente: '', assunto: '', de: '', ate: '', numero: '', cnpj: '', chave: '', ...filtros });
  const { dados, erro, carregando } = useDados(() => api.get(`/emails${qs({ ...filtros, limite: 50 })}`), [JSON.stringify(filtros)]);
  const pagina = Number(filtros.pagina ?? 1);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const aba = (rotulo, status, n) => (
    <button className={(filtros.status ?? '') === status ? 'ativa' : ''} onClick={() => setParams({ ...filtros, status, pagina: 1 })}>{rotulo}{n != null ? ` (${n})` : ''}</button>
  );

  return (
    <>
      <Topo titulo="Caixas de entrada" descricao="E-mails de suprimentos lidos automaticamente e o que foi identificado em cada um." />
      <div className="pagina">
        <CaixasConectadas />
        <Cartao semPadding>
          <div className="abas">
            {aba('Recebidos', '', dados?.resumo.recebidos)}
            {aba('Processados', 'processado', dados?.resumo.processado)}
            {aba('Sem NF', 'sem_nf', dados?.resumo.sem_nf)}
            {aba('Com erro', 'erro', dados?.resumo.erro)}
            {aba('Aguardando processamento', 'aguardando', dados?.resumo.aguardando)}
            {aba('Duplicados', 'duplicado', dados?.resumo.duplicado)}
          </div>
          <form className="filtros" style={{ padding: 14, borderBottom: '1px solid var(--borda)' }} onSubmit={(e) => { e.preventDefault(); setParams(Object.fromEntries(Object.entries({ ...filtros, ...form, pagina: 1 }).filter(([, v]) => v !== ''))); }}>
            <Campo rotulo="Remetente"><input value={form.remetente} onChange={set('remetente')} /></Campo>
            <Campo rotulo="Assunto"><input value={form.assunto} onChange={set('assunto')} /></Campo>
            <Campo rotulo="De"><input type="date" value={form.de} onChange={set('de')} /></Campo>
            <Campo rotulo="Até"><input type="date" value={form.ate} onChange={set('ate')} /></Campo>
            <Campo rotulo="Número da NF"><input value={form.numero} onChange={set('numero')} /></Campo>
            <Campo rotulo="CNPJ"><input value={form.cnpj} onChange={set('cnpj')} /></Campo>
            <Campo rotulo="Chave de acesso"><input value={form.chave} onChange={set('chave')} /></Campo>
            <div className="acoes"><button className="btn primario">Buscar</button><button type="button" className="btn" onClick={() => { setForm({ remetente: '', assunto: '', de: '', ate: '', numero: '', cnpj: '', chave: '' }); setParams({}); }}>Limpar</button></div>
          </form>
          <Erro erro={erro} />
          {carregando && !dados ? <Carregando /> : (
            <>
              <Tabela linhas={dados?.itens} onClique={(l) => navegar(`/caixas/emails/${l.id}${qs(filtros)}`)} vazio="Nenhum e-mail encontrado." colunas={[
                { campo: 'data', titulo: 'Recebido', render: (l) => <span className="nowrap">{data(l.data_recebimento, true)}</span> },
                { campo: 'caixa', titulo: 'Conta', render: (l) => <span className="pequeno">{l.caixa}</span> },
                { campo: 'remetente', titulo: 'Remetente', render: (l) => <div><div>{l.remetente_nome ?? l.remetente}</div><div className="muted pequeno">{l.remetente}</div></div> },
                { campo: 'assunto', titulo: 'Assunto', render: (l) => l.assunto },
                { campo: 'anexos', titulo: 'Anexos', classe: 'num', render: (l) => l.qtd_anexos },
                { campo: 'docs', titulo: 'NFs', classe: 'num', render: (l) => l.qtd_documentos },
                { campo: 'status', titulo: 'Processamento', render: (l) => <StatusEmail s={l.status} /> },
                { campo: 'st_docs', titulo: 'Situação das NFs', render: (l) => <span className="linha" style={{ gap: 4 }}>{(l.status_documentos ?? '').split(',').filter(Boolean).map((s) => <Status key={s} s={s} curto />)}</span> },
              ]} />
              {dados && dados.total > dados.limite && (
                <div className="paginacao">
                  <span>Página {pagina} de {Math.ceil(dados.total / dados.limite)} · {dados.total} e-mails</span>
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
      {id && <DetalheEmail id={id} onFechar={() => navegar(`/caixas${qs(filtros)}`)} />}
    </>
  );
}
