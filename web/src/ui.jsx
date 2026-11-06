import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { baixar, exportarExcel } from './api.js';
import { AuthCtx } from './contexto.jsx';

// ------------------------------------------------------------------ formatação
export const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const numero = (v, casas = 0) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas }));
export const pct = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`);
export function data(v, comHora = false) {
  if (!v) return '—';
  const s = String(v).replace(' ', 'T');
  const [d, h] = s.split('T');
  const [a, m, di] = d.split('-');
  if (!di) return v;
  return `${di}/${m}/${a}${comHora && h ? ` ${h.slice(0, 5)}` : ''}`;
}
/** Data curta para tabelas: "23/09" no ano corrente, "23/09/25" nos outros (a data completa vai no title). */
export function dataCurta(v) {
  if (!v) return '—';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  if (!d) return v;
  return a === String(new Date().getFullYear()) ? `${d}/${m}` : `${d}/${m}/${a.slice(2)}`;
}
export function cnpj(v) {
  const c = String(v || '').replace(/[^0-9A-Z]/gi, '');
  if (c.length === 14) return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
  if (c.length === 11) return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
  return v || '—';
}
export const chaveFmt = (c) => (c && /^\d{44}$/.test(c) ? c.match(/.{1,4}/g).join(' ') : c || '—');

// Cores fixas por tipo de nota (serviço, combustível...), as mesmas nas abas de pendentes e lançadas
export const COR_CATEGORIA = {
  combustivel: '#e8833a', servico: '#7a4fd0', frete: '#1c8c8c', energia_telecom: '#c2a100',
  biomassa: '#6b8e23', produto: 'var(--serie-1)', sem_itens: 'var(--status-neutro)',
};

// ------------------------------------------------------------------ status
export const STATUS = {
  APROVADA: { rotulo: 'Aprovada', curto: 'Aprovada', icone: '✓' },
  PENDENTE: { rotulo: 'Pendente de validação', curto: 'Pendente', icone: '●' },
  INCONSISTENTE: { rotulo: 'Com inconsistência', curto: 'Inconsistente', icone: '!' },
  DUPLICADA: { rotulo: 'Duplicada', curto: 'Duplicada', icone: '⧉' },
  AGUARDANDO_XML: { rotulo: 'Aguardando XML', curto: 'Sem XML', icone: '⋯' },
  REJEITADA: { rotulo: 'Rejeitada', curto: 'Rejeitada', icone: '✕' },
  CORRECAO_SOLICITADA: { rotulo: 'Correção solicitada', curto: 'Correção', icone: '↺' },
  NAO_FISCAL: { rotulo: 'Não fiscal', curto: 'Não fiscal', icone: '–' },
};
export function Status({ s, curto }) {
  const info = STATUS[s] ?? { rotulo: s, icone: '•' };
  return <span className={`badge st-${s}`} title={info.rotulo}><span aria-hidden>{info.icone}</span>{curto ? info.curto ?? info.rotulo : info.rotulo}</span>;
}
const SEV = { erro: 'Erro', alerta: 'Alerta', conferencia: 'Conferência', ok: 'OK', nao_aplicavel: 'N/A', falha: 'Falha' };
export function Severidade({ s }) {
  const cls = s === 'falha' ? 'erro' : s === 'nao_aplicavel' ? 'na' : s;
  return <span className={`badge sev-${cls}`}><span className="ponto" aria-hidden />{SEV[s] ?? s}</span>;
}
// Nota, boleto e ordem de compra de cada NF, em colunas próprias nas listas
const abrirAnexo = (e, id, nome) => { e.stopPropagation(); if (id) baixar(`/anexos/${id}/arquivo`, nome, true).catch(() => {}); };

/** Coluna "Nota": abre o PDF (ou o XML) da nota. */
export function NotaArquivo({ l }) {
  const id = l.pdf_anexo_id ?? l.xml_anexo_id;
  if (!id) return <span className="muted">—</span>;
  return <button className="btn pequeno" title="Abrir a nota" onClick={(e) => abrirAnexo(e, id, 'nota')}>{l.pdf_anexo_id ? 'PDF' : 'XML'}</button>;
}

/** Coluna "Boleto": vencimento e valor, com botão para abrir o arquivo quando o boleto veio no e-mail. */
export function BoletoInfo({ l, vencimento = l.boleto_vencimento, valor = l.boleto_valor }) {
  if (!l.boleto_anexo_id && !(l.qtd_boletos > 0)) return <span className="muted pequeno" title="Nenhum boleto veio no e-mail">sem boleto</span>;
  return (
    <div className="linha" style={{ gap: 6, flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
      <div className="pequeno nowrap" style={{ lineHeight: 1.3 }}>
        <div title={vencimento ? `vencimento ${data(vencimento)}` : ''}>{vencimento ? `venc. ${dataCurta(vencimento)}` : 'sem vencimento'}</div>
        {valor != null && <div className="muted">{brl(valor)}</div>}
      </div>
      {l.boleto_anexo_id
        ? <button className="btn pequeno" title="Abrir o boleto" onClick={(e) => abrirAnexo(e, l.boleto_anexo_id, 'boleto')}>Abrir</button>
        : <span className="tag" title="Vencimento lido da própria nota (sem arquivo de boleto)">da nota</span>}
    </div>
  );
}

/**
 * Botão "Exportar Excel" das tabelas: exporta as linhas visíveis (com os filtros aplicados).
 * `linhas` pode ser uma função assíncrona (ex.: buscar todas as páginas antes de exportar).
 */
export function BotaoExportar({ titulo, colunas, linhas, rotulo = 'Exportar Excel' }) {
  const avisar = useToast();
  const [ocupado, setOcupado] = useState(false);
  const exportar = async () => {
    setOcupado(true);
    try {
      const dados = typeof linhas === 'function' ? await linhas() : linhas;
      if (!dados?.length) { avisar('Nada para exportar com esses filtros.', 'erro'); return; }
      await exportarExcel(titulo, colunas, dados);
    } catch (e) { avisar(e.message, 'erro'); } finally { setOcupado(false); }
  };
  return <button type="button" className="btn pequeno" onClick={exportar} disabled={ocupado} title="Baixa em Excel o que está na tabela, com os filtros aplicados">{ocupado ? 'Exportando…' : rotulo}</button>;
}

/** Texto da coluna OC para exportação (mesma lógica de exibição). */
export function textoOrdemCompra(l) {
  let s = null;
  try { s = l.senior_ocs ? JSON.parse(l.senior_ocs) : null; } catch { /* ignora */ }
  if (s?.origem === 'lancada') return `${s.ocs.map((o) => o.numocp).join(', ')} (lançamento Senior)`;
  const abertas = s?.origem === 'aberta' ? s.ocs : [];
  if (l.oc_documento) return `${l.oc_documento} (na nota${abertas.some((o) => o.numocp === l.oc_documento) ? ', em aberto no Senior' : ', não achada em aberto'})`;
  const prov = abertas.find((o) => o.bate_valor);
  if (prov) return `provável ${prov.numocp} (sugestão)`;
  return abertas.length ? `${abertas.length} OC em aberto: ${abertas.map((o) => o.numocp).join(', ')}` : '';
}

/** Coluna "OC": usada no lançamento do Senior, citada na nota (conferida no Senior) ou OC em aberto sugerida. */
export function OrdemCompra({ l }) {
  let senior = null;
  try { senior = l.senior_ocs ? JSON.parse(l.senior_ocs) : null; } catch { /* ignora */ }
  const lancada = senior?.origem === 'lancada' ? senior.ocs.map((o) => o.numocp) : [];
  const abertas = senior?.origem === 'aberta' ? senior.ocs : [];
  const provavel = abertas.find((o) => o.bate_valor);
  const dica = abertas.map((o) => `OC ${o.numocp} · Emp ${o.codemp}/Fil ${o.codfil} · ${data(o.emissao)} · saldo ${brl(o.valor)}${o.parcial ? ' (parcial)' : ''}${o.bate_valor ? ' · valor igual ao da nota' : ''}`).join('\n');
  if (lancada.length) return <span className="badge sev-ok" title="Ordem de compra usada no lançamento do Senior">{lancada.join(', ')}</span>;
  if (l.oc_documento) {
    return abertas.some((o) => o.numocp === l.oc_documento)
      ? <span className="badge sev-ok" title={`OC citada na nota e em aberto no Senior:\n${dica}`}>{l.oc_documento} ✓</span>
      : <span className="badge sev-alerta" title={`OC citada na nota, mas não está em aberto no Senior para este fornecedor/empresa${abertas.length ? `. Em aberto:\n${dica}` : ''}`}>{l.oc_documento} ?</span>;
  }
  if (provavel) return <span className="badge sev-conferencia" title={`Sugestão: OC em aberto no Senior com o mesmo valor da nota (conferir):\n${dica}`}>provável {provavel.numocp}</span>;
  if (abertas.length) return <span className="tag" title={`OCs em aberto deste fornecedor no Senior:\n${dica}`}>{abertas.length} em aberto</span>;
  return <span className="muted">—</span>;
}
/**
 * Situação do pagamento pelos títulos a pagar do Senior: a resposta a "esta NF já foi paga?".
 * `semTitulo` deixa explícito que não há título (em coluna própria, célula vazia não diz nada).
 */
export function PagamentoSenior({ l, semTitulo }) {
  const p = l.senior_pagamento;
  if (!p) return semTitulo ? <span className="muted pequeno" title="Nenhum título a pagar lançado no Senior para esta nota">sem título</span> : null;
  const hoje = new Date().toLocaleDateString('sv-SE');
  if (p === 'pago') return <span className="badge sev-ok" title="Títulos baixados no Senior">Pago{l.senior_data_pagamento ? ` ${data(l.senior_data_pagamento)}` : ''}</span>;
  const vencido = l.senior_vencimento && l.senior_vencimento < hoje;
  const rotulo = p === 'em_pagamento' ? 'Em pagamento' : 'A pagar';
  return <span className={`badge ${vencido ? 'sev-erro' : p === 'em_pagamento' ? 'sev-conferencia' : 'sev-alerta'}`} title="Título a pagar no Senior">{rotulo}{l.senior_vencimento ? ` · venc. ${data(l.senior_vencimento)}` : ''}</span>;
}

/** Situação da nota no Senior (conciliação com as notas de entrada lançadas). */
export function SeniorBadge({ s, titulo }) {
  if (s === 'lancada') return <span className="badge sev-ok" title={titulo ?? 'Lançada no Senior'}>✓ Lançada</span>;
  if (s === 'nao_lancada') return <span className="badge sev-alerta" title="Não encontrada nas notas de entrada do Senior">Não lançada</span>;
  return <span className="muted pequeno" title="Ainda não conferida no Senior">—</span>;
}

export const TIPOS_DOC ={ NFE: 'NF-e', NFCE: 'NFC-e', CTE: 'CT-e', NFSE: 'NFS-e', OUTRO: 'Outro' };
export const PRIORIDADE = { 1: 'Alta', 2: 'Média-alta', 3: 'Média', 4: 'Baixa', 5: 'Mínima' };
export const PERFIS = { admin: 'Administrador', membro: 'Membro', fiscal: 'Fiscal', consulta: 'Consulta', auditor: 'Auditor', financeiro: 'Financeiro' };

// ------------------------------------------------------------------ ícones (traço 1.8)
const caminhos = {
  painel: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  fila: 'M4 6h16M4 12h16M4 18h10',
  docs: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  email: 'M3 6h18v12H3zM3 7l9 6 9-6',
  empresa: 'M4 21V5l8-2v18M12 8h8v13M8 9v.01M8 13v.01M8 17v.01M16 12v.01M16 16v.01',
  regras: 'M9 11l2 2 4-4M5 4h14v16H5z',
  relatorio: 'M4 20V10m6 10V4m6 16v-8m4 8H2',
  usuarios: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6zM22 19v-1a4 4 0 00-3-3.87M16 4.13a4 4 0 010 7.75',
  auditoria: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  erp: 'M8 7h11l-3-3m3 3l-3 3M16 17H5l3 3m-3-3l3-3',
  ia: 'M12 3v3m0 12v3m9-9h-3M6 12H3m14.5-6.5l-2 2m-7 7l-2 2m11 0l-2-2m-7-7l-2-2M12 9a3 3 0 100 6 3 3 0 000-6z',
  sair: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  seta: 'M9 6l6 6-6 6',
  voltar: 'M15 6l-6 6 6 6',
  download: 'M12 4v12m0 0l-4-4m4 4l4-4M4 20h16',
  sync: 'M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0012 2.5L20 14M18.5 9a7 7 0 00-12-2.5L4 10',
};
export function Icone({ nome, tam = 17 }) {
  return (
    <svg width={tam} height={tam} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={caminhos[nome]} />
    </svg>
  );
}

// ------------------------------------------------------------------ blocos
export function Cartao({ titulo, sub, acoes, children, className = '', semPadding, style }) {
  return (
    <section className={`cartao ${className}`} style={style}>
      {(titulo || acoes) && (
        <div className="cartao-topo">
          <h2>{titulo}{sub && <span className="sub">{sub}</span>}</h2>
          {acoes}
        </div>
      )}
      <div className={`cartao-corpo ${semPadding ? 'sem-padding' : ''}`}>{children}</div>
    </section>
  );
}

export function Kpi({ rotulo, valor, detalhe, cor, onClick, titulo }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="kpi" style={{ '--kpi-cor': cor }} onClick={onClick} title={titulo}>
      <span className="rotulo">{rotulo}</span>
      <span className="valor">{valor ?? '—'}</span>
      {detalhe && <span className="detalhe">{detalhe}</span>}
    </Tag>
  );
}

export function Campo({ rotulo, children, style }) {
  return <label className="campo" style={style}><span>{rotulo}</span>{children}</label>;
}

export function Modal({ titulo, onFechar, children, rodape, largo }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onFechar?.();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onFechar]);
  return (
    <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && onFechar?.()}>
      <div className={`modal ${largo ? 'largo' : ''}`} role="dialog" aria-modal="true" aria-label={titulo}>
        <header><h2>{titulo}</h2><button className="btn ghost pequeno" onClick={onFechar} aria-label="Fechar">✕</button></header>
        <div className="corpo">{children}</div>
        {rodape && <footer>{rodape}</footer>}
      </div>
    </div>
  );
}

export const Carregando = ({ texto = 'Carregando…' }) => <div className="carregando">{texto}</div>;
export const Vazio = ({ texto = 'Nenhum registro encontrado.' }) => <div className="vazio">{texto}</div>;

// ------------------------------------------------------------------ notificações
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const avisar = useCallback((msg, tipo = 'ok') => {
    setT({ msg, tipo, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!t) return undefined;
    const h = setTimeout(() => setT(null), 4500);
    return () => clearTimeout(h);
  }, [t]);
  return (
    <ToastCtx.Provider value={avisar}>
      {children}
      {t && <div className={`toast ${t.tipo === 'erro' ? 'erro' : ''}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ dados
