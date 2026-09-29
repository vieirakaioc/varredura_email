import { useState } from 'react';
import { api } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { Campo, Cartao, Carregando, data, Erro, Modal, Severidade, useDados, useToast } from '../ui.jsx';

const CATEGORIAS = {
  identificacao: 'Identificação', valores: 'Valores', cfop: 'CFOP', icms: 'ICMS', pis_cofins: 'PIS/COFINS', ipi: 'IPI',
  servicos: 'Serviços (ISS)', financeiro: 'Financeiro (Senior)', cadastro: 'NCM / CEST', historico: 'Histórico do fornecedor', personalizada: 'Personalizadas',
};
const OPERADORES = { eq: '=', ne: '≠', em: 'está em', fora_de: 'não está em', comeca_com: 'começa com', gt: '>', gte: '≥', lt: '<', lte: '≤', entre: 'entre', existe: 'existe', nao_existe: 'não existe', regex: 'regex' };
const CAMPOS_SUGERIDOS = ['cfop', 'ncm', 'cest', 'impostos.ICMS.cst', 'impostos.ICMS.aliquota', 'impostos.ICMSST.valor', 'impostos.IPI.aliquota', 'impostos.PIS.cst', 'impostos.PIS.aliquota', 'impostos.COFINS.aliquota', 'impostos.ISS.aliquota', 'valor_total', 'doc.tipo', 'doc.emitente_uf', 'doc.destinatario_uf', 'doc.emitente_crt', 'doc.finalidade', 'doc.v_total', 'operacao', 'fornecedor.tipo_fornecedor', 'empresa.uf', 'empresa.regime_tributario', 'empresa.perfil_fiscal'];

