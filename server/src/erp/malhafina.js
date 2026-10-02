// Malha fina: confere a planilha de serviços tomados da contabilidade contra as notas de entrada do Senior.
//
// A contabilidade manda o que o fisco já sabe que recebemos (NFS-e tomadas). O que estiver nessa lista
// e não tiver virado nota de entrada é exposição: imposto retido, crédito e obrigação acessória ficam
// sem lastro. A planilha é guardada no banco, então dá para reconferir quantas vezes quiser sem reenviar.
//
// Casamento com o Senior: CNPJ do prestador + número da nota (e, quando dá, o CNPJ da empresa tomadora).
// Só dígitos nos dois lados — a planilha vem com máscara e o Senior, sem.
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { all, get, insert, run, tx } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { comCache, versaoSql } from './cache.js';

export const SITUACOES = {
  lancada: 'Lançada no Senior',
  nao_lancada: 'NÃO lançada',
  valor_divergente: 'Valor não bate',
  cancelada_senior: 'Entrada cancelada no Senior',
  cancelada_prefeitura: 'Cancelada na prefeitura',
  nao_conferida: 'Ainda não conferida',
};

// Colunas da planilha da contabilidade. A busca é pelo texto do cabeçalho (sem acento, minúsculo),
// não pela letra da coluna: o relatório muda de ordem entre versões.
const COLUNAS = {
  cnpj_empresa: ['cnpj empresa'],
  empresa: ['empresa'],
  numero: ['numero nfe', 'numero da nfe', 'numero nota', 'numero'],
  codigo_verificador: ['codigo verificador'],
  chave: ['chave nota nacional', 'chave de acesso', 'chave'],
  competencia: ['data competencia', 'competencia'],
  emissao: ['emissao nfe', 'emissao rps', 'data emissao'],
  cancelamento: ['cancelamento'],
  exclusao: ['exclusao'],
  prestador: ['prestador'],
  cnpj_prestador: ['cnpj/cpf prestador', 'cnpj prestador', 'cpf/cnpj prestador'],
  municipio_prestador: ['municipio prestador'],
  valor: ['valor nfe', 'valor da nfe', 'valor total'],
  valor_liquido: ['valor liquido'],
};

// Retenções informadas pela contabilidade. Somadas, explicam a diferença para o líquido do Senior.
const COLUNAS_RETENCAO = ['iss dentro do municipio', 'iss fora do municipio', 'valor csrf', 'valor pis',
  'valor cofins', 'valor csll', 'valor irrf', 'valor inss'];

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const texto = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? '').trim() || null;
  return String(v).trim() || null;
};
const numero = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const dia = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // A planilha às vezes traz a data como número de série do Excel
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const t = texto(v);
  const br = t?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(t ?? '') ? t.slice(0, 10) : null;
};

// ------------------------------------------------------------------ retenção: por que o Senior é menor
// A planilha da contabilidade traz o valor BRUTO da NFS-e; o Senior guarda o LÍQUIDO, já com o que foi
// retido na fonte. A diferença só é aceitável quando bate com uma alíquota de retenção de verdade —
// e é isso que separa "retivemos imposto" de "lançaram o valor errado".
const ISS = [0, 2, 2.5, 3, 3.5, 4, 5];
const COMBINACOES = (() => {
  const lista = [];
  for (const iss of ISS) {
    for (const irrf of [0, 1.5]) {
      for (const csrf of [0, 4.65]) {
        for (const inss of [0, 11]) {
          const pct = Math.round((iss + irrf + csrf + inss) * 100) / 100;
          const partes = [iss && `ISS ${String(iss).replace('.', ',')}%`, irrf && 'IRRF 1,5%',
            csrf && 'CSRF 4,65%', inss && 'INSS 11%'].filter(Boolean);
          lista.push({ pct, nome: partes.join(' + ') || 'sem retenção' });
        }
      }
    }
  }
  // Mesma alíquota por caminhos diferentes: fica a explicação mais simples
  return [...lista.reduce((m, c) => (m.has(c.pct) && m.get(c.pct).nome.length <= c.nome.length ? m : m.set(c.pct, c)), new Map()).values()]
    .sort((a, b) => a.pct - b.pct);
})();