/**
 * Guarda os filtros da tela (a query string) na sessão do navegador e os devolve
 * quando se volta para ela sem filtros na URL — sair da tela e voltar não perde o que estava filtrado.
 * `ignorar`: parâmetros que não contam como filtro, como a aba ativa.
 */
export function filtrosLembrados(chave) {
  try { return sessionStorage.getItem(`filtros:${chave}`) ?? ''; } catch { return ''; }
}

export function useFiltrosLembrados(chave, ignorar = []) {
  const [params, setParams] = useSearchParams();
  const atual = params.toString();
  const primeira = useRef(true);
  useEffect(() => {
    const agora = new URLSearchParams(atual);
    const semFiltros = [...agora.keys()].every((k) => ignorar.includes(k));
    if (primeira.current) {
      primeira.current = false;
      const salvo = filtrosLembrados(chave);
      if (semFiltros && salvo) {
        const novo = new URLSearchParams(salvo);
        for (const k of ignorar) (agora.get(k) ? novo.set(k, agora.get(k)) : novo.delete(k));
        setParams(novo, { replace: true });
        return;  // grava no ciclo seguinte, já com os filtros restaurados
      }
    }
    try { sessionStorage.setItem(`filtros:${chave}`, atual); } catch { /* sessão indisponível: segue sem lembrar */ }
  }, [atual]);
}

