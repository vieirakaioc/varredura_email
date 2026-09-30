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
  if (!i.fornecedor_cadastrado || i.itens === 0) return 'incompleta';
  return 'pendente';
}
const SITUACOES = { pendente: 'Pendente', inconsistente: 'Inconsistente', incompleta: 'Incompleta', processada: 'Processada' };

const SQL = `SELECT x.CHVNEL, x.NUMNFC, x.CODSNF, x.TIPNFE, x.TIPOPE, x.DATEMI, x.DATENT AS DATA_RECEBIMENTO, x.VLRLIQ, x.OBSNFC,
    fo.CODFOR AS FORNECEDOR_ID,
    (SELECT COUNT(*) FROM E000IPC ip WHERE ip.CHVNEL = x.CHVNEL) AS ITENS_PRODUTO,
    (SELECT COUNT(*) FROM E000ISC isv WHERE isv.CHVNEL = x.CHVNEL) AS ITENS_SERVICO,
    x.CGCFOR, fo.NOMFOR, x.CGCFIL, fi.CODEMP, fi.CODFIL, fi.NOMFIL, fi.SIGFIL, fi.SIGUFS, fd.NOMFOR AS NOME_DESTINO,
    n.NUMNFC AS ENTRADA_NUM, n.CODSNF AS ENTRADA_SERIE, n.DATENT AS ENTRADA_DATA, n.SITNFC AS ENTRADA_SITUACAO,
    sa.NUMNFV AS SAIDA_NUM
  FROM E000NFC x
  LEFT JOIN E440NFC n ON n.CHVNEL = x.CHVNEL
  LEFT JOIN E140IDE sa ON sa.CHVDOE = x.CHVNEL
  LEFT JOIN E070FIL fi ON fi.NUMCGC = x.CGCFIL
  LEFT JOIN E095FOR fo ON fo.CGCCPF = x.CGCFOR
  LEFT JOIN E095FOR fd ON fd.CGCCPF = x.CGCFIL
  WHERE x.DATEMI >= @desde AND x.DATEMI <= @ate{somenteAbertas}`;

// Modelo do documento pela chave de acesso (posições 21-22), usado enquanto a nota não tem série no Senior
const MODELOS = { 55: 'NF-e', 57: 'CT-e', 65: 'NFC-e', 58: 'MDF-e', 59: 'SAT', 67: 'CT-e OS' };
const modeloDaChave = (chave) => MODELOS[Number(String(chave ?? '').slice(20, 22))] ?? null;

