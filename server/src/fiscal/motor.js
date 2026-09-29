// Motor de validação fiscal: executa as regras ativas e grava VALIDAÇÕES e ALERTAS,
// separados dos dados extraídos. Nunca altera dados fiscais do documento.
import { all, get, getConfig, insert, parseJSON, run, tx, update } from '../db/index.js';
import { log } from '../util/log.js';
import { REGRAS, REGRAS_POR_CODIGO } from './regras.js';
import { sugerirCfopEntrada } from './tabelas.js';
import { perfilFornecedor } from './historico.js';
import { dataHoraLocal, lerDataLocal } from '../util/data.js';

const STATUS_DECIDIDOS = ['APROVADA', 'REJEITADA', 'NAO_FISCAL', 'CORRECAO_SOLICITADA'];
const CATEGORIAS_QUE_EXIGEM_XML = ['valores', 'icms', 'pis_cofins', 'ipi', 'servicos', 'cadastro', 'historico'];

// Regras condicionais de exemplo (configuráveis pelo administrador na tela de Regras).
const REGRAS_CONDICIONAIS_EXEMPLO = [
  {
    codigo: 'COND_ISS_ALIQUOTA_MAXIMA', nome: 'ISS limitado a 5% (LC 116/2003)', categoria: 'personalizada', severidade: 'erro', ativo: 1,
    descricao: 'Regra condicional de exemplo: a alíquota de ISS não pode exceder 5%.',
    definicao: {
      escopo: 'item',
      condicoes: [{ campo: 'impostos.ISS.aliquota', operador: 'existe' }],
      exigencias: [{ campo: 'impostos.ISS.aliquota', operador: 'lte', valor: 5 }],
      problema: 'Alíquota de ISS acima do máximo legal de 5%',
      acao_sugerida: 'Solicitar cancelamento e reemissão da NFS-e ao prestador.',
    },
  },
  {
    codigo: 'COND_COMBUSTIVEL_ST', nome: 'Combustíveis (NCM 2710) com ICMS retido', categoria: 'personalizada', severidade: 'alerta', ativo: 1,
    descricao: 'Regra condicional de exemplo: derivados de petróleo devem vir com CST 60/61 ou CSOSN 500.',
    definicao: {
      escopo: 'item',
      condicoes: [{ campo: 'ncm', operador: 'comeca_com', valor: '2710' }],
      exigencias: [{ campo: 'impostos.ICMS.cst', operador: 'em', valor: ['60', '61', '500'] }],
      problema: 'Combustível sem tributação monofásica/retida de ICMS',
      acao_sugerida: 'Confirmar a tributação do combustível com o fornecedor.',
    },
  },
];

/** Garante que todas as regras nativas existam na tabela (sem sobrescrever a configuração do administrador). */
export function sincronizarCatalogo() {
  for (const r of REGRAS) {
    const existe = get('SELECT id, parametros FROM regras_fiscais WHERE codigo = ?', [r.codigo]);
    if (!existe) {
      insert('regras_fiscais', {
        codigo: r.codigo, nome: r.nome, descricao: r.descricao, categoria: r.categoria, tipo: 'nativa',
        severidade: r.severidade, parametros: r.parametros ? JSON.stringify(r.parametros) : null,
      });
    } else if (r.parametros) {
      // acrescenta parâmetros novos preservando os valores já configurados
      const atual = parseJSON(existe.parametros, {});
      const mesclado = { ...r.parametros, ...atual };
      if (JSON.stringify(mesclado) !== existe.parametros) run('UPDATE regras_fiscais SET parametros = ? WHERE id = ?', [JSON.stringify(mesclado), existe.id]);
    }
  }
  if (!getConfig('regras_exemplo_criadas')) {
    for (const r of REGRAS_CONDICIONAIS_EXEMPLO) {
      if (!get('SELECT 1 FROM regras_fiscais WHERE codigo = ?', [r.codigo])) {
        insert('regras_fiscais', { ...r, tipo: 'condicional', definicao: JSON.stringify(r.definicao) });
      }
    }
    run("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('regras_exemplo_criadas', 'true')");
  }
}

