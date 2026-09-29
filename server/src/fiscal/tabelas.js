// Tabelas fiscais de referência. Valores parametrizáveis (alíquotas internas etc.)
// são apenas o padrão inicial: o administrador pode sobrescrevê-los nas regras.

export const UF_CODIGO = {
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN',
  25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC',
  43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
};
export const CODIGO_UF = Object.fromEntries(Object.entries(UF_CODIGO).map(([k, v]) => [v, k]));

// Alíquota modal interna de ICMS por UF (referência 2026; conferir legislação estadual vigente).
export const ALIQUOTA_INTERNA_PADRAO = {
  AC: 19, AL: 20, AM: 20, AP: 18, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19, MA: 23, MG: 18, MS: 17, MT: 17,
  PA: 19, PB: 20, PE: 20.5, PI: 22.5, PR: 19.5, RJ: 20, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SE: 20,
  SP: 18, TO: 20,
};

// Resolução SF 22/89: saídas de S/SE (exceto ES) para N/NE/CO/ES = 7%; demais = 12%.
// Resolução SF 13/2012: importados (origem 1, 2, 3, 8) = 4%.
const SUL_SUDESTE_SEM_ES = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);
export function aliquotaInterestadual(ufOrigem, ufDestino, origemMercadoria) {
  if (['1', '2', '3', '8'].includes(String(origemMercadoria ?? ''))) return 4;
  if (SUL_SUDESTE_SEM_ES.has(ufOrigem) && !SUL_SUDESTE_SEM_ES.has(ufDestino)) return 7;
  return 12;
}

export const CST_ICMS = ['00', '02', '10', '15', '20', '30', '40', '41', '50', '51', '53', '60', '61', '70', '90'];
export const CSOSN = ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'];
export const CST_ICMS_COM_ST = ['10', '30', '70', '201', '202', '203'];
export const CST_ICMS_TRIBUTADO = ['00', '10', '20', '70', '90'];
export const CST_PIS_COFINS_SAIDA = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '49', '99'];
export const CST_PIS_COFINS = [...CST_PIS_COFINS_SAIDA, '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66', '67', '70', '71', '72', '73', '74', '75', '98'];
export const CST_IPI_SAIDA = ['50', '51', '52', '53', '54', '55', '99'];
export const CST_IPI = ['00', '01', '02', '03', '04', '05', '49', ...CST_IPI_SAIDA];

// Grupos de CFOP (últimos 3 dígitos) por natureza da operação.
export const GRUPOS_CFOP = {
  venda: ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119', '120', '122', '123', '124', '125'],
  venda_st: ['401', '402', '403', '405'],
  transferencia: ['151', '152', '153', '155', '156', '408', '409', '552', '557'],
  devolucao: ['201', '202', '203', '204', '205', '206', '207', '208', '209', '210', '410', '411', '412', '413', '503', '553', '555', '556', '660', '661', '662', '918', '919'],
  industrializacao: ['124', '125', '901', '902', '903', '904', '924', '925'],
  bonificacao: ['910', '911'],
  remessa: ['905', '906', '907', '908', '909', '912', '913', '914', '915', '916', '917', '920', '921', '922', '923', '934', '949'],
  ativo: ['551', '552', '553', '554', '555', '557'],
  uso_consumo: ['556', '557'],
  servico: ['933', '301', '302', '303', '304', '305', '306', '307', '351', '352', '353', '354', '355', '356', '357', '359', '360'],
  combustivel: ['651', '652', '653', '654', '655', '656', '657', '658', '659', '660', '661', '662', '663', '664', '665', '666', '667'],
};

export function naturezaCfop(cfop) {
  const s = String(cfop || '');
  const sufixo = s.slice(1);
  const natureza = [];
  for (const [nome, lista] of Object.entries(GRUPOS_CFOP)) if (lista.includes(sufixo)) natureza.push(nome);
  return natureza;
}

