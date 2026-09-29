// Catálogo de regras nativas do motor fiscal.
// Cada regra devolve: null (não aplicável) | [] (ok) | [achados] (falhas).
// Achado: { n_item?, problema, valor_encontrado, valor_esperado, contexto?, acao_sugerida, severidade? }
// Severidade: erro (bloqueia -> COM INCONSISTÊNCIA) | alerta | conferencia (ponto de conferência, não é erro fiscal).
// Parâmetros e severidade são configuráveis pelo administrador (tabela regras_fiscais).

import { all } from '../db/index.js';
import { brl, pct, quaseIgual, r2, soma } from '../util/num.js';
import { documentoValido, problemasChave, raizCnpj, formatarCnpj } from './validadores.js';
import {
  ALIQUOTA_INTERNA_PADRAO, CSOSN, CST_ICMS, CST_ICMS_COM_ST, CST_ICMS_TRIBUTADO, CST_IPI, CST_IPI_SAIDA,
  CST_PIS_COFINS, CST_PIS_COFINS_SAIDA, DESCRICAO_CFOP, aliquotaInterestadual, direcaoCfop, naturezaCfop, sugerirCfopEntrada,
} from './tabelas.js';

const MERCADORIA = ['NFE', 'NFCE'];
const COM_CHAVE = ['NFE', 'NFCE', 'CTE'];
const TODOS = ['NFE', 'NFCE', 'CTE', 'NFSE', 'OUTRO'];
const descCfop = (c) => (DESCRICAO_CFOP[c] ? `${c} (${DESCRICAO_CFOP[c]})` : c);
const imp = (item, t) => item.impostos?.[t];
const temValor = (v) => v != null && Math.abs(v) > 0.00001;

/** Verifica base x alíquota = valor para um tributo em cada item. */
function conferirCalculo(ctx, tributo, p) {
  const achados = [];
  let aplicavel = false;
  for (const it of ctx.itens) {
    const t = imp(it, tributo);
    if (!t || !temValor(t.aliquota) || t.base == null || t.valor == null) continue;
    aplicavel = true;
    const esperado = r2(t.base * t.aliquota / 100);
    if (!quaseIgual(esperado, t.valor, p.tolerancia)) {
      achados.push({
        n_item: it.n_item,
        problema: `${tributo} do item ${it.n_item} não confere com base × alíquota`,
        valor_encontrado: brl(t.valor),
        valor_esperado: brl(esperado),
        contexto: `Base ${brl(t.base)} × ${pct(t.aliquota)} = ${brl(esperado)}. Diferença de ${brl(r2((t.valor ?? 0) - esperado))}.`,
        acao_sugerida: `Conferir o destaque de ${tributo} com o fornecedor; se o valor destacado estiver incorreto, solicitar carta de correção/NF complementar ou considerar apenas o valor correto no crédito.`,
      });
    }
  }
  return aplicavel ? achados : null;
}

/** Soma de um campo dos itens x total do documento. */
function conferirTotal(ctx, campoTotal, fnItem, rotulo, p, acao) {
  const total = ctx.doc[campoTotal];
  const somaItens = r2(soma(ctx.itens, fnItem));
  if (total == null && somaItens === 0) return null;
  if (quaseIgual(total ?? 0, somaItens, p.tolerancia)) return [];
  return [{
    problema: `Soma de ${rotulo} dos itens difere do total da nota`,
    valor_encontrado: `Total da NF: ${brl(total ?? 0)}`,
    valor_esperado: `Soma dos itens: ${brl(somaItens)}`,
    contexto: `Diferença de ${brl(r2((total ?? 0) - somaItens))}.`,
    acao_sugerida: acao,
  }];
}