// ------------------------------------------------------------------ contexto
export function carregarItens(documentoId) {
  const itens = all('SELECT * FROM documento_itens WHERE documento_id = ? ORDER BY n_item', [documentoId]);
  const impostos = all(`SELECT t.* FROM item_impostos t JOIN documento_itens i ON i.id = t.item_id WHERE i.documento_id = ?`, [documentoId]);
  const porItem = {};
  for (const t of impostos) (porItem[t.item_id] ??= {})[t.tributo] = t;
  return itens.map((i) => ({ ...i, impostos: porItem[i.id] ?? {} }));
}

function operacaoDoc(doc, extraido) {
  let a = doc.emitente_uf, b = doc.destinatario_uf;
  if (doc.tipo === 'CTE') { a = extraido.transporte?.uf_inicio; b = extraido.transporte?.uf_fim; }
  if (!a || !b) return null;
  if (a === 'EX' || b === 'EX') return 'exterior';
  return a === b ? 'interna' : 'interestadual';
}

export function carregarContexto(documentoId) {
  const doc = get('SELECT * FROM documentos WHERE id = ?', [documentoId]);
  if (!doc) throw new Error(`Documento ${documentoId} não encontrado`);
  const extraido = parseJSON(doc.dados_extraidos, {});
  const itens = carregarItens(documentoId);
  const empresa = doc.empresa_id ? get('SELECT * FROM empresas WHERE id = ?', [doc.empresa_id]) : null;
  const fornecedor = doc.fornecedor_id ? get('SELECT * FROM fornecedores WHERE id = ?', [doc.fornecedor_id]) : null;
  const anexos = {
    xml: doc.xml_anexo_id ? get('SELECT id, nome_arquivo FROM anexos WHERE id = ?', [doc.xml_anexo_id]) : null,
    pdf: doc.pdf_anexo_id ? get('SELECT id, nome_arquivo, texto_extraido FROM anexos WHERE id = ?', [doc.pdf_anexo_id]) : null,
  };
  let hist;
  return {
    doc, extraido, itens, empresa, fornecedor, anexos,
    titulosSenior: all('SELECT * FROM senior_titulos WHERE documento_id = ? ORDER BY vencimento, numtit', [documentoId]),
    duplicatas: all('SELECT * FROM documento_duplicatas WHERE documento_id = ? ORDER BY vencimento', [documentoId]),
    operacao: operacaoDoc(doc, extraido),
    historico: () => (hist === undefined ? (hist = perfilFornecedor(doc.fornecedor_id, doc.id)) : hist),
  };
}

// ------------------------------------------------------------------ regras condicionais
function valorCampo(alvo, caminho) {
  return caminho.split('.').reduce((o, k) => (o == null ? undefined : o[k]), alvo);
}

const OPERADORES = {
  eq: (a, b) => String(a ?? '') === String(b ?? ''),
  ne: (a, b) => String(a ?? '') !== String(b ?? ''),
  em: (a, b) => (Array.isArray(b) ? b : String(b).split(',')).map(String).includes(String(a ?? '')),
  fora_de: (a, b) => !(Array.isArray(b) ? b : String(b).split(',')).map(String).includes(String(a ?? '')),
  comeca_com: (a, b) => (Array.isArray(b) ? b : [b]).some((p) => String(a ?? '').startsWith(String(p))),
  gt: (a, b) => a != null && Number(a) > Number(b),
  gte: (a, b) => a != null && Number(a) >= Number(b),
  lt: (a, b) => a != null && Number(a) < Number(b),
  lte: (a, b) => a != null && Number(a) <= Number(b),
  entre: (a, b) => a != null && Number(a) >= Number(b[0]) && Number(a) <= Number(b[1]),
  existe: (a) => a != null && a !== '',
  nao_existe: (a) => a == null || a === '',
  regex: (a, b) => new RegExp(b).test(String(a ?? '')),
};
export const OPERADORES_DISPONIVEIS = Object.keys(OPERADORES);