const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
// Identidade da empresa destinatária: filial do grupo (codemp/codfil) ou, fora do grupo, o CNPJ
const chaveEmpresa = (i) => (i.empresa_do_grupo ? `${i.codemp}/${i.codfil}` : i.cnpj_destinatario);
const hoje = () => new Date().toLocaleDateString('sv-SE');
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
const soma = (lista, f) => Math.round(lista.reduce((s, x) => s + (f(x) ?? 0), 0) * 100) / 100;

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
  // então ela fica em cache por um minuto ("Atualizar" na tela força a leitura no banco).
  const sql = SQL.replace('{somenteAbertas}', tudoAberto ? ' AND n.CHVNEL IS NULL' : '');
  // A chave usa o filtro pedido, não as datas calculadas: "últimos 60 dias" vira um Date diferente
  // a cada chamada e o cache nunca seria aproveitado.
  const linhas = await comCache(
    `pendentes|${mes ?? ''}|${filtros.de ?? ''}|${filtros.ate ?? ''}|${filtros.dias ?? ''}|${tudoAberto}`,
    filtros.forcar === '1' ? 0 : 60_000,
    () => consultar(sql, de, { ate }),
  );

  // Chaves canceladas já conhecidas (SEFAZ ou registro de saída do Senior)
  const canceladas = new Map(all("SELECT chave, data_evento, justificativa FROM sefaz_eventos WHERE tp_evento IN ('110111','110112')")
    .map((c) => [c.chave, c]));

  const dia = hoje();
  let itens = linhas.map((l) => {
    const chave = String(l.CHVNEL ?? '').trim();
    const recebido = iso(l.DATA_RECEBIMENTO) ?? iso(l.DATEMI);
    const lancada = l.ENTRADA_DATA != null;
    const cancelada = canceladas.get(chave) ?? null;
    return {
      chave, numero: l.NUMNFC, especie: String(l.CODSNF ?? '').trim() || null,
      // Antes de lançar, a nota ainda não tem série no Senior: o modelo vem da chave de acesso
      especie_rotulo: ESPECIES[String(l.CODSNF ?? '').trim()] ?? modeloDaChave(chave) ?? 'Não identificado',
      tipo: TIPOS[l.TIPNFE] ?? `Tipo ${l.TIPNFE}`,
      emissao: iso(l.DATEMI), recebido_em: recebido,
      valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null,
      cnpj_fornecedor: String(l.CGCFOR ?? '').padStart(14, '0'), fornecedor: String(l.NOMFOR ?? '').trim() || null,
      codemp: l.CODEMP, codfil: l.CODFIL,
      cnpj_destinatario: String(l.CGCFIL ?? '').padStart(14, '0'),
      // Destinatário: filial do grupo quando o CNPJ está cadastrado; senão, o nome que o Senior conhece
      empresa: String(l.SIGFIL ?? '').trim() || String(l.NOMFIL ?? '').trim() || String(l.NOME_DESTINO ?? '').trim() || 'Empresa não identificada',
      empresa_do_grupo: l.CODEMP != null,
      uf: String(l.SIGUFS ?? '').trim() || null,
      lancada, entrada: lancada ? { numero: l.ENTRADA_NUM, serie: String(l.ENTRADA_SERIE ?? '').trim(), data: iso(l.ENTRADA_DATA), situacao: String(l.ENTRADA_SITUACAO ?? '').trim() } : null,
      // Documento emitido por nós (está no e-Docs de saída): não é pendência de entrada
      nossa_saida: l.SAIDA_NUM != null,
      tipo_movimento: l.SAIDA_NUM != null ? 'saida' : 'entrada',
      fornecedor_cadastrado: l.FORNECEDOR_ID != null,
      itens: Number(l.ITENS_PRODUTO ?? 0) + Number(l.ITENS_SERVICO ?? 0),
      dias_parada: recebido ? Math.max(0, diasEntre(recebido, dia)) : null,
      cancelada: Boolean(cancelada),
      cancelada_em: cancelada?.data_evento ?? null,
      justificativa_cancelamento: cancelada?.justificativa ?? null,
      observacao: String(l.OBSNFC ?? '').trim() || null,
    };
  }).map((i) => ({ ...i, situacao: classificar(i), situacao_rotulo: SITUACOES[classificar(i)] }));

  if (filtros.codemp) itens = itens.filter((i) => String(i.codemp) === String(filtros.codemp) && (!filtros.codfil || String(i.codfil) === String(filtros.codfil)));
  if (filtros.empresa) itens = itens.filter((i) => chaveEmpresa(i) === filtros.empresa);
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

  // Tipo: entradas (documentos de terceiros para nós) ou saídas (emitidos pelo grupo)
  if (filtros.tipo === 'saidas') itens = itens.filter((i) => i.tipo_movimento === 'saida');
  else if (filtros.tipo !== 'todos') itens = itens.filter((i) => i.tipo_movimento === 'entrada');

  const nossasSaidas = itens.filter((i) => i.nossa_saida && !i.lancada).length;
  const pendentes = itens.filter((i) => !i.lancada && !i.nossa_saida);
  const lancadas = itens.filter((i) => i.lancada);
  const porSituacao = Object.keys(SITUACOES).map((s) => ({
    chave: s, rotulo: SITUACOES[s],
    qtd: itens.filter((i) => i.situacao === s).length,
    valor: soma(itens.filter((i) => i.situacao === s), (i) => i.valor),
  }));
  const doDia = (lista, campo) => lista.filter((i) => i[campo] === dia);

  // Série diária dos últimos 21 dias: o que chegou x o que foi lançado
  const dias = Array.from({ length: 21 }, (_, k) => new Date(Date.now() - (20 - k) * 86400000).toLocaleDateString('sv-SE'));
  const serie = dias.map((d) => ({
    dia: d,
    recebidas: itens.filter((i) => i.recebido_em === d).length,
    lancadas: itens.filter((i) => i.entrada?.data === d).length,
    pendentes: itens.filter((i) => i.recebido_em === d && !i.lancada).length,
  }));

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
      lancadas_hoje: itens.filter((i) => i.entrada?.data === dia).length,
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
    por_empresa: agrupar(pendentes, chaveEmpresa, (i) => `${i.empresa}${i.uf ? ` (${i.uf})` : ''}`).slice(0, 12),
    por_especie: agrupar(pendentes, (i) => i.especie_rotulo, (i) => i.especie_rotulo),
    por_fornecedor: agrupar(pendentes, (i) => i.cnpj_fornecedor, (i) => i.fornecedor ?? i.cnpj_fornecedor).slice(0, 10),
    aging: FAIXAS.map((f) => ({
      ...f,
      qtd: pendentes.filter((i) => (i.dias_parada ?? 0) >= f.de && (i.dias_parada ?? 0) <= f.ate).length,
      valor: soma(pendentes.filter((i) => (i.dias_parada ?? 0) >= f.de && (i.dias_parada ?? 0) <= f.ate), (i) => i.valor),
    })),
    // situacoes = lista separada por vírgula, como as caixas de seleção do Senior (padrão: tudo menos processada)
    itens: itens
      .filter((i) => {
        const escolhidas = String(filtros.situacoes ?? 'pendente,inconsistente,incompleta').split(',').filter(Boolean);
        return escolhidas.includes('todas') || escolhidas.includes(i.situacao);
      })
      .filter((i) => (filtros.especie ? i.especie_rotulo === filtros.especie : true))
      .sort((a, b) => (b.dias_parada ?? 0) - (a.dias_parada ?? 0) || String(b.recebido_em).localeCompare(String(a.recebido_em)))
      .slice(0, 3000),
  };
}