export const REGRAS = [
  // =========================================================== IDENTIFICAÇÃO
  {
    codigo: 'CHAVE_ACESSO', nome: 'Chave de acesso válida', categoria: 'identificacao', severidade: 'erro', aplicaA: COM_CHAVE,
    descricao: 'Valida formato, dígito verificador e coerência da chave com CNPJ, modelo, série, número e mês de emissão.',
    avaliar(ctx) {
      if (!ctx.doc.chave_acesso) {
        return [{ problema: 'Documento sem chave de acesso identificada', valor_encontrado: '—', valor_esperado: 'Chave de 44 posições', acao_sugerida: 'Solicitar o XML ao fornecedor ou informar a chave manualmente após conferência.' }];
      }
      return problemasChave(ctx.doc.chave_acesso, ctx.doc).map((p) => ({
        problema: 'Chave de acesso inconsistente', valor_encontrado: ctx.doc.chave_acesso, valor_esperado: p,
        acao_sugerida: 'Consultar a chave no portal da SEFAZ e confirmar a autenticidade do documento.',
      }));
    },
  },
  {
    codigo: 'CNPJ_EMITENTE', nome: 'CNPJ/CPF do emitente válido', categoria: 'identificacao', severidade: 'erro', aplicaA: TODOS,
    descricao: 'Valida os dígitos verificadores do CNPJ (numérico ou alfanumérico) ou CPF do emitente.',
    avaliar(ctx) {
      const c = ctx.doc.emitente_cnpj;
      if (documentoValido(c)) return [];
      return [{ problema: 'CNPJ/CPF do emitente inválido ou ausente', valor_encontrado: c || '—', valor_esperado: 'CNPJ/CPF com dígitos verificadores válidos', acao_sugerida: 'Conferir os dados do emitente no documento e no cadastro da Receita Federal.' }];
    },
  },
  {
    codigo: 'CNPJ_DESTINATARIO', nome: 'CNPJ do destinatário/tomador válido', categoria: 'identificacao', severidade: 'erro', aplicaA: TODOS,
    descricao: 'Valida os dígitos verificadores do CNPJ/CPF do destinatário (ou tomador, no CT-e/NFS-e).',
    avaliar(ctx) {
      const c = ctx.doc.destinatario_cnpj;
      if (documentoValido(c)) return [];
      return [{ problema: 'CNPJ/CPF do destinatário inválido ou ausente', valor_encontrado: c || '—', valor_esperado: 'CNPJ válido de empresa do grupo', acao_sugerida: 'Verificar se o documento foi emitido para a empresa correta.' }];
    },
  },
  {
    codigo: 'DESTINATARIO_GRUPO', nome: 'Destinatário é empresa do grupo', categoria: 'identificacao', severidade: 'erro', aplicaA: TODOS,
    descricao: 'O CNPJ do destinatário deve corresponder a uma empresa cadastrada. Também confere a Inscrição Estadual.',
    avaliar(ctx) {
      if (!ctx.empresa) {
        return [{
          problema: 'Destinatário não corresponde a nenhuma empresa cadastrada do grupo',
          valor_encontrado: `${formatarCnpj(ctx.doc.destinatario_cnpj)} ${ctx.doc.destinatario_nome ?? ''}`.trim(),
          valor_esperado: 'CNPJ de uma empresa cadastrada', acao_sugerida: 'Verificar se o documento foi enviado por engano ou se é necessário cadastrar o estabelecimento.',
        }];
      }
      const ieDoc = (ctx.doc.destinatario_ie || '').replace(/\D/g, ''), ieEmp = (ctx.empresa.ie || '').replace(/\D/g, '');
      if (ctx.doc.tipo !== 'NFSE' && ieDoc && ieEmp && ieDoc !== ieEmp) {
        return [{ severidade: 'alerta', problema: 'Inscrição Estadual do destinatário difere do cadastro da empresa', valor_encontrado: ctx.doc.destinatario_ie, valor_esperado: ctx.empresa.ie, acao_sugerida: 'Confirmar a IE do estabelecimento com o fornecedor; IE incorreta pode comprometer o crédito de ICMS.' }];
      }
      return [];
    },
  },
  {
    codigo: 'NUMERO_SERIE_DUPLICADO', nome: 'Número/série duplicados', categoria: 'identificacao', severidade: 'erro', aplicaA: TODOS,
    descricao: 'Detecta outro documento do mesmo emitente com o mesmo número e série (possível duplicidade com chave diferente).',
    avaliar(ctx) {
      if (!ctx.doc.numero || !ctx.doc.emitente_cnpj) return null;
      const outros = all(`SELECT id, chave_acesso, status FROM documentos WHERE emitente_cnpj = ? AND numero = ? AND COALESCE(serie,'') = COALESCE(?, '')
        AND tipo = ? AND id <> ? AND id < ? AND status NOT IN ('REJEITADA')`,
      [ctx.doc.emitente_cnpj, ctx.doc.numero, ctx.doc.serie, ctx.doc.tipo, ctx.doc.id, ctx.doc.id]);
      // Documento lido de PDF com mesma chave de um XML já existente é tratado na ingestão (mesclagem), não aqui.
      return outros.map((o) => ({
        problema: 'Possível NF duplicada: mesmo emitente, número e série já recebidos',
        valor_encontrado: `NF ${ctx.doc.numero}/${ctx.doc.serie ?? '-'} (este documento)`,
        valor_esperado: 'Número/série únicos por emitente',
        contexto: `Documento anterior #${o.id} (${o.status})${o.chave_acesso && o.chave_acesso !== ctx.doc.chave_acesso ? ` com chave diferente: ${o.chave_acesso}` : ''}.`,
        acao_sugerida: 'Comparar os dois documentos. Se for reemissão, manter apenas o válido e reprovar o outro.',
        dados: { duplicado_de_id: o.id },
      }));
    },
  },
  {
    codigo: 'SITUACAO_SEFAZ', nome: 'Documento autorizado', categoria: 'identificacao', severidade: 'erro', aplicaA: COM_CHAVE,
    descricao: 'O XML deve conter protocolo de autorização. Eventos de cancelamento recebidos marcam o documento como cancelado.',
    avaliar(ctx) {
      const s = ctx.doc.situacao_sefaz;
      if (ctx.doc.origem_dados !== 'xml') return null;
      if (s === 'cancelada') return [{ problema: 'Documento CANCELADO pelo emitente (evento de cancelamento recebido)', valor_encontrado: 'Cancelada', valor_esperado: 'Autorizada', acao_sugerida: 'Não escriturar. Confirmar o cancelamento no portal da SEFAZ e reprovar o documento.' }];
      if (s === 'sem_protocolo') return [{ severidade: 'alerta', problema: 'XML sem protocolo de autorização da SEFAZ', valor_encontrado: 'Sem protNFe/protCTe', valor_esperado: 'XML de distribuição (nfeProc/cteProc) com protocolo', acao_sugerida: 'Solicitar o XML autorizado ao fornecedor ou consultar a chave na SEFAZ.' }];
      if (s && s !== 'autorizada') return [{ problema: 'Situação do documento na SEFAZ não é "autorizada"', valor_encontrado: s, valor_esperado: 'cStat 100/150', acao_sugerida: 'Consultar a chave no portal da SEFAZ.' }];
      return [];
    },
  },
  {
    codigo: 'CARTA_CORRECAO', nome: 'Carta de correção recebida', categoria: 'identificacao', severidade: 'conferencia', aplicaA: COM_CHAVE,
    descricao: 'Sinaliza CC-e vinculadas ao documento para que o texto da correção seja considerado na escrituração.',
    avaliar(ctx) {
      const cces = all("SELECT texto, data_evento FROM documento_eventos WHERE documento_id = ? AND tp_evento = '110110' ORDER BY data_evento", [ctx.doc.id]);
      if (!cces.length) return null;
      return cces.map((c) => ({ problema: 'Carta de Correção Eletrônica vinculada ao documento', valor_encontrado: (c.texto ?? '').slice(0, 300), valor_esperado: '—', contexto: `CC-e de ${c.data_evento?.slice(0, 10) ?? '—'}`, acao_sugerida: 'Considerar a correção na escrituração. CC-e não pode alterar valores, base, alíquota, dados cadastrais ou data.' }));
    },
  },
  {
    codigo: 'XML_PDF_CORRESPONDENCIA', nome: 'XML corresponde ao PDF', categoria: 'identificacao', severidade: 'erro', aplicaA: TODOS,
    descricao: 'Quando XML e PDF (DANFE/DACTE) chegam juntos, a chave (ou número + CNPJ) do XML deve constar no PDF.',
    avaliar(ctx) {
      const pdf = ctx.anexos.pdf;
      if (!pdf || ctx.doc.origem_dados !== 'xml' || !pdf.texto_extraido) return null;
      const texto = pdf.texto_extraido.replace(/\D/g, '');
      const chave = (ctx.doc.chave_acesso || '').replace(/\D/g, '');
      if (chave.length === 44 && texto.includes(chave)) return [];
      if (ctx.doc.tipo === 'NFSE' && ctx.doc.numero && texto.includes(ctx.doc.emitente_cnpj?.replace(/\D/g, '') ?? '#')) return [];
      return [{ problema: 'O PDF anexado não corresponde ao XML', valor_encontrado: `PDF: ${pdf.nome_arquivo}`, valor_esperado: `Chave ${ctx.doc.chave_acesso ?? ctx.doc.numero} presente no PDF`, acao_sugerida: 'Verificar se o fornecedor enviou o DANFE de outra nota. Solicitar o PDF correto.' }];
    },
  },
  {
    codigo: 'DATA_EMISSAO', nome: 'Data de emissão coerente', categoria: 'identificacao', severidade: 'alerta', aplicaA: TODOS,
    parametros: { dias_max_atraso: 60 },
    descricao: 'Emissão no futuro é erro; emissão muito antiga gera alerta de prazo de escrituração.',
    avaliar(ctx, p) {
      if (!ctx.doc.data_emissao) return [{ problema: 'Data de emissão não identificada', valor_encontrado: '—', valor_esperado: 'Data de emissão', acao_sugerida: 'Conferir o documento.' }];
      const emissao = new Date(ctx.doc.data_emissao.slice(0, 10) + 'T12:00:00');
      const recebido = new Date(ctx.doc.recebido_em.replace(' ', 'T'));
      const dias = Math.floor((recebido - emissao) / 86400000);
      if (dias < -1) return [{ severidade: 'erro', problema: 'Data de emissão posterior ao recebimento', valor_encontrado: ctx.doc.data_emissao.slice(0, 10), valor_esperado: `Até ${ctx.doc.recebido_em.slice(0, 10)}`, acao_sugerida: 'Verificar o documento com o fornecedor.' }];
      if (dias > p.dias_max_atraso) return [{ problema: `Documento emitido há ${dias} dias`, valor_encontrado: ctx.doc.data_emissao.slice(0, 10), valor_esperado: `Emissão nos últimos ${p.dias_max_atraso} dias`, acao_sugerida: 'Verificar se a NF já foi escriturada e o prazo para aproveitamento de créditos.' }];
      return [];
    },
  },
  {
    codigo: 'ORIGEM_PDF', nome: 'Dados lidos do XML', categoria: 'identificacao', severidade: 'alerta', aplicaA: TODOS,
    descricao: 'Documentos lidos apenas do PDF têm dados parciais e de menor confiança; aguardam o XML.',
    avaliar(ctx) {
      if (ctx.doc.origem_dados === 'xml') return [];
      if (ctx.doc.tipo === 'NFSE') {
        return [{ severidade: 'conferencia', problema: 'NFS-e lida do PDF: conferir os dados com o documento', valor_encontrado: `Leitura automática do PDF (confiança ${Math.round((ctx.doc.confianca_extracao ?? 0) * 100)}%)`, valor_esperado: 'Número, prestador, valor e retenções conferidos', acao_sugerida: 'Abrir o PDF na aba Origem e confirmar número, valor líquido e retenções antes de lançar.' }];
      }
      return [{ problema: 'Documento recebido sem XML (dados extraídos do PDF)', valor_encontrado: `Origem: ${ctx.doc.origem_dados} (confiança ${Math.round((ctx.doc.confianca_extracao ?? 0) * 100)}%)`, valor_esperado: 'XML do documento fiscal', acao_sugerida: 'Solicitar o XML ao fornecedor. O documento será atualizado automaticamente quando o XML chegar.' }];
    },
  },

  // =========================================================== VALORES
  {
    codigo: 'SOMA_ITENS_PRODUTOS', nome: 'Soma dos itens = valor dos produtos', categoria: 'valores', severidade: 'erro', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'A soma dos valores brutos dos itens (vProd) deve ser igual ao total de produtos da nota.',
    avaliar(ctx, p) {
      if (!ctx.itens.length) return null;
      return conferirTotal(ctx, 'v_prod', (i) => i.valor_total, 'valores dos produtos', p, 'Conferir itens e totais do XML; divergência indica XML adulterado ou erro de emissão.');
    },
  },
  {
    codigo: 'QTD_X_UNITARIO', nome: 'Quantidade × valor unitário = valor do item', categoria: 'valores', severidade: 'alerta', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'Confere o valor total de cada item com quantidade × valor unitário.',
    avaliar(ctx, p) {
      const achados = [];
      for (const it of ctx.itens) {
        if (it.quantidade == null || it.valor_unitario == null) continue;
        const esperado = r2(it.quantidade * it.valor_unitario);
        const tol = Math.max(p.tolerancia, esperado * 0.0005);
        if (!quaseIgual(esperado, it.valor_total, tol)) {
          achados.push({ n_item: it.n_item, problema: `Valor do item ${it.n_item} difere de quantidade × unitário`, valor_encontrado: brl(it.valor_total), valor_esperado: brl(esperado), contexto: `${it.quantidade} ${it.unidade ?? ''} × ${brl(it.valor_unitario)}`, acao_sugerida: 'Conferir preço e quantidade com o pedido de compra.' });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'TOTAL_NF', nome: 'Valor total da NF consistente', categoria: 'valores', severidade: 'erro', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'vNF = vProd − vDesc − vICMSDeson + vST + vFCPST + vFrete + vSeg + vOutro + vII + vIPI + vIPIDevol.',
    avaliar(ctx, p) {
      const d = ctx.doc;
      if (d.v_total == null) return [{ problema: 'Valor total da NF ausente ou ilegível no XML', valor_encontrado: '—', valor_esperado: 'vNF numérico', acao_sugerida: 'Solicitar ao fornecedor o XML válido.' }];
      if (d.v_prod == null) return null;
      const calc = r2((d.v_prod ?? 0) - (d.v_desconto ?? 0) - (d.v_icms_deson ?? 0) + (d.v_icms_st ?? 0) + (d.v_fcp_st ?? 0)
        + (d.v_frete ?? 0) + (d.v_seguro ?? 0) + (d.v_outro ?? 0) + (d.v_ii ?? 0) + (d.v_ipi ?? 0) + (d.v_ipi_devol ?? 0));
      if (quaseIgual(calc, d.v_total, p.tolerancia)) return [];
      return [{
        problema: 'Valor total da NF não fecha com a composição dos totais', valor_encontrado: brl(d.v_total), valor_esperado: brl(calc),
        contexto: `Produtos ${brl(d.v_prod)} − desconto ${brl(d.v_desconto ?? 0)} + ST ${brl(d.v_icms_st ?? 0)} + frete ${brl(d.v_frete ?? 0)} + seguro ${brl(d.v_seguro ?? 0)} + outras ${brl(d.v_outro ?? 0)} + IPI ${brl(d.v_ipi ?? 0)}.`,
        acao_sugerida: 'Verificar se há valores não considerados (ex.: ICMS desonerado, serviços) e confirmar o valor a pagar com o financeiro.',
      }];
    },
  },
  {
    codigo: 'DESCONTO_RATEIO', nome: 'Desconto corretamente considerado', categoria: 'valores', severidade: 'erro', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'A soma dos descontos dos itens deve ser igual ao desconto total.',
    avaliar: (ctx, p) => conferirTotal(ctx, 'v_desconto', (i) => i.v_desconto, 'descontos', p, 'Conferir desconto negociado e rateio nos itens; o desconto reduz a base de ICMS/PIS/COFINS.'),
  },
  {
    codigo: 'FRETE_RATEIO', nome: 'Frete corretamente considerado', categoria: 'valores', severidade: 'erro', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'A soma do frete dos itens deve ser igual ao frete total; frete destacado deve compor a base do ICMS (CST 00).',
    avaliar: (ctx, p) => conferirTotal(ctx, 'v_frete', (i) => i.v_frete, 'frete', p, 'Conferir modalidade de frete (CIF/FOB) e rateio nos itens.'),
  },
  {
    codigo: 'TOTAIS_TRIBUTOS', nome: 'Totais de tributos = soma dos itens', categoria: 'valores', severidade: 'erro', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'Totais de ICMS, ICMS-ST, IPI, PIS e COFINS devem ser a soma dos valores dos itens.',
    avaliar(ctx, p) {
      const pares = [['v_icms', 'ICMS'], ['v_icms_st', 'ICMSST'], ['v_ipi', 'IPI'], ['v_pis', 'PIS'], ['v_cofins', 'COFINS']];
      const achados = [];
      for (const [campo, trib] of pares) {
        const somaItens = r2(soma(ctx.itens, (i) => imp(i, trib)?.valor));
        const total = ctx.doc[campo] ?? 0;
        if (!quaseIgual(total, somaItens, p.tolerancia)) {
          achados.push({ problema: `Total de ${trib} difere da soma dos itens`, valor_encontrado: brl(total), valor_esperado: brl(somaItens), acao_sugerida: `Conferir o destaque de ${trib} item a item antes de apropriar o crédito.` });
        }
      }
      return achados;
    },
  },

  {
    codigo: 'DUPLICATAS_TOTAL', nome: 'Duplicatas somam o valor da fatura', categoria: 'valores', severidade: 'alerta', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'A soma das duplicatas deve igualar o valor líquido da fatura (ou o total da NF, quando não houver fatura). Vencimento anterior à emissão também é sinalizado.',
    avaliar(ctx, p) {
      const cob = ctx.extraido.cobranca;
      if (!cob?.duplicatas?.length) return null;
      const somaDup = r2(soma(cob.duplicatas, (d) => d.valor));
      const esperado = cob.fatura?.valor_liquido ?? ctx.doc.v_total;
      const achados = [];
      if (!quaseIgual(somaDup, esperado, p.tolerancia)) {
        achados.push({ problema: 'Soma das duplicatas difere do valor a pagar', valor_encontrado: `${cob.duplicatas.length} duplicata(s): ${brl(somaDup)}`, valor_esperado: `${cob.fatura?.valor_liquido != null ? 'Fatura líquida' : 'Total da NF'}: ${brl(esperado)}`, acao_sugerida: 'Conferir com o financeiro o valor e as parcelas antes de programar o pagamento.' });
      }
      const emissao = ctx.doc.data_emissao?.slice(0, 10);
      for (const d of cob.duplicatas.filter((x) => emissao && x.vencimento && x.vencimento < emissao)) {
        achados.push({ problema: `Duplicata ${d.numero} vence antes da emissão da NF`, valor_encontrado: d.vencimento, valor_esperado: `Após ${emissao}`, acao_sugerida: 'Confirmar a data de vencimento com o fornecedor.' });
      }
      return achados;
    },
  },

  // =========================================================== CFOP
  {
    codigo: 'CFOP_UF_OPERACAO', nome: 'CFOP compatível com operação interna/interestadual', categoria: 'cfop', severidade: 'erro', aplicaA: [...MERCADORIA, 'CTE'],
    descricao: 'Em documentos de saída do emitente: CFOP 5xxx para operação interna, 6xxx para interestadual, 7xxx para exterior.',
    avaliar(ctx) {
      if (!ctx.operacao) return null;
      const esperado = { interna: '5', interestadual: '6', exterior: '7' }[ctx.operacao];
      const esperadoEntrada = { interna: '1', interestadual: '2', exterior: '3' }[ctx.operacao];
      const achados = [];
      const saida = ctx.doc.tipo_operacao !== '0';
      const ufA = ctx.doc.tipo === 'CTE' ? ctx.extraido.transporte?.uf_inicio : ctx.doc.emitente_uf;
      const ufB = ctx.doc.tipo === 'CTE' ? ctx.extraido.transporte?.uf_fim : ctx.doc.destinatario_uf;
      for (const it of ctx.itens) {
        if (!it.cfop) continue;
        const primeiro = it.cfop[0];
        const ok = saida ? primeiro === esperado : primeiro === esperadoEntrada;
        if (!ok) {
          achados.push({
            n_item: it.n_item,
            problema: 'CFOP inconsistente com a localização das partes',
            valor_encontrado: `CFOP informado: ${descCfop(it.cfop)}`,
            valor_esperado: `CFOP iniciado em ${saida ? esperado : esperadoEntrada} (operação ${ctx.operacao})`,
            contexto: `${ctx.doc.tipo === 'CTE' ? 'Prestação' : 'Emitente'}: ${ufA ?? '?'} → ${ctx.doc.tipo === 'CTE' ? 'destino' : 'destinatário'}: estabelecimento em ${ufB ?? '?'}. Operação identificada: ${ctx.operacao}.`,
            acao_sugerida: 'Revisar CFOP com o fornecedor (carta de correção não pode alterar dados que modifiquem o imposto). Escriturar com o CFOP de entrada correspondente.',
          });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'CFOP_TIPO_DOCUMENTO', nome: 'CFOP compatível com o tipo de documento', categoria: 'cfop', severidade: 'erro', aplicaA: [...MERCADORIA, 'CTE'],
    descricao: 'NF-e de saída deve usar CFOP 5/6/7; NF-e de entrada, 1/2/3; CT-e deve usar CFOP de prestação de serviço de transporte; CFOP x933 exige ISSQN.',
    avaliar(ctx) {
      const achados = [];
      for (const it of ctx.itens) {
        if (!it.cfop) {
          achados.push({ n_item: it.n_item, problema: `Item ${it.n_item} sem CFOP`, valor_encontrado: '—', valor_esperado: 'CFOP de 4 dígitos', acao_sugerida: 'Solicitar correção ao emissor.' });
          continue;
        }
        const dir = direcaoCfop(it.cfop);
        if (!dir) { achados.push({ n_item: it.n_item, problema: 'CFOP inválido', valor_encontrado: it.cfop, valor_esperado: 'CFOP iniciado por 1-3 ou 5-7', acao_sugerida: 'Solicitar correção ao emissor.' }); continue; }
        if (ctx.doc.tipo === 'CTE') {
          const suf = it.cfop.slice(1);
          if (!(suf.startsWith('35') || suf.startsWith('36') || suf === '932' || suf === '949')) {
            achados.push({ n_item: it.n_item, problema: 'CT-e com CFOP que não é de prestação de serviço de transporte', valor_encontrado: descCfop(it.cfop), valor_esperado: 'CFOP x351–x360 / x932', acao_sugerida: 'Verificar o CT-e com a transportadora.' });
          }
          continue;
        }
        const esperadoFluxo = ctx.doc.tipo_operacao === '0' ? 'entrada' : 'saida';
        if (dir.fluxo !== esperadoFluxo) {
          achados.push({ n_item: it.n_item, problema: `CFOP de ${dir.fluxo} em NF de ${esperadoFluxo}`, valor_encontrado: descCfop(it.cfop), valor_esperado: `CFOP de ${esperadoFluxo}`, contexto: `tpNF = ${ctx.doc.tipo_operacao}`, acao_sugerida: 'Verificar se o documento foi emitido corretamente.' });
        }
        if (it.cfop.slice(1) === '933' && !imp(it, 'ISS')) {
          achados.push({ n_item: it.n_item, severidade: 'alerta', problema: 'CFOP de serviço (x933) sem grupo ISSQN', valor_encontrado: it.cfop, valor_esperado: 'Grupo ISSQN preenchido', acao_sugerida: 'Conferir a tributação do serviço.' });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'CFOP_TRANSFERENCIA', nome: 'Transferência entre estabelecimentos', categoria: 'cfop', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'CFOP de transferência exige mesma raiz de CNPJ entre emitente e destinatário; operação entre estabelecimentos da mesma empresa deve usar CFOP de transferência/remessa.',
    avaliar(ctx) {
      const mesmaRaiz = raizCnpj(ctx.doc.emitente_cnpj) === raizCnpj(ctx.doc.destinatario_cnpj) && raizCnpj(ctx.doc.emitente_cnpj).length === 8;
      const achados = [];
      let aplicavel = mesmaRaiz;
      for (const it of ctx.itens) {
        const nat = naturezaCfop(it.cfop);
        const transf = nat.includes('transferencia');
        if (transf) aplicavel = true;
        if (transf && !mesmaRaiz) {
          achados.push({ n_item: it.n_item, problema: 'CFOP de transferência entre empresas de CNPJ base diferentes', valor_encontrado: descCfop(it.cfop), valor_esperado: 'Transferência somente entre estabelecimentos do mesmo titular', contexto: `Emitente ${formatarCnpj(ctx.doc.emitente_cnpj)} / destinatário ${formatarCnpj(ctx.doc.destinatario_cnpj)}`, acao_sugerida: 'Solicitar ao emitente o CFOP de venda/remessa correto.' });
        } else if (mesmaRaiz && !transf && !nat.includes('remessa') && !nat.includes('devolucao') && !nat.includes('industrializacao')) {
          achados.push({ n_item: it.n_item, severidade: 'alerta', problema: 'Operação entre estabelecimentos do mesmo CNPJ base sem CFOP de transferência', valor_encontrado: descCfop(it.cfop), valor_esperado: 'CFOP x151/x152/x552/x557 ou remessa', acao_sugerida: 'Confirmar a natureza da operação com o estabelecimento emitente.' });
        }
      }
      return aplicavel ? achados : null;
    },
  },
  {
    codigo: 'CFOP_DEVOLUCAO', nome: 'Devolução com finalidade e referência', categoria: 'cfop', severidade: 'alerta', aplicaA: MERCADORIA,
    descricao: 'CFOP de devolução exige finalidade 4 (devolução) e NF referenciada; finalidade 4 exige CFOP de devolução.',
    avaliar(ctx) {
      const devol = ctx.itens.filter((i) => naturezaCfop(i.cfop).includes('devolucao'));
      const fin4 = ctx.doc.finalidade === '4';
      if (!devol.length && !fin4) return null;
      const achados = [];
      if (devol.length && !fin4) achados.push({ problema: 'CFOP de devolução em NF sem finalidade "devolução"', valor_encontrado: `finNFe = ${ctx.doc.finalidade}; CFOP ${devol[0].cfop}`, valor_esperado: 'finNFe = 4', acao_sugerida: 'Conferir se a operação é realmente de devolução.' });
      if (fin4 && devol.length < ctx.itens.length) achados.push({ problema: 'NF de devolução com itens sem CFOP de devolução', valor_encontrado: ctx.itens.filter((i) => !devol.includes(i)).map((i) => i.cfop).join(', '), valor_esperado: 'CFOP de devolução em todos os itens', acao_sugerida: 'Solicitar correção ao emitente.' });
      if ((devol.length || fin4) && !(ctx.extraido.referencias || []).length) achados.push({ problema: 'Devolução sem documento fiscal referenciado', valor_encontrado: 'Sem NFref', valor_esperado: 'Chave da NF original referenciada', acao_sugerida: 'Identificar a NF de origem para estorno correto dos créditos.' });
      return achados;
    },
  },
  {
    codigo: 'CFOP_INDUSTRIALIZACAO', nome: 'Remessa/retorno de industrialização', categoria: 'cfop', severidade: 'alerta', aplicaA: MERCADORIA,
    descricao: 'Retorno de industrialização (x902/x124/x125) deve referenciar a NF de remessa.',
    avaliar(ctx) {
      const ind = ctx.itens.filter((i) => naturezaCfop(i.cfop).includes('industrializacao'));
      if (!ind.length) return null;
      const retorno = ind.some((i) => ['902', '124', '125', '903'].includes(i.cfop.slice(1)));
      if (retorno && !(ctx.extraido.referencias || []).length) {
        return [{ problema: 'Retorno de industrialização sem NF de remessa referenciada', valor_encontrado: ind.map((i) => i.cfop).join(', '), valor_esperado: 'NFref com a remessa original', acao_sugerida: 'Vincular a NF de remessa para controle de estoque em poder de terceiros.' }];
      }
      return [{ severidade: 'conferencia', problema: 'Operação de industrialização por encomenda', valor_encontrado: ind.map((i) => descCfop(i.cfop)).join('; '), valor_esperado: 'Controle de remessa/retorno', acao_sugerida: 'Conferir saldo de materiais em poder de terceiros.' }];
    },
  },
  {
    codigo: 'CFOP_BONIFICACAO', nome: 'Bonificação / amostra', categoria: 'cfop', severidade: 'conferencia', aplicaA: MERCADORIA,
    descricao: 'Bonificações e amostras exigem conferência de acordo comercial e tratamento de ICMS/PIS/COFINS.',
    avaliar(ctx) {
      const b = ctx.itens.filter((i) => naturezaCfop(i.cfop).includes('bonificacao'));
      if (!b.length) return null;
      return [{ problema: 'NF de bonificação/amostra grátis', valor_encontrado: b.map((i) => descCfop(i.cfop)).join('; '), valor_esperado: 'Bonificação prevista em acordo comercial', acao_sugerida: 'Confirmar com Suprimentos; escriturar com CFOP x910/x911 e verificar crédito de ICMS conforme legislação estadual.' }];
    },
  },
  {
    codigo: 'CFOP_ATIVO_USO_CONSUMO', nome: 'Destinação ativo / uso e consumo', categoria: 'cfop', severidade: 'conferencia', aplicaA: MERCADORIA,
    descricao: 'Aquisições para ativo imobilizado ou uso e consumo têm tratamento específico (CIAP, vedação de crédito, DIFAL).',
    avaliar(ctx) {
      const tipo = ctx.fornecedor?.tipo_fornecedor;
      const ativoVenda = ctx.itens.filter((i) => ['551'].includes(String(i.cfop).slice(1)));
      if (tipo !== 'ativo' && tipo !== 'uso_consumo' && !ativoVenda.length) return null;
      if (tipo === 'ativo' || ativoVenda.length) return [{ problema: 'Aquisição de bem para o ativo imobilizado', valor_encontrado: ctx.itens.map((i) => i.cfop).join(', '), valor_esperado: 'Entrada com CFOP x551 e controle no CIAP', acao_sugerida: 'Registrar no CIAP (crédito em 1/48 avos) e no controle patrimonial.' }];
      return [{ problema: 'Aquisição de material de uso e consumo', valor_encontrado: ctx.itens.map((i) => i.cfop).join(', '), valor_esperado: 'Entrada com CFOP x556 sem crédito de ICMS', acao_sugerida: 'Escriturar sem crédito de ICMS; verificar DIFAL em operação interestadual.' }];
    },
  },
  {
    codigo: 'CFOP_PERMITIDOS', nome: 'CFOPs permitidos/bloqueados', categoria: 'cfop', severidade: 'alerta', aplicaA: [...MERCADORIA, 'CTE'],
    parametros: { bloqueados: ['5929', '6929'], permitidos: [] },
    descricao: 'Lista configurável de CFOPs bloqueados e (opcionalmente) de CFOPs permitidos.',
    avaliar(ctx, p) {
      const achados = [];
      for (const it of ctx.itens) {
        if (!it.cfop) continue;
        if ((p.bloqueados || []).includes(it.cfop)) achados.push({ n_item: it.n_item, problema: 'CFOP bloqueado pela política fiscal', valor_encontrado: descCfop(it.cfop), valor_esperado: 'CFOP não bloqueado', acao_sugerida: 'Avaliar com o responsável fiscal antes de escriturar.' });
        else if ((p.permitidos || []).length && !p.permitidos.includes(it.cfop)) achados.push({ n_item: it.n_item, problema: 'CFOP fora da lista de CFOPs permitidos', valor_encontrado: descCfop(it.cfop), valor_esperado: p.permitidos.join(', '), acao_sugerida: 'Avaliar com o responsável fiscal.' });
      }
      return achados;
    },
  },

  // =========================================================== ICMS
  {
    codigo: 'ICMS_CST_REGIME', nome: 'CST/CSOSN compatível com o regime do emitente', categoria: 'icms', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'Emitente do Simples Nacional (CRT 1/4) usa CSOSN; regime normal (CRT 2/3) usa CST. O código deve existir na tabela.',
    avaliar(ctx) {
      const crt = ctx.doc.emitente_crt;
      const achados = [];
      for (const it of ctx.itens) {
        const cst = imp(it, 'ICMS')?.cst;
        if (!cst) { achados.push({ n_item: it.n_item, problema: 'Item sem CST/CSOSN de ICMS', valor_encontrado: '—', valor_esperado: 'CST ou CSOSN', acao_sugerida: 'Solicitar correção ao emissor.' }); continue; }
        const ehCsosn = cst.length === 3;
        if (ehCsosn ? !CSOSN.includes(cst) : !CST_ICMS.includes(cst)) {
          achados.push({ n_item: it.n_item, problema: 'CST/CSOSN de ICMS inexistente', valor_encontrado: cst, valor_esperado: 'Código da tabela oficial', acao_sugerida: 'Solicitar correção ao emissor.' });
        } else if (crt && ['1', '4'].includes(crt) && !ehCsosn) {
          achados.push({ n_item: it.n_item, problema: 'Emitente do Simples Nacional informando CST (deveria ser CSOSN)', valor_encontrado: `CRT ${crt} / CST ${cst}`, valor_esperado: 'CSOSN (101 a 900)', acao_sugerida: 'Confirmar o regime do fornecedor e solicitar correção.' });
        } else if (crt && ['2', '3'].includes(crt) && ehCsosn) {
          achados.push({ n_item: it.n_item, problema: 'Emitente do regime normal informando CSOSN', valor_encontrado: `CRT ${crt} / CSOSN ${cst}`, valor_esperado: 'CST de ICMS', acao_sugerida: 'Confirmar o regime do fornecedor e solicitar correção.' });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'ICMS_CALCULO', nome: 'ICMS: base × alíquota = imposto', categoria: 'icms', severidade: 'erro', aplicaA: [...MERCADORIA, 'CTE'],
    parametros: { tolerancia: 0.05 },
    descricao: 'Confere o ICMS destacado em cada item com base de cálculo × alíquota.',
    avaliar: (ctx, p) => conferirCalculo(ctx, 'ICMS', p),
  },
  {
    codigo: 'ICMS_ALIQUOTA_INTERESTADUAL', nome: 'Alíquota interestadual de ICMS', categoria: 'icms', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'Operação interestadual: 4% para importados (origem 1, 2, 3, 8); 7% de S/SE (exceto ES) para N/NE/CO/ES; 12% nas demais.',
    avaliar(ctx) {
      if (ctx.operacao !== 'interestadual' || ctx.extraido.destinatario?.ind_ie === '9') return null;
      const achados = [];
      for (const it of ctx.itens) {
        const icms = imp(it, 'ICMS');
        if (!icms || !CST_ICMS_TRIBUTADO.includes(icms.cst) || !temValor(icms.aliquota)) continue;
        const esperado = aliquotaInterestadual(ctx.doc.emitente_uf, ctx.doc.destinatario_uf, icms.origem);
        if (!quaseIgual(icms.aliquota, esperado, 0.001)) {
          achados.push({
            n_item: it.n_item, problema: 'Alíquota interestadual de ICMS divergente', valor_encontrado: pct(icms.aliquota), valor_esperado: pct(esperado),
            contexto: `${ctx.doc.emitente_uf} → ${ctx.doc.destinatario_uf}, origem da mercadoria ${icms.origem ?? '?'}.`,
            acao_sugerida: 'Apropriar crédito apenas pela alíquota correta e solicitar correção ao fornecedor.',
          });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'ICMS_ALIQUOTA_INTERNA', nome: 'Alíquota interna de ICMS', categoria: 'icms', severidade: 'alerta', aplicaA: MERCADORIA,
    parametros: { aliquotas_por_uf: ALIQUOTA_INTERNA_PADRAO, aliquotas_aceitas_adicionais: [4, 7, 12, 25] },
    descricao: 'Operação interna: alíquota deve ser a modal da UF ou uma das alíquotas diferenciadas aceitas (configurável).',
    avaliar(ctx, p) {
      if (ctx.operacao !== 'interna') return null;
      const modal = p.aliquotas_por_uf?.[ctx.doc.emitente_uf];
      if (modal == null) return null;
      const aceitas = [modal, ...(p.aliquotas_aceitas_adicionais || [])];
      const achados = [];
      for (const it of ctx.itens) {
        const icms = imp(it, 'ICMS');
        if (!icms || !CST_ICMS_TRIBUTADO.includes(icms.cst) || !temValor(icms.aliquota)) continue;
        if (!aceitas.some((a) => quaseIgual(a, icms.aliquota, 0.001))) {
          achados.push({ n_item: it.n_item, problema: 'Alíquota interna de ICMS fora do padrão da UF', valor_encontrado: pct(icms.aliquota), valor_esperado: `${pct(modal)} (modal ${ctx.doc.emitente_uf}) ou ${p.aliquotas_aceitas_adicionais.join('%, ')}%`, contexto: `NCM ${it.ncm ?? '—'}`, acao_sugerida: 'Verificar se o produto possui alíquota específica ou benefício na legislação estadual.' });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'ICMS_BASE_CALCULO', nome: 'Base de cálculo do ICMS coerente', categoria: 'icms', severidade: 'alerta', aplicaA: MERCADORIA,
    parametros: { tolerancia: 0.05 },
    descricao: 'CST 00: base = valor do item − desconto + frete + seguro + outras (± IPI). CST 20: base reduzida com percentual de redução informado.',
    avaliar(ctx, p) {
      const achados = [];
      let aplicavel = false;
      for (const it of ctx.itens) {
        const icms = imp(it, 'ICMS');
        if (!icms || icms.base == null) continue;
        const liquido = r2((it.valor_total ?? 0) - (it.v_desconto ?? 0) + (it.v_frete ?? 0) + (it.v_seguro ?? 0) + (it.v_outro ?? 0));
        const comIpi = r2(liquido + (imp(it, 'IPI')?.valor ?? 0));
        if (icms.cst === '00') {
          aplicavel = true;
          if (!quaseIgual(icms.base, liquido, p.tolerancia) && !quaseIgual(icms.base, comIpi, p.tolerancia)) {
            achados.push({ n_item: it.n_item, problema: `Base de ICMS do item ${it.n_item} diferente do valor da operação`, valor_encontrado: brl(icms.base), valor_esperado: comIpi !== liquido ? `${brl(liquido)} ou ${brl(comIpi)} (com IPI)` : brl(liquido), acao_sugerida: 'Verificar se frete/seguro/descontos foram considerados na base.' });
          }
        } else if (icms.cst === '20') {
          aplicavel = true;
          if (!temValor(icms.reducao_bc) || icms.base >= liquido) {
            achados.push({ n_item: it.n_item, problema: 'CST 20 (redução de base) sem redução efetiva', valor_encontrado: `Base ${brl(icms.base)}; redução ${pct(icms.reducao_bc)}`, valor_esperado: `Base menor que ${brl(liquido)}`, acao_sugerida: 'Confirmar o benefício de redução de base com o fornecedor.' });
          } else {
            const esperado = r2(comIpi * (1 - icms.reducao_bc / 100)), esperadoSemIpi = r2(liquido * (1 - icms.reducao_bc / 100));
            if (!quaseIgual(icms.base, esperado, p.tolerancia) && !quaseIgual(icms.base, esperadoSemIpi, p.tolerancia)) {
              achados.push({ n_item: it.n_item, problema: 'Base reduzida do ICMS não confere com o percentual de redução', valor_encontrado: brl(icms.base), valor_esperado: brl(esperadoSemIpi), contexto: `Redução de ${pct(icms.reducao_bc)} sobre ${brl(liquido)}`, acao_sugerida: 'Conferir o cálculo da redução.' });
            }
          }
        }
      }
      return aplicavel ? achados : null;
    },
  },
  {
    codigo: 'ICMS_ST', nome: 'ICMS-ST consistente com o CST', categoria: 'icms', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'CST 10/30/70 (CSOSN 201/202/203) exigem ICMS-ST destacado e CEST; CST 60/CSOSN 500 não devem destacar ST.',
    avaliar(ctx) {
      const achados = [];
      let aplicavel = false;
      for (const it of ctx.itens) {
        const cst = imp(it, 'ICMS')?.cst;
        const st = imp(it, 'ICMSST');
        if (CST_ICMS_COM_ST.includes(cst)) {
          aplicavel = true;
          if (!st || !temValor(st.valor)) achados.push({ n_item: it.n_item, problema: 'CST com substituição tributária sem ICMS-ST destacado', valor_encontrado: `CST ${cst}; ICMS-ST ${brl(st?.valor ?? 0)}`, valor_esperado: 'ICMS-ST > 0', acao_sugerida: 'Verificar se o ST foi recolhido por GNRE ou se há regime especial.' });
          else if (st.base != null && temValor(st.aliquota)) {
            const icmsProprio = imp(it, 'ICMS')?.valor ?? 0;
            const esperado = r2(st.base * st.aliquota / 100 - icmsProprio);
            if (!quaseIgual(esperado, st.valor, 0.1)) achados.push({ severidade: 'alerta', n_item: it.n_item, problema: 'ICMS-ST não confere com (base ST × alíquota) − ICMS próprio', valor_encontrado: brl(st.valor), valor_esperado: brl(esperado), contexto: `Base ST ${brl(st.base)} × ${pct(st.aliquota)} − ICMS próprio ${brl(icmsProprio)}; MVA ${pct(st.mva)}`, acao_sugerida: 'Conferir MVA e alíquota interna do destino.' });
          }
          if (!it.cest) achados.push({ severidade: 'alerta', n_item: it.n_item, problema: 'Item sujeito a ST sem CEST', valor_encontrado: 'CEST ausente', valor_esperado: 'CEST de 7 dígitos', acao_sugerida: 'Solicitar ao fornecedor a inclusão do CEST.' });
        } else if (['60', '500'].includes(cst)) {
          aplicavel = true;
          if (st && temValor(st.valor)) achados.push({ n_item: it.n_item, problema: 'ICMS-ST destacado em item com ST retido anteriormente', valor_encontrado: `CST ${cst}; ST ${brl(st.valor)}`, valor_esperado: 'Sem destaque de ST', acao_sugerida: 'Confirmar a tributação com o fornecedor.' });
        }
      }
      return aplicavel ? achados : null;
    },
  },
  {
    codigo: 'ICMS_DIFAL', nome: 'DIFAL em aquisição interestadual para uso/consumo/ativo', categoria: 'icms', severidade: 'conferencia', aplicaA: MERCADORIA,
    parametros: { aliquotas_por_uf: ALIQUOTA_INTERNA_PADRAO },
    descricao: 'Aquisição interestadual para uso e consumo ou ativo por contribuinte gera DIFAL a recolher pelo destinatário (estimativa).',
    avaliar(ctx, p) {
      if (ctx.operacao !== 'interestadual') return null;
      const destinacao = ctx.fornecedor?.tipo_fornecedor;
      const itens = ctx.itens.filter((i) => ['556', '551', '407', '406'].includes(String(i.cfop_entrada ?? i.cfop_entrada_sugerido ?? '').slice(1))
        || destinacao === 'uso_consumo' || destinacao === 'ativo');
      if (!itens.length) return null;
      const aliqDestino = p.aliquotas_por_uf?.[ctx.doc.destinatario_uf];
      if (aliqDestino == null) return null;
      let total = 0;
      for (const it of itens) {
        const icms = imp(it, 'ICMS');
        const aliqInter = icms?.aliquota || aliquotaInterestadual(ctx.doc.emitente_uf, ctx.doc.destinatario_uf, icms?.origem);
        const base = r2((it.valor_total ?? 0) - (it.v_desconto ?? 0) + (it.v_frete ?? 0) + (it.v_seguro ?? 0) + (it.v_outro ?? 0) + (imp(it, 'IPI')?.valor ?? 0));
        // Base dupla (LC 190/2022): (base − ICMS origem) / (1 − alíq. destino) × alíq. destino − ICMS origem
        const icmsOrigem = base * aliqInter / 100;
        total += Math.max(0, ((base - icmsOrigem) / (1 - aliqDestino / 100)) * aliqDestino / 100 - icmsOrigem);
      }
      return [{
        problema: 'DIFAL a recolher pelo destinatário (estimativa)', valor_encontrado: `${itens.length} item(ns) para uso/consumo ou ativo`,
        valor_esperado: `DIFAL estimado: ${brl(r2(total))}`, contexto: `Alíquota interna ${ctx.doc.destinatario_uf}: ${pct(aliqDestino)}; cálculo por base dupla.`,
        acao_sugerida: 'Confirmar a destinação da mercadoria e apurar o DIFAL na escrituração (a estimativa não substitui a apuração).',
      }];
    },
  },

  // =========================================================== PIS / COFINS
  {
    codigo: 'PIS_COFINS_CST', nome: 'CST de PIS/COFINS válido', categoria: 'pis_cofins', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'CST deve existir na tabela; em NF de saída do emitente, CST de saída (01–49, 99). Simples Nacional usa 49/99/04–09.',
    avaliar(ctx) {
      const achados = [];
      for (const it of ctx.itens) {
        for (const t of ['PIS', 'COFINS']) {
          const cst = imp(it, t)?.cst;
          if (!cst) { achados.push({ n_item: it.n_item, severidade: 'alerta', problema: `Item sem CST de ${t}`, valor_encontrado: '—', valor_esperado: `CST de ${t}`, acao_sugerida: 'Solicitar correção ao emissor.' }); continue; }
          if (!CST_PIS_COFINS.includes(cst)) achados.push({ n_item: it.n_item, problema: `CST de ${t} inexistente`, valor_encontrado: cst, valor_esperado: 'Código da tabela oficial', acao_sugerida: 'Solicitar correção ao emissor.' });
          else if (ctx.doc.tipo_operacao === '1' && !CST_PIS_COFINS_SAIDA.includes(cst)) achados.push({ n_item: it.n_item, problema: `CST de entrada de ${t} em NF de saída`, valor_encontrado: cst, valor_esperado: '01–49 ou 99', acao_sugerida: 'Solicitar correção ao emissor.' });
          else if (['1', '4'].includes(ctx.doc.emitente_crt) && ['01', '02'].includes(cst)) achados.push({ n_item: it.n_item, severidade: 'alerta', problema: `Fornecedor do Simples Nacional com CST ${cst} de ${t}`, valor_encontrado: cst, valor_esperado: '49 ou 99 (Simples Nacional)', acao_sugerida: 'Confirmar o regime do fornecedor.' });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'PIS_COFINS_ALIQUOTA', nome: 'Alíquotas de PIS/COFINS', categoria: 'pis_cofins', severidade: 'alerta', aplicaA: MERCADORIA,
    parametros: { pis: [0.65, 1.65], cofins: [3, 7.6] },
    descricao: 'CST 01: PIS 0,65% (cumulativo) ou 1,65% (não cumulativo); COFINS 3% ou 7,6% (configurável).',
    avaliar(ctx, p) {
      const achados = [];
      let aplicavel = false;
      for (const it of ctx.itens) {
        for (const [t, lista] of [['PIS', p.pis], ['COFINS', p.cofins]]) {
          const tr = imp(it, t);
          if (tr?.cst !== '01') continue;
          aplicavel = true;
          if (!lista.some((a) => quaseIgual(a, tr.aliquota, 0.0001))) achados.push({ n_item: it.n_item, problema: `Alíquota de ${t} fora do padrão para CST 01`, valor_encontrado: pct(tr.aliquota), valor_esperado: lista.map(pct).join(' ou '), acao_sugerida: 'Verificar regime monofásico/alíquota diferenciada (CST 02/04).' });
        }
      }
      return aplicavel ? achados : null;
    },
  },
  { codigo: 'PIS_CALCULO', nome: 'PIS: base × alíquota = imposto', categoria: 'pis_cofins', severidade: 'erro', aplicaA: MERCADORIA, parametros: { tolerancia: 0.05 }, descricao: 'Confere o PIS de cada item.', avaliar: (ctx, p) => conferirCalculo(ctx, 'PIS', p) },
  { codigo: 'COFINS_CALCULO', nome: 'COFINS: base × alíquota = imposto', categoria: 'pis_cofins', severidade: 'erro', aplicaA: MERCADORIA, parametros: { tolerancia: 0.05 }, descricao: 'Confere a COFINS de cada item.', avaliar: (ctx, p) => conferirCalculo(ctx, 'COFINS', p) },

  // =========================================================== IPI
  {
    codigo: 'IPI_CST', nome: 'CST de IPI válido', categoria: 'ipi', severidade: 'erro', aplicaA: MERCADORIA,
    descricao: 'CST de IPI deve existir; NF de saída usa CST 50–55/99; CST 50 (tributada) exige alíquota.',
    avaliar(ctx) {
      const achados = [];
      let aplicavel = false;
      for (const it of ctx.itens) {
        const ipi = imp(it, 'IPI');
        if (!ipi?.cst) continue;
        aplicavel = true;
        if (!CST_IPI.includes(ipi.cst)) achados.push({ n_item: it.n_item, problema: 'CST de IPI inexistente', valor_encontrado: ipi.cst, valor_esperado: 'Código da tabela oficial', acao_sugerida: 'Solicitar correção.' });
        else if (ctx.doc.tipo_operacao === '1' && !CST_IPI_SAIDA.includes(ipi.cst)) achados.push({ n_item: it.n_item, problema: 'CST de IPI de entrada em NF de saída', valor_encontrado: ipi.cst, valor_esperado: '50–55 ou 99', acao_sugerida: 'Solicitar correção.' });
        else if (ipi.cst === '50' && !temValor(ipi.aliquota)) achados.push({ n_item: it.n_item, severidade: 'alerta', problema: 'IPI tributado (CST 50) com alíquota zero', valor_encontrado: pct(ipi.aliquota ?? 0), valor_esperado: 'Alíquota da TIPI para o NCM', acao_sugerida: 'Conferir o NCM na TIPI.' });
      }
      return aplicavel ? achados : null;
    },
  },
  { codigo: 'IPI_CALCULO', nome: 'IPI: base × alíquota = imposto', categoria: 'ipi', severidade: 'erro', aplicaA: MERCADORIA, parametros: { tolerancia: 0.05 }, descricao: 'Confere o IPI de cada item.', avaliar: (ctx, p) => conferirCalculo(ctx, 'IPI', p) },

  // =========================================================== SERVIÇOS
  { codigo: 'ISS_CALCULO', nome: 'ISS: base × alíquota = imposto', categoria: 'servicos', severidade: 'erro', aplicaA: ['NFSE', 'NFE'], parametros: { tolerancia: 0.05 }, descricao: 'Confere o ISS do serviço.', avaliar: (ctx, p) => conferirCalculo(ctx, 'ISS', p) },
  {
    codigo: 'NFSE_VALOR_LIQUIDO', nome: 'Valor líquido = valor dos serviços − retenções', categoria: 'servicos', severidade: 'alerta', aplicaA: ['NFSE'],
    parametros: { tolerancia: 0.05 },
    descricao: 'O valor líquido a pagar deve ser o valor dos serviços menos ISS retido, IRRF, INSS e PIS/COFINS/CSLL retidos.',
    avaliar(ctx, p) {
      const d = ctx.doc;
      if (d.v_total == null || d.v_liquido == null) return null;
      const esperado = r2(d.v_total - (d.v_retencoes ?? 0));
      if (quaseIgual(esperado, d.v_liquido, p.tolerancia)) return [];
      return [{ problema: 'Valor líquido da NFS-e não fecha com as retenções', valor_encontrado: `Líquido ${brl(d.v_liquido)}`, valor_esperado: `${brl(d.v_total)} − retenções ${brl(d.v_retencoes ?? 0)} = ${brl(esperado)}`, acao_sugerida: 'Conferir as retenções (ISS, IRRF, INSS, CSRF) antes de programar o pagamento.' }];
    },
  },

  // =========================================================== FINANCEIRO (títulos a pagar do Senior)
  {
    codigo: 'SENIOR_TITULO_VALOR', nome: 'Título no Senior = valor a pagar da nota', categoria: 'financeiro', severidade: 'alerta', aplicaA: TODOS,
    parametros: { tolerancia: 0.05 },
    descricao: 'A soma dos títulos a pagar gerados no Senior deve igualar o valor líquido da nota (valor total quando não há retenções). Título pelo valor bruto com retenções na nota indica retenção não descontada.',
    avaliar(ctx, p) {
      const d = ctx.doc;
      // Substituídos (LS) e cancelados não entram: o saldo migrou para outro título
      const ativos = ctx.titulosSenior.filter((t) => !['cancelado'].includes(t.situacao_grupo) && t.situacao !== 'LS');
      if (!ativos.length || d.v_total == null) return null;
      const somaTit = r2(soma(ativos, (t) => t.valor));
      const esperado = d.v_liquido ?? d.v_total;
      if (quaseIgual(somaTit, esperado, p.tolerancia)) return [];
      const lista = `${ativos.length} título(s): ${brl(somaTit)}`;
      if (d.v_liquido != null && d.v_liquido < d.v_total - p.tolerancia && quaseIgual(somaTit, d.v_total, p.tolerancia)) {
        return [{ severidade: 'erro', problema: 'Título lançado pelo valor bruto: retenções não descontadas', valor_encontrado: lista, valor_esperado: `Líquido ${brl(d.v_liquido)} (retenções ${brl(d.v_retencoes ?? r2(d.v_total - d.v_liquido))})`, acao_sugerida: 'Ajustar o título no Senior antes do pagamento para não pagar as retenções ao prestador.' }];
      }
      return [{ severidade: somaTit > esperado ? 'erro' : 'alerta', problema: somaTit > esperado ? 'Títulos no Senior acima do valor da nota' : 'Títulos no Senior abaixo do valor da nota', valor_encontrado: lista, valor_esperado: `${d.v_liquido != null ? 'Líquido' : 'Total'} da nota: ${brl(esperado)}`, acao_sugerida: 'Conferir o lançamento financeiro no Senior (valor, parcelas, retenções).' }];
    },
  },
  {
    codigo: 'BOLETO_VALOR_NOTA', nome: 'Boleto = valor a pagar da NFS-e', categoria: 'financeiro', severidade: 'alerta', aplicaA: ['NFSE', 'OUTRO'],
    parametros: { tolerancia: 0.05 },
    descricao: 'O boleto recebido junto com a NFS-e deve cobrar o valor líquido da nota. Valor diferente indica boleto de outra nota, cobrança agrupada ou retenção não descontada.',
    avaliar(ctx, p) {
      const dups = ctx.duplicatas.filter((x) => x.valor != null && x.status_pagamento !== 'cancelada');
      const esperado = ctx.doc.v_liquido ?? ctx.doc.v_total;
      if (!dups.length || esperado == null) return null;
      const somaDup = r2(soma(dups, (x) => x.valor));
      if (quaseIgual(somaDup, esperado, p.tolerancia)) return [];
      const retencao = ctx.doc.v_liquido != null && quaseIgual(somaDup, ctx.doc.v_total, p.tolerancia) && ctx.doc.v_liquido < ctx.doc.v_total;
      return [{
        severidade: retencao || somaDup > esperado ? 'erro' : 'alerta',
        problema: retencao ? 'Boleto cobra o valor bruto: retenções não descontadas' : somaDup > esperado ? 'Boleto com valor maior que a nota' : 'Boleto com valor menor que a nota',
        valor_encontrado: `${dups.length} boleto(s)/parcela(s): ${brl(somaDup)}`, valor_esperado: `${ctx.doc.v_liquido != null ? 'Líquido' : 'Total'} da nota: ${brl(esperado)}`,
        acao_sugerida: 'Confirmar com o fornecedor se o boleto é desta nota (ou de várias) antes de pagar; se houver retenção, pedir boleto pelo líquido.',
      }];
    },
  },
  {
    codigo: 'SENIOR_PAGO_A_MAIOR', nome: 'Pagamento no Senior não excede a nota', categoria: 'financeiro', severidade: 'erro', aplicaA: TODOS,
    parametros: { tolerancia: 0.05 },
    descricao: 'Os títulos já pagos (baixa LQ) não podem somar mais que o valor a pagar da nota — indica pagamento em duplicidade.',
    avaliar(ctx, p) {
      const pagos = ctx.titulosSenior.filter((t) => t.situacao_grupo === 'pago');
      const esperado = ctx.doc.v_liquido ?? ctx.doc.v_total;
      if (!pagos.length || esperado == null) return null;
      const somaPg = r2(soma(pagos, (t) => t.valor));
      if (somaPg <= esperado + p.tolerancia) return [];
      return [{ problema: 'Pago mais do que o valor da nota', valor_encontrado: pagos.map((t) => `${t.numtit} ${brl(t.valor)} em ${t.data_pagamento ?? '—'}`).join('; '), valor_esperado: `Até ${brl(esperado)}`, acao_sugerida: 'Verificar pagamento em duplicidade com o financeiro e solicitar devolução/abatimento ao fornecedor.' }];
    },
  },
  {
    codigo: 'SENIOR_TITULO_VENCIDO', nome: 'Título vencido sem pagamento', categoria: 'financeiro', severidade: 'alerta', aplicaA: TODOS,
    descricao: 'Título a pagar da nota com vencimento passado e saldo em aberto no Senior (risco de juros, multa e protesto).',
    avaliar(ctx) {
      const abertos = ctx.titulosSenior.filter((t) => ['aberto', 'em_pagamento'].includes(t.situacao_grupo) && (t.valor_aberto ?? t.valor) > 0);
      if (!abertos.length) return null;
      const hoje = new Date().toLocaleDateString('sv-SE');
      return abertos.filter((t) => t.vencimento && t.vencimento < hoje).map((t) => ({
        problema: `Título ${t.numtit} vencido ${t.situacao_grupo === 'em_pagamento' ? '(em pagamento)' : 'em aberto'}`,
        valor_encontrado: `Venc. ${t.vencimento} · saldo ${brl(t.valor_aberto ?? t.valor)}`, valor_esperado: `Pago até ${t.vencimento}`,
        acao_sugerida: 'Confirmar com o financeiro se o pagamento foi feito ou renegociar o vencimento com o fornecedor.',
      }));
    },
  },
  {
    codigo: 'SENIOR_VENCIMENTO_DIVERGENTE', nome: 'Vencimento no Senior = boleto/nota', categoria: 'financeiro', severidade: 'alerta', aplicaA: TODOS,
    descricao: 'Os vencimentos lidos da nota ou do boleto devem existir nos títulos em aberto do Senior.',
    avaliar(ctx) {
      const tits = ctx.titulosSenior.filter((t) => ['aberto', 'em_pagamento'].includes(t.situacao_grupo));
      const dups = ctx.duplicatas.filter((x) => x.vencimento);
      if (!tits.length || !dups.length) return null;
      const datas = new Set(tits.map((t) => t.vencimento));
      const primeiroSenior = [...datas].sort()[0];
      return dups.filter((x) => !datas.has(x.vencimento)).map((x) => {
        // Boleto vence antes do título no Senior: risco de pagar atrasado (juros/multa/protesto)
        const atrasa = x.vencimento < primeiroSenior;
        return {
          severidade: atrasa ? 'alerta' : 'conferencia',
          problema: atrasa ? `Boleto vence ${x.vencimento}, antes do título no Senior (${primeiroSenior})` : `Vencimento ${x.vencimento} do boleto/nota difere do Senior (${primeiroSenior})`,
          valor_encontrado: `Senior: ${[...datas].join(', ')}`, valor_esperado: `${x.vencimento} (${brl(x.valor)})`,
          acao_sugerida: atrasa ? 'Antecipar o título no Senior ou negociar novo vencimento com o fornecedor para evitar juros e multa.' : 'Conferir a data do título no Senior com o boleto (pagamento antecipado sem necessidade).',
        };
      });
    },
  },

  // =========================================================== CADASTRO
  {
    codigo: 'NCM_CEST_FORMATO', nome: 'NCM e CEST com formato válido', categoria: 'cadastro', severidade: 'alerta', aplicaA: MERCADORIA,
    descricao: 'NCM com 8 dígitos (ou 00 para serviços); CEST, quando informado, com 7 dígitos.',
    avaliar(ctx) {
      const achados = [];
      for (const it of ctx.itens) {
        if (!it.ncm || !(/^\d{8}$/.test(it.ncm) || it.ncm === '00')) achados.push({ n_item: it.n_item, problema: 'NCM inválido ou ausente', valor_encontrado: it.ncm ?? '—', valor_esperado: '8 dígitos', acao_sugerida: 'Solicitar correção ao fornecedor.' });
        if (it.cest && !/^\d{7}$/.test(it.cest)) achados.push({ n_item: it.n_item, problema: 'CEST com formato inválido', valor_encontrado: it.cest, valor_esperado: '7 dígitos', acao_sugerida: 'Solicitar correção ao fornecedor.' });
      }
      return achados;
    },
  },

  // =========================================================== HISTÓRICO DO FORNECEDOR (pontos de conferência)
  {
    codigo: 'HIST_CFOP', nome: 'CFOP fora do padrão do fornecedor', categoria: 'historico', severidade: 'conferencia', aplicaA: [...MERCADORIA, 'CTE'],
    parametros: { minimo_nfs: 3, pct_minimo: 10 },
    descricao: 'Compara os CFOPs da NF com os CFOPs normalmente utilizados pelo fornecedor.',
    avaliar(ctx, p) {
      const h = ctx.historico();
      if (!h || h.qtd_nfs < p.minimo_nfs) return null;
      const achados = [];
      const usual = h.cfops[0];
      for (const cfop of new Set(ctx.itens.map((i) => i.cfop).filter(Boolean))) {
        const reg = h.cfops.find((c) => c.cfop === cfop);
        if (!reg || reg.pct < p.pct_minimo) {
          achados.push({
            problema: `Este fornecedor normalmente utiliza CFOP ${usual?.cfop}. Nesta NF foi utilizado CFOP ${cfop}.`,
            valor_encontrado: descCfop(cfop), valor_esperado: h.cfops.slice(0, 3).map((c) => `${c.cfop} (${c.pct}%)`).join(', '),
            contexto: `Base: ${h.qtd_nfs} NF(s) anteriores do fornecedor.`, acao_sugerida: 'Ponto de conferência: confirmar se a natureza da operação mudou (não é erro fiscal definitivo).',
          });
        }
      }
      return achados;
    },
  },
  {
    codigo: 'HIST_NCM', nome: 'Produto/NCM novo para o fornecedor', categoria: 'historico', severidade: 'conferencia', aplicaA: MERCADORIA,
    parametros: { minimo_nfs: 3 },
    descricao: 'Sinaliza NCMs nunca fornecidos anteriormente por este fornecedor.',
    avaliar(ctx, p) {
      const h = ctx.historico();
      if (!h || h.qtd_nfs < p.minimo_nfs) return null;
      const conhecidos = new Set(h.ncms.map((n) => n.ncm));
      return ctx.itens.filter((i) => i.ncm && !conhecidos.has(i.ncm)).map((i) => ({
        n_item: i.n_item, problema: `NCM ${i.ncm} nunca fornecido anteriormente por este fornecedor`, valor_encontrado: `${i.ncm} — ${i.descricao ?? ''}`.slice(0, 120),
        valor_esperado: `NCMs habituais: ${h.ncms.slice(0, 4).map((n) => n.ncm).join(', ')}`, acao_sugerida: 'Ponto de conferência: validar com Suprimentos se o item foi efetivamente comprado.',
      }));
    },
  },
  {
    codigo: 'HIST_VALOR', nome: 'Valor atípico para o fornecedor', categoria: 'historico', severidade: 'conferencia', aplicaA: TODOS,
    parametros: { minimo_nfs: 5, desvios: 3 },
    descricao: 'Valor total muito acima da média histórica do fornecedor (média + N desvios-padrão).',
    avaliar(ctx, p) {
      const h = ctx.historico();
      if (!h || h.qtd_nfs < p.minimo_nfs || !h.valor_desvio || ctx.doc.v_total == null) return null;
      const limite = h.valor_medio + p.desvios * h.valor_desvio;
      if (ctx.doc.v_total <= limite) return [];
      return [{ problema: 'Valor da NF muito acima do padrão histórico do fornecedor', valor_encontrado: brl(ctx.doc.v_total), valor_esperado: `Até ~${brl(limite)} (média ${brl(h.valor_medio)})`, contexto: `Base: ${h.qtd_nfs} NFs; maior valor anterior ${brl(h.valor_max)}.`, acao_sugerida: 'Ponto de conferência: confirmar pedido de compra e recebimento.' }];
    },
  },
  {
    codigo: 'HIST_ALIQUOTA_ICMS', nome: 'Alíquota de ICMS diferente do histórico', categoria: 'historico', severidade: 'conferencia', aplicaA: MERCADORIA,
    parametros: { minimo_itens: 3 },
    descricao: 'Para o mesmo NCM e fornecedor, a alíquota de ICMS difere da habitualmente destacada.',
    avaliar(ctx, p) {
      const h = ctx.historico();
      if (!h) return null;
      const achados = [];
      for (const it of ctx.itens) {
        const hist = h.aliquota_icms_por_ncm[it.ncm];
        const aliq = imp(it, 'ICMS')?.aliquota ?? 0;
        if (!hist) continue;
        const total = Object.values(hist).reduce((a, b) => a + b, 0);
        if (total < p.minimo_itens) continue;
        const [usual] = Object.entries(hist).sort((a, b) => b[1] - a[1]);
        if (!hist[aliq] && Number(usual[0]) !== aliq) {
          achados.push({ n_item: it.n_item, problema: `Alíquota de ICMS do NCM ${it.ncm} diferente do histórico`, valor_encontrado: pct(aliq), valor_esperado: `${pct(Number(usual[0]))} (usual em ${usual[1]} de ${total} itens)`, acao_sugerida: 'Ponto de conferência: verificar mudança de legislação ou de tributação do fornecedor.' });
        }
      }
      return achados;
    },
  },
];

export const REGRAS_POR_CODIGO = Object.fromEntries(REGRAS.map((r) => [r.codigo, r]));

export { sugerirCfopEntrada };