export function direcaoCfop(cfop) {
  const d = String(cfop || '')[0];
  return {
    '1': { fluxo: 'entrada', abrangencia: 'interna' },
    '2': { fluxo: 'entrada', abrangencia: 'interestadual' },
    '3': { fluxo: 'entrada', abrangencia: 'exterior' },
    '5': { fluxo: 'saida', abrangencia: 'interna' },
    '6': { fluxo: 'saida', abrangencia: 'interestadual' },
    '7': { fluxo: 'saida', abrangencia: 'exterior' },
  }[d] || null;
}

export const DESCRICAO_CFOP = {
  '5101': 'Venda de produção do estabelecimento', '6101': 'Venda de produção do estabelecimento',
  '5102': 'Venda de mercadoria adquirida de terceiros', '6102': 'Venda de mercadoria adquirida de terceiros',
  '5103': 'Venda de produção efetuada fora do estabelecimento', '6107': 'Venda de produção a não contribuinte',
  '6108': 'Venda de mercadoria de terceiros a não contribuinte', '5116': 'Venda de produção originada de encomenda para entrega futura',
  '5117': 'Venda de mercadoria originada de encomenda para entrega futura', '5124': 'Industrialização efetuada para outra empresa',
  '6124': 'Industrialização efetuada para outra empresa', '5125': 'Industrialização efetuada para outra empresa (insumo não transitou)',
  '5151': 'Transferência de produção do estabelecimento', '6151': 'Transferência de produção do estabelecimento',
  '5152': 'Transferência de mercadoria adquirida de terceiros', '6152': 'Transferência de mercadoria adquirida de terceiros',
  '5201': 'Devolução de compra para industrialização', '6201': 'Devolução de compra para industrialização',
  '5202': 'Devolução de compra para comercialização', '6202': 'Devolução de compra para comercialização',
  '5401': 'Venda de produção em operação com ST (contribuinte substituto)', '6401': 'Venda de produção em operação com ST (contribuinte substituto)',
  '5403': 'Venda de mercadoria de terceiros com ST (contribuinte substituto)', '6403': 'Venda de mercadoria de terceiros com ST (contribuinte substituto)',
  '5405': 'Venda de mercadoria com ST (contribuinte substituído)', '5551': 'Venda de bem do ativo imobilizado',
  '6551': 'Venda de bem do ativo imobilizado', '5552': 'Transferência de bem do ativo imobilizado',
  '5556': 'Devolução de compra de material de uso ou consumo', '5901': 'Remessa para industrialização por encomenda',
  '6901': 'Remessa para industrialização por encomenda', '5902': 'Retorno de mercadoria utilizada na industrialização por encomenda',
  '6902': 'Retorno de mercadoria utilizada na industrialização por encomenda', '5910': 'Remessa em bonificação, doação ou brinde',
  '6910': 'Remessa em bonificação, doação ou brinde', '5911': 'Remessa de amostra grátis', '6911': 'Remessa de amostra grátis',
  '5915': 'Remessa para conserto ou reparo', '6915': 'Remessa para conserto ou reparo', '5916': 'Retorno de conserto ou reparo',
  '6916': 'Retorno de conserto ou reparo', '5949': 'Outra saída não especificada', '6949': 'Outra saída não especificada',
  '5933': 'Prestação de serviço tributado pelo ISSQN', '6933': 'Prestação de serviço tributado pelo ISSQN',
  '5353': 'Prestação de serviço de transporte a estabelecimento comercial', '6353': 'Prestação de serviço de transporte a estabelecimento comercial',
  '5352': 'Prestação de serviço de transporte a estabelecimento industrial', '6352': 'Prestação de serviço de transporte a estabelecimento industrial',
  '1101': 'Compra para industrialização', '2101': 'Compra para industrialização', '1102': 'Compra para comercialização',
  '2102': 'Compra para comercialização', '1403': 'Compra para comercialização com ST', '2403': 'Compra para comercialização com ST',
  '1551': 'Compra de bem para o ativo imobilizado', '2551': 'Compra de bem para o ativo imobilizado',
  '1556': 'Compra de material para uso ou consumo', '2556': 'Compra de material para uso ou consumo',
  '1407': 'Compra de mercadoria para uso ou consumo com ST', '2407': 'Compra de mercadoria para uso ou consumo com ST',
  '1406': 'Compra de bem para o ativo imobilizado com ST', '2406': 'Compra de bem para o ativo imobilizado com ST',
  '1152': 'Transferência para comercialização', '2152': 'Transferência para comercialização', '1151': 'Transferência para industrialização',
  '2151': 'Transferência para industrialização', '1202': 'Devolução de venda de mercadoria adquirida de terceiros',
  '2202': 'Devolução de venda de mercadoria adquirida de terceiros', '1201': 'Devolução de venda de produção do estabelecimento',
  '2201': 'Devolução de venda de produção do estabelecimento', '1910': 'Entrada de bonificação, doação ou brinde',
  '2910': 'Entrada de bonificação, doação ou brinde', '1949': 'Outra entrada não especificada', '2949': 'Outra entrada não especificada',
  '1901': 'Entrada para industrialização por encomenda', '2901': 'Entrada para industrialização por encomenda',
  '1902': 'Retorno de mercadoria remetida para industrialização', '2902': 'Retorno de mercadoria remetida para industrialização',
  '1915': 'Entrada para conserto ou reparo', '1916': 'Retorno de mercadoria remetida para conserto', '2916': 'Retorno de mercadoria remetida para conserto',
  '1353': 'Aquisição de serviço de transporte por estabelecimento comercial', '2353': 'Aquisição de serviço de transporte por estabelecimento comercial',
  '1352': 'Aquisição de serviço de transporte por estabelecimento industrial', '2352': 'Aquisição de serviço de transporte por estabelecimento industrial',
  '1933': 'Aquisição de serviço tributado pelo ISSQN', '2933': 'Aquisição de serviço tributado pelo ISSQN',
};

