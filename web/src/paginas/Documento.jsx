import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, baixar } from '../api.js';
import { ModalPagamento } from './Financeiro.jsx';
import {
  brl, Campo, Cartao, Carregando, chaveFmt, cnpj, data, Erro, Icone, Modal, numero, PagamentoSenior, pct, PRIORIDADE, Severidade, Status, TIPOS_DOC, useDados, useToast,
} from '../ui.jsx';

const SITUACAO_TITULO = {
  pago: { rotulo: 'Pago', cls: 'sev-ok' }, em_pagamento: { rotulo: 'Em pagamento', cls: 'sev-conferencia' }, aberto: { rotulo: 'Em aberto', cls: 'sev-alerta' },
  baixado_sem_pagamento: { rotulo: 'Baixado sem pagamento', cls: 'sev-na' }, cancelado: { rotulo: 'Cancelado', cls: 'sev-na' },
};
// Mesma regra do servidor: substituídos (LS) e cancelados não contam
function pagamentoDoc(titulos) {
  const v = (titulos ?? []).filter((t) => t.situacao_grupo !== 'cancelado' && t.situacao !== 'LS');
  if (!v.length) return null;
  if (!v.some((t) => ['aberto', 'em_pagamento'].includes(t.situacao_grupo))) return 'pago';
  return v.some((t) => t.situacao_grupo === 'em_pagamento') ? 'em_pagamento' : 'aberto';
}
const FINALIDADE = { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução' };
const ACOES = {
  APROVAR: { titulo: 'Aprovar documento', botao: 'Aprovar', classe: 'ok' },
  REPROVAR: { titulo: 'Reprovar documento', botao: 'Reprovar', classe: 'perigo', exige: true },
  SOLICITAR_CORRECAO: { titulo: 'Solicitar correção ao fornecedor', botao: 'Solicitar correção', exige: true },
  NAO_FISCAL: { titulo: 'Marcar como "não fiscal"', botao: 'Não fiscal', exige: true },
  OBSERVACAO: { titulo: 'Adicionar observação', botao: 'Observação', exige: true },
  ENCAMINHAR: { titulo: 'Encaminhar para outro usuário', botao: 'Encaminhar' },
  DEFINIR_PRAZO: { titulo: 'Prioridade e prazo', botao: 'Prazo' },
  REPROCESSAR: { titulo: 'Reprocessar documento', botao: 'Reprocessar' },
  REABRIR: { titulo: 'Reabrir validação', botao: 'Reabrir', exige: true },
};
const ROTULO_ACAO = {
  APROVAR: 'Aprovou', REPROVAR: 'Reprovou', SOLICITAR_CORRECAO: 'Solicitou correção', NAO_FISCAL: 'Marcou como não fiscal', OBSERVACAO: 'Observação',
  ENCAMINHAR: 'Encaminhou', ASSUMIR: 'Assumiu', DEFINIR_PRAZO: 'Definiu prazo/prioridade', REPROCESSAR: 'Reprocessou', REABRIR: 'Reabriu',
  IGNORAR_ALERTA: 'Ignorou alerta', REATIVAR_ALERTA: 'Reativou alerta', ALTERAR_CAMPO: 'Alterou escrituração', ACEITAR_SUGESTAO_IA: 'Aceitou sugestão da IA',
  DESCARTAR_SUGESTAO_IA: 'Descartou sugestão da IA', SISTEMA: 'Sistema', FINANCEIRO: 'Atualizou pagamento',
};

function Camada({ tipo, rotulo, titulo, sub, acoes, children, semPadding }) {
  return (
    <section className={`cartao camada camada-${tipo}`}>
      <div className="cartao-topo">
        <div style={{ flex: 1 }}>
          <div className="camada-rotulo">{rotulo}</div>
          <h2>{titulo}{sub && <span className="sub">{sub}</span>}</h2>
        </div>
        {acoes}
      </div>
      <div className={`cartao-corpo ${semPadding ? 'sem-padding' : ''}`}>{children}</div>
    </section>
  );
}

const Def = ({ r, v, mono }) => <div><span>{r}</span><strong className={mono ? 'mono' : ''}>{v ?? '—'}</strong></div>;

// ------------------------------------------------------------------ modais
function ModalAcao({ acao, doc, refs, errosAbertos, onFechar, onFeito }) {
  const cfg = ACOES[acao];
  const avisar = useToast();
  const [justificativa, setJust] = useState('');
  const [confirmarCfop, setConfirmarCfop] = useState(true);
  const [responsavel, setResponsavel] = useState('');
  const [prazo, setPrazo] = useState(doc.prazo ?? '');
  const [prioridade, setPrioridade] = useState(doc.prioridade ?? 3);
  const [enviando, setEnviando] = useState(false);
  const exigeJust = cfg.exige || (acao === 'APROVAR' && (errosAbertos > 0 || doc.status === 'DUPLICADA'));
  const enviar = async () => {
    setEnviando(true);
    try {
      await api.post(`/documentos/${doc.id}/acoes`, { acao, justificativa, confirmar_cfop_sugerido: confirmarCfop, responsavel_id: responsavel, prazo, prioridade });
      avisar(`${cfg.botao}: registrado.`);
      onFeito();
    } catch (e) { avisar(e.message, 'erro'); } finally { setEnviando(false); }
  };
  return (
    <Modal titulo={cfg.titulo} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className={`btn ${cfg.classe === 'perigo' ? 'perigo' : 'primario'}`} disabled={enviando || (exigeJust && justificativa.trim().length < (acao === 'APROVAR' ? 10 : 5)) || (acao === 'ENCAMINHAR' && !responsavel)} onClick={enviar}>{cfg.botao}</button></>}>
      {acao === 'APROVAR' && errosAbertos > 0 && <div className="aviso erro">Este documento tem {errosAbertos} inconsistência(s) aberta(s). A aprovação será registrada como <strong>aprovação com ressalva</strong> e exige justificativa.</div>}
      {acao === 'APROVAR' && (
        <label className="check"><input type="checkbox" checked={confirmarCfop} onChange={(e) => setConfirmarCfop(e.target.checked)} />Confirmar os CFOPs de entrada sugeridos pelo motor para itens ainda não confirmados</label>
      )}
      {acao === 'REPROCESSAR' && <div className="aviso info">O arquivo original será lido novamente e todas as regras reexecutadas. Alertas ignorados continuam ignorados se a ocorrência for a mesma. CFOPs de entrada já confirmados são mantidos.</div>}
      {acao === 'ENCAMINHAR' && (
        <Campo rotulo="Encaminhar para">
          <select value={responsavel} onChange={(e) => setResponsavel(e.target.value)}>
            <option value="">Selecione…</option>
            {refs?.usuarios.filter((u) => ['admin', 'fiscal'].includes(u.perfil)).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </Campo>
      )}
      {acao === 'DEFINIR_PRAZO' && (
        <div className="form-grade">
          <Campo rotulo="Prazo"><input type="date" value={prazo} onChange={(e) => setPrazo(e.target.value)} /></Campo>
          <Campo rotulo="Prioridade"><select value={prioridade} onChange={(e) => setPrioridade(e.target.value)}>{Object.entries(PRIORIDADE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        </div>
      )}
      <Campo rotulo={`${acao === 'OBSERVACAO' ? 'Observação' : 'Justificativa'}${exigeJust ? ' (obrigatória)' : ' (opcional)'}`}>
        <textarea value={justificativa} onChange={(e) => setJust(e.target.value)} autoFocus />
      </Campo>
    </Modal>
  );
}

function ModalTexto({ titulo, rotulo, botao, onFechar, onConfirmar, extra }) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  return (
    <Modal titulo={titulo} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" disabled={enviando || texto.trim().length < 3} onClick={async () => { setEnviando(true); try { await onConfirmar(texto); } finally { setEnviando(false); } }}>{botao}</button></>}>
      {extra}
      <Campo rotulo={rotulo}><textarea value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus /></Campo>
    </Modal>
  );
}

// ------------------------------------------------------------------ itens
function tributo(it, t) { return it.impostos?.[t]; }
function CelulaTributo({ t }) {
  if (!t) return <span className="muted">—</span>;
  return <div className="num"><div>{brl(t.valor)}</div><div className="muted pequeno">{t.aliquota != null ? pct(t.aliquota) : ''}{t.cst ? ` · CST ${t.cst}` : ''}</div></div>;
}

function TabelaItens({ itens, alertasPorItem, podeDecidir, onEditarCfop }) {
  return (
    <div className="tabela-wrap">
      <table className="tabela">
        <thead>
          <tr>
            <th>Item</th><th>Código</th><th>Descrição</th><th>NCM</th><th>CEST</th><th>CFOP</th><th>CST ICMS</th>
            <th className="num">Qtd</th><th>Un</th><th className="num">V. unit.</th><th className="num">V. total</th>
            <th className="num">ICMS</th><th className="num">ICMS-ST</th><th className="num">IPI</th><th className="num">PIS</th><th className="num">COFINS</th>
            <th>CFOP entrada</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((it) => {
            const al = alertasPorItem[it.n_item];
            return (
              <tr key={it.id} style={al ? { background: al === 'erro' ? 'var(--erro-fundo)' : 'var(--pend-fundo)' } : undefined}>
                <td><strong>{it.n_item}</strong></td>
                <td className="mono">{it.codigo}</td>
                <td style={{ minWidth: 200 }}>{it.descricao}</td>
                <td className="mono">{it.ncm ?? '—'}</td>
                <td className="mono">{it.cest ?? '—'}</td>
                <td className="mono" title={it.cfop_descricao ?? ''}>{it.cfop ?? '—'}</td>
                <td className="mono">{tributo(it, 'ICMS')?.cst ?? '—'}</td>
                <td className="num">{numero(it.quantidade, 4)}</td>
                <td>{it.unidade}</td>
                <td className="num">{brl(it.valor_unitario)}</td>
                <td className="num"><strong>{brl(it.valor_total)}</strong></td>
                <td><CelulaTributo t={tributo(it, 'ICMS')} /></td>
                <td><CelulaTributo t={tributo(it, 'ICMSST')} /></td>
                <td><CelulaTributo t={tributo(it, 'IPI')} /></td>
                <td><CelulaTributo t={tributo(it, 'PIS')} /></td>
                <td><CelulaTributo t={tributo(it, 'COFINS')} /></td>
                <td className="nowrap">
                  {it.cfop_entrada
                    ? <span className="tag azul" title="Confirmado pelo usuário">✓ {it.cfop_entrada}</span>
                    : it.cfop_entrada_sugerido ? <span className="tag" title={`Sugestão do motor: ${it.cfop_entrada_sugerido_descricao ?? ''}`}>sug. {it.cfop_entrada_sugerido}</span> : <span className="muted">—</span>}
                  {podeDecidir && <button className="btn ghost pequeno" onClick={() => onEditarCfop(it)} title="Definir CFOP de entrada">✎</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModalCfop({ item, onFechar, onSalvar }) {
  const [cfop, setCfop] = useState(item.cfop_entrada ?? item.cfop_entrada_sugerido ?? '');
  const [just, setJust] = useState('');
  const origem = !item.cfop_entrada && cfop === item.cfop_entrada_sugerido ? 'SUGESTAO_MOTOR_ACEITA' : 'USUARIO';
  return (
    <Modal titulo={`CFOP de entrada — item ${item.n_item}`} onFechar={onFechar}
      rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" disabled={!/^[123]\d{3}$/.test(cfop) || just.trim().length < 3} onClick={() => onSalvar(cfop, just, origem)}>Confirmar</button></>}>
      <div className="aviso info">CFOP do emitente: <strong className="mono">{item.cfop}</strong> {item.cfop_descricao ? `(${item.cfop_descricao})` : ''}. Sugestão do motor: <strong className="mono">{item.cfop_entrada_sugerido ?? '—'}</strong> {item.cfop_entrada_sugerido_descricao ? `(${item.cfop_entrada_sugerido_descricao})` : ''}.</div>
      <p className="muted pequeno" style={{ margin: 0 }}>O CFOP de entrada é dado de escrituração. A alteração fica registrada com usuário, data e justificativa; o dado extraído do XML não é alterado.</p>
      <Campo rotulo="CFOP de entrada"><input value={cfop} onChange={(e) => setCfop(e.target.value.replace(/\D/g, '').slice(0, 4))} className="mono" /></Campo>
      <Campo rotulo="Justificativa"><textarea value={just} onChange={(e) => setJust(e.target.value)} /></Campo>
    </Modal>
  );
}

// ------------------------------------------------------------------ alertas
function CartaoAlerta({ a, podeDecidir, podeIa, onIgnorar, onReativar, onExplicar, explicacao }) {
  return (
    <div className={`alerta-card ${a.severidade} ${a.status === 'ignorada' ? 'ignorada' : ''}`}>
      <div className="linha">
        <Severidade s={a.severidade} />
        {a.origem === 'HISTORICO' && <span className="tag" title="Comparação com o histórico do fornecedor: ponto de conferência, não é erro fiscal definitivo">Histórico do fornecedor</span>}
        {a.n_item && <span className="tag">Item {a.n_item}</span>}
        <strong style={{ flex: 1 }}>{a.problema}</strong>
        {a.status === 'ignorada' && <span className="badge sev-na">Ignorado</span>}
      </div>
      <div className="alerta-fluxo">
        <div><span>Problema encontrado</span><strong>{a.problema}</strong></div>
        <div><span>Regra violada</span><strong>{a.regra_violada}</strong></div>
        <div><span>Valor encontrado</span><strong>{a.valor_encontrado ?? '—'}</strong></div>
        <div><span>Valor esperado</span><strong>{a.valor_esperado ?? '—'}</strong></div>
        <div><span>Ação sugerida</span><strong>{a.acao_sugerida ?? '—'}</strong></div>
      </div>
      {a.contexto && <div className="sec pequeno">{a.contexto}</div>}
      {a.status === 'ignorada' && <div className="muted pequeno">Ignorado por {a.tratada_por_nome ?? '—'} em {data(a.tratada_em, true)}: “{a.justificativa}”</div>}
      {explicacao && (
        <div className="aviso info" style={{ borderLeft: '3px solid var(--camada-ia)' }}>
          <div><div className="camada-rotulo" style={{ color: 'var(--camada-ia)' }}>Sugestão da IA</div>{explicacao.explicacao}{explicacao.como_resolver && <div style={{ marginTop: 4 }}><strong>Como resolver:</strong> {explicacao.como_resolver}</div>}{explicacao.provavel_falso_positivo && <div className="pequeno" style={{ marginTop: 4 }}>A IA considera este alerta um possível falso positivo — confirme antes de ignorar.</div>}</div>
        </div>
      )}
      <div className="linha fim">
        {podeIa && !explicacao && <button className="btn ghost pequeno" onClick={onExplicar}><Icone nome="ia" tam={14} />Explicar com IA</button>}
        {podeDecidir && a.status === 'aberta' && <button className="btn pequeno" onClick={onIgnorar}>Ignorar alerta</button>}
        {podeDecidir && a.status === 'ignorada' && <button className="btn pequeno" onClick={onReativar}>Reativar</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ página
export default function Documento() {
  const { id } = useParams();
  const navegar = useNavigate();
  const avisar = useToast();
  const { dados: d, erro, carregando, recarregar } = useDados(() => api.get(`/documentos/${id}`), [id]);
  const refs = useDados(() => api.get('/referencias'), []);
  const [abaDados, setAbaDados] = useState('itens');
  const [modal, setModal] = useState(null);
  const [mostrarNa, setMostrarNa] = useState(false);
  const [mostrarOk, setMostrarOk] = useState(false);
  const [iaCarregando, setIaCarregando] = useState(false);
  const [explicando, setExplicando] = useState({});

  const alertasPorItem = useMemo(() => {
    const m = {};
    for (const a of d?.inconsistencias ?? []) {
      if (a.status !== 'aberta' || !a.n_item || a.severidade === 'conferencia') continue;
      if (m[a.n_item] !== 'erro') m[a.n_item] = a.severidade;
    }
    return m;
  }, [d]);
  const explicacoes = useMemo(() => {
    const m = {};
    for (const s of d?.sugestoes_ia ?? []) if (s.tipo === 'explicacao' && s.inconsistencia_id && !m[s.inconsistencia_id]) m[s.inconsistencia_id] = s.conteudo;
    return m;
  }, [d]);

  if (carregando && !d) return <div className="pagina"><Carregando /></div>;
  if (erro) return <div className="pagina"><Erro erro={erro} /></div>;
  const doc = d.documento;
  const x = d.dados_extraidos;
  const podeDecidir = d.permissoes.decidir;
  const abertos = d.inconsistencias.filter((a) => a.status === 'aberta');
  const errosAbertos = abertos.filter((a) => a.severidade === 'erro').length;
  const decidido = ['APROVADA', 'REJEITADA', 'NAO_FISCAL', 'CORRECAO_SOLICITADA'].includes(doc.status);
  const falhas = d.validacoes.filter((v) => v.resultado === 'falha');
  const oks = d.validacoes.filter((v) => v.resultado === 'ok');
  const nas = d.validacoes.filter((v) => v.resultado === 'nao_aplicavel');

  const acaoSimples = async (acao) => {
    try { await api.post(`/documentos/${doc.id}/acoes`, { acao }); avisar('Registrado.'); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };
  const proximo = async () => {
    const r = await api.get(`/documentos/${doc.id}/navegacao`);
    if (r.proximo) navegar(`/documentos/${r.proximo}`); else avisar('Não há outros documentos na fila.');
  };
  const analisarIa = async () => {
    setIaCarregando(true);
    try { const r = await api.post(`/documentos/${doc.id}/ia/analisar`); avisar(`Análise da IA concluída (${r.sugestoes} sugestões).`); recarregar(); } catch (e) { avisar(e.message, 'erro'); } finally { setIaCarregando(false); }
  };
  const explicar = async (incId) => {
    setExplicando((m) => ({ ...m, [incId]: true }));
    try { await api.post(`/inconsistencias/${incId}/explicar`); recarregar(); } catch (e) { avisar(e.message, 'erro'); } finally { setExplicando((m) => ({ ...m, [incId]: false })); }
  };

  return (
    <>
      <div className="topo">
        <button className="btn ghost" onClick={() => navegar(-1)}><Icone nome="voltar" />Voltar</button>
        <div className="espaco" />
        <button className="btn" onClick={proximo}>Próximo da fila<Icone nome="seta" /></button>
      </div>
      <div className="pagina">
        {/* ------------------------------------------------ cabeçalho + ações */}
        <section className="cartao">
          <div className="cartao-corpo coluna">
            <div className="cabecalho-doc">
              <div className="ident">
                <div className="linha" style={{ marginBottom: 6 }}>
                  <span className="tag azul">{TIPOS_DOC[doc.tipo] ?? doc.tipo}</span>
                  <Status s={doc.status} />
                  {doc.situacao_sefaz === 'cancelada' && <span className="badge sev-erro">Cancelada na SEFAZ</span>}
                  {doc.origem_dados !== 'xml' && <span className="badge st-AGUARDANDO_XML">Lido do PDF · confiança {Math.round((doc.confianca_extracao ?? 0) * 100)}%</span>}
                  {doc.qtd_recebimentos > 1 && <span className="badge st-DUPLICADA">Recebida {doc.qtd_recebimentos}×</span>}
                  {doc.senior_status === 'lancada' && <span className="badge sev-ok" title={doc.senior_ref}>✓ Lançada no Senior {doc.senior_data_entrada ? `em ${data(doc.senior_data_entrada)}` : ''}</span>}
                  <PagamentoSenior l={{ senior_pagamento: pagamentoDoc(d.senior_titulos), senior_data_pagamento: d.senior_titulos?.map((t) => t.data_pagamento).filter(Boolean).sort().pop(), senior_vencimento: d.senior_titulos?.filter((t) => ['aberto', 'em_pagamento'].includes(t.situacao_grupo)).map((t) => t.vencimento).sort()[0] }} />
                  {doc.senior_status === 'nao_lancada' && <span className="badge sev-alerta" title={`Conferido em ${data(doc.senior_verificado_em, true)}`}>Não lançada no Senior</span>}
                  <span className="tag">Prioridade {PRIORIDADE[doc.prioridade]}</span>
                  {doc.prazo && <span className="tag">Prazo {data(doc.prazo)}</span>}
                </div>
                <h1>NF {doc.numero ?? '—'}{doc.serie ? ` / série ${doc.serie}` : ''}</h1>
                <div className="sec" style={{ marginTop: 4 }}>
                  <strong>{doc.emitente_nome ?? '—'}</strong> ({cnpj(doc.emitente_cnpj)} · {doc.emitente_uf ?? '—'}) → <strong>{d.empresa?.nome_fantasia ?? doc.destinatario_nome ?? '—'}</strong> ({cnpj(doc.destinatario_cnpj)} · {doc.destinatario_uf ?? '—'})
                </div>
                <div className="muted pequeno mono" style={{ marginTop: 4 }}>{chaveFmt(doc.chave_acesso)}</div>
              </div>
              <div className="valor-total"><span className="muted pequeno">Valor total</span><strong>{brl(doc.v_total)}</strong>{doc.v_liquido != null && doc.v_liquido !== doc.v_total && <span className="pequeno">Líquido a pagar: <strong style={{ display: 'inline', fontSize: 13 }}>{brl(doc.v_liquido)}</strong></span>}<span className="muted pequeno">Responsável: {doc.responsavel_nome ?? '—'}</span></div>
            </div>
            {podeDecidir && (
              <div className="linha" style={{ borderTop: '1px solid var(--borda)', paddingTop: 12 }}>
                {!decidido && <button className="btn ok" onClick={() => setModal({ acao: 'APROVAR' })} disabled={doc.situacao_sefaz === 'cancelada'}>✓ Aprovar</button>}
                {!decidido && <button className="btn perigo" onClick={() => setModal({ acao: 'REPROVAR' })}>✕ Reprovar</button>}
                {!decidido && <button className="btn" onClick={() => setModal({ acao: 'SOLICITAR_CORRECAO' })}>Solicitar correção</button>}
                {!decidido && <button className="btn" onClick={() => setModal({ acao: 'NAO_FISCAL' })}>Não fiscal</button>}
                {decidido && <button className="btn" onClick={() => setModal({ acao: 'REABRIR' })}>Reabrir validação</button>}
                <button className="btn" onClick={() => setModal({ acao: 'OBSERVACAO' })}>Observação</button>
                <button className="btn" onClick={() => setModal({ acao: 'ENCAMINHAR' })}>Encaminhar</button>
                <button className="btn ghost" onClick={() => acaoSimples('ASSUMIR')}>Assumir</button>
                <button className="btn ghost" onClick={() => setModal({ acao: 'DEFINIR_PRAZO' })}>Prazo</button>
                <span className="espaco" />
                <button className="btn ghost" onClick={() => setModal({ acao: 'REPROCESSAR' })}><Icone nome="sync" tam={15} />Reprocessar</button>
              </div>
            )}
            <div className="linha pequeno" style={{ gap: 18 }}>
              <span><strong style={{ color: 'var(--erro)' }}>{errosAbertos}</strong> erro(s)</span>
              <span><strong style={{ color: 'var(--pend)' }}>{abertos.filter((a) => a.severidade === 'alerta').length}</strong> alerta(s)</span>
              <span><strong style={{ color: 'var(--conf)' }}>{abertos.filter((a) => a.severidade === 'conferencia').length}</strong> ponto(s) de conferência</span>
              <span><strong>{oks.length}</strong> regra(s) OK de {oks.length + falhas.length} aplicáveis</span>
              <span className="muted">Execução #{d.execucao} do motor · {data(doc.validado_em, true)}</span>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ 1. DADO EXTRAÍDO */}
        <Camada tipo="dado" rotulo="1 · Dado extraído" titulo="Dados do documento" sub={`lidos do ${doc.origem_dados === 'xml' ? 'XML' : 'PDF'} · imutáveis`} semPadding>
          <div className="abas">
            <button className={abaDados === 'itens' ? 'ativa' : ''} onClick={() => setAbaDados('itens')}>Itens ({d.itens.length})</button>
            <button className={abaDados === 'nf' ? 'ativa' : ''} onClick={() => setAbaDados('nf')}>Dados da NF</button>
            <button className={abaDados === 'fiscal' ? 'ativa' : ''} onClick={() => setAbaDados('fiscal')}>Dados fiscais</button>
            <button className={abaDados === 'cobranca' ? 'ativa' : ''} onClick={() => setAbaDados('cobranca')}>Cobrança ({d.duplicatas.length})</button>
            <button className={abaDados === 'origem' ? 'ativa' : ''} onClick={() => setAbaDados('origem')}>Origem (e-mail e anexos)</button>
            {d.perfil_fornecedor && <button className={abaDados === 'fornecedor' ? 'ativa' : ''} onClick={() => setAbaDados('fornecedor')}>Histórico do fornecedor</button>}
          </div>
          {abaDados === 'itens' && (
            <>
              {podeDecidir && d.itens.some((i) => !i.cfop_entrada && i.cfop_entrada_sugerido) && (
                <div className="linha" style={{ padding: '10px 14px', borderBottom: '1px solid var(--borda)' }}>
                  <span className="sec pequeno" style={{ flex: 1 }}>A coluna “CFOP entrada” mostra a sugestão do motor (<em>sug.</em>) ou o CFOP confirmado pelo usuário (✓). Somente CFOPs confirmados seguem para o ERP.</span>
                  <button className="btn pequeno" onClick={async () => { try { const r = await api.post(`/documentos/${doc.id}/cfop-entrada/confirmar-sugestoes`, {}); avisar(`${r.confirmados} CFOP(s) confirmados.`); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }}>Confirmar sugestões do motor</button>
                </div>
              )}
              {d.itens.length ? <TabelaItens itens={d.itens} alertasPorItem={alertasPorItem} podeDecidir={podeDecidir} onEditarCfop={(it) => setModal({ cfop: it })} /> : <div className="vazio">Itens não disponíveis (documento lido do PDF). Aguardando o XML.</div>}
            </>
          )}
          {abaDados === 'nf' && (
            <div className="cartao-corpo definicoes">
              <Def r="Tipo / modelo" v={`${TIPOS_DOC[doc.tipo] ?? doc.tipo} · mod. ${doc.modelo ?? '—'}`} />
              <Def r="Número / série" v={`${doc.numero ?? '—'} / ${doc.serie ?? '—'}`} />
              <Def r="Chave de acesso" v={chaveFmt(doc.chave_acesso)} mono />
              <Def r="Protocolo" v={doc.protocolo} mono />
              <Def r="Situação SEFAZ (XML)" v={doc.situacao_sefaz} />
              <Def r="Emissão" v={data(doc.data_emissao, true)} />
              <Def r="Saída/entrada" v={data(doc.data_entrada, true)} />
              <Def r="Recebido em" v={data(doc.recebido_em, true)} />
              <Def r="Natureza da operação" v={doc.natureza_operacao} />
              <Def r="Tipo de operação (tpNF)" v={doc.tipo_operacao === '0' ? '0 - Entrada' : doc.tipo_operacao === '1' ? '1 - Saída' : doc.tipo_operacao} />
              <Def r="Finalidade" v={FINALIDADE[doc.finalidade] ?? doc.finalidade} />
              <Def r="Emitente" v={doc.emitente_nome} />
              <Def r="CNPJ emitente" v={cnpj(doc.emitente_cnpj)} mono />
              <Def r="IE / UF emitente" v={`${doc.emitente_ie ?? '—'} / ${doc.emitente_uf ?? '—'}`} />
              <Def r="Regime (CRT)" v={doc.emitente_crt} />
              <Def r="Destinatário" v={doc.destinatario_nome} />
              <Def r="CNPJ destinatário" v={cnpj(doc.destinatario_cnpj)} mono />
              <Def r="IE / UF destinatário" v={`${doc.destinatario_ie ?? '—'} / ${doc.destinatario_uf ?? '—'}`} />
              <Def r="Empresa do grupo" v={d.empresa ? <Link to="/empresas">{d.empresa.nome_fantasia ?? d.empresa.razao_social}</Link> : 'Não identificada'} />
              {x.transporte && <Def r="Transporte" v={`${x.transporte.municipio_inicio ?? ''}/${x.transporte.uf_inicio} → ${x.transporte.municipio_fim ?? ''}/${x.transporte.uf_fim}`} />}
              {x.referencias?.length > 0 && <Def r="Documentos referenciados" v={x.referencias.join(', ')} mono />}
              {x.informacoes_complementares && <div style={{ gridColumn: '1 / -1' }}><span>Informações complementares</span><strong style={{ fontWeight: 400 }}>{x.informacoes_complementares}</strong></div>}
            </div>
          )}
          {abaDados === 'fiscal' && (
            <div className="cartao-corpo definicoes">
              <Def r="Valor dos produtos" v={brl(doc.v_prod)} />
              <Def r="Frete" v={brl(doc.v_frete)} />
              <Def r="Seguro" v={brl(doc.v_seguro)} />
              <Def r="Desconto" v={brl(doc.v_desconto)} />
              <Def r="Outras despesas" v={brl(doc.v_outro)} />
              <Def r="Base ICMS" v={brl(doc.v_bc_icms)} />
              <Def r="ICMS" v={brl(doc.v_icms)} />
              <Def r="ICMS desonerado" v={brl(doc.v_icms_deson)} />
              <Def r="Base ICMS-ST" v={brl(doc.v_bc_st)} />
              <Def r="ICMS-ST" v={brl(doc.v_icms_st)} />
              <Def r="FCP / FCP-ST" v={`${brl(doc.v_fcp)} / ${brl(doc.v_fcp_st)}`} />
              <Def r="IPI" v={brl(doc.v_ipi)} />
              <Def r="PIS" v={brl(doc.v_pis)} />
              <Def r="COFINS" v={brl(doc.v_cofins)} />
              <Def r="Serviços / ISS" v={`${brl(doc.v_servicos)} / ${brl(doc.v_iss)}`} />
              <Def r="Valor total" v={<span style={{ fontSize: 16 }}>{brl(doc.v_total)}</span>} />
              {doc.v_liquido != null && <Def r="Valor líquido a pagar" v={<span style={{ fontSize: 16 }}>{brl(doc.v_liquido)}</span>} />}
              {x.retencoes && <Def r="Retenções" v={`${brl(doc.v_retencoes ?? 0)} (ISS ${brl(x.retencoes.iss_retido ?? 0)} · IRRF ${brl(x.retencoes.irrf ?? 0)} · INSS ${brl(x.retencoes.inss ?? 0)} · PIS/COFINS/CSLL ${brl((x.retencoes.csrf ?? 0) + (x.retencoes.pis ?? 0) + (x.retencoes.cofins ?? 0) + (x.retencoes.csll ?? 0))})`} />}
              {x.competencia && <Def r="Competência" v={x.competencia} />}
              <Def r="CFOPs" v={[...new Set(d.itens.map((i) => i.cfop).filter(Boolean))].join(', ')} mono />
              <Def r="NCMs" v={[...new Set(d.itens.map((i) => i.ncm).filter(Boolean))].join(', ')} mono />
              <Def r="CST/CSOSN ICMS" v={[...new Set(d.itens.map((i) => i.impostos?.ICMS?.cst).filter(Boolean))].join(', ')} mono />
              <Def r="CEST" v={[...new Set(d.itens.map((i) => i.cest).filter(Boolean))].join(', ') || '—'} mono />
              <Def r="Alíquotas ICMS" v={[...new Set(d.itens.map((i) => i.impostos?.ICMS?.aliquota).filter((v) => v != null))].map(pct).join(', ') || '—'} />
              <Def r="Quantidade de itens" v={d.itens.length} />
            </div>
          )}
          {abaDados === 'cobranca' && (
            <div className="cartao-corpo coluna">
              {x.cobranca?.fatura && (
                <div className="definicoes">
                  <Def r="Fatura" v={x.cobranca.fatura.numero} />
                  <Def r="Valor original" v={brl(x.cobranca.fatura.valor_original)} />
                  <Def r="Desconto" v={brl(x.cobranca.fatura.desconto)} />
                  <Def r="Valor líquido" v={brl(x.cobranca.fatura.valor_liquido)} />
                  {x.cobranca.pagamentos?.map((p, i) => <Def key={i} r="Forma de pagamento" v={`${p.descricao}${p.prazo ? ` (${p.prazo})` : ''} · ${brl(p.valor)}`} />)}
                </div>
              )}
              {d.duplicatas.length ? (
                <table className="tabela">
                  <thead><tr><th>Duplicata</th><th>Vencimento</th><th className="num">Valor</th><th>Pagamento</th><th>Atualizado por</th><th /></tr></thead>
                  <tbody>{d.duplicatas.map((dp) => (
                    <tr key={dp.id}>
                      <td className="mono">{dp.numero}</td>
                      <td>{data(dp.vencimento)}</td>
                      <td className="num">{brl(dp.valor)}</td>
                      <td><span className={`badge ${{ paga: 'sev-ok', programada: 'st-AGUARDANDO_XML', aberta: 'sev-alerta', cancelada: 'sev-na' }[dp.status_pagamento]}`}>{dp.status_pagamento}</span>{dp.data_pagamento && <span className="muted pequeno"> em {data(dp.data_pagamento)}</span>}</td>
                      <td className="pequeno">{dp.atualizado_por_nome ?? '—'}{dp.observacao ? <div className="muted">“{dp.observacao}”</div> : null}</td>
                      <td>{d.permissoes.pagamentos && <button className="btn pequeno" onClick={() => setModal({ pagamento: { ...dp, status_fiscal: doc.status, nf: doc.numero } })}>Atualizar</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className="muted">{x.cobranca?.pagamentos?.length ? `Sem duplicatas: pagamento ${x.cobranca.pagamentos.map((p) => p.descricao).join(', ')}.` : 'O documento não informa duplicatas/cobrança.'}</div>}
              {d.senior_titulos?.length > 0 && (
                <>
                  <h4 style={{ margin: '8px 0 0' }}>Títulos a pagar no Senior</h4>
                  <table className="tabela">
                    <thead><tr><th>Título</th><th>Emp/Fil</th><th>Vencimento</th><th className="num">Valor</th><th className="num">Saldo</th><th>Situação</th></tr></thead>
                    <tbody>{d.senior_titulos.map((t) => (
                      <tr key={t.id}>
                        <td className="mono">{t.numtit} <span className="muted pequeno">{t.codtpt}</span></td>
                        <td className="pequeno">{t.codemp}/{t.codfil}</td>
                        <td>{data(t.vencimento)}</td>
                        <td className="num">{brl(t.valor)}</td>
                        <td className="num">{brl(t.valor_aberto)}</td>
                        <td><span className={`badge ${SITUACAO_TITULO[t.situacao_grupo]?.cls ?? ''}`} title={`Situação Senior: ${t.situacao}`}>{SITUACAO_TITULO[t.situacao_grupo]?.rotulo ?? t.situacao}</span>{t.data_pagamento && <span className="muted pequeno"> em {data(t.data_pagamento)}</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </>
              )}
              <p className="muted pequeno" style={{ margin: 0 }}>Número, vencimento e valor são dados extraídos do XML/boleto. A situação de pagamento vem da baixa dos títulos no Senior (somente leitura) ou do controle do Financeiro.</p>
            </div>
          )}
          {abaDados === 'origem' && (
            <div className="cartao-corpo coluna">
              {d.email ? (
                <div className="fluxo-email">
                  <span className="tag">E-mail</span><Link to={`/caixas/emails/${d.email.id}`}>{d.email.assunto}</Link>
                  <span>de {d.email.remetente_nome ?? ''} &lt;{d.email.remetente}&gt;</span><span>para {d.email.caixa}</span><span>em {data(d.email.data_recebimento, true)}</span>
                </div>
              ) : <div className="muted">Documento importado manualmente.</div>}
              <table className="tabela">
                <thead><tr><th>Arquivo</th><th>Tipo identificado</th><th>Status</th><th>Mensagem</th><th /></tr></thead>
                <tbody>
                  {d.anexos.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.nome_arquivo}</td><td><span className="tag">{a.tipo_detectado}</span></td><td>{a.status}</td><td className="muted pequeno">{a.mensagem ?? ''}</td>
                      <td className="nowrap">
                        <button className="btn pequeno" onClick={() => baixar(`/anexos/${a.id}/arquivo`, a.nome_arquivo, /\.pdf$/i.test(a.nome_arquivo))}>{/\.pdf$/i.test(a.nome_arquivo) ? 'Visualizar' : 'Baixar'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.recebimentos_duplicados.length > 0 && (
                <div className="aviso atencao">Este documento chegou novamente {d.recebimentos_duplicados.length} vez(es): {d.recebimentos_duplicados.map((r) => `${r.caixa ?? 'upload'} em ${data(r.data_recebimento ?? r.created_at, true)}`).join('; ')}. As cópias não geraram novos documentos.</div>
              )}
              {d.duplicado_de && <div className="aviso erro">Possível duplicidade com o documento <Link to={`/documentos/${d.duplicado_de.id}`}>#{d.duplicado_de.id} (NF {d.duplicado_de.numero}, {d.duplicado_de.status})</Link>.</div>}
              {d.eventos.length > 0 && (
                <div><h3 style={{ marginBottom: 6 }}>Eventos fiscais</h3>{d.eventos.map((e) => <div key={e.id} className="pequeno">{data(e.data_evento, true)} · <strong>{e.descricao ?? e.tp_evento}</strong> {e.texto ? `— ${e.texto}` : ''}</div>)}</div>
              )}
            </div>
          )}
          {abaDados === 'fornecedor' && d.perfil_fornecedor && (
            <div className="cartao-corpo grade grade-2">
              <div>
                <h3 style={{ marginBottom: 8 }}>CFOPs normalmente utilizados <span className="muted pequeno">({d.perfil_fornecedor.qtd_nfs} NFs anteriores)</span></h3>
                {d.perfil_fornecedor.cfops.length ? d.perfil_fornecedor.cfops.slice(0, 6).map((c) => (
                  <div key={c.cfop} className="linha" style={{ marginBottom: 6 }}>
                    <span className="mono" style={{ width: 44 }}>{c.cfop}</span>
                    <div className="barra-progresso" style={{ flex: 1 }}><div style={{ width: `${c.pct}%` }} /></div>
                    <span className="num pequeno" style={{ width: 70 }}>{c.pct}%</span>
                  </div>
                )) : <div className="muted">Sem histórico.</div>}
              </div>
              <div>
                <h3 style={{ marginBottom: 8 }}>Produtos normalmente fornecidos</h3>
                {d.perfil_fornecedor.ncms.slice(0, 6).map((n) => <div key={n.ncm} className="pequeno"><span className="mono">{n.ncm}</span> · {n.exemplo} <span className="muted">({n.itens} itens)</span></div>)}
                <div style={{ marginTop: 10 }}><Link to={`/fornecedores/${doc.fornecedor_id}`}>Abrir cadastro do fornecedor →</Link></div>
              </div>
            </div>
          )}
        </Camada>

        {/* ------------------------------------------------ 2. VALIDAÇÃO AUTOMÁTICA */}
        <Camada tipo="validacao" rotulo="2 · Validação automática" titulo="Regras executadas pelo motor fiscal"
          sub={`${falhas.length} falha(s) · ${oks.length} OK · ${nas.length} não aplicável(is)`}
          acoes={<>
            <button className="btn ghost pequeno" onClick={() => setMostrarOk((v) => !v)}>{mostrarOk ? 'Ocultar' : 'Mostrar'} regras OK ({oks.length})</button>
            <button className="btn ghost pequeno" onClick={() => setMostrarNa((v) => !v)}>{mostrarNa ? 'Ocultar' : 'Mostrar'} não aplicáveis ({nas.length})</button>
          </>} semPadding>
          {!falhas.length && !mostrarOk && <div className="aviso ok" style={{ margin: 14 }}>✓ Todas as {oks.length} regras aplicáveis passaram.</div>}
          <div className="tabela-wrap">
            <table className="tabela">
              {(falhas.length > 0 || mostrarOk || mostrarNa) && <thead><tr><th>Resultado</th><th>Regra</th><th>Categoria</th><th>Severidade configurada</th><th>Detalhe</th></tr></thead>}
              <tbody>
                {[...falhas, ...(mostrarOk ? oks : []), ...(mostrarNa ? nas : [])].map((v) => (
                  <tr key={v.regra_codigo} className={v.resultado === 'nao_aplicavel' ? 'fraco' : ''}>
                    <td><Severidade s={v.resultado === 'ok' ? 'ok' : v.resultado} /></td>
                    <td><strong>{v.nome ?? v.regra_codigo}</strong><div className="muted pequeno mono">{v.regra_codigo}</div></td>
                    <td><span className="tag">{v.categoria}</span></td>
                    <td>{v.severidade}</td>
                    <td className="muted">{v.detalhe ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Camada>

        {/* ------------------------------------------------ 3. ALERTAS */}
        <Camada tipo="alerta" rotulo="3 · Alerta" titulo="Inconsistências e pontos de conferência" sub={`${abertos.length} aberto(s)`}>
          {d.inconsistencias.length ? (
            <div className="coluna">
              {d.inconsistencias.map((a) => (
                <CartaoAlerta key={a.id} a={a} podeDecidir={podeDecidir} podeIa={d.permissoes.ia && !explicando[a.id]} explicacao={explicacoes[a.id]}
                  onExplicar={() => explicar(a.id)}
                  onIgnorar={() => setModal({ ignorar: a })}
                  onReativar={async () => { try { await api.post(`/documentos/${doc.id}/inconsistencias/${a.id}/reativar`, {}); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }} />
              ))}
            </div>
          ) : <div className="aviso ok">✓ Nenhuma inconsistência encontrada pelo motor fiscal.</div>}
        </Camada>

        {/* ------------------------------------------------ 4. SUGESTÃO DA IA */}
        <Camada tipo="ia" rotulo="4 · Sugestão da IA" titulo="Análise auxiliar por inteligência artificial"
          acoes={d.permissoes.ia && <button className="btn pequeno" onClick={analisarIa} disabled={iaCarregando}><Icone nome="ia" tam={14} />{iaCarregando ? 'Analisando…' : 'Analisar com IA'}</button>}>
          <div className="aviso info" style={{ marginBottom: 12 }}>As sugestões da IA <strong>não são tratadas como verdade fiscal</strong> e nunca alteram CFOP, CST, NCM, alíquotas ou impostos automaticamente. Sugestões de escrituração só são aplicadas se você aceitar, com justificativa.</div>
          {!d.ia_habilitada && <div className="muted">Camada de IA desabilitada. Configure <code>ANTHROPIC_API_KEY</code> no servidor para habilitar.</div>}
          <div className="coluna">
            {d.sugestoes_ia.filter((s) => s.tipo !== 'explicacao').map((s) => (
              <div key={s.id} className="alerta-card" style={{ '--sev-cor': 'var(--camada-ia)' }}>
                <div className="linha">
                  <span className="tag">{{ analise: 'Resumo', classificacao: 'Classificação (CFOP de entrada)', ponto_atencao: 'Ponto de atenção', extracao_pdf: 'Extração de PDF' }[s.tipo] ?? s.tipo}</span>
                  <span className="muted pequeno" style={{ flex: 1 }}>{s.modelo} · {data(s.created_at, true)}</span>
                  {s.status !== 'informativa' && <span className={`badge ${s.status === 'aceita' ? 'sev-ok' : s.status === 'descartada' ? 'sev-na' : 'sev-alerta'}`}>{s.status}</span>}
                </div>
                {s.tipo === 'analise' && <div><strong>{s.conteudo.classificacao_operacao}</strong><div>{s.conteudo.resumo}</div></div>}
                {s.tipo === 'ponto_atencao' && <div><strong>{s.conteudo.titulo}</strong>{s.conteudo.n_item ? ` (item ${s.conteudo.n_item})` : ''}<div className="sec">{s.conteudo.descricao}</div>{s.conteudo.valor_sugerido && <div className="pequeno">Campo {s.conteudo.campo}: atual <code>{s.conteudo.valor_atual}</code> · IA sugere <code>{s.conteudo.valor_sugerido}</code> (dado do documento não é alterado — solicite correção ao emitente se procedente)</div>}</div>}
                {s.tipo === 'classificacao' && (
                  <div className="linha">
                    <div style={{ flex: 1 }}>Item {s.conteudo.n_item}: CFOP de entrada sugerido <strong className="mono">{s.conteudo.cfop_sugerido}</strong> <span className="muted">(confiança {Math.round((s.conteudo.confianca ?? 0) * 100)}%)</span><div className="sec pequeno">{s.conteudo.justificativa}</div></div>
                    {s.status === 'pendente' && podeDecidir && (
                      <>
                        <button className="btn pequeno ok" onClick={() => setModal({ sugestao: s, aceitar: true })}>Aceitar</button>
                        <button className="btn pequeno" onClick={() => setModal({ sugestao: s, aceitar: false })}>Descartar</button>
                      </>
                    )}
                    {s.decidido_por_nome && <span className="muted pequeno">por {s.decidido_por_nome}</span>}
                  </div>
                )}
              </div>
            ))}
            {d.ia_habilitada && !d.sugestoes_ia.some((s) => s.tipo !== 'explicacao') && <div className="muted">Nenhuma análise solicitada para este documento.</div>}
          </div>
        </Camada>

        {/* ------------------------------------------------ 5. DECISÃO DO USUÁRIO */}
        <Camada tipo="decisao" rotulo="5 · Decisão do usuário" titulo="Histórico de decisões e alterações">
          {d.decisoes == null ? <div className="muted">Seu perfil não tem acesso ao histórico.</div> : (
            <div className="grade grade-2">
              <ul className="linha-tempo">
                {d.decisoes.map((h) => (
                  <li key={h.id} className={h.acao === 'SISTEMA' ? 'sistema' : ''}>
                    <div>
                      <div><strong>{h.usuario_nome ?? 'Sistema'}</strong> · {ROTULO_ACAO[h.acao] ?? h.acao}{h.status_novo && h.status_novo !== h.status_anterior ? <> → <Status s={h.status_novo} /></> : ''}</div>
                      {h.justificativa && <div className="sec">“{h.justificativa}”</div>}
                      {h.dados?.responsavel_nome && <div className="sec pequeno">Para: {h.dados.responsavel_nome}</div>}
                      {h.dados?.problema && <div className="sec pequeno">Alerta: {h.dados.problema}</div>}
                      {h.acao === 'FINANCEIRO' && <div className="sec pequeno">Duplicata {h.dados?.duplicata} ({brl(h.dados?.valor)}): {h.dados?.de} → {h.dados?.para}{h.dados?.data_pagamento ? ` em ${data(h.dados.data_pagamento)}` : ''}</div>}
                      <div className="muted pequeno">{data(h.created_at, true)}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <div>
                <h3 style={{ marginBottom: 8 }}>Alterações de escrituração</h3>
                {d.alteracoes?.length ? (
                  <table className="tabela">
                    <thead><tr><th>Item</th><th>Campo</th><th>De → Para</th><th>Origem</th><th>Usuário</th><th>Justificativa</th></tr></thead>
                    <tbody>{d.alteracoes.map((a) => (
                      <tr key={a.id}><td>{a.n_item ?? '—'}</td><td className="mono">{a.campo}</td><td className="mono">{a.valor_anterior ?? '∅'} → {a.valor_novo}</td><td><span className="tag">{a.origem}</span></td><td>{a.usuario_nome}<div className="muted pequeno">{data(a.created_at, true)}</div></td><td className="pequeno">{a.justificativa}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <div className="muted">Nenhuma alteração. Os dados fiscais permanecem exatamente como extraídos.</div>}
              </div>
            </div>
          )}
        </Camada>
      </div>

      {modal?.acao && <ModalAcao acao={modal.acao} doc={doc} refs={refs.dados} errosAbertos={errosAbertos} onFechar={() => setModal(null)} onFeito={() => { setModal(null); recarregar(); }} />}
      {modal?.ignorar && (
        <ModalTexto titulo="Ignorar alerta" rotulo="Justificativa (obrigatória)" botao="Ignorar alerta" onFechar={() => setModal(null)}
          extra={<div className="aviso atencao"><strong>{modal.ignorar.problema}</strong><br />O alerta continuará visível no histórico como “ignorado”, com seu nome e a justificativa.</div>}
          onConfirmar={async (j) => { try { await api.post(`/documentos/${doc.id}/inconsistencias/${modal.ignorar.id}/ignorar`, { justificativa: j }); setModal(null); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }} />
      )}
      {modal?.sugestao && (
        <ModalTexto titulo={modal.aceitar ? 'Aceitar sugestão da IA' : 'Descartar sugestão da IA'} rotulo="Justificativa (obrigatória)" botao={modal.aceitar ? 'Aceitar' : 'Descartar'} onFechar={() => setModal(null)}
          extra={modal.aceitar && <div className="aviso atencao">O CFOP de entrada do item {modal.sugestao.conteudo.n_item} será definido como <strong>{modal.sugestao.conteudo.cfop_sugerido}</strong>, registrado como “sugestão da IA aceita” por você.</div>}
          onConfirmar={async (j) => { try { await api.post(`/documentos/${doc.id}/sugestoes/${modal.sugestao.id}/decidir`, { aceitar: modal.aceitar, justificativa: j }); setModal(null); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }} />
      )}
      {modal?.pagamento && <ModalPagamento titulo={modal.pagamento} onFechar={() => setModal(null)} onFeito={() => { setModal(null); recarregar(); }} />}
      {modal?.cfop && (
        <ModalCfop item={modal.cfop} onFechar={() => setModal(null)}
          onSalvar={async (cfop, justificativa, origem) => { try { await api.post(`/documentos/${doc.id}/itens/${modal.cfop.id}/cfop-entrada`, { cfop, justificativa, origem }); setModal(null); recarregar(); } catch (e) { avisar(e.message, 'erro'); } }} />
      )}
    </>
  );
}