/**
 * Explica a diferença entre o bruto da planilha e o líquido do Senior.
 * Devolve null quando nenhuma alíquota de retenção justifica — aí é divergência de verdade.
 */
export function explicarDiferenca(bruto, liquido, retencoesInformadas = 0) {
  if (bruto == null || liquido == null || bruto <= 0) return null;
  const dif = Math.round((bruto - liquido) * 100) / 100;
  if (dif < -0.01) return null;                       // Senior maior que a nota: nunca é retenção
  if (Math.abs(dif) <= 0.01) return { pct: 0, nome: 'sem retenção', valor: 0 };
  // Folga para centavos: 5 centavos ou 0,05% do bruto, o que for maior
  const folga = Math.max(0.05, bruto * 0.0005);
  if (retencoesInformadas > 0 && Math.abs(dif - retencoesInformadas) <= folga) {
    return { pct: Math.round((dif / bruto) * 10000) / 100, nome: 'retenção informada na planilha', valor: dif };
  }
  const pct = (dif / bruto) * 100;
  const achada = COMBINACOES.find((c) => c.pct > 0 && Math.abs((bruto * c.pct) / 100 - dif) <= folga);
  return achada ? { pct: Math.round(pct * 100) / 100, nome: achada.nome, valor: dif } : null;
}

/** Localiza cada coluna pelo cabeçalho; devolve { campo: índice da coluna }. */
function mapearColunas(linhaCabecalho) {
  const titulos = [];
  linhaCabecalho.eachCell({ includeEmpty: true }, (cel, n) => { titulos[n] = semAcento(texto(cel.value)); });
  const mapa = {};
  for (const [campo, nomes] of Object.entries(COLUNAS)) {
    const n = titulos.findIndex((t) => t && nomes.includes(t));
    if (n > 0) mapa[campo] = n;
  }
  mapa._retencoes = titulos.map((t, n) => (t && COLUNAS_RETENCAO.includes(t) ? n : 0)).filter(Boolean);
  return mapa;
}

/**
 * Lê a planilha da contabilidade. Devolve as notas e o que não deu para entender,
 * sem gravar nada — a gravação é do importarPlanilha.
 */
export async function lerPlanilha(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('A planilha está vazia');
  const mapa = mapearColunas(ws.getRow(1));
  const faltando = ['numero', 'cnpj_prestador'].filter((c) => !mapa[c]);
  if (faltando.length) {
    throw new Error('Não encontrei as colunas "Número NFe" e "Cnpj/Cpf Prestador" na primeira linha da planilha. '
      + 'Envie o relatório de serviços tomados da contabilidade com o cabeçalho original.');
  }
  const celula = (linha, campo) => (mapa[campo] ? linha.getCell(mapa[campo]).value : null);
  const notas = [];
  for (let n = 2; n <= ws.rowCount; n += 1) {
    const linha = ws.getRow(n);
    const numeroNota = texto(celula(linha, 'numero'));
    const cnpjPrestador = digitos(celula(linha, 'cnpj_prestador'));
    if (!numeroNota || !cnpjPrestador) continue;  // linhas de rodapé/total
    const cancelada = Boolean(texto(celula(linha, 'cancelamento')) || texto(celula(linha, 'exclusao')));
    notas.push({
      cnpj_empresa: digitos(celula(linha, 'cnpj_empresa')) || null,
      empresa: texto(celula(linha, 'empresa')),
      numero: numeroNota,
      codigo_verificador: texto(celula(linha, 'codigo_verificador')),
      chave: digitos(celula(linha, 'chave')) || null,
      competencia: dia(celula(linha, 'competencia')),
      emissao: dia(celula(linha, 'emissao')),
      cancelada_na_prefeitura: cancelada ? 1 : 0,
      cnpj_prestador: cnpjPrestador,
      prestador: texto(celula(linha, 'prestador')),
      municipio_prestador: texto(celula(linha, 'municipio_prestador')),
      valor: numero(celula(linha, 'valor')),
      valor_liquido: numero(celula(linha, 'valor_liquido')),
      retencoes_planilha: Math.round(mapa._retencoes.reduce((t, c) => t + (numero(linha.getCell(c).value) ?? 0), 0) * 100) / 100,
      linha: n,
    });
  }
  if (!notas.length) throw new Error('Não achei nenhuma nota na planilha (nenhuma linha com número e CNPJ do prestador).');
  // Competência predominante, só para nomear o lote
  const meses = notas.map((i) => (i.competencia ?? i.emissao ?? '').slice(0, 7)).filter(Boolean);
  const competencia = [...meses.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map()).entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { notas, competencia, aba: ws.name };
}

