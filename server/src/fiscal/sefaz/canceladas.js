// Cruzamento: NF-e canceladas na SEFAZ x notas já escrituradas no Senior.
// É o alerta que interessa ao fiscal: "entrou, foi lançada, e depois o fornecedor cancelou".
import { all, get, insert, run } from '../../db/index.js';
import { consultar, seniorConfigurado } from '../../erp/senior.js';
import { CANCELAMENTOS } from './dfe.js';

const LOTE = 300; // chaves por consulta ao Senior
// Notas de saída canceladas no próprio Senior (E140IDE, e-Docs de venda): SitDoe 9 = cancelado.
// Serve para transferências dentro do grupo — pega o cancelamento mesmo sem certificado da filial.
const SQL_SAIDAS_CANCELADAS = `SELECT s.CHVDOE, s.CODEMP AS EMP_SAIDA, s.CODFIL AS FIL_SAIDA, s.NUMNFV, s.DATCAN, s.NUMPRC, s.USUCAN,
    n.CODEMP, n.CODFIL, n.NUMNFC, n.CODSNF, n.DATENT, n.VLRLIQ, n.SITNFC, f.NOMFOR, fi.NOMFIL,
    (SELECT COUNT(*) FROM E501TCP t WHERE t.CODEMP = n.CODEMP AND t.FILNFC = n.CODFIL AND t.CODFOR = n.CODFOR AND t.NUMNFC = n.NUMNFC AND t.SITTIT <> 'CA') AS TITULOS,
    (SELECT COALESCE(SUM(t.VLRABE), 0) FROM E501TCP t WHERE t.CODEMP = n.CODEMP AND t.FILNFC = n.CODFIL AND t.CODFOR = n.CODFOR AND t.NUMNFC = n.NUMNFC AND t.SITTIT IN ('AB','AV','AI','PE')) AS SALDO_ABERTO
  FROM E140IDE s
  JOIN E440NFC n ON n.CHVNEL = s.CHVDOE
  JOIN E095FOR f ON f.CODFOR = n.CODFOR
  LEFT JOIN E070FIL fi ON fi.CODEMP = n.CODEMP AND fi.CODFIL = n.CODFIL
  WHERE s.SITDOE = 9 AND s.DATCAN >= @desde AND s.DATCAN <= @ate`;
// Situação da nota de entrada no Senior (E440NFC.SITNFC)
const SITUACAO_SENIOR = { 1: 'Pendente/em digitação', 2: 'Ativa (escriturada)', 3: 'Cancelada no Senior' };
const CANCELADA_NO_SENIOR = ['3'];