function valorCondicao(c) {
  if (['existe', 'nao_existe'].includes(c.operador)) return undefined;
  if (['em', 'fora_de', 'comeca_com'].includes(c.operador)) return String(c.valor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (c.operador === 'entre') return String(c.valor ?? '').split(',').map((s) => Number(s.trim()));
  if (['gt', 'gte', 'lt', 'lte'].includes(c.operador)) return Number(c.valor);
  return c.valor;
}

function ListaCondicoes({ titulo, lista, onChange }) {
  const set = (i, k, v) => onChange(lista.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return (
    <div className="coluna" style={{ gap: 6 }}>
      <strong className="pequeno">{titulo}</strong>
      {lista.map((c, i) => (
        <div key={i} className="linha">
          <input list="campos-regra" value={c.campo} onChange={(e) => set(i, 'campo', e.target.value)} placeholder="campo" style={{ flex: 2 }} className="mono" />
          <select value={c.operador} onChange={(e) => set(i, 'operador', e.target.value)} style={{ flex: 1 }}>{Object.entries(OPERADORES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input value={Array.isArray(c.valor) ? c.valor.join(', ') : (c.valor ?? '')} onChange={(e) => set(i, 'valor', e.target.value)} placeholder="valor (listas separadas por vírgula)" style={{ flex: 2 }} disabled={['existe', 'nao_existe'].includes(c.operador)} />
          <button className="btn ghost pequeno" onClick={() => onChange(lista.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div><button className="btn pequeno" onClick={() => onChange([...lista, { campo: '', operador: 'eq', valor: '' }])}>+ Adicionar</button></div>
    </div>
  );
}

function ModalRegra({ regra, empresas, onFechar, onSalvo }) {
  const avisar = useToast();
  const nova = !regra.id;
  const condicional = nova || regra.tipo === 'condicional';
  const [f, setF] = useState({
    codigo: regra.codigo ?? 'COND_', nome: regra.nome ?? '', descricao: regra.descricao ?? '', severidade: regra.severidade ?? 'alerta',
    ativo: regra.ativo ?? 1, empresa_id: regra.empresa_id ?? '', parametrosTxt: regra.parametros ? JSON.stringify(regra.parametros, null, 2) : '',
    escopo: regra.definicao?.escopo ?? 'item', condicoes: regra.definicao?.condicoes ?? [], exigencias: regra.definicao?.exigencias ?? [{ campo: '', operador: 'eq', valor: '' }],
    problema: regra.definicao?.problema ?? '', acao_sugerida: regra.definicao?.acao_sugerida ?? '',
  });
  const salvar = async () => {
    try {
      const corpo = { nome: f.nome, descricao: f.descricao, severidade: f.severidade, ativo: Boolean(f.ativo), empresa_id: f.empresa_id || null };
      if (condicional) {
        corpo.definicao = {
          escopo: f.escopo, problema: f.problema, acao_sugerida: f.acao_sugerida,
          condicoes: f.condicoes.filter((c) => c.campo).map((c) => ({ ...c, valor: valorCondicao(c) })),
          exigencias: f.exigencias.filter((c) => c.campo).map((c) => ({ ...c, valor: valorCondicao(c) })),
        };
      } else if (f.parametrosTxt.trim()) {
        try { corpo.parametros = JSON.parse(f.parametrosTxt); } catch { avisar('Parâmetros: JSON inválido', 'erro'); return; }
      }
      if (nova) await api.post('/regras', { ...corpo, codigo: f.codigo, categoria: 'personalizada' }); else await api.put(`/regras/${regra.id}`, corpo);
      avisar('Regra salva. Use “Revalidar pendentes” para aplicar aos documentos em aberto.');
      onSalvo();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={nova ? 'Nova regra condicional' : `Regra ${regra.codigo}`} onFechar={onFechar} largo rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      <datalist id="campos-regra">{CAMPOS_SUGERIDOS.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="form-grade">
        {nova && <Campo rotulo="Código (COND_...)"><input className="mono" value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value.toUpperCase() })} /></Campo>}
        <Campo rotulo="Nome"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Campo>
        <Campo rotulo="Severidade">
          <select value={f.severidade} onChange={(e) => setF({ ...f, severidade: e.target.value })}>
            <option value="erro">Erro (bloqueia: “com inconsistência”)</option><option value="alerta">Alerta</option><option value="conferencia">Ponto de conferência</option>
          </select>
        </Campo>
        <Campo rotulo="Aplicar à empresa">
          <select value={f.empresa_id} onChange={(e) => setF({ ...f, empresa_id: e.target.value })}><option value="">Todas</option>{empresas?.map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia || e.razao_social}</option>)}</select>
        </Campo>
      </div>
      <Campo rotulo="Descrição"><textarea rows={2} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} /></Campo>
      <label className="check"><input type="checkbox" checked={Boolean(f.ativo)} onChange={(e) => setF({ ...f, ativo: e.target.checked })} />Regra ativa</label>
      {condicional ? (
        <>
          <Campo rotulo="Escopo"><select value={f.escopo} onChange={(e) => setF({ ...f, escopo: e.target.value })}><option value="item">Cada item da NF</option><option value="documento">Documento (cabeçalho)</option></select></Campo>
          <ListaCondicoes titulo="QUANDO (todas as condições forem verdadeiras)…" lista={f.condicoes} onChange={(condicoes) => setF({ ...f, condicoes })} />
          <ListaCondicoes titulo="…ENTÃO EXIGIR (se alguma falhar, gera alerta)" lista={f.exigencias} onChange={(exigencias) => setF({ ...f, exigencias })} />
          <Campo rotulo="Mensagem do alerta (problema encontrado)"><input value={f.problema} onChange={(e) => setF({ ...f, problema: e.target.value })} /></Campo>
          <Campo rotulo="Ação sugerida"><input value={f.acao_sugerida} onChange={(e) => setF({ ...f, acao_sugerida: e.target.value })} /></Campo>
          <p className="muted pequeno" style={{ margin: 0 }}>Campos do item: <code>cfop</code>, <code>ncm</code>, <code>impostos.ICMS.aliquota</code>… Documento: <code>doc.*</code>; contexto: <code>operacao</code> (interna/interestadual), <code>fornecedor.*</code>, <code>empresa.*</code>.</p>
        </>
      ) : (
        <Campo rotulo={`Parâmetros (JSON)${regra.parametros_padrao ? ' — padrão: ' + JSON.stringify(regra.parametros_padrao).slice(0, 120) : ''}`}>
          <textarea className="mono" rows={10} value={f.parametrosTxt} onChange={(e) => setF({ ...f, parametrosTxt: e.target.value })} placeholder="Esta regra não possui parâmetros" disabled={!regra.parametros_padrao} />
        </Campo>
      )}
    </Modal>
  );
}

function Configuracoes() {
  const avisar = useToast();
  const { dados, recarregar } = useDados(() => api.get('/configuracoes'), []);
  const [reprocessando, setReprocessando] = useState(false);
  if (!dados) return null;
  const salvar = async (k, v) => {
    try {
      const r = await api.put('/configuracoes', { [k]: v });
      avisar(r.escopo ? `Escopo aplicado: ${r.escopo.removidos} documento(s) saíram do controle, ${r.escopo.incluidos} incluído(s).` : 'Configuração salva.');
      recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  const reprocessar = async () => {
    if (!window.confirm('Reprocessar TODOS os anexos já baixados? Use só após atualização dos leitores: documentos, alertas e decisões atuais serão recriados a partir dos arquivos (mudar o escopo acima NÃO precisa disso). Os e-mails não são lidos de novo.')) return;
    setReprocessando(true);
    try { const r = await api.post('/configuracoes/reprocessar-anexos'); avisar(`${r.anexos} anexo(s) reprocessado(s), ${r.documentos} documento(s).`); } catch (e) { avisar(e.message, 'erro'); } finally { setReprocessando(false); }
  };
  return (
    <Cartao titulo="Configurações gerais do fluxo" acoes={<button className="btn pequeno" disabled={reprocessando} onClick={reprocessar}>{reprocessando ? 'Reprocessando…' : 'Reprocessar anexos baixados'}</button>}>
      <div className="form-grade">
        {Object.entries(dados).map(([k, c]) => (
          <Campo key={k} rotulo={c.descricao}>
            {c.tipo === 'lista' ? (
              <div className="linha">
                {Object.entries(c.opcoes).map(([op, rot]) => (
                  <label key={op} className="check">
                    <input type="checkbox" checked={c.valor.includes(op)} onChange={(e) => salvar(k, e.target.checked ? [...c.valor, op] : c.valor.filter((x) => x !== op))} />{rot}
                  </label>
                ))}
              </div>
            ) : c.tipo === 'boolean'
              ? <select value={c.valor ? '1' : '0'} onChange={(e) => salvar(k, e.target.value === '1')}><option value="0">Não</option><option value="1">Sim</option></select>
              : <input type="number" defaultValue={c.valor} onBlur={(e) => Number(e.target.value) !== c.valor && salvar(k, e.target.value)} />}
          </Campo>
        ))}
      </div>
    </Cartao>
  );
}

export default function Regras() {
  const { pode } = useAuth();
  const avisar = useToast();
  const admin = pode('administrar');
  const refs = useDados(() => api.get('/referencias'), []);
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/regras'), []);
  const [editar, setEditar] = useState(null);
  const [revalidando, setRevalidando] = useState(false);
  const alternar = async (r) => { try { await api.put(`/regras/${r.id}`, { ativo: !r.ativo }); recarregar(); } catch (e) { avisar(e.message, 'erro'); } };
  const grupos = {};
  for (const r of dados ?? []) (grupos[r.categoria] ??= []).push(r);

  return (
    <>
      <Topo titulo="Regras fiscais" descricao="Motor de validação: regras nativas parametrizáveis e regras condicionais definidas pelo administrador.">
        {admin && <button className="btn" disabled={revalidando} onClick={async () => { setRevalidando(true); try { const r = await api.post('/regras/revalidar'); avisar(`${r.revalidados} documento(s) revalidado(s).`); } finally { setRevalidando(false); } }}>{revalidando ? 'Revalidando…' : 'Revalidar pendentes'}</button>}
        {admin && <button className="btn primario" onClick={() => setEditar({})}>Nova regra condicional</button>}
      </Topo>
      <div className="pagina">
        <Erro erro={erro} />
        {admin && <Configuracoes />}
        {carregando ? <Carregando /> : Object.entries(CATEGORIAS).filter(([k]) => grupos[k]).map(([k, rotulo]) => (
          <Cartao key={k} titulo={rotulo} sub={`${grupos[k].length} regra(s)`} semPadding>
            <div className="tabela-wrap">
              <table className="tabela">
                <thead><tr><th style={{ width: 70 }}>Ativa</th><th>Regra</th><th>Severidade</th><th>Tipo</th><th>Parâmetros / definição</th><th className="num">Abertas</th><th>Atualizada</th><th /></tr></thead>
                <tbody>
                  {grupos[k].map((r) => (
                    <tr key={r.id} className={r.ativo ? '' : 'fraco'}>
                      <td><input type="checkbox" checked={Boolean(r.ativo)} disabled={!admin} onChange={() => alternar(r)} aria-label="Ativa" /></td>
                      <td><strong>{r.nome}</strong><div className="muted pequeno"><span className="mono">{r.codigo}</span> · {r.descricao}</div>{r.empresa_nome && <span className="tag azul">Somente {r.empresa_nome}</span>}</td>
                      <td><Severidade s={r.severidade} /></td>
                      <td><span className="tag">{r.tipo}</span></td>
                      <td className="mono pequeno" style={{ maxWidth: 320, wordBreak: 'break-word' }}>{r.tipo === 'condicional' ? `${r.definicao?.escopo}: ${(r.definicao?.condicoes ?? []).map((c) => `${c.campo} ${c.operador} ${c.valor ?? ''}`).join(' e ') || 'sempre'} ⇒ ${(r.definicao?.exigencias ?? []).map((c) => `${c.campo} ${c.operador} ${Array.isArray(c.valor) ? c.valor.join('/') : c.valor ?? ''}`).join(' e ')}` : r.parametros ? JSON.stringify(r.parametros).slice(0, 140) : '—'}</td>
                      <td className="num">{r.ocorrencias_abertas || '—'}</td>
                      <td className="pequeno">{r.atualizado_por ? `${r.atualizado_por} · ${data(r.updated_at)}` : '—'}</td>
                      <td>{admin && <button className="btn pequeno" onClick={() => setEditar(r)}>Editar</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Cartao>
        ))}
      </div>
      {editar && <ModalRegra regra={editar} empresas={refs.dados?.empresas} onFechar={() => setEditar(null)} onSalvo={() => { setEditar(null); recarregar(); }} />}
    </>
  );
}
