// Notas recebidas por XML no Senior (tela "Via Recebimento de Documento Eletrônico", tabela E000NFC)
// que ainda não viraram nota de entrada (E440NFC). Somente leitura.
//
// "Pendente" = o XML está no recebimento e não existe entrada com a mesma chave de acesso.
// Cancelamentos conhecidos (SEFAZ / saída do Senior) são destacados: não devem ser lançados.
import { all } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { comCache } from './cache.js';

const ESPECIES = { NFE: 'NF-e', CTE: 'CT-e', NF2: 'NF-e (série 2)', NF: 'Nota fiscal', CTR: 'CT-e (redespacho)' };
const TIPOS = { 1: 'Entrada', 2: 'Devolução', 4: 'Complementar', 8: 'Serviço/CT-e', 9: 'Ajuste', 11: 'Outro' };

/**
 * Mesma classificação da tela "Via Recebimento de Documento Eletrônico" do Senior.
 * O ERP calcula na hora (não guarda no banco); aqui reproduzimos pelos dados do XML:
 *   processada   = já existe nota de entrada com a chave
 *   inconsistente= cancelada na SEFAZ, destinatário fora do grupo ou valor zerado
 *   incompleta   = falta cadastro para lançar (fornecedor não cadastrado ou XML sem itens)
 *   pendente     = completa, só falta lançar
 */
function classificar(i) {
  if (i.lancada) return 'processada';
  if (i.cancelada || !i.empresa_do_grupo || !(i.valor > 0)) return 'inconsistente';
  if (!i.fornecedor_cadastrado || !i.tem_itens) return 'incompleta';
  return 'pendente';
}
const LIMITE_ITENS = 20000;
// Notas não lançadas aparecem sempre, qualquer que seja o período escolhido, até esta idade
const DIAS_ABERTAS = 365;
const SITUACOES = { pendente: 'Pendente', inconsistente: 'Inconsistente', incompleta: 'Incompleta', processada: 'Processada' };

// OUTER APPLY (TOP 1) em vez de LEFT JOIN: o mesmo CNPJ pode ter vários fornecedores/filiais no Senior e a
// mesma chave pode ter mais de uma entrada. Com JOIN a nota se repetia e as contagens inchavam.
// Entrada cancelada (SITNFC 3) não conta como lançada: o XML volta a ser pendência.
const SQL = `SELECT x.CHVNEL, x.NUMNFC, x.CODSNF, x.TIPNFE, x.TIPOPE, x.DATEMI, x.DATENT AS DATA_RECEBIMENTO, x.VLRLIQ, x.OBSNFC,
    fo.CODFOR AS FORNECEDOR_ID, fo.NOMFOR,
    CASE WHEN EXISTS (SELECT 1 FROM E000IPC ip WHERE ip.CHVNEL = x.CHVNEL)
           OR EXISTS (SELECT 1 FROM E000ISC isv WHERE isv.CHVNEL = x.CHVNEL) THEN 1 ELSE 0 END AS TEM_ITENS,
    x.CGCFOR, x.CGCFIL, fi.CODEMP, fi.CODFIL, fi.NOMFIL, fi.SIGFIL, fi.SIGUFS, fd.NOMFOR AS NOME_DESTINO,
    fe.CODEMP AS EMIT_CODEMP, fe.CODFIL AS EMIT_CODFIL, fe.NOMFIL AS EMIT_NOMFIL, fe.SIGFIL AS EMIT_SIGFIL, fe.SIGUFS AS EMIT_SIGUFS,
    n.NUMNFC AS ENTRADA_NUM, n.CODSNF AS ENTRADA_SERIE, n.DATENT AS ENTRADA_DATA, n.SITNFC AS ENTRADA_SITUACAO,
    sa.NUMNFV AS SAIDA_NUM
  FROM E000NFC x
  OUTER APPLY (SELECT TOP 1 n.NUMNFC, n.CODSNF, n.DATENT, n.SITNFC FROM E440NFC n
    WHERE n.CHVNEL = x.CHVNEL AND n.SITNFC <> '3' ORDER BY n.DATENT DESC) n
  OUTER APPLY (SELECT TOP 1 sa.NUMNFV FROM E140IDE sa WHERE sa.CHVDOE = x.CHVNEL) sa
  OUTER APPLY (SELECT TOP 1 fi.CODEMP, fi.CODFIL, fi.NOMFIL, fi.SIGFIL, fi.SIGUFS FROM E070FIL fi
    WHERE fi.NUMCGC = x.CGCFIL ORDER BY fi.CODEMP, fi.CODFIL) fi
  OUTER APPLY (SELECT TOP 1 fe.CODEMP, fe.CODFIL, fe.NOMFIL, fe.SIGFIL, fe.SIGUFS FROM E070FIL fe
    WHERE fe.NUMCGC = x.CGCFOR ORDER BY fe.CODEMP, fe.CODFIL) fe
  OUTER APPLY (SELECT TOP 1 fo.CODFOR, fo.NOMFOR FROM E095FOR fo WHERE fo.CGCCPF = x.CGCFOR ORDER BY fo.CODFOR) fo
  OUTER APPLY (SELECT TOP 1 fd.NOMFOR FROM E095FOR fd WHERE fd.CGCCPF = x.CGCFIL ORDER BY fd.CODFOR) fd
  -- Período pela emissão OU pelo recebimento: nota emitida antes do período e recebida dentro dele também entra.
  -- As ainda não lançadas entram sempre (desde @abertasDesde), como na tela do Senior: o período limita só as lançadas.
  WHERE (((x.DATEMI >= @desde AND x.DATEMI <= @ate) OR (x.DATENT >= @desde AND x.DATENT <= @ate))
      OR (x.DATEMI >= @abertasDesde AND NOT EXISTS (SELECT 1 FROM E440NFC n3 WHERE n3.CHVNEL = x.CHVNEL AND n3.SITNFC <> '3'))){somenteAbertas}`;