// ------------------------------------------------- última cópia de cada consulta
// Toda consulta guarda o resultado na memória e no IndexedDB do navegador. Abrir o app de novo
// mostra a última visão na hora, sem tela de "Carregando": nada é buscado por conta própria,
// quem decide quando ir ao banco/Senior é o botão "Atualizar" no topo da tela.
//
// IndexedDB e não localStorage porque telas como "Pendentes de lançamento" devolvem até 20 mil
// notas — alguns megabytes, muito acima dos ~5 MB que o localStorage inteiro comporta.
// Nome da consulta quando a chamada não passa `memoria`: um resumo do próprio código da função,
// que é estável enquanto o código não muda. Duas telas que fazem exatamente a mesma chamada
// (/referencias, por exemplo) caem na mesma cópia de propósito — é a mesma requisição.
const assinar = (texto) => {
  let h = 5381;
  for (let i = 0; i < texto.length; i += 1) h = (h * 33 + texto.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const memoriaDados = new Map();
const MEMORIA_MAX = 40;        // cópias mantidas (nas duas pontas: memória e banco)
const DIAS_VALIDADE = 7;       // cópia mais velha que isso não vale mais a pena guardar
const BANCO = 'vf_copias';
const LOJA = 'telas';
const PREFIXO_ANTIGO = 'vf_copia:';  // onde as cópias ficavam antes; limpo na primeira abertura

let bancoPromessa = null;
function abrirBanco() {
  if (bancoPromessa) return bancoPromessa;
  bancoPromessa = new Promise((ok, falhou) => {
    if (typeof indexedDB === 'undefined') { falhou(new Error('sem IndexedDB')); return; }
    const req = indexedDB.open(BANCO, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(LOJA)) req.result.createObjectStore(LOJA); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => falhou(req.error);
    req.onblocked = () => falhou(new Error('banco bloqueado'));
  }).catch((e) => { bancoPromessa = null; throw e; });
  return bancoPromessa;
}

function comLoja(modo, usar) {
  return abrirBanco().then((db) => new Promise((ok, falhou) => {
    const tx = db.transaction(LOJA, modo);
    const pedido = usar(tx.objectStore(LOJA));
    tx.oncomplete = () => ok(pedido?.result);
    tx.onerror = () => falhou(tx.error);
    tx.onabort = () => falhou(tx.error);
  }));
}

/**
 * Traz as cópias guardadas para a memória. Roda uma vez na abertura do app, antes das telas
 * aparecerem — assim `lerCopia` responde na hora e nenhuma tela precisa piscar "Carregando".
 */
let prontidao = null;
export function carregarCopias() {
  if (prontidao) return prontidao;
  prontidao = comLoja('readonly', (loja) => loja.getAll()).then((lista) => {
    const limite = Date.now() - DIAS_VALIDADE * 86400000;
    const vivas = (lista ?? []).filter((c) => c?.chave && c.em > limite).sort((a, b) => a.em - b.em);
    const velhas = (lista ?? []).filter((c) => !c?.chave || c.em <= limite);
    for (const c of vivas.slice(-MEMORIA_MAX)) memoriaDados.set(c.chave, { dados: c.dados, em: c.em });
    const descartar = [...velhas, ...vivas.slice(0, Math.max(0, vivas.length - MEMORIA_MAX))];
    if (descartar.length) {
      comLoja('readwrite', (loja) => { for (const c of descartar) if (c?.chave) loja.delete(c.chave); }).catch(() => {});
    }
  }).catch(() => { /* sem IndexedDB (janela anônima, por exemplo): as cópias valem só nesta sessão */ });
  // cópias da versão anterior, que usava localStorage e não dava conta das telas grandes
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIXO_ANTIGO)) localStorage.removeItem(k);
    }
  } catch { /* sem storage */ }
  return prontidao;
}