/** Importa a planilha (ou atualiza o lote, se o mesmo arquivo já tiver sido enviado). */
export async function importarPlanilha({ buffer, nomeArquivo, usuarioId }) {
  const { notas, competencia } = await lerPlanilha(buffer);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  let jaExistia = false;
  const loteId = tx(() => {
    const existente = get('SELECT id FROM malha_fina_lotes WHERE hash = ?', [hash]);
    jaExistia = Boolean(existente);
    const id = existente?.id ?? insert('malha_fina_lotes', {
      arquivo: nomeArquivo ?? 'planilha.xlsx', hash, competencia, notas: notas.length, usuario_id: usuarioId ?? null,
    });
    if (existente) {
      run('UPDATE malha_fina_lotes SET arquivo = ?, competencia = ?, notas = ? WHERE id = ?', [nomeArquivo ?? 'planilha.xlsx', competencia, notas.length, id]);
      run('DELETE FROM malha_fina_notas WHERE lote_id = ?', [id]);
    }
    for (const nota of notas) {
      insert('malha_fina_notas', {
        ...nota, lote_id: id,
        situacao: nota.cancelada_na_prefeitura ? 'cancelada_prefeitura' : 'nao_conferida',
      });
    }
    return id;
  });
  const r = await conferirLote(loteId, { forcar: true });
  return { lote_id: loteId, reimportado: jaExistia, notas_lidas: notas.length, competencia, ...r };
}

// Notas de entrada do Senior no período do lote, para casar com a planilha.
// DATENT e DATEMI: a nota pode ter entrado num mês e sido emitida no anterior.
const SQL_ENTRADAS = `SELECT n.CODEMP, n.CODFIL, n.NUMNFC, n.CODSNF, n.DATENT, n.DATGER, n.VLRLIQ, n.SITNFC, n.CHVNEL,
    fo.CGCCPF AS CNPJ_PRESTADOR, fo.NOMFOR,
    fi.NUMCGC AS CNPJ_EMPRESA, fi.SIGFIL, fi.NOMFIL,
    u.NOMUSU
  FROM E440NFC n
  OUTER APPLY (SELECT TOP 1 fo.CGCCPF, fo.NOMFOR FROM E095FOR fo WHERE fo.CODFOR = n.CODFOR ORDER BY fo.CODFOR) fo
  OUTER APPLY (SELECT TOP 1 fi.NUMCGC, fi.SIGFIL, fi.NOMFIL FROM E070FIL fi WHERE fi.CODEMP = n.CODEMP AND fi.CODFIL = n.CODFIL) fi
  LEFT JOIN r999usu u ON u.CODUSU = n.USUGER
  WHERE (n.DATENT >= @desde AND n.DATENT <= @ate) OR (n.DATEMI >= @desde AND n.DATEMI <= @ate)`;

const MARGEM_DIAS = 120;  // a nota pode ser lançada bem depois da competência

/**
 * Confere as notas do lote contra o Senior e grava o resultado.
 * O período consultado sai das próprias datas da planilha, com folga para lançamento atrasado.
 */