// Série "chegada × lançamento": XMLs recebidos por dia de chegada (só destinados às filiais do grupo), quantos
// deles ainda não viraram entrada, e entradas lançadas por dia de lançamento a partir de um XML recebido.
const SQL_SERIE = `SELECT 'R' AS TIPO, CAST(x.DATENT AS date) AS D, fi.CODEMP, fi.CODFIL, COUNT(*) AS N,
    SUM(CASE WHEN nl.L IS NULL THEN 1 ELSE 0 END) AS PEND
  FROM E000NFC x
  CROSS APPLY (SELECT TOP 1 fi.CODEMP, fi.CODFIL FROM E070FIL fi WHERE fi.NUMCGC = x.CGCFIL ORDER BY fi.CODEMP, fi.CODFIL) fi
  OUTER APPLY (SELECT TOP 1 1 AS L FROM E440NFC n WHERE n.CHVNEL = x.CHVNEL AND n.SITNFC <> '3') nl
  WHERE x.DATENT >= @desde AND x.DATENT <= @ate
  GROUP BY CAST(x.DATENT AS date), fi.CODEMP, fi.CODFIL
  UNION ALL
  SELECT 'L', CAST(n.DATGER AS date), n.CODEMP, n.CODFIL, COUNT(*), 0
  FROM E440NFC n
  WHERE n.DATGER >= @desde AND n.DATGER <= @ate AND n.SITNFC <> '3'
    AND EXISTS (SELECT 1 FROM E000NFC x WHERE x.CHVNEL = n.CHVNEL)
  GROUP BY CAST(n.DATGER AS date), n.CODEMP, n.CODFIL`;

// Modelo do documento pela chave de acesso (posições 21-22), usado enquanto a nota não tem série no Senior
const MODELOS = { 55: 'NF-e', 57: 'CT-e', 65: 'NFC-e', 58: 'MDF-e', 59: 'SAT', 67: 'CT-e OS' };
const modeloDaChave = (chave) => MODELOS[Number(String(chave ?? '').slice(20, 22))] ?? null;