/** Apaga as cópias guardadas (usado ao sair: os dados de um usuário não ficam para o próximo). */
export function limparCopias() {
  memoriaDados.clear();
  comLoja('readwrite', (loja) => loja.clear()).catch(() => {});
}

function lerCopia(chave) {
  return memoriaDados.get(chave);
}

function guardarCopia(chave, dados) {
  const copia = { dados, em: Date.now() };
  memoriaDados.delete(chave);
  memoriaDados.set(chave, copia);
  const sobrando = [];
  while (memoriaDados.size > MEMORIA_MAX) {
    const maisVelha = memoriaDados.keys().next().value;
    memoriaDados.delete(maisVelha);
    sobrando.push(maisVelha);
  }
  comLoja('readwrite', (loja) => {
    loja.put({ chave, dados, em: copia.em }, chave);
    for (const k of sobrando) loja.delete(k);
  }).catch(() => { /* banco cheio ou indisponível: a cópia vale nesta sessão */ });
  return copia;
}

// --------------------------------------------- registro das consultas da tela aberta
// Cada useDados se anuncia aqui enquanto está montado. A barra do topo usa esse registro
// para saber se há atualização em andamento, desde quando os dados são e o que recarregar.
const fontes = new Map();
const ouvintes = new Set();
let proximaFonte = 0;