function avaliarCondicional(regra, ctx) {
  const def = parseJSON(regra.definicao, null);
  if (!def) return null;
  const alvos = def.escopo === 'documento' ? [null] : ctx.itens;
  const achados = [];
  let aplicavel = false;
  for (const item of alvos) {
    const escopo = {
      ...(item ?? {}), item, doc: ctx.doc, empresa: ctx.empresa ?? {}, fornecedor: ctx.fornecedor ?? {}, operacao: ctx.operacao,
    };
    const teste = (c) => OPERADORES[c.operador]?.(valorCampo(escopo, c.campo), c.valor) ?? false;
    if (!(def.condicoes || []).every(teste)) continue;
    aplicavel = true;
    const falhas = (def.exigencias || []).filter((c) => !teste(c));
    if (falhas.length) {
      achados.push({
        n_item: item?.n_item ?? null,
        problema: def.problema || regra.nome,
        valor_encontrado: falhas.map((c) => `${c.campo} = ${valorCampo(escopo, c.campo) ?? '—'}`).join('; '),
        valor_esperado: falhas.map((c) => `${c.campo} ${c.operador} ${Array.isArray(c.valor) ? c.valor.join(', ') : c.valor ?? ''}`).join('; '),
        acao_sugerida: def.acao_sugerida || 'Avaliar conforme política fiscal.',
      });
    }
  }
  return aplicavel ? achados : null;
}

// ------------------------------------------------------------------ execução
function regrasAtivas(empresaId) {
  return all('SELECT * FROM regras_fiscais WHERE ativo = 1 AND (empresa_id IS NULL OR empresa_id = ?) ORDER BY categoria, codigo', [empresaId ?? 0]);
}

/** Sugere CFOP de entrada por item (sugestão do motor; só vira escrituração quando o usuário confirma). */
function atualizarSugestoesCfop(ctx) {
  for (const it of ctx.itens) {
    const sug = sugerirCfopEntrada(it.cfop, { destinacao: ctx.fornecedor?.tipo_fornecedor, perfilEmpresa: ctx.empresa?.perfil_fiscal });
    if (sug !== it.cfop_entrada_sugerido) {
      run('UPDATE documento_itens SET cfop_entrada_sugerido = ? WHERE id = ?', [sug, it.id]);
      it.cfop_entrada_sugerido = sug;
    }
  }
}

function calcularStatus(doc, achados, duplicadoDe) {
  if (duplicadoDe) return 'DUPLICADA';
  // NFS-e: muitas prefeituras só enviam o PDF ao tomador — não fica "aguardando XML".
  if (doc.origem_dados !== 'xml' && doc.tipo !== 'NFSE') return 'AGUARDANDO_XML';
  if (achados.some((a) => a.severidade === 'erro' && a.status === 'aberta')) return 'INCONSISTENTE';
  return 'PENDENTE';
}

function calcularPrioridade(status, doc, achados, vencimento) {
  const valorAlto = (doc.v_total ?? 0) >= Number(getConfig('valor_prioridade_alta', 50000));
  if (status === 'DUPLICADA' || doc.situacao_sefaz === 'cancelada') return 1;
  // Título a pagar vencendo em até N dias: a validação fiscal precisa acontecer antes do pagamento.
  const diasVenc = vencimento ? (lerDataLocal(`${vencimento} 23:59:59`) - Date.now()) / 86400000 : null;
  if (diasVenc != null && diasVenc <= Number(getConfig('dias_vencimento_prioridade', 5)) && status !== 'APROVADA') return 1;
  if (status === 'INCONSISTENTE') return valorAlto ? 1 : 2;
  if (status === 'AGUARDANDO_XML') return 3;
  if (achados.some((a) => a.status === 'aberta' && a.severidade !== 'conferencia')) return valorAlto ? 2 : 3;
  return valorAlto ? 3 : 4;
}