// O Senior grava data vazia como 31/12/1900
const iso = (v) => {
  const d = v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;
  return d && d > '1901-01-01' ? d : null;
};
// Tipo de operação do XML (tpNF): 0/E = entrada, 1/S = saída
const ehEntrada = (tipope) => ['0', 'E'].includes(String(tipope ?? '').trim().toUpperCase());
// Identidade da empresa destinatária: filial do grupo (codemp/codfil) ou, fora do grupo, o CNPJ
const chaveEmpresa = (i) => (i.empresa_do_grupo ? `${i.codemp}/${i.codfil}` : i.cnpj_destinatario);
const hoje = () => new Date().toLocaleDateString('sv-SE');
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
const soma = (lista, f) => Math.round(lista.reduce((s, x) => s + (f(x) ?? 0), 0) * 100) / 100;

/** Uma linha do Senior -> nota da tela, já com a situação (mesma regra da tela do Senior). */
function montarItem(l, canceladas, dia) {
  const chave = String(l.CHVNEL ?? '').trim();
  const recebido = iso(l.DATA_RECEBIMENTO) ?? iso(l.DATEMI);
  const lancada = l.ENTRADA_NUM != null;
  const cancelada = canceladas.get(chave) ?? null;
  const cnpjFornecedor = String(l.CGCFOR ?? '').padStart(14, '0');
  const cnpjDestino = String(l.CGCFIL ?? '').padStart(14, '0');
  // Documento emitido pelo grupo (está no e-Docs de saída do Senior). Só não é pendência de entrada quando
  // é uma saída de verdade. Continuam como entrada:
  //  - nota de entrada própria (tpNF = 0), ex.: compra de produtor rural emitida pela Biomassa: quem lança é o emitente
  //  - transferência entre empresas do grupo: quem lança é a filial destinatária
  const emitidaPeloGrupo = l.SAIDA_NUM != null || l.EMIT_CODEMP != null;
  const entradaPropria = emitidaPeloGrupo && ehEntrada(l.TIPOPE) && l.EMIT_CODEMP != null;
  const transferencia = emitidaPeloGrupo && !entradaPropria && l.CODEMP != null && cnpjDestino !== cnpjFornecedor;
  const nossaSaida = l.SAIDA_NUM != null && !entradaPropria && !transferencia;
  // Empresa que precisa lançar: o destinatário; na entrada própria, o próprio emitente
  const dest = entradaPropria
    ? { CODEMP: l.EMIT_CODEMP, CODFIL: l.EMIT_CODFIL, SIGFIL: l.EMIT_SIGFIL, NOMFIL: l.EMIT_NOMFIL, SIGUFS: l.EMIT_SIGUFS }
    : l;
  return {
    chave, numero: l.NUMNFC, especie: String(l.CODSNF ?? '').trim() || null,
    // Antes de lançar, a nota ainda não tem série no Senior: o modelo vem da chave de acesso
    especie_rotulo: ESPECIES[String(l.CODSNF ?? '').trim()] ?? modeloDaChave(chave) ?? 'Não identificado',
    tipo: TIPOS[l.TIPNFE] ?? `Tipo ${l.TIPNFE}`,
    emissao: iso(l.DATEMI), recebido_em: recebido,
    valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null,
    cnpj_fornecedor: cnpjFornecedor, fornecedor: String(l.NOMFOR ?? '').trim() || null,
    codemp: dest.CODEMP, codfil: dest.CODFIL,
    cnpj_destinatario: entradaPropria ? cnpjFornecedor : cnpjDestino,
    // Destinatário: filial do grupo quando o CNPJ está cadastrado; senão, o nome que o Senior conhece
    empresa: String(dest.SIGFIL ?? '').trim() || String(dest.NOMFIL ?? '').trim() || String(l.NOME_DESTINO ?? '').trim() || 'Empresa não identificada',
    empresa_do_grupo: dest.CODEMP != null,
    uf: String(dest.SIGUFS ?? '').trim() || null,
    lancada, entrada: lancada ? { numero: l.ENTRADA_NUM, serie: String(l.ENTRADA_SERIE ?? '').trim(), data: iso(l.ENTRADA_DATA), situacao: String(l.ENTRADA_SITUACAO ?? '').trim() } : null,
    nossa_saida: nossaSaida,
    entrada_propria: entradaPropria,
    transferencia,
    tipo_movimento: nossaSaida ? 'saida' : 'entrada',
    // na entrada própria o "fornecedor" é o produtor, que nem sempre está no XML como CNPJ cadastrado
    fornecedor_cadastrado: l.FORNECEDOR_ID != null || entradaPropria,
    tem_itens: Number(l.TEM_ITENS) === 1,
    dias_parada: recebido ? Math.max(0, diasEntre(recebido, dia)) : null,
    cancelada: Boolean(cancelada),
    cancelada_em: cancelada?.data_evento ?? null,
    justificativa_cancelamento: cancelada?.justificativa ?? null,
    observacao: String(l.OBSNFC ?? '').trim() || null,
  };
}
function montarItemClassificado(l, canceladas, dia) {
  const i = montarItem(l, canceladas, dia);
  const situacao = classificar(i);
  return { ...i, situacao, situacao_rotulo: SITUACOES[situacao] };
}