export async function conferirLote(loteId, { forcar = false } = {}) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  const notas = all('SELECT * FROM malha_fina_notas WHERE lote_id = ?', [loteId]);
  if (!notas.length) throw new Error('Lote sem notas');

  const datas = notas.flatMap((i) => [i.competencia, i.emissao]).filter(Boolean).sort();
  const de = new Date(`${datas[0] ?? '2020-01-01'}T00:00:00Z`);
  de.setUTCDate(de.getUTCDate() - 31);
  const ate = new Date(`${datas.at(-1) ?? '2030-01-01'}T23:59:59Z`);
  ate.setUTCDate(ate.getUTCDate() + MARGEM_DIAS);
  const periodo = { de: de.toISOString().slice(0, 10), ate: ate.toISOString().slice(0, 10) };

  const linhas = await comCache(
    `malha-fina|${versaoSql(SQL_ENTRADAS)}|${periodo.de}|${periodo.ate}`,
    forcar ? 0 : 300_000,
    () => consultar(SQL_ENTRADAS, de, { ate }),
  );

  // Índice: CNPJ do prestador + número da nota. O mesmo par pode ter mais de uma entrada
  // (empresas diferentes do grupo), então guardamos a lista.
  const porChave = new Map();
  for (const l of linhas) {
    const chave = `${digitos(l.CNPJ_PRESTADOR)}|${digitos(l.NUMNFC)}`;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(l);
  }

  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const resumo = {};
  tx(() => {
    for (const nota of notas) {
      const candidatas = porChave.get(`${nota.cnpj_prestador}|${digitos(nota.numero)}`) ?? [];
      // Entre várias, prefere a da mesma empresa tomadora e, depois, a que não está cancelada
      const mesmaEmpresa = nota.cnpj_empresa ? candidatas.filter((l) => digitos(l.CNPJ_EMPRESA) === nota.cnpj_empresa) : [];
      const lista = mesmaEmpresa.length ? mesmaEmpresa : candidatas;
      const ativa = lista.find((l) => String(l.SITNFC).trim() !== '3');
      const achada = ativa ?? lista[0] ?? null;

      let situacao;
      let diferenca = null;
      let retencao = null;
      if (!achada) situacao = nota.cancelada_na_prefeitura ? 'cancelada_prefeitura' : 'nao_lancada';
      else if (String(achada.SITNFC).trim() === '3') situacao = 'cancelada_senior';
      else {
        const esperado = nota.valor ?? nota.valor_liquido;
        const lancado = achada.VLRLIQ != null ? Number(achada.VLRLIQ) : null;
        diferenca = esperado != null && lancado != null ? Math.round((esperado - lancado) * 100) / 100 : null;
        const explicacao = explicarDiferenca(esperado, lancado, nota.retencoes_planilha ?? 0);
        retencao = explicacao?.valor ? `${explicacao.nome} (${String(explicacao.pct).replace('.', ',')}%)` : null;
        situacao = diferenca == null || explicacao ? 'lancada' : 'valor_divergente';
      }
      resumo[situacao] = (resumo[situacao] ?? 0) + 1;
      run(`UPDATE malha_fina_notas SET situacao = ?, entrada_numero = ?, entrada_empresa = ?, entrada_data = ?,
             entrada_lancada_em = ?, entrada_valor = ?, entrada_usuario = ?, diferenca_valor = ?, retencao = ?, conferido_em = ? WHERE id = ?`,
      [situacao,
        achada ? String(achada.NUMNFC) : null,
        achada ? (String(achada.SIGFIL ?? '').trim() || String(achada.NOMFIL ?? '').trim() || `${achada.CODEMP}/${achada.CODFIL}`) : null,
        achada ? iso(achada.DATENT) : null,
        achada ? iso(achada.DATGER) : null,
        achada?.VLRLIQ != null ? Number(achada.VLRLIQ) : null,
        achada ? String(achada.NOMUSU ?? '').trim() || null : null,
        diferenca, retencao, agora, nota.id]);
    }
    run('UPDATE malha_fina_lotes SET conferido_em = ? WHERE id = ?', [agora, loteId]);
  });
  return { conferidas: notas.length, periodo, resumo, entradas_lidas: linhas.length };
}