/**
 * Executa o motor para um documento.
 * @param {object} opcoes.reabrir  Recalcula o status mesmo se o documento já tiver decisão do usuário (usado em "Reprocessar").
 */
export function executarMotor(documentoId, { reabrir = false } = {}) {
  return tx(() => {
    const ctx = carregarContexto(documentoId);
    const { doc } = ctx;
    atualizarSugestoesCfop(ctx);
    const execucao = (get('SELECT MAX(execucao) AS m FROM validacoes WHERE documento_id = ?', [documentoId]).m ?? 0) + 1;
    const anteriores = all("SELECT * FROM inconsistencias WHERE documento_id = ? AND status IN ('aberta','ignorada')", [documentoId]);
    const achados = [];

    for (const regra of regrasAtivas(doc.empresa_id)) {
      let resultado;
      try {
        if (regra.tipo === 'condicional') {
          resultado = avaliarCondicional(regra, ctx);
        } else {
          const nativa = REGRAS_POR_CODIGO[regra.codigo];
          if (!nativa) continue;
          if (nativa.aplicaA && !nativa.aplicaA.includes(doc.tipo)) resultado = null;
          // Dados lidos só do PDF são parciais: regras de valores/tributos aguardam o XML.
          else if (doc.origem_dados !== 'xml' && CATEGORIAS_QUE_EXIGEM_XML.includes(nativa.categoria)
            && !(doc.tipo === 'NFSE' && nativa.categoria === 'servicos')) resultado = null;
          else resultado = nativa.avaliar(ctx, { ...(nativa.parametros ?? {}), ...parseJSON(regra.parametros, {}) });
        }
      } catch (e) {
        log('erro', 'motor', `Falha na regra ${regra.codigo} (doc ${documentoId}): ${e.message}`);
        resultado = null;
      }
      insert('validacoes', {
        documento_id: documentoId, execucao, regra_codigo: regra.codigo,
        resultado: resultado == null ? 'nao_aplicavel' : resultado.length ? 'falha' : 'ok',
        detalhe: resultado?.length ? `${resultado.length} ocorrência(s)` : null,
      });
      for (const a of resultado ?? []) {
        achados.push({
          ...a,
          regra_codigo: regra.codigo,
          regra_violada: `${regra.codigo} — ${regra.nome}`,
          categoria: regra.categoria,
          severidade: a.severidade && regra.severidade !== 'conferencia' ? a.severidade : regra.severidade,
          origem: regra.categoria === 'historico' ? 'HISTORICO' : 'MOTOR',
        });
      }
    }

    // Mantém alertas ignorados pelo usuário quando a mesma ocorrência se repete.
    const chave = (a) => `${a.regra_codigo}|${a.n_item ?? ''}|${a.valor_encontrado ?? ''}`;
    const ignoradas = new Map(anteriores.filter((a) => a.status === 'ignorada').map((a) => [chave(a), a]));
    run("UPDATE inconsistencias SET status = 'resolvida', tratada_em = datetime('now','localtime'), justificativa = COALESCE(justificativa, 'Não reproduzida na reexecução do motor') WHERE documento_id = ? AND status IN ('aberta','ignorada')", [documentoId]);

    let duplicadoDe = null;
    for (const a of achados) {
      const ign = ignoradas.get(chave(a));
      a.status = ign ? 'ignorada' : 'aberta';
      if (a.regra_codigo === 'NUMERO_SERIE_DUPLICADO' && !ign && a.dados?.duplicado_de_id) duplicadoDe = a.dados.duplicado_de_id;
      insert('inconsistencias', {
        documento_id: documentoId, execucao, origem: a.origem, regra_codigo: a.regra_codigo, severidade: a.severidade,
        categoria: a.categoria, n_item: a.n_item ?? null, problema: a.problema, regra_violada: a.regra_violada,
        valor_encontrado: a.valor_encontrado != null ? String(a.valor_encontrado) : null,
        valor_esperado: a.valor_esperado != null ? String(a.valor_esperado) : null,
        contexto: a.contexto ?? null, acao_sugerida: a.acao_sugerida ?? null, status: a.status,
        tratada_por: ign?.tratada_por ?? null, justificativa: ign?.justificativa ?? null, tratada_em: ign?.tratada_em ?? null,
      });
    }

    const statusCalculado = calcularStatus(doc, achados, duplicadoDe);
    const manterDecisao = STATUS_DECIDIDOS.includes(doc.status) && !reabrir;
    let novoStatus = manterDecisao ? doc.status : statusCalculado;

    const autoAprovar = getConfig('auto_aprovar_sem_alertas', false);
    const semPendencias = !achados.some((a) => a.status === 'aberta');
    if (!manterDecisao && autoAprovar && novoStatus === 'PENDENTE' && semPendencias) novoStatus = 'APROVADA';

    const prazoDias = Number(getConfig('prazo_validacao_dias', 3));
    const vencimento = get("SELECT MIN(vencimento) AS v FROM documento_duplicatas WHERE documento_id = ? AND status_pagamento IN ('aberta','programada')", [documentoId]).v
      ?? get("SELECT MIN(vencimento) AS v FROM senior_titulos WHERE documento_id = ? AND situacao_grupo IN ('aberto','em_pagamento')", [documentoId]).v;
    let prazo = doc.prazo ?? dataHoraLocal(new Date(lerDataLocal(doc.recebido_em).getTime() + prazoDias * 86400000)).slice(0, 10);
    // Prazo de validação nunca depois da véspera do primeiro vencimento
    if (vencimento) {
      const vespera = dataHoraLocal(new Date(lerDataLocal(`${vencimento} 12:00:00`).getTime() - 86400000)).slice(0, 10);
      if (vespera < prazo) prazo = vespera;
    }
    update('documentos', documentoId, {
      status: novoStatus,
      duplicado_de_id: duplicadoDe,
      bloqueada: novoStatus === 'DUPLICADA' || doc.situacao_sefaz === 'cancelada' ? 1 : 0,
      prioridade: calcularPrioridade(novoStatus, doc, achados, vencimento),
      prazo,
      validado_em: dataHoraLocal(),
      updated_at: dataHoraLocal(),
    });
    if (novoStatus !== doc.status) {
      insert('decisoes', {
        documento_id: documentoId, usuario_id: null, acao: 'SISTEMA',
        justificativa: novoStatus === 'APROVADA' ? 'Aprovação automática: nenhuma ocorrência (configuração ativa)' : `Motor fiscal (execução ${execucao})`,
        status_anterior: doc.status, status_novo: novoStatus,
      });
    }
    return { execucao, status: novoStatus, achados: achados.length };
  });
}

/** Status "calculado" de um documento considerando alertas ignorados/tratados (usado após decisão do usuário). */
export function recalcularStatusAposTratamento(documentoId) {
  const doc = get('SELECT * FROM documentos WHERE id = ?', [documentoId]);
  if (STATUS_DECIDIDOS.includes(doc.status) || ['DUPLICADA', 'AGUARDANDO_XML'].includes(doc.status)) return doc.status;
  const abertosErro = get("SELECT COUNT(*) AS n FROM inconsistencias WHERE documento_id = ? AND status = 'aberta' AND severidade = 'erro'", [documentoId]).n;
  const novo = abertosErro ? 'INCONSISTENTE' : 'PENDENTE';
  if (novo !== doc.status) run("UPDATE documentos SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [novo, documentoId]);
  return novo;
}