/**
 * Painel de notas pendentes de lançamento.
 * filtros: de, ate, dias (padrão 60), codemp, codfil, especie, situacao (pendentes|lancadas|todas), fornecedor
 */
export async function painelPendentes(filtros = {}) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  // Período: mês fechado (AAAA-MM) ou os últimos N dias
  const mes = /^\d{4}-\d{2}$/.test(String(filtros.mes ?? '')) ? String(filtros.mes) : null;
  // Datas em UTC ("Z"): o driver do SQL Server converte, e sem isso o período anda 3 horas
  const ultimoDia = mes ? new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
  const ate = mes ? new Date(`${ultimoDia}T23:59:59Z`)
    : filtros.ate ? new Date(`${filtros.ate}T23:59:59Z`) : new Date();
  // "dias=tudo": traz todas as notas em aberto, sem limite de data. Para o volume não explodir,
  // nesse modo a consulta já exclui no banco o que virou nota de entrada.
  const tudoAberto = !mes && String(filtros.dias) === 'tudo';
  const de = mes ? new Date(`${mes}-01T00:00:00Z`)
    : tudoAberto ? new Date('2000-01-01T00:00:00Z')
      : filtros.de ? new Date(`${filtros.de}T00:00:00Z`) : new Date(Date.now() - (Number(filtros.dias) || 60) * 86400000);
  // Os filtros da tela são aplicados abaixo, sobre estas linhas: só o período muda a consulta,
  // então ela fica em cache por cinco minutos ("Atualizar" na tela força a leitura no banco).
  const sql = SQL.replace('{somenteAbertas}', tudoAberto ? " AND NOT EXISTS (SELECT 1 FROM E440NFC n2 WHERE n2.CHVNEL = x.CHVNEL AND n2.SITNFC <> '3')" : '');
  // A chave usa o filtro pedido, não as datas calculadas: "últimos 60 dias" vira um Date diferente
  // a cada chamada e o cache nunca seria aproveitado.
  // A série do gráfico "chegada × lançamento" é outra consulta: começa junto, sem esperar a principal
  const hojeSerie = hoje();
  const diasSerie = Array.from({ length: 21 }, (_, k) => new Date(Date.now() - (20 - k) * 86400000).toLocaleDateString('sv-SE'));
  const serieAsync = comCache(`pendentes-serie|${hojeSerie}`, filtros.forcar === '1' ? 0 : 300_000,
    () => consultar(SQL_SERIE, new Date(`${diasSerie[0]}T00:00:00Z`), { ate: new Date(`${hojeSerie}T23:59:59Z`) }));
  serieAsync.catch(() => {}); // o erro é tratado lá embaixo
  const linhas = await comCache(
    `pendentes3|${mes ?? ''}|${filtros.de ?? ''}|${filtros.ate ?? ''}|${filtros.dias ?? ''}|${tudoAberto}`,
    filtros.forcar === '1' ? 0 : 300_000,
    () => consultar(sql, de, { ate, abertasDesde: new Date(Date.now() - DIAS_ABERTAS * 86400000) }),
  );

  // Chaves canceladas já conhecidas (SEFAZ ou registro de saída do Senior)
  const canceladas = new Map(all("SELECT chave, data_evento, justificativa FROM sefaz_eventos WHERE tp_evento IN ('110111','110112')")
    .map((c) => [c.chave, c]));

  const dia = hoje();
  let itens = linhas.map((l) => montarItemClassificado(l, canceladas, dia));

  if (filtros.codemp) itens = itens.filter((i) => String(i.codemp) === String(filtros.codemp) && (!filtros.codfil || String(i.codfil) === String(filtros.codfil)));
  // A base do Senior também recebe XMLs de terceiros: por padrão, só o que é destinado ao grupo
  const foraDoGrupo = itens.filter((i) => !i.empresa_do_grupo).length;
  if (filtros.incluir_terceiros !== '1') itens = itens.filter((i) => i.empresa_do_grupo);
  // Lista completa das empresas do resultado, para as caixas de seleção (antes de excluir qualquer uma)
  const empresasDisponiveis = [...itens.reduce((m, i) => {
    const chave = chaveEmpresa(i);
    const a = m.get(chave) ?? { chave, rotulo: `${i.empresa}${i.uf ? ` (${i.uf})` : ''}`, qtd: 0, do_grupo: i.empresa_do_grupo };
    a.qtd += 1;
    return m.set(chave, a);
  }, new Map()).values()].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  // sem_empresas = empresas desmarcadas nas caixas de seleção (ex.: empresas que não são acompanhadas)
  const excluidas = String(filtros.sem_empresas ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  if (excluidas.length) itens = itens.filter((i) => !excluidas.includes(chaveEmpresa(i)));
  if (filtros.fornecedor) {
    const busca = String(filtros.fornecedor).toLowerCase();
    const numero = busca.replace(/\D/g, '');
    itens = itens.filter((i) => (i.fornecedor ?? '').toLowerCase().includes(busca) || (numero.length >= 4 && i.cnpj_fornecedor.includes(numero)));
  }

  // Contado antes do filtro de tipo (com "Entradas" marcado ele sempre dava zero)
  const nossasSaidas = itens.filter((i) => i.nossa_saida && !i.lancada).length;
  // Tipo: entradas (documentos de terceiros para nós) ou saídas (emitidos pelo grupo)
  if (filtros.tipo === 'saidas') itens = itens.filter((i) => i.tipo_movimento === 'saida');
  else if (filtros.tipo !== 'todos') itens = itens.filter((i) => i.tipo_movimento === 'entrada');
  // Filtro de empresa (clique no cartão "Pendentes por empresa") por último: o cartão e as caixas de
  // seleção continuam mostrando todas as empresas, com a escolhida em destaque
  const pendentesTodasEmpresas = itens.filter((i) => !i.lancada && !i.nossa_saida);
  if (filtros.empresa) itens = itens.filter((i) => chaveEmpresa(i) === filtros.empresa);

  const pendentes = itens.filter((i) => !i.lancada && !i.nossa_saida);
  const lancadas = itens.filter((i) => i.lancada);
  const porSituacao = Object.keys(SITUACOES).map((s) => ({
    chave: s, rotulo: SITUACOES[s],
    qtd: itens.filter((i) => i.situacao === s).length,
    valor: soma(itens.filter((i) => i.situacao === s), (i) => i.valor),
  }));
  const doDia = (lista, campo) => lista.filter((i) => i[campo] === dia);

  // Série diária dos últimos 21 dias: o que chegou x o que foi lançado. Consulta própria: a lista acima
  // depende do período/filtros (no "Tudo em aberto" nem tem notas lançadas) e não serve para isso.
  const porDia = new Map(diasSerie.map((d) => [d, { dia: d, recebidas: 0, lancadas: 0, pendentes: 0 }]));
  try {
    const linhasSerie = await serieAsync;
    for (const l of linhasSerie) {
      const empresaSerie = `${l.CODEMP}/${l.CODFIL}`;
      if (filtros.empresa && empresaSerie !== filtros.empresa) continue;
      if (excluidas.includes(empresaSerie)) continue;
      const r = porDia.get(iso(l.D));
      if (!r) continue;
      if (l.TIPO === 'R') { r.recebidas += Number(l.N); r.pendentes += Number(l.PEND); } else r.lancadas += Number(l.N);
    }
  } catch {
    // sem a consulta, cai para o que dá para tirar da lista
    for (const i of itens) {
      const r = porDia.get(i.recebido_em);
      if (r) { r.recebidas += 1; if (!i.lancada) r.pendentes += 1; }
    }
  }
  const serie = [...porDia.values()];

  const agrupar = (lista, chave, rotulo) => [...lista.reduce((m, i) => {
    const k = chave(i) ?? '—';
    const atual = m.get(k) ?? { chave: k, rotulo: rotulo(i), qtd: 0, valor: 0 };
    atual.qtd += 1; atual.valor += i.valor ?? 0;
    return m.set(k, atual);
  }, new Map()).values()].sort((a, b) => b.qtd - a.qtd);

  const FAIXAS = [
    { id: '0-2', rotulo: 'Até 2 dias', de: 0, ate: 2 },
    { id: '3-5', rotulo: '3 a 5 dias', de: 3, ate: 5 },
    { id: '6-10', rotulo: '6 a 10 dias', de: 6, ate: 10 },
    { id: '11-30', rotulo: '11 a 30 dias', de: 11, ate: 30 },
    { id: '31+', rotulo: 'Mais de 30 dias', de: 31, ate: Infinity },
  ];

  return {
    periodo: { de: de.toLocaleDateString('sv-SE'), ate: ate.toLocaleDateString('sv-SE') },
    tudo_aberto: tudoAberto,
    empresas_disponiveis: empresasDisponiveis, sem_empresas: excluidas,
    indicadores: {
      pendentes: pendentes.length, pendentes_valor: soma(pendentes, (i) => i.valor),
      lancadas: lancadas.length, lancadas_valor: soma(lancadas, (i) => i.valor),
      recebidas_hoje: doDia(itens, 'recebido_em').length,
      // "hoje" pela data do lançamento (como na aba Produtividade), de XMLs recebidos; vem da série do gráfico
      lancadas_hoje: porDia.get(dia)?.lancadas ?? itens.filter((i) => i.entrada?.data === dia).length,
      pendentes_hoje: doDia(pendentes, 'recebido_em').length,
      canceladas_pendentes: pendentes.filter((i) => i.cancelada).length,
      paradas_mais_5: pendentes.filter((i) => (i.dias_parada ?? 0) > 5).length,
      mais_antiga: pendentes.reduce((max, i) => Math.max(max, i.dias_parada ?? 0), 0),
      total: itens.length,
      fora_do_grupo: foraDoGrupo,        // XMLs de terceiros na base do Senior
      nossas_saidas: nossasSaidas,       // documentos que nós emitimos (não são entrada)
    },
    por_situacao: porSituacao,
    serie,
    por_empresa: agrupar(pendentesTodasEmpresas, chaveEmpresa, (i) => `${i.empresa}${i.uf ? ` (${i.uf})` : ''}`),
    por_especie: agrupar(pendentes, (i) => i.especie_rotulo, (i) => i.especie_rotulo),
    por_fornecedor: agrupar(pendentes, (i) => i.cnpj_fornecedor, (i) => i.fornecedor ?? i.cnpj_fornecedor).slice(0, 50),
    aging: FAIXAS.map((f) => ({
      ...f,
      qtd: pendentes.filter((i) => (i.dias_parada ?? 0) >= f.de && (i.dias_parada ?? 0) <= f.ate).length,
      valor: soma(pendentes.filter((i) => (i.dias_parada ?? 0) >= f.de && (i.dias_parada ?? 0) <= f.ate), (i) => i.valor),
    })),
    // situacoes = lista separada por vírgula, como as caixas de seleção do Senior (padrão: tudo menos processada)
    ...(() => {
      const escolhidas = String(filtros.situacoes ?? 'pendente,inconsistente,incompleta').split(',').filter(Boolean);
      const lista = itens
        .filter((i) => escolhidas.includes('todas') || escolhidas.includes(i.situacao))
        .filter((i) => (filtros.especie ? i.especie_rotulo === filtros.especie : true))
        .sort((a, b) => (b.dias_parada ?? 0) - (a.dias_parada ?? 0) || String(b.recebido_em).localeCompare(String(a.recebido_em)));
      // Limite alto só para proteger o navegador; a tela avisa quando cortar
      return { itens: lista.slice(0, LIMITE_ITENS), total_itens: lista.length, truncado: lista.length > LIMITE_ITENS };
    })(),
  };
}