function anunciarFonte(id, info) {
  if (info) fontes.set(id, info); else fontes.delete(id);
  for (const avisar of ouvintes) avisar();
}

/**
 * Carrega dados da API e expõe { dados, erro, carregando, em, recarregar }.
 *
 * A tela nunca busca sozinha: na abertura mostra a última cópia guardada e só vai à origem
 * quando não existe cópia ou quando alguém pede (botão "Atualizar" → `recarregar`).
 * `automatico` (padrão) mantém a tela em dia depois de gravações feitas aqui mesmo;
 * consultas pesadas (Senior, SEFAZ) passam `automatico: false` e só atualizam sob demanda.
 * `memoria` dá um nome fixo à consulta; sem ele a chave sai do próprio código da função.
 */
export function useDados(fn, deps = [], { automatico = true, memoria = null } = {}) {
  const usuarioId = useContext(AuthCtx)?.usuario?.id ?? 'anonimo';
  const assinatura = useRef(null);
  if (assinatura.current === null) assinatura.current = memoria ?? assinar(String(fn));
  const chaveFiltros = JSON.stringify(deps);
  const chaveCopia = `${usuarioId}|${assinatura.current}|${chaveFiltros}`;
  // `chave` = filtros a que os dados na tela pertencem: se for diferente dos atuais, a tela está trocando de período/filtro
  const [estado, setEstado] = useState(() => {
    const guardado = lerCopia(chaveCopia);
    return { dados: guardado?.dados ?? null, chave: guardado ? chaveFiltros : null, em: guardado?.em ?? null, erro: null, carregando: !guardado };
  });
  const ultimoN = useRef(0);
  const [n, setN] = useState(0);
  const [silencioso, setSilencioso] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // "Atualizar" pede dados novos de verdade: a função recebe { forcar } para furar o cache do servidor
  const forcar = useRef(false);
  useEffect(() => {
    let vivo = true;
    const guardado = forcar.current ? undefined : lerCopia(chaveCopia);
    // Abriu a tela (ou voltou a um filtro) com cópia guardada: mostra e não consulta.
    // "Atualizar" e gravações (n mudou) sempre consultam.
    const pedidoExplicito = n !== ultimoN.current;
    ultimoN.current = n;
    if (guardado && !pedidoExplicito) {
      setEstado({ dados: guardado.dados, chave: chaveFiltros, em: guardado.em, erro: null, carregando: false });
      return undefined;
    }
    setEstado((e) => (guardado
      ? { ...e, dados: guardado.dados, chave: chaveFiltros, em: guardado.em, carregando: true }
      : { ...e, carregando: true }));
    const pedido = fnRef.current({ forcar: forcar.current });
    forcar.current = false;
    pedido.then((dados) => {
      const copia = guardarCopia(chaveCopia, dados);
      if (vivo) setEstado({ dados, chave: chaveFiltros, em: copia.em, erro: null, carregando: false });
    }).catch((erro) => {
      // a última cópia continua valendo na tela; o erro aparece ao lado
      if (vivo) setEstado((e) => ({ ...e, erro, carregando: false }));
    });
    return () => { vivo = false; };
  }, [chaveCopia, n]);
  useEffect(() => {
    if (!silencioso) return undefined;
    let vivo = true;
    fnRef.current({}).then((dados) => {
      const copia = guardarCopia(chaveCopia, dados);
      if (vivo) setEstado({ dados, chave: chaveFiltros, em: copia.em, erro: null, carregando: false });
    }).catch(() => {});
    return () => { vivo = false; };
  }, [silencioso]);
  useEffect(() => {
    // Gravações feitas na própria tela (conciliar, decidir, salvar) atualizam o que está à vista.
    // Não há mais relógio nem recarga ao voltar para a aba: a tela só muda quando alguém pede.
    if (!automatico) return undefined;
    const atualizar = () => setSilencioso((x) => x + 1);
    window.addEventListener('dados-alterados', atualizar);
    return () => window.removeEventListener('dados-alterados', atualizar);
  }, [automatico]);

  const recarregar = useCallback(() => { forcar.current = true; setN((x) => x + 1); }, []);
  // relê pela API sem furar o cache do servidor (ex.: depois de salvar uma configuração local)
  const atualizar = useCallback(() => setN((x) => x + 1), []);

  const idFonte = useRef(null);
  if (idFonte.current === null) { proximaFonte += 1; idFonte.current = `f${proximaFonte}`; }
  useEffect(() => {
    anunciarFonte(idFonte.current, { carregando: estado.carregando, em: estado.em, recarregar });
  }, [estado.carregando, estado.em, recarregar]);
  useEffect(() => () => anunciarFonte(idFonte.current, null), []);

  return {
    ...estado,
    // dados na tela são de outro período/filtro e os novos ainda estão chegando
    trocando: estado.carregando && estado.dados != null && estado.chave !== chaveFiltros,
    recarregar,
    atualizar,
  };
}