/** Eventos de cancelamento recebidos, com a situação no Senior (lançada / não lançada). */
export async function canceladasNaSefaz({ dias = 180, mes, so_lancadas } = {}) {
  // Período: um mês exato (AAAA-MM) ou os últimos N dias
  const mesValido = /^\d{4}-\d{2}$/.test(String(mes ?? '')) ? String(mes) : null;
  const periodo = mesValido
    ? { de: `${mesValido}-01`, ate: new Date(Number(mesValido.slice(0, 4)), Number(mesValido.slice(5, 7)), 0).toLocaleDateString('sv-SE') }
    : { de: new Date(Date.now() - (Number(dias) || 180) * 86400000).toLocaleDateString('sv-SE'), ate: new Date().toLocaleDateString('sv-SE') };
  const eventos = all(`SELECT e.*, (SELECT d.id FROM documentos d WHERE replace(d.chave_acesso, 'NFSE', '') = e.chave LIMIT 1) AS documento_id,
      (SELECT d.numero FROM documentos d WHERE replace(d.chave_acesso, 'NFSE', '') = e.chave LIMIT 1) AS documento_numero,
      (SELECT r.emitente_nome FROM sefaz_eventos r WHERE r.chave = e.chave AND r.emitente_nome IS NOT NULL LIMIT 1) AS emitente_resumo,
      (SELECT r.numero FROM sefaz_eventos r WHERE r.chave = e.chave AND r.numero IS NOT NULL LIMIT 1) AS numero_resumo,
      (SELECT r.valor FROM sefaz_eventos r WHERE r.chave = e.chave AND r.valor IS NOT NULL LIMIT 1) AS valor_resumo,
      u.nome AS tratado_por_nome
    FROM sefaz_eventos e LEFT JOIN usuarios u ON u.id = e.tratado_por
    WHERE e.tp_evento IN (${CANCELAMENTOS.map(() => '?').join(',')})
      AND date(COALESCE(e.data_evento, e.created_at)) BETWEEN ? AND ?
    ORDER BY COALESCE(e.data_evento, e.created_at) DESC`, [...CANCELAMENTOS, periodo.de, periodo.ate]);
  // Situação no Senior (a nota pode ter sido lançada mesmo sem ter passado pelo nosso e-mail)
  const porChave = new Map();
  let senior = 'ok';
  if (seniorConfigurado()) {
    const chaves = [...new Set(eventos.map((e) => e.chave))];
    try {
      for (let i = 0; i < chaves.length; i += LOTE) {
        const parte = chaves.slice(i, i + LOTE);
        const lista = parte.map((c) => `'${c.replace(/\D/g, '')}'`).join(',');
        const linhas = await consultar(`SELECT n.CHVNEL, n.CODEMP, n.CODFIL, n.NUMNFC, n.CODSNF, n.DATENT, n.VLRLIQ, n.SITNFC,
            f.NOMFOR, fi.NOMFIL, fi.SIGUFS AS UF_ENTRADA,
            s.CODEMP AS EMIT_EMP, s.CODFIL AS EMIT_FIL, s.NUMNFV AS EMIT_NUM, s.DATCAN AS EMIT_DATCAN, s.NUMPRC AS EMIT_PROT,
            fe.NOMFIL AS EMIT_NOME, fe.SIGUFS AS EMIT_UF,
            (SELECT COUNT(*) FROM E501TCP t WHERE t.CODEMP = n.CODEMP AND t.FILNFC = n.CODFIL AND t.CODFOR = n.CODFOR AND t.NUMNFC = n.NUMNFC AND t.SITTIT NOT IN ('CA')) AS TITULOS,
            (SELECT COALESCE(SUM(t.VLRABE), 0) FROM E501TCP t WHERE t.CODEMP = n.CODEMP AND t.FILNFC = n.CODFIL AND t.CODFOR = n.CODFOR AND t.NUMNFC = n.NUMNFC AND t.SITTIT IN ('AB','AV','AI','PE')) AS SALDO_ABERTO
          FROM E440NFC n JOIN E095FOR f ON f.CODFOR = n.CODFOR
          LEFT JOIN E070FIL fi ON fi.CODEMP = n.CODEMP AND fi.CODFIL = n.CODFIL
          LEFT JOIN E140IDE s ON s.CHVDOE = n.CHVNEL AND s.SITDOE = 9
          LEFT JOIN E070FIL fe ON fe.CODEMP = s.CODEMP AND fe.CODFIL = s.CODFIL
          WHERE n.CHVNEL IN (${lista})`);
        for (const l of linhas) {
          porChave.set(String(l.CHVNEL).trim(), {
            codemp: l.CODEMP, codfil: l.CODFIL, filial: String(l.NOMFIL ?? '').trim() || null,
            numero: l.NUMNFC, serie: String(l.CODSNF ?? '').trim(), fornecedor: String(l.NOMFOR ?? '').trim() || null,
            entrada: l.DATENT instanceof Date ? l.DATENT.toISOString().slice(0, 10) : String(l.DATENT ?? '').slice(0, 10),
            valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null, situacao_senior: String(l.SITNFC ?? '').trim(),
            titulos: Number(l.TITULOS ?? 0), saldo_aberto: Number(l.SALDO_ABERTO ?? 0),
            uf: String(l.UF_ENTRADA ?? '').trim() || null,
            // Lado do emitente quando a nota é do próprio grupo (operação entre empresas)
            emitente: l.EMIT_EMP != null ? {
              codemp: l.EMIT_EMP, codfil: l.EMIT_FIL, nome: String(l.EMIT_NOME ?? '').trim() || null,
              uf: String(l.EMIT_UF ?? '').trim() || null, numero: l.EMIT_NUM,
              cancelado_em: l.EMIT_DATCAN instanceof Date ? l.EMIT_DATCAN.toISOString().slice(0, 10) : null,
              protocolo: String(l.EMIT_PROT ?? '').trim() || null,
            } : null,
          });
        }
      }
    } catch (e) { senior = `erro: ${e.message}`; }
  } else senior = 'nao_configurado';

  // Segunda fonte: o próprio Senior já registra o cancelamento das notas de saída do grupo
  const extras = [];
  if (seniorConfigurado() && senior === 'ok') {
    try {
      for (const l of await consultar(SQL_SAIDAS_CANCELADAS, new Date(`${periodo.de}T00:00:00Z`), { ate: new Date(`${periodo.ate}T23:59:59Z`) })) {
        const chave = String(l.CHVDOE ?? '').trim();
        // Já veio pela SEFAZ: descarta o registro do Senior (e apaga o que tenha sobrado de execuções anteriores)
        if (eventos.some((e) => e.chave === chave && e.nsu !== 'senior-saida')) {
          run("DELETE FROM sefaz_eventos WHERE chave = ? AND nsu = 'senior-saida' AND tratado_em IS NULL", [chave]);
          continue;
        }
        if (eventos.some((e) => e.chave === chave)) continue; // já está gravado como evento do Senior
        const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
        // Guarda como evento (nsu "senior-saida") para poder ser tratado/observado como os demais
        const dados = {
          chave, cnpj_destinatario: '', tipo: 'evento', tp_evento: '110111', descricao: 'Cancelamento (registrado na saída do Senior)',
          data_evento: iso(l.DATCAN), protocolo: String(l.NUMPRC ?? '').trim() || null,
          emitente_nome: String(l.NOMFOR ?? '').trim() || null, numero: String(l.NUMNFC ?? ''),
          valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null, nsu: 'senior-saida',
        };
        const jaGravado = get('SELECT * FROM sefaz_eventos WHERE chave = ? AND nsu = ?', [chave, 'senior-saida']);
        const id = jaGravado?.id ?? insert('sefaz_eventos', dados);
        extras.push({
          ...dados, id, origem: 'senior_saida',
          tratado_em: jaGravado?.tratado_em ?? null, observacao: jaGravado?.observacao ?? null,
          senior: {
            codemp: l.CODEMP, codfil: l.CODFIL, filial: String(l.NOMFIL ?? '').trim() || null, numero: l.NUMNFC,
            serie: String(l.CODSNF ?? '').trim(), fornecedor: String(l.NOMFOR ?? '').trim() || null, entrada: iso(l.DATENT),
            valor: l.VLRLIQ != null ? Number(l.VLRLIQ) : null, situacao_senior: String(l.SITNFC ?? '').trim(),
            titulos: Number(l.TITULOS ?? 0), saldo_aberto: Number(l.SALDO_ABERTO ?? 0),
          },
        });
      }
    } catch (e) { senior = `parcial: ${e.message}`; }
  }

  const dinheiro = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const dataBr = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');

  /** Texto pronto para o fiscal: quem emitiu, quem recebeu, qual é o problema e o que fazer. */
  function explicar(item) {
    const s = item.senior;
    const emit = s?.emitente;
    const quem = emit
      ? `Operação entre empresas do grupo: emitida pela empresa ${emit.codemp} / filial ${emit.codfil}${emit.nome ? ` (${emit.nome}${emit.uf ? `-${emit.uf}` : ''})` : ''} como NF ${emit.numero ?? item.numero}, e recebida pela empresa ${s.codemp} / filial ${s.codfil}${s.filial ? ` (${s.filial}${s.uf ? `-${s.uf}` : ''})` : ''}.`
      : `Nota emitida por ${item.fornecedor ?? 'fornecedor não identificado'}${s ? ` e recebida pela empresa ${s.codemp} / filial ${s.codfil}${s.filial ? ` (${s.filial})` : ''}` : ''}.`;
    const cancelamento = `Cancelada na SEFAZ em ${dataBr(item.data_evento)}${item.protocolo ? ` (protocolo ${item.protocolo})` : ''}${item.justificativa ? `, justificativa do emitente: "${item.justificativa}"` : ''}.`;

    if (!s) {
      return {
        problema: `${quem} ${cancelamento} A nota não está lançada no Senior.`,
        acao: 'Nenhuma providência na escrituração. Se a mercadoria/serviço foi recebida, cobrar do fornecedor a nota substituta.',
      };
    }
    const entrada = `Entrada lançada no Senior em ${dataBr(s.entrada)} (NF ${s.numero}${s.serie ? `-${s.serie}` : ''}, ${dinheiro(s.valor)}).`;
    if (!item.pendente_estorno) {
      return { problema: `${quem} ${cancelamento} ${entrada} A entrada já consta cancelada no Senior.`, acao: 'Situação regularizada: nada a fazer, apenas confirmar.' };
    }
    const ordem = item.lancada_apos_cancelamento
      ? `ATENÇÃO: a entrada foi lançada em ${dataBr(s.entrada)}, depois de a nota já estar cancelada (${dataBr(item.data_evento)}).`
      : `A nota foi cancelada ${item.cancelada_apos_entrada ? 'depois' : 'no mesmo dia'} da entrada.`;
    const passos = [
      `Estornar/excluir a entrada no Senior na empresa ${s.codemp} / filial ${s.codfil} (NF ${s.numero}${s.serie ? `-${s.serie}` : ''}).`,
      'Conferir o estoque e os lançamentos contábeis/fiscais gerados por essa entrada.',
      s.saldo_aberto > 0 ? `Cancelar o título a pagar (saldo em aberto ${dinheiro(s.saldo_aberto)}) antes do pagamento.` : 'Não há título a pagar em aberto.',
      emit ? `Conferir com a filial emitente (${emit.codemp}/${emit.codfil}) se houve nota substituta a lançar.` : 'Cobrar do fornecedor a nota substituta, se a operação continuou.',
    ];
    return {
      problema: `${quem} ${cancelamento} ${entrada} A entrada continua ATIVA no Senior (situação ${s.situacao_senior}). ${ordem}`,
      acao: passos.join(' '),
    };
  }

  // Só é pendência quando a nota está lançada e ativa no Senior. Cancelada e não lançada = tudo certo.
  const conferencia = (item) => (item.pendente_estorno ? 'pendente' : item.lancada ? 'ok_estornada' : 'ok_nao_lancada');

  const montar = (e) => {
    const s = e.senior ?? porChave.get(e.chave) ?? null;
    return {
      id: e.id, chave: e.chave, tp_evento: e.tp_evento, descricao: e.descricao,
      origem: e.origem ?? (e.nsu === 'senior-saida' ? 'senior_saida' : 'sefaz'),
      data_evento: e.data_evento, justificativa: e.justificativa, protocolo: e.protocolo,
      cnpj_destinatario: e.cnpj_destinatario,
      fornecedor: s?.fornecedor ?? e.emitente_nome ?? e.emitente_resumo,
      numero: s?.numero ?? e.numero ?? e.numero_resumo ?? e.documento_numero,
      valor: s?.valor ?? e.valor ?? e.valor_resumo,
      lancada: Boolean(s), senior: s,
      documento_id: e.documento_id,
      // Cancelou depois de a nota já estar escriturada: é o caso que exige estorno
      cancelada_apos_entrada: Boolean(s?.entrada && e.data_evento && e.data_evento >= s.entrada),
      // Pior caso: a entrada foi lançada quando a nota já estava cancelada na SEFAZ
      lancada_apos_cancelamento: Boolean(s?.entrada && e.data_evento && s.entrada > e.data_evento),
      // Situação no Senior x SEFAZ: o que importa é "cancelada na SEFAZ e ainda ativa no Senior"
      situacao_senior: s ? (SITUACAO_SENIOR[s.situacao_senior] ?? `Código ${s.situacao_senior}`) : null,
      cancelada_no_senior: s ? CANCELADA_NO_SENIOR.includes(s.situacao_senior) : null,
      pendente_estorno: Boolean(s && !CANCELADA_NO_SENIOR.includes(s.situacao_senior)),
      saldo_aberto: s?.saldo_aberto ?? null,
      titulos: s?.titulos ?? null,
      tratado_em: e.tratado_em, tratado_por: e.tratado_por_nome, observacao: e.observacao,
    };
  };
  // Uma linha por nota: o evento da SEFAZ (com justificativa do fornecedor) tem preferência
  // sobre o registro de saída do Senior, que serve de reforço quando a SEFAZ não trouxe.
  const porNota = new Map();
  for (const item of [...eventos, ...extras].map(montar).map((i) => ({ ...i, ...explicar(i), conferencia: conferencia(i) }))) {
    const atual = porNota.get(item.chave);
    if (!atual) { porNota.set(item.chave, item); continue; }
    const melhor = atual.origem === 'sefaz' ? atual : item;
    const outro = atual.origem === 'sefaz' ? item : atual;
    porNota.set(item.chave, {
      ...melhor,
      justificativa: melhor.justificativa ?? outro.justificativa,
      protocolo: melhor.protocolo ?? outro.protocolo,
      tratado_em: melhor.tratado_em ?? outro.tratado_em,
      tratado_por: melhor.tratado_por ?? outro.tratado_por,
      observacao: melhor.observacao ?? outro.observacao,
      confirmado_no_senior: true, // cancelamento registrado nas duas pontas
    });
  }
  const itens = [...porNota.values()].sort((a, b) => String(b.data_evento).localeCompare(String(a.data_evento)));
  return { senior, periodo, itens: so_lancadas === '1' ? itens.filter((i) => i.lancada) : itens };
}