/**
 * Sugestão determinística do CFOP de entrada a partir do CFOP de saída do emitente
 * e da destinação da mercadoria (tipo do fornecedor / perfil da empresa).
 * É SUGESTÃO: o CFOP de escrituração só é gravado quando o usuário confirma.
 */
export function sugerirCfopEntrada(cfopSaida, { destinacao, perfilEmpresa } = {}) {
  const s = String(cfopSaida || '');
  if (!/^[5-7]\d{3}$/.test(s)) return null;
  const prefixo = s[0] === '5' ? '1' : s[0] === '6' ? '2' : '3';
  const suf = s.slice(1);
  const comST = ['401', '403', '405'].includes(suf);
  const mapaDireto = {
    '151': '151', '152': '152', '201': '201', '202': '202', '124': '124', '125': '125', '901': '901', '902': '902',
    '910': '910', '911': '911', '915': '915', '916': '916', '949': '949', '552': '552', '933': '933', '353': '353', '352': '352',
    '905': '905', '906': '906', '908': '908', '909': '909', '912': '912', '913': '913', '920': '920', '921': '921',
  };
  // Devolução: o fornecedor devolvendo uma compra nossa (5201/5202) = para nós, devolução de venda (1201/1202).
  if (mapaDireto[suf]) return prefixo + mapaDireto[suf];
  const venda = GRUPOS_CFOP.venda.includes(suf) || GRUPOS_CFOP.venda_st.includes(suf) || suf === '551';
  if (!venda) return null;
  switch (destinacao) {
    case 'uso_consumo': return prefixo + (comST ? '407' : '556');
    case 'ativo': return prefixo + (comST ? '406' : '551');
    case 'insumo': return prefixo + (comST ? '401' : '101');
    case 'revenda': return prefixo + (comST ? '403' : '102');
    default:
      if (perfilEmpresa === 'industria') return prefixo + (comST ? '401' : '101');
      return prefixo + (comST ? '403' : '102');
  }
}

export const TIPOS_FORNECEDOR = {
  revenda: 'Mercadoria para revenda',
  insumo: 'Insumo / industrialização',
  uso_consumo: 'Material de uso e consumo',
  ativo: 'Ativo imobilizado',
  servico: 'Prestador de serviço',
  transporte: 'Transportadora',
  outros: 'Outros',
};

export const CRT = { '1': 'Simples Nacional', '2': 'Simples Nacional - excesso de sublimite', '3': 'Regime Normal', '4': 'MEI' };