/**
 * Diagnóstico: por que um XML aparece ou não na lista de pendentes.
 * busca = chave de acesso (44 dígitos) ou CNPJ (do emitente ou do destinatário). Sem limite de data.
 */
export async function diagnosticarPendentes(busca) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  const dig = String(busca ?? '').replace(/\D/g, '');
  if (dig.length !== 44 && dig.length !== 14 && dig.length !== 11) throw new Error('Informe a chave de acesso (44 dígitos) ou um CNPJ/CPF');
  const filtro = dig.length === 44 ? 'x.CHVNEL = @busca' : '(x.CGCFIL = CAST(@num AS NUMERIC(14,0)) OR x.CGCFOR = CAST(@num AS NUMERIC(14,0)))';
  const sql = SQL.replace('SELECT x.CHVNEL', 'SELECT TOP 300 x.CHVNEL, x.TIPOPE AS TIPOPE_BRUTO')
    .replace(/WHERE \(\(\(x\.DATEMI[\s\S]*\{somenteAbertas\}/, `WHERE ${filtro} ORDER BY x.DATEMI DESC`);
  const extras = dig.length === 44 ? { busca: dig } : { num: dig };
  const [linhas, filiais] = await Promise.all([
    consultar(sql, null, extras),
    dig.length === 44 ? Promise.resolve([]) : consultar('SELECT CODEMP, CODFIL, NOMFIL, SIGFIL, NUMCGC FROM E070FIL WHERE NUMCGC = CAST(@num AS NUMERIC(14,0))', null, { num: dig }),
  ]);
  const canceladas = new Map(all("SELECT chave, data_evento, justificativa FROM sefaz_eventos WHERE tp_evento IN ('110111','110112')").map((c) => [c.chave, c]));
  const dia = hoje();
  return {
    filiais_com_este_cnpj: filiais.map((f) => ({ codemp: f.CODEMP, codfil: f.CODFIL, nome: String(f.SIGFIL ?? f.NOMFIL ?? '').trim() })),
    notas: linhas.map((l) => {
      const i = montarItemClassificado(l, canceladas, dia);
      const motivos = [];
      if (i.lancada) motivos.push(`já lançada no Senior (NF ${i.entrada.numero}, ${i.entrada.data ?? 'sem data'}, situação ${i.entrada.situacao})`);
      if (!i.empresa_do_grupo) motivos.push('destinatário não encontrado nas filiais do Senior (E070FIL): só aparece com "Incluir XMLs de terceiros"');
      if (i.nossa_saida) motivos.push('tratada como saída do grupo: só aparece com Tipo "Saídas" ou "Todos"');
      return {
        chave: i.chave, numero: i.numero, emissao: i.emissao, recebido_em: i.recebido_em, valor: i.valor,
        cnpj_emitente: i.cnpj_fornecedor, emitente: i.fornecedor, cnpj_destinatario: String(l.CGCFIL ?? ''), empresa: i.empresa,
        tipope_no_xml: l.TIPOPE_BRUTO, emitida_pelo_grupo: l.SAIDA_NUM != null || l.EMIT_CODEMP != null,
        entrada_propria: i.entrada_propria, transferencia: i.transferencia,
        situacao: i.situacao_rotulo, aparece_na_lista_padrao: !motivos.length, motivos,
      };
    }),
  };
}
