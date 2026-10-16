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
import { all, get, getConfig, insert, run, setConfig, tx } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { comCache, versaoSql } from './cache.js';

export const SITUACOES = {
  lancada: 'Lançada no Senior',
  so_saida: 'Emitida, sem entrada no grupo',
  nao_lancada: 'NÃO lançada',
  conferir: 'Conferir: casamento duvidoso',
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
  emissao: ['emissao nfe', 'emissao rps', 'data emissao', 'emissao'],
  cancelamento: ['cancelamento'],
  exclusao: ['exclusao'],
  prestador: ['prestador'],
  cnpj_prestador: ['cnpj/cpf prestador', 'cnpj prestador', 'cpf/cnpj prestador'],
  municipio_prestador: ['municipio prestador'],
  valor: ['valor nfe', 'valor da nfe', 'valor total'],
  valor_liquido: ['valor liquido'],
  // segundo layout (relatório da EFD): a chave de acesso é a identificação
  status_planilha: ['status'],
  modelo: ['modelo nota', 'modelo'],
  serie: ['serie'],
  cfop: ['cfop'],
  status_cancelamento: ['status cancelamento'],
};

// Retenções informadas pela contabilidade. Somadas, explicam a diferença para o líquido do Senior.
const COLUNAS_RETENCAO = ['iss dentro do municipio', 'iss fora do municipio', 'valor csrf', 'valor pis',
  'valor cofins', 'valor csll', 'valor irrf', 'valor inss'];

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const digitos = (s) => String(s ?? '').replace(/\D/g, '');
// O Senior guarda CGCCPF sem o zero à esquerda (4740876000125), a planilha traz com máscara
// (04.740.876/0001-25). Sem completar com zero, nenhum CNPJ começado em 0 casava.
const documento = (s) => {
  const d = digitos(s);
  return d ? d.padStart(d.length > 11 ? 14 : 11, '0') : '';
};
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
  const celula = (linha, campo) => (mapa[campo] ? linha.getCell(mapa[campo]).value : null);
  // Dois relatórios diferentes chegam da contabilidade:
  //   servicos_tomados = NFS-e tomadas (sem chave de acesso; casa por CNPJ + número)
  //   efd              = o que o fisco tem e não entrou na escrituração (casa pela chave de acesso)
  const tipo = mapa.chave && mapa.status_planilha ? 'efd' : 'servicos_tomados';
  if (tipo === 'servicos_tomados' && !(mapa.numero && mapa.cnpj_prestador)) {
    throw new Error('Não reconheci o layout da planilha. Esperava o relatório de serviços tomados '
      + '(com "Número NFe" e "Cnpj/Cpf Prestador") ou o relatório da EFD (com "Status" e "Chave"), '
      + 'com o cabeçalho original na primeira linha.');
  }
  if (tipo === 'efd') return lerPlanilhaEfd(ws, mapa, celula);
  const notas = [];
  for (let n = 2; n <= ws.rowCount; n += 1) {
    const linha = ws.getRow(n);
    const numeroNota = texto(celula(linha, 'numero'));
    const cnpjPrestador = documento(celula(linha, 'cnpj_prestador'));
    if (!numeroNota || !cnpjPrestador) continue;  // linhas de rodapé/total
    const cancelada = Boolean(texto(celula(linha, 'cancelamento')) || texto(celula(linha, 'exclusao')));
    notas.push({
      cnpj_empresa: documento(celula(linha, 'cnpj_empresa')) || null,
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
  return { notas, competencia, aba: ws.name, tipo: 'servicos_tomados' };
}

/**
 * Relatório da EFD: uma linha por documento que o fisco tem e a escrituração não.
 * A chave de acesso identifica a nota sem ambiguidade, então é ela que casa com o Senior.
 * O arquivo costuma vir com dezenas de milhares de linhas vazias depois dos dados.
 */
function lerPlanilhaEfd(ws, mapa, celula) {
  const notas = [];
  for (let n = 2; n <= ws.rowCount; n += 1) {
    const linha = ws.getRow(n);
    const chave = digitos(celula(linha, 'chave'));
    if (chave.length !== 44) continue;   // linha vazia ou de rodapé
    const cancelado = texto(celula(linha, 'status_cancelamento'));
    notas.push({
      chave,
      // Posições 7 a 20 da chave: CNPJ de quem emitiu. É por ele que se sabe se a nota é nossa.
      cnpj_prestador: chave.slice(6, 20),
      numero: String(Number(chave.slice(25, 34))),
      serie: texto(celula(linha, 'serie')),
      modelo: texto(celula(linha, 'modelo')) ?? chave.slice(20, 22),
      cfop: texto(celula(linha, 'cfop')),
      emissao: dia(celula(linha, 'emissao')),
      competencia: dia(celula(linha, 'emissao')),
      valor: numero(celula(linha, 'valor')),
      status_planilha: texto(celula(linha, 'status_planilha')),
      cancelada_na_prefeitura: cancelado && !/^ok$/i.test(cancelado) ? 1 : 0,
      linha: n,
    });
  }
  if (!notas.length) throw new Error('Não achei nenhuma linha com chave de acesso de 44 dígitos na planilha.');
  const meses = notas.map((i) => (i.emissao ?? '').slice(0, 7)).filter(Boolean);
  const competencia = [...meses.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map()).entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { notas, competencia, aba: ws.name, tipo: 'efd' };
}

/** Importa a planilha (ou atualiza o lote, se o mesmo arquivo já tiver sido enviado). */
export async function importarPlanilha({ buffer, nomeArquivo, usuarioId }) {
  const { notas: lidas, competencia, tipo } = await lerPlanilha(buffer);
  // A planilha da contabilidade às vezes repete a mesma linha. Antes isso derrubava a importação
  // inteira na restrição de unicidade; agora a repetição é ignorada e contada.
  const vistas = new Map();
  for (const n of lidas) {
    const k = tipo === 'efd' ? n.chave : [n.cnpj_prestador, n.numero, n.codigo_verificador ?? ''].join('|');
    if (!vistas.has(k)) vistas.set(k, n);
  }
  const notas = [...vistas.values()];
  const duplicadas = lidas.length - notas.length;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  let jaExistia = false;
  const loteId = tx(() => {
    const existente = get('SELECT id FROM malha_fina_lotes WHERE hash = ?', [hash]);
    jaExistia = Boolean(existente);
    const id = existente?.id ?? insert('malha_fina_lotes', {
      arquivo: nomeArquivo ?? 'planilha.xlsx', hash, competencia, tipo, notas: notas.length, usuario_id: usuarioId ?? null,
    });
    if (existente) {
      run('UPDATE malha_fina_lotes SET arquivo = ?, competencia = ?, notas = ?, tipo = ? WHERE id = ?', [nomeArquivo ?? 'planilha.xlsx', competencia, notas.length, tipo, id]);
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
  return { lote_id: loteId, reimportado: jaExistia, notas_lidas: notas.length, duplicadas, competencia, tipo, ...r };
}

// ------------------------------------------------------------------ conferência do relatório da EFD
// Aqui a chave de acesso casa sem ambiguidade. A nota pode estar no Senior de dois jeitos:
// como documento que o grupo emitiu (E140IDE) e/ou como nota de entrada (E440NFC) — em transferência
// entre filiais, os dois. Achar a nota no ERP e ela não estar na EFD significa que o problema está na
// escrituração, não no lançamento: é uma informação diferente, e a tela diz qual é qual.
const SQL_EFD = `SELECT s.CHVDOE AS CHAVE, s.CODEMP AS SAIDA_EMP, s.CODFIL AS SAIDA_FIL, s.NUMNFV AS SAIDA_NUM, s.SITDOE,
    fs.SIGFIL AS SAIDA_SIGFIL, fs.NOMFIL AS SAIDA_NOMFIL,
    n.CODEMP AS ENT_EMP, n.CODFIL AS ENT_FIL, n.NUMNFC AS ENT_NUM, n.DATENT, n.DATGER, n.VLRLIQ, n.SITNFC,
    fe.SIGFIL AS ENT_SIGFIL, fe.NOMFIL AS ENT_NOMFIL, u.NOMUSU
  FROM E140IDE s
  OUTER APPLY (SELECT TOP 1 fs.SIGFIL, fs.NOMFIL FROM E070FIL fs WHERE fs.CODEMP = s.CODEMP AND fs.CODFIL = s.CODFIL) fs
  OUTER APPLY (SELECT TOP 1 n.CODEMP, n.CODFIL, n.NUMNFC, n.DATENT, n.DATGER, n.VLRLIQ, n.SITNFC, n.USUGER
    FROM E440NFC n WHERE n.CHVNEL = s.CHVDOE ORDER BY n.DATENT DESC) n
  OUTER APPLY (SELECT TOP 1 fe.SIGFIL, fe.NOMFIL FROM E070FIL fe WHERE fe.CODEMP = n.CODEMP AND fe.CODFIL = n.CODFIL) fe
  LEFT JOIN r999usu u ON u.CODUSU = n.USUGER
  WHERE s.CHVDOE IN ({chaves})
  UNION ALL
  SELECT n.CHVNEL, NULL, NULL, NULL, NULL, NULL, NULL,
    n.CODEMP, n.CODFIL, n.NUMNFC, n.DATENT, n.DATGER, n.VLRLIQ, n.SITNFC,
    fe.SIGFIL, fe.NOMFIL, u.NOMUSU
  FROM E440NFC n
  OUTER APPLY (SELECT TOP 1 fe.SIGFIL, fe.NOMFIL FROM E070FIL fe WHERE fe.CODEMP = n.CODEMP AND fe.CODFIL = n.CODFIL) fe
  LEFT JOIN r999usu u ON u.CODUSU = n.USUGER
  WHERE n.CHVNEL IN ({chaves}) AND NOT EXISTS (SELECT 1 FROM E140IDE s2 WHERE s2.CHVDOE = n.CHVNEL)`;

const LOTE_CHAVES = 400;   // a consulta vai por blocos: IN com milhares de itens trava o SQL Server

async function conferirEfd(loteId, notas, forcar) {
  const chaves = [...new Set(notas.map((n) => n.chave).filter((c) => c && c.length === 44))];
  const linhas = [];
  for (let i = 0; i < chaves.length; i += LOTE_CHAVES) {
    const bloco = chaves.slice(i, i + LOTE_CHAVES);
    const lista = bloco.map((c) => `'${c}'`).join(',');
    const sql = SQL_EFD.replaceAll('{chaves}', lista);
    // eslint-disable-next-line no-await-in-loop
    linhas.push(...await comCache(`malha-efd|${versaoSql(sql)}`, forcar ? 0 : 300_000, () => consultar(sql, null)));
  }
  const porChave = new Map();
  for (const l of linhas) {
    const c = String(l.CHAVE ?? '').trim();
    if (!porChave.has(c)) porChave.set(c, l);
    else if (l.SAIDA_NUM != null) porChave.set(c, l);   // a linha com a saída manda
  }

  // Nome de quem emitiu. O CNPJ sai da própria chave de acesso; o nome vem do cadastro de
  // fornecedores ou, quando é empresa do grupo, do cadastro de filiais.
  const emitentes = [...new Set(notas.map((n) => n.cnpj_prestador).filter(Boolean))];
  const nomes = new Map();
  for (let i = 0; i < emitentes.length; i += LOTE_CHAVES) {
    const bloco = emitentes.slice(i, i + LOTE_CHAVES);
    // com e sem o zero à esquerda: o Senior guarda os dois jeitos conforme a tabela
    const lista = [...new Set(bloco.flatMap((c) => [c, String(Number(c))]))].map((c) => `'${c}'`).join(',');
    const sql = `SELECT CGCCPF AS CNPJ, MAX(NOMFOR) AS NOME, 0 AS DO_GRUPO FROM E095FOR WHERE CGCCPF IN (${lista}) GROUP BY CGCCPF
      UNION ALL
      SELECT NUMCGC, MAX(COALESCE(SIGFIL, NOMFIL)), 1 FROM E070FIL WHERE NUMCGC IN (${lista}) GROUP BY NUMCGC`;
    // eslint-disable-next-line no-await-in-loop
    for (const l of await comCache(`malha-efd-nomes|${versaoSql(sql)}`, forcar ? 0 : 300_000, () => consultar(sql, null))) {
      const doc = documento(l.CNPJ);
      // a filial do grupo tem prioridade sobre o cadastro de fornecedor com o mesmo CNPJ
      if (!nomes.has(doc) || l.DO_GRUPO === 1) nomes.set(doc, { nome: String(l.NOME ?? '').trim() || null, do_grupo: l.DO_GRUPO === 1 });
    }
  }

  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const nomeFilial = (sig, nome, emp, fil) => String(sig ?? '').trim() || String(nome ?? '').trim() || (emp != null ? `${emp}/${fil}` : null);
  const resumo = {};
  tx(() => {
    for (const nota of notas) {
      const a = porChave.get(nota.chave);
      const temEntrada = a?.ENT_NUM != null;
      const temSaida = a?.SAIDA_NUM != null;
      const canceladaSaida = a && Number(a.SITDOE) === 9;
      const canceladaEntrada = temEntrada && String(a.SITNFC).trim() === '3';

      let situacao;
      if (!a) situacao = nota.cancelada_na_prefeitura ? 'cancelada_prefeitura' : 'nao_lancada';
      else if (canceladaSaida || (temEntrada && canceladaEntrada && !temSaida)) situacao = 'cancelada_senior';
      else if (temEntrada) situacao = 'lancada';
      else situacao = 'so_saida';   // emitimos e está no ERP, mas não há nota de entrada correspondente
      resumo[situacao] = (resumo[situacao] ?? 0) + 1;

      const emitente = nomes.get(nota.cnpj_prestador);
      run(`UPDATE malha_fina_notas SET situacao = ?, prestador = ?, entrada_numero = ?, entrada_empresa = ?, entrada_empresa_chave = ?,
             entrada_data = ?, entrada_lancada_em = ?, entrada_valor = ?, entrada_usuario = ?,
             saida_numero = ?, saida_empresa = ?, saida_empresa_chave = ?, diferenca_valor = ?, retencao = ?, conferido_em = ?
           WHERE id = ?`,
      [situacao,
        emitente?.nome ?? nota.prestador ?? null,
        temEntrada ? String(a.ENT_NUM) : null,
        temEntrada ? nomeFilial(a.ENT_SIGFIL, a.ENT_NOMFIL, a.ENT_EMP, a.ENT_FIL) : null,
        temEntrada ? `${a.ENT_EMP}/${a.ENT_FIL}` : null,
        temEntrada ? iso(a.DATENT) : null,
        temEntrada ? iso(a.DATGER) : null,
        temEntrada && a.VLRLIQ != null ? Number(a.VLRLIQ) : null,
        temEntrada ? String(a.NOMUSU ?? '').trim() || null : null,
        temSaida ? String(a.SAIDA_NUM) : null,
        temSaida ? nomeFilial(a.SAIDA_SIGFIL, a.SAIDA_NOMFIL, a.SAIDA_EMP, a.SAIDA_FIL) : null,
        temSaida ? `${a.SAIDA_EMP}/${a.SAIDA_FIL}` : null,
        null, null, agora, nota.id]);
    }
    run('UPDATE malha_fina_lotes SET conferido_em = ? WHERE id = ?', [agora, loteId]);
  });
  return { conferidas: notas.length, resumo, chaves_consultadas: chaves.length, encontradas: porChave.size };
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

// Espécies que claramente NÃO são nota de serviço. Casar uma NFS-e da planilha com uma dessas
// quer dizer que o número bateu por coincidência, não que a nota foi lançada.
const ESPECIE_DE_OUTRO_TIPO = /^(NFE|NF|CTE|CT|MDF|NFC|CUP|CF)$/i;
// Entrada muito anterior à competência é número reaproveitado pelo prestador, não a nota da planilha
const DIAS_ANTES_ACEITOS = 31;

/**
 * Por que este casamento pode não ser esta nota. Devolve null quando não há dúvida.
 *
 * O casamento é por CNPJ do prestador + número, que não é único: o mesmo prestador pode ter
 * emitido notas de tipos diferentes com o mesmo número, para empresas diferentes do grupo ou em
 * anos diferentes. Sem essa conferência, a tela diria "lançada" para nota que ninguém lançou.
 */
function duvidasDoCasamento(nota, achada, candidatas, mesmaEmpresa) {
  const duvidas = [];
  if (nota.cnpj_empresa && !mesmaEmpresa.length) {
    duvidas.push(`a entrada está em ${String(achada.SIGFIL ?? '').trim() || 'outra empresa'}, e a planilha diz que o tomador é outro`);
  }
  const especie = String(achada.CODSNF ?? '').trim();
  if (ESPECIE_DE_OUTRO_TIPO.test(especie)) duvidas.push(`a entrada foi lançada como ${especie}, que não é nota de serviço`);
  const base = nota.competencia ?? nota.emissao;
  const entrada = achada.DATENT ? new Date(achada.DATENT).toISOString().slice(0, 10) : null;
  if (base && entrada) {
    const dias = Math.round((new Date(entrada) - new Date(base)) / 86400000);
    if (dias < -DIAS_ANTES_ACEITOS) duvidas.push(`a entrada é de ${entrada}, bem antes da competência ${base}`);
  }
  // Mais de uma entrada possível e elas não concordam: não dá para dizer qual é
  const possiveis = (mesmaEmpresa.length ? mesmaEmpresa : candidatas).filter((l) => String(l.SITNFC).trim() !== '3');
  if (possiveis.length > 1) {
    const valores = new Set(possiveis.map((l) => Number(l.VLRLIQ ?? 0).toFixed(2)));
    if (valores.size > 1) duvidas.push(`há ${possiveis.length} entradas com esse número e valores diferentes`);
  }
  return duvidas.length ? duvidas.join('; ') : null;
}

/**
 * Confere as notas do lote contra o Senior e grava o resultado.
 * O período consultado sai das próprias datas da planilha, com folga para lançamento atrasado.
 */
export async function conferirLote(loteId, { forcar = false } = {}) {
  if (!seniorConfigurado()) throw new Error('Senior não configurado');
  const notas = all('SELECT * FROM malha_fina_notas WHERE lote_id = ?', [loteId]);
  if (!notas.length) throw new Error('Lote sem notas');
  const lote = get('SELECT tipo FROM malha_fina_lotes WHERE id = ?', [loteId]);
  if (lote?.tipo === 'efd') return conferirEfd(loteId, notas, forcar);

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
    const chave = `${documento(l.CNPJ_PRESTADOR)}|${digitos(l.NUMNFC)}`;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(l);
  }

  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const resumo = {};
  tx(() => {
    for (const nota of notas) {
      const candidatas = porChave.get(`${documento(nota.cnpj_prestador)}|${digitos(nota.numero)}`) ?? [];
      // Entre várias, prefere a da mesma empresa tomadora e, depois, a que não está cancelada
      const mesmaEmpresa = nota.cnpj_empresa ? candidatas.filter((l) => documento(l.CNPJ_EMPRESA) === documento(nota.cnpj_empresa)) : [];
      const lista = mesmaEmpresa.length ? mesmaEmpresa : candidatas;
      const ativa = lista.find((l) => String(l.SITNFC).trim() !== '3');
      const achada = ativa ?? lista[0] ?? null;

      let situacao;
      let diferenca = null;
      let retencao = null;
      let alerta = null;
      if (!achada) situacao = nota.cancelada_na_prefeitura ? 'cancelada_prefeitura' : 'nao_lancada';
      else if (String(achada.SITNFC).trim() === '3') situacao = 'cancelada_senior';
      else {
        // Antes de dizer "lançada", confere se a entrada encontrada é mesmo ESTA nota.
        // Verde só sai quando os quatro critérios batem; na dúvida vai para "conferir",
        // porque dar "ok" para quem não está lançado é o erro caro aqui.
        alerta = duvidasDoCasamento(nota, achada, candidatas, mesmaEmpresa);
        const esperado = nota.valor ?? nota.valor_liquido;
        const lancado = achada.VLRLIQ != null ? Number(achada.VLRLIQ) : null;
        diferenca = esperado != null && lancado != null ? Math.round((esperado - lancado) * 100) / 100 : null;
        const explicacao = explicarDiferenca(esperado, lancado, nota.retencoes_planilha ?? 0);
        retencao = explicacao?.valor ? `${explicacao.nome} (${String(explicacao.pct).replace('.', ',')}%)` : null;
        situacao = alerta ? 'conferir' : (diferenca == null || explicacao ? 'lancada' : 'valor_divergente');
      }
      resumo[situacao] = (resumo[situacao] ?? 0) + 1;
      run(`UPDATE malha_fina_notas SET situacao = ?, entrada_numero = ?, entrada_empresa = ?, entrada_data = ?,
             entrada_lancada_em = ?, entrada_valor = ?, entrada_usuario = ?, diferenca_valor = ?, retencao = ?,
             entrada_empresa_chave = ?, alerta = ?, conferido_em = ? WHERE id = ?`,
      [situacao,
        achada ? String(achada.NUMNFC) : null,
        achada ? (String(achada.SIGFIL ?? '').trim() || String(achada.NOMFIL ?? '').trim() || `${achada.CODEMP}/${achada.CODFIL}`) : null,
        achada ? iso(achada.DATENT) : null,
        achada ? iso(achada.DATGER) : null,
        achada?.VLRLIQ != null ? Number(achada.VLRLIQ) : null,
        achada ? String(achada.NOMUSU ?? '').trim() || null : null,
        diferenca, retencao, achada ? `${achada.CODEMP}/${achada.CODFIL}` : null, alerta, agora, nota.id]);
    }
    run('UPDATE malha_fina_lotes SET conferido_em = ? WHERE id = ?', [agora, loteId]);
  });
  return { conferidas: notas.length, periodo, resumo, entradas_lidas: linhas.length };
}

// ------------------------------------------------------------------ prestadores PJ
// "PJ" aqui é o prestador de serviço continuado da própria empresa (consultoria, assessoria,
// serviço de escritório). A nota dele existe e é legítima, mas não é compra a lançar pela escrita
// fiscal — então sai da malha fina por padrão, sem deixar de ficar guardada.
const PJ_INICIAIS = [
  ['60007793000100', '60.007.793 DIHENES DE OLIVEIRA LOPES'], ['60471079000160', '60.471.079 ANDRE PEREIRA DA SILVA'],
  ['61014018000137', '61.014.018 DIEGO BARROS DOS SANTOS'], ['65496279000191', '65.496.279 PAULO HENRIQUE DE LIMA JUNIOR'],
  ['54034511000153', 'APEXFINANCAS LTDA'], ['65385362000193', 'AZ SOLUTIONS LTDA'],
  ['51237084000112', 'BRUNO PAIVA PEREIRA LTDA'], ['68952735000159', 'CESAR AUGUSTO PEREIRA BONIFACIO'],
  ['59518434000120', 'D. DE FREITAS RIBEIRO NETO'], ['59202453000143', 'EDSON JS JUNIOR'],
  ['56299391000141', 'J A FAGUNDES'], ['43400889000107', 'J. J. ALVES LTDA.'],
  ['47732569000105', 'JOSUE ALVES DA SILVA 00912309180'], ['58011970000172', 'LUIS FERNANDO FARDIN DE MARQUE MANUTENCOES'],
  ['61851576000157', 'MEH SERVICOS ADMINISTRATIVOS LTDA'], ['68540725000106', 'METRICA CONSULTORIA LTDA'],
  ['61317085000120', 'MUNIZ ASSESSORIA E CONSULTORIA LTDA'], ['30411890000195', 'PATRICIA SILVEIRA GONZAGA 58751386100'],
  ['52605988000116', 'PECUS CONTABILIDADE E ASSESSORIA EMPRESARIAL LTDA'], ['58971196000141', 'PROJETOS COM PROPOSITO CONSULTORIA LTDA'],
  ['53609815000139', 'R. M. ROMBI'], ['68130320000108', 'ROGER LUIZ DA SILVA ALMEIDA FILHO'],
  ['49439311000140', 'STAR SERVICOS DE ESCRITORIO LTDA'], ['20867409000117', 'V. I. A. PRESTACAO DE SERVICOS, TRANSPORTE E LOCACAO LTDA'],
];

/** Lista os PJ. Na primeira vez, semeia a lista que já era usada no Power Query. */
export function listarPj() {
  if (!getConfig('malha_fina_pj_iniciais')) {
    tx(() => {
      for (const [cnpj, nome] of PJ_INICIAIS) {
        run('INSERT OR IGNORE INTO prestadores_pj (cnpj, nome, observacao) VALUES (?, ?, ?)', [cnpj, nome, 'lista inicial']);
      }
      setConfig('malha_fina_pj_iniciais', '1');
    });
  }
  return all('SELECT p.*, u.nome AS usuario FROM prestadores_pj p LEFT JOIN usuarios u ON u.id = p.usuario_id ORDER BY p.nome');
}

export function salvarPj({ cnpj, nome, observacao }, usuarioId) {
  const doc = documento(cnpj);
  if (!doc) throw new Error('Informe o CNPJ/CPF do prestador');
  run(`INSERT INTO prestadores_pj (cnpj, nome, observacao, usuario_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(cnpj) DO UPDATE SET nome = excluded.nome, observacao = excluded.observacao, usuario_id = excluded.usuario_id`,
  [doc, nome ?? null, observacao ?? null, usuarioId ?? null]);
  return { cnpj: doc, nome };
}

export function removerPj(cnpj) {
  run('DELETE FROM prestadores_pj WHERE cnpj = ?', [documento(cnpj)]);
  return { ok: true };
}

/**
 * NFS-e da contabilidade que ainda não foram lançadas.
 *
 * NFS-e municipal não chega ao recebimento de XML do Senior (conferido: das 577 notas da planilha,
 * só 20 aparecem lá). Sem isso, nota de serviço não lançada não aparece em nenhum acompanhamento —
 * é o painel de pendências que precisa somá-las.
 *
 * Quando a mesma nota aparece em mais de uma planilha, vale a mais recente: se ela foi lançada
 * depois, deixa de ser pendência.
 */
export function nfseNaoLancadas({ de, ate } = {}) {
  const pj = new Set(listarPj().map((p) => p.cnpj));
  const porNota = new Map();
  for (const n of all(`SELECT n.*, l.id AS lote, l.arquivo, l.competencia AS lote_competencia
      FROM malha_fina_notas n JOIN malha_fina_lotes l ON l.id = n.lote_id
      WHERE l.tipo = 'servicos_tomados' ORDER BY l.id`)) {
    porNota.set(`${n.cnpj_prestador}|${n.numero}`, n);   // a última planilha sobrescreve
  }
  const notas = [...porNota.values()]
    .filter((n) => n.situacao === 'nao_lancada' && !pj.has(n.cnpj_prestador))
    .filter((n) => {
      const d = n.competencia ?? n.emissao;
      return !d || ((!de || d >= de) && (!ate || d <= ate));
    });
  return { notas, lotes: [...new Set(notas.map((n) => n.arquivo))] };
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
  // PJ saem da conta por padrão (filtros.com_pj = '1' traz de volta). O total continua guardado.
  const pj = new Set(listarPj().map((p) => p.cnpj));
  const notasPj = notas.filter((n) => pj.has(n.cnpj_prestador));
  const comPj = filtros.com_pj === '1';
  if (!comPj) notas = notas.filter((n) => !pj.has(n.cnpj_prestador));
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

  // Empresa do grupo que lançou (ou deveria ter lançado) a nota
  const porEmpresa = [...notas.reduce((m, n) => {
    const chave = n.entrada_empresa_chave ?? '—';
    const a = m.get(chave) ?? { chave, rotulo: n.entrada_empresa ?? 'Sem entrada no Senior', qtd: 0, nao_lancadas: 0, valor: 0 };
    a.qtd += 1;
    if (n.situacao === 'nao_lancada') { a.nao_lancadas += 1; a.valor += n.valor ?? 0; }
    return m.set(chave, a);
  }, new Map()).values()].sort((a, b) => b.nao_lancadas - a.nao_lancadas || b.qtd - a.qtd);

  if (filtros.empresa) notas = notas.filter((n) => (n.entrada_empresa_chave ?? '—') === filtros.empresa);
  if (filtros.situacao) notas = notas.filter((n) => n.situacao === filtros.situacao);
  if (filtros.busca) {
    const b = String(filtros.busca).toLowerCase();
    const d = digitos(b);
    notas = notas.filter((n) => (n.prestador ?? '').toLowerCase().includes(b)
      || String(n.numero).includes(b) || (d.length >= 4 && String(n.cnpj_prestador).includes(d))
      || (d.length >= 6 && String(n.chave ?? '').includes(d)));
  }
  const total = notas.length;
  return {
    lote: { ...lote, situacoes: SITUACOES },
    pj: {
      cadastrados: pj.size, ocultos: comPj ? 0 : notasPj.length, com_pj: comPj,
      nao_lancadas: notasPj.filter((n) => n.situacao === 'nao_lancada').length,
      valor: Math.round(notasPj.filter((n) => n.situacao === 'nao_lancada').reduce((t, n) => t + (n.valor ?? 0), 0) * 100) / 100,
    },
    indicadores: {
      notas: lote.notas,
      nao_lancadas: notas.filter((n) => n.situacao === 'nao_lancada').length,
      valor_nao_lancado: Math.round(notas.filter((n) => n.situacao === 'nao_lancada').reduce((s, n) => s + (n.valor ?? 0), 0) * 100) / 100,
    },
    por_situacao: porSituacao, por_prestador: porPrestador, por_empresa: porEmpresa,
    total, notas: notas.slice(0, 3000),
  };
}

export function apagarLote(loteId) {
  run('DELETE FROM malha_fina_notas WHERE lote_id = ?', [loteId]);
  run('DELETE FROM malha_fina_lotes WHERE id = ?', [loteId]);
  return { ok: true };
}