/** Lotes importados, com o placar de cada um. */
export function listarLotes() {
  return all(`SELECT l.*, u.nome AS usuario,
      SUM(CASE WHEN n.situacao = 'nao_lancada' THEN 1 ELSE 0 END) AS nao_lancadas,
      SUM(CASE WHEN n.situacao = 'lancada' THEN 1 ELSE 0 END) AS lancadas,
      SUM(CASE WHEN n.situacao = 'valor_divergente' THEN 1 ELSE 0 END) AS divergentes,
      SUM(CASE WHEN n.situacao = 'cancelada_senior' THEN 1 ELSE 0 END) AS canceladas_senior,
      SUM(CASE WHEN n.situacao = 'cancelada_prefeitura' THEN 1 ELSE 0 END) AS canceladas_prefeitura,
      SUM(CASE WHEN n.situacao = 'nao_lancada' THEN COALESCE(n.valor, 0) ELSE 0 END) AS valor_nao_lancado
    FROM malha_fina_lotes l
    LEFT JOIN malha_fina_notas n ON n.lote_id = l.id
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    GROUP BY l.id ORDER BY l.id DESC`);
}

/** Um lote com suas notas, já filtradas pela tela. */
export function painelLote(loteId, filtros = {}) {
  const lote = get('SELECT * FROM malha_fina_lotes WHERE id = ?', [loteId]);
  if (!lote) throw new Error('Lote não encontrado');
  let notas = all('SELECT * FROM malha_fina_notas WHERE lote_id = ? ORDER BY competencia, prestador, numero', [loteId]);
  const porSituacao = Object.keys(SITUACOES).map((chave) => ({
    chave, rotulo: SITUACOES[chave],
    qtd: notas.filter((n) => n.situacao === chave).length,
    valor: Math.round(notas.filter((n) => n.situacao === chave).reduce((s, n) => s + (n.valor ?? 0), 0) * 100) / 100,
  })).filter((s) => s.qtd > 0);
  const porPrestador = [...notas.filter((n) => n.situacao === 'nao_lancada').reduce((m, n) => {
    const a = m.get(n.cnpj_prestador) ?? { chave: n.cnpj_prestador, rotulo: n.prestador ?? n.cnpj_prestador, qtd: 0, valor: 0 };
    a.qtd += 1; a.valor += n.valor ?? 0;
    return m.set(n.cnpj_prestador, a);
  }, new Map()).values()].sort((a, b) => b.qtd - a.qtd).slice(0, 10);

  if (filtros.situacao) notas = notas.filter((n) => n.situacao === filtros.situacao);
  if (filtros.busca) {
    const b = String(filtros.busca).toLowerCase();
    const d = digitos(b);
    notas = notas.filter((n) => (n.prestador ?? '').toLowerCase().includes(b)
      || String(n.numero).includes(b) || (d.length >= 4 && String(n.cnpj_prestador).includes(d)));
  }
  const total = notas.length;
  return {
    lote: { ...lote, situacoes: SITUACOES },
    indicadores: {
      notas: lote.notas,
      nao_lancadas: notas.filter((n) => n.situacao === 'nao_lancada').length,
      valor_nao_lancado: Math.round(notas.filter((n) => n.situacao === 'nao_lancada').reduce((s, n) => s + (n.valor ?? 0), 0) * 100) / 100,
    },
    por_situacao: porSituacao, por_prestador: porPrestador,
    total, notas: notas.slice(0, 3000),
  };
}

export function apagarLote(loteId) {
  run('DELETE FROM malha_fina_notas WHERE lote_id = ?', [loteId]);
  run('DELETE FROM malha_fina_lotes WHERE id = ?', [loteId]);
  return { ok: true };
}
