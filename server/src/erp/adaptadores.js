// Adaptadores de saída para ERPs. O formato "generico" é o contrato canônico da API.
// Para integrar um ERP específico, implemente `converter(doc)` produzindo o payload esperado
// pela API de importação do ERP (ou por um middleware/iPaaS) e registre-o abaixo.

export const ADAPTADORES = {
  generico: {
    nome: 'Genérico (JSON canônico)',
    converter: (doc) => doc,
  },

  // Esboço para Senior (G5/ERP XT): o mapeamento final depende do serviço de importação de NF de entrada
  // configurado no ambiente do cliente (ex.: com_senior_g5_co_mfi_nfe). Validar campos com a equipe Senior.
  senior: {
    nome: 'Senior (esboço — validar mapeamento)',
    converter: (doc) => ({
      codEmp: null, // preencher com o código da empresa no ERP (de-para por CNPJ)
      cnpjFil: doc.destinatario.cnpj,
      cgcFor: doc.emitente.cnpj,
      numNfc: doc.numero, codSnf: doc.serie, chvNel: doc.chave_acesso,
      datEmi: doc.data_emissao?.slice(0, 10), vlrLiq: doc.totais.total,
      itens: doc.itens.map((i) => ({
        seqIpc: i.n_item, codPro: i.codigo, desPro: i.descricao, codClf: i.ncm, codTns: null, cfoEnt: i.cfop_entrada,
        qtdRec: i.quantidade, uniMed: i.unidade, preUni: i.valor_unitario, vlrBru: i.valor_total,
        vlrIcm: i.impostos.ICMS?.valor ?? 0, perIcm: i.impostos.ICMS?.aliquota ?? 0, vlrIpi: i.impostos.IPI?.valor ?? 0,
        vlrPis: i.impostos.PIS?.valor ?? 0, vlrCof: i.impostos.COFINS?.valor ?? 0,
      })),
      _origem: { validador_id: doc.id, aprovacao: doc.aprovacao },
    }),
  },

  // Esboço para Sankhya (portal de importação de XML / serviço CACSP.incluirNota).
  sankhya: {
    nome: 'Sankhya (esboço — validar mapeamento)',
    converter: (doc) => ({
      cabecalho: {
        CODEMP: null, CODPARC: null, // de-para por CNPJ no Sankhya
        NUMNOTA: doc.numero, SERIENOTA: doc.serie, CHAVENFE: doc.chave_acesso, DTNEG: doc.data_emissao?.slice(0, 10),
        VLRNOTA: doc.totais.total, TIPMOV: 'C', CODTIPOPER: null,
      },
      itens: doc.itens.map((i) => ({
        SEQUENCIA: i.n_item, CODPROD: null, REFFORN: i.codigo, DESCRPROD: i.descricao, NCM: i.ncm, CODCFO: i.cfop_entrada,
        QTDNEG: i.quantidade, CODVOL: i.unidade, VLRUNIT: i.valor_unitario, VLRTOT: i.valor_total,
        BASEICMS: i.impostos.ICMS?.base ?? 0, ALIQICMS: i.impostos.ICMS?.aliquota ?? 0, VLRICMS: i.impostos.ICMS?.valor ?? 0,
        VLRIPI: i.impostos.IPI?.valor ?? 0, VLRSUBST: i.impostos.ICMSST?.valor ?? 0,
      })),
      _origem: { validador_id: doc.id, aprovacao: doc.aprovacao },
    }),
  },
};