/**
 * Botão "Atualizar" da tela, no canto superior direito: recarrega de uma vez todas as
 * consultas da página aberta e mostra desde quando são os dados que estão à vista.
 */
export function BarraAtualizacao() {
  const [, redesenhar] = useState(0);
  useEffect(() => {
    const avisar = () => redesenhar((x) => x + 1);
    ouvintes.add(avisar);
    return () => { ouvintes.delete(avisar); };
  }, []);
  const lista = [...fontes.values()];
  if (!lista.length) return null;
  const ocupado = lista.some((f) => f.carregando);
  // a tela é tão antiga quanto a sua consulta mais antiga
  const em = lista.reduce((velho, f) => (f.em && (!velho || f.em < velho) ? f.em : velho), 0);
  const atualizarTudo = () => { for (const f of [...fontes.values()]) f.recarregar(); };
  return (
    <div className="barra-atualizacao">
      {ocupado
        ? <span className="atualizacao-estado" role="status" aria-live="polite"><span className="girando" aria-hidden />Atualização em andamento…</span>
        : <span className="atualizacao-estado muted">{em ? `Atualizado em ${dataHoraCompleta(em)}` : 'Sem dados carregados ainda'}</span>}
      <button type="button" className="btn pequeno" onClick={atualizarTudo} disabled={ocupado}
        title="Busca os dados novos no banco e nas integrações (Senior, SEFAZ). Até clicar aqui, a tela mostra a última cópia.">
        <Icone nome="sync" tam={14} />{ocupado ? 'Atualizando…' : 'Atualizar'}
      </button>
    </div>
  );
}

function dataHoraCompleta(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Faixa fixa no topo enquanto a tela busca outro período/filtro (o conteúdo antigo fica esmaecido). */
export function AvisoCarregando({ ativo, texto = 'Carregando os dados do novo filtro…' }) {
  if (!ativo) return null;
  return (
    <div className="aviso-carregando" role="status" aria-live="polite">
      <span className="girando" aria-hidden />{texto}
      <span className="muted pequeno">consultando o Senior; pode levar alguns segundos na primeira vez</span>
    </div>
  );
}

export function Erro({ erro }) {
  if (!erro) return null;
  return <div className="aviso erro">⚠ {erro.message || String(erro)}</div>;
}

/** Tabela com cabeçalho ordenável opcional. colunas: [{ campo, titulo, render?, classe?, ordenavel? }] */
export function Tabela({ colunas, linhas, onClique, ordem, onOrdenar, vazio, chave = 'id', classeLinha }) {
  if (!linhas?.length) return <Vazio texto={vazio} />;
  return (
    <div className="tabela-wrap">
      <table className="tabela">
        <thead>
          <tr>
            {colunas.map((c) => (
              <th key={c.campo} className={`${c.classe ?? ''} ${c.ordenavel && onOrdenar ? 'ordenavel' : ''}`}
                onClick={c.ordenavel && onOrdenar ? () => onOrdenar(c.ordenavel === true ? c.campo : c.ordenavel) : undefined}>
                {c.titulo}{ordem && c.ordenavel && ordem.campo === (c.ordenavel === true ? c.campo : c.ordenavel) ? (ordem.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l, i) => (
            <tr key={l[chave] ?? i} className={`${onClique ? 'clicavel' : ''} ${classeLinha?.(l) ?? ''}`} onClick={onClique ? () => onClique(l) : undefined}>
              {colunas.map((c) => <td key={c.campo} className={c.classe}>{c.render ? c.render(l) : (l[c.campo] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
