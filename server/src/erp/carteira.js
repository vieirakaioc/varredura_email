import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { all, get, insert, run, tx } from '../db/index.js';
import { consultar, seniorConfigurado } from './senior.js';
import { log } from '../util/log.js';
import { MOTIVOS } from './pendentes.js';

export const hojeCarteira = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const agora = () => new Date().toISOString();
const novaVersao = (antes) => new Date(Math.max(Date.now(), Date.parse(antes) + 1)).toISOString();
const texto = (v) => String(v == null ? '' : typeof v === 'object' && !(v instanceof Date)
  ? v.result ?? v.text ?? v.richText?.map((r) => r.text).join('') ?? '' : v).trim();
const normal = (v) => texto(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const digitos = (v) => texto(v).replace(/\D/g, '');
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const colunas = {
  chave: ['chave de acesso'], numero: ['numero'], serie: ['serie'], documento: ['documento'],
  fornecedor: ['fornecedor'], cnpj_fornecedor: ['cnpj fornecedor'], empfil: ['emp/fil'],
  tomador_nome: ['tomador', 'nome do tomador'], tomador_cnpj: ['cnpj tomador', 'cnpj do tomador', 'cnpj destinatario'],
  empresa: ['empresa destinataria'], valor: ['valor'], emissao: ['emissao'], recebida_em: ['recebida em'],
  tipo_nota: ['tipo de nota'], prioridade: ['prioridade'], data_prevista: ['data prevista'],
  responsavel: ['responsavel da programacao'], observacao: ['observacao da programacao'],
};

export function dataPlanilha(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text;
  if (v instanceof Date) v = Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') v = new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = texto(v);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(Date.parse(`${iso}T12:00:00Z`))
    || new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) !== iso) throw erro(`Data inválida: ${s}`);
  return iso;
}

function prioridade(v) {
  if (!texto(v)) return null;
  const p = { '1': 1, urgente: 1, '2': 2, alta: 2, '3': 3, normal: 3 }[normal(v)];
  if (!p) throw erro('Prioridade deve ser Urgente (1), Alta (2) ou Normal (3)');
  return p;
}

function empfil(v) {
  const m = texto(v).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m || +m[1] < 1 || +m[2] < 1) throw erro('Emp/Fil deve conter empresa/filial, por exemplo 1/2');
  return `${Number(m[1])}/${Number(m[2])}`;
}

export function identidadeNota(n) {
  if (/^\d{44}$/.test(n.chave)) return `chave:${n.chave}`;
  if (!n.cnpj_fornecedor || !n.numero || !n.documento) throw erro('Sem chave de acesso, informe CNPJ fornecedor, Número e Documento');
  // A filial também identifica NFS-e: o mesmo prestador pode emitir para vários tomadores.
  return `nota:${JSON.stringify([n.empfil, n.cnpj_fornecedor, normal(n.documento), n.numero.replace(/^0+(?=\d)/, ''), n.serie || ''])}`;
}

export function configuracaoCarteira() {
  return {
    pessoas: all("SELECT id, nome, email FROM usuarios WHERE ativo = 1 AND perfil IN ('admin','fiscal','membro') ORDER BY nome"),
    filiais: all('SELECT f.*, u.nome, u.email FROM carteira_filiais f JOIN usuarios u ON u.id = f.usuario_id ORDER BY empfil'),
    // Lista fechada de por que a nota ainda não foi lançada; a mesma usada nas pendências
    motivos: MOTIVOS,
  };
}

export function salvarFilialCarteira(dados) {
  const filial = empfil(dados.empfil);
  if (dados.usuario_id == null || dados.usuario_id === '') {
    run('DELETE FROM carteira_filiais WHERE empfil = ?', [filial]);
  } else {
    const id = Number(dados.usuario_id);
    if (!configuracaoCarteira().pessoas.some((p) => p.id === id)) throw erro('Escolha um responsável ativo');
    run(`INSERT INTO carteira_filiais (empfil, usuario_id, atualizado_em) VALUES (?,?,?)
      ON CONFLICT(empfil) DO UPDATE SET usuario_id = excluded.usuario_id, atualizado_em = excluded.atualizado_em`, [filial, id, agora()]);
  }
  return configuracaoCarteira();
}

function versaoCarteira() {
  return hash([all('SELECT * FROM carteira_notas ORDER BY id').map(({ verificada_em, ...n }) => n), configuracaoCarteira()]);
}

function historico(notaId, usuarioId, acao, antes, depois) {
  insert('carteira_historico', { nota_id: notaId, usuario_id: usuarioId, acao,
    antes: antes ? JSON.stringify(antes) : null, depois: JSON.stringify(depois), criado_em: agora() });
}

export async function lerPlanilhaCarteira(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
      const indices = {};
      ws.getRow(r).eachCell((cell, c) => {
        const nome = normal(cell.value);
        for (const [campo, nomes] of Object.entries(colunas)) {
          if (nomes.includes(nome)) {
            if (indices[campo]) throw erro(`Cabeçalho repetido: ${texto(cell.value)}`);
            indices[campo] = c;
          }
        }
      });
      if (!indices.numero || !indices.empfil || !indices.documento) continue;
      if (ws.rowCount - r > 20000) throw erro('Limite de 20.000 notas por importação');
      const linhas = [];
      for (let n = r + 1; n <= ws.rowCount; n++) {
        const valores = Object.fromEntries(Object.entries(indices).map(([k, c]) => [k, ws.getRow(n).getCell(c).value]));
        if (Object.values(valores).every((v) => !texto(v))) continue;
        linhas.push({ linha: n, valores });
      }
      if (!linhas.length) throw erro('A planilha não contém notas');
      return linhas;
    }
  }
  throw erro('Use o Excel exportado de Pendentes: faltam os cabeçalhos Número, Documento ou Emp/Fil');
}

export async function prepararImportacaoCarteira({ buffer, arquivo, dia, usuarioId }) {
  const prevista = dataPlanilha(dia) || hojeCarteira();
  const linhas = await lerPlanilhaCarteira(buffer);
  const cfg = configuracaoCarteira();
  const atuais = new Map(all('SELECT * FROM carteira_notas WHERE excluida_em IS NULL').map((n) => [n.identidade, n]));
  const vistos = new Set();
  const itens = [], erros = [];
  const resumo = { novas: 0, atualizadas: 0, sem_alteracao: 0, concluidas: 0, sem_responsavel: 0, erros: 0 };
  for (const { linha, valores: v } of linhas) {
    try {
      if (typeof (v.chave?.result ?? v.chave) === 'number') throw erro('Chave de acesso deve estar como texto no Excel (44 dígitos)');
      const chave = texto(v.chave);
      if (chave && !/^\d{44}$/.test(chave) && !/^NFSE-/i.test(chave)) throw erro('Chave de acesso inválida; confira se o Excel alterou os dígitos');
      const n = { chave: /^\d{44}$/.test(chave) ? chave : null,
        numero: texto(v.numero), serie: texto(v.serie), documento: texto(v.documento), fornecedor: texto(v.fornecedor),
        cnpj_fornecedor: digitos(v.cnpj_fornecedor), empfil: empfil(v.empfil), empresa: texto(v.empresa),
        valor: !texto(v.valor) ? null : typeof v.valor === 'number' ? v.valor : Number(texto(v.valor).replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.')),
        emissao: dataPlanilha(v.emissao), recebida_em: dataPlanilha(v.recebida_em), tipo_nota: texto(v.tipo_nota) };
      if (!n.numero || !n.documento) throw erro('Informe Número e Documento');
      if (!/^\d+$/.test(n.numero)) throw erro('Número da nota deve conter apenas dígitos');
      if (n.cnpj_fornecedor && ![11,14].includes(n.cnpj_fornecedor.length)) throw erro('CNPJ/CPF fornecedor inválido');
      if (n.valor != null && (!Number.isFinite(n.valor) || n.valor < 0)) throw erro('Valor inválido');
      n.identidade = identidadeNota(n);
      if (vistos.has(n.identidade)) throw erro('Nota repetida na mesma planilha');
      vistos.add(n.identidade);
      const atual = atuais.get(n.identidade);
      n.tomador_nome = texto(v.tomador_nome) || atual?.tomador_nome || n.empresa;
      n.tomador_cnpj = digitos(v.tomador_cnpj) || atual?.tomador_cnpj || null;
      if (n.tomador_cnpj && ![11,14].includes(n.tomador_cnpj.length)) throw erro('CNPJ/CPF do tomador inválido');
      if (atual && (atual.empfil !== n.empfil || atual.numero !== n.numero)) throw erro('A chave já existe com outro número ou filial; confira a identificação');
      let responsavel = null;
      if (texto(v.responsavel)) {
        const candidatos = cfg.pessoas.filter((p) => [String(p.id), normal(p.nome), normal(p.email)].includes(normal(v.responsavel)));
        if (candidatos.length !== 1) throw erro('Responsável da programação não encontrado ou ambíguo; use o e-mail do usuário');
        responsavel = candidatos[0].id;
      }
      n.prioridade = prioridade(v.prioridade) ?? atual?.prioridade ?? 3;
      n.data_prevista = dataPlanilha(v.data_prevista) || atual?.data_prevista || prevista;
      n.responsavel_id = responsavel ?? atual?.responsavel_id ?? cfg.filiais.find((f) => f.empfil === n.empfil && cfg.pessoas.some((p) => p.id === f.usuario_id))?.usuario_id ?? null;
      n.observacao = texto(v.observacao) || atual?.observacao || '';
      let acao = !atual ? 'nova' : atual.status === 'lancada' ? 'concluida'
        : Object.entries(n).some(([k, value]) => (atual[k] ?? null) !== (value ?? null)) ? 'atualizada' : 'sem_alteracao';
      resumo[{ nova: 'novas', atualizada: 'atualizadas', concluida: 'concluidas', sem_alteracao: 'sem_alteracao' }[acao]]++;
      if (!n.responsavel_id && acao !== 'concluida') resumo.sem_responsavel++;
      itens.push({ linha, acao, nota: n, id: atual?.id ?? null });
    } catch (e) { erros.push({ linha, erro: e.message }); }
  }
  resumo.erros = erros.length;
  const id = insert('carteira_importacoes', { usuario_id: usuarioId, arquivo: texto(arquivo).slice(0, 250),
    dados: JSON.stringify(itens), versao: versaoCarteira(), resumo: JSON.stringify(resumo), criada_em: agora() });
  return { id, resumo, erros, amostra: itens.slice(0, 100).map((i) => ({ ...i, responsavel: cfg.pessoas.find((p) => p.id === i.nota.responsavel_id)?.nome ?? null })), total: linhas.length };
}

export function confirmarImportacaoCarteira(id, usuarioId) {
  return tx(() => {
    const lote = get('SELECT * FROM carteira_importacoes WHERE id = ? AND usuario_id = ?', [Number(id), usuarioId]);
    if (!lote) throw erro('Prévia não encontrada', 404);
    if (lote.excluida_em) throw erro('Esta importação foi excluída. Envie a planilha novamente', 409);
    if (lote.confirmada_em) return { id: lote.id, resumo: JSON.parse(lote.resumo), ja_confirmada: true };
    if (Date.now() - Date.parse(lote.criada_em) > 2 * 3600000) throw erro('A prévia expirou. Envie o arquivo novamente', 409);
    if (JSON.parse(lote.resumo).erros) throw erro('Corrija as linhas com erro e envie novamente');
    if (lote.versao !== versaoCarteira()) throw erro('A carteira ou os responsáveis mudaram. Envie novamente para conferir uma prévia atualizada', 409);
    for (const item of JSON.parse(lote.dados)) {
      if (['concluida','sem_alteracao'].includes(item.acao)) continue;
      const anterior = item.id ? get('SELECT * FROM carteira_notas WHERE id = ?', [item.id]) : null;
      const n = item.nota;
      let notaId = item.id;
      if (!notaId) {
        const arquivada = get('SELECT * FROM carteira_notas WHERE identidade = ? AND excluida_em IS NOT NULL', [n.identidade]);
        const nova = { ...n, data_original: n.data_prevista, criada_em: agora(), atualizado_em: agora(),
          excluida_em: null, status: 'pendente', motivo_bloqueio: '', lancada_em: null, senior_ref: null, verificada_em: null };
        if (arquivada) {
          notaId = arquivada.id;
          const cols = Object.keys(nova);
          run(`UPDATE carteira_notas SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, [...cols.map((c) => nova[c]), notaId]);
        } else notaId = insert('carteira_notas', nova);
      }
      else {
        const cols = Object.keys(n);
        run(`UPDATE carteira_notas SET ${cols.map((c) => `${c} = ?`).join(',')}, atualizado_em = ? WHERE id = ?`, [...cols.map((c) => n[c]), novaVersao(anterior.atualizado_em), notaId]);
      }
      historico(notaId, usuarioId, anterior ? 'importar_atualizacao' : 'importar_nova', anterior, get('SELECT * FROM carteira_notas WHERE id = ?', [notaId]));
    }
    run('UPDATE carteira_importacoes SET confirmada_em = ? WHERE id = ?', [agora(), lote.id]);
    return { id: lote.id, resumo: JSON.parse(lote.resumo) };
  });
}

export function alterarNotaCarteira(id, dados, usuarioId) {
  return tx(() => {
    const antes = get('SELECT * FROM carteira_notas WHERE id = ?', [Number(id)]);
    if (!antes || antes.excluida_em) throw erro('Nota não encontrada na carteira', 404);
    if (antes.status === 'lancada') throw erro('Nota já confirmada no Senior; consulte o histórico');
    if (dados.versao !== antes.atualizado_em) throw erro('Esta nota foi alterada. Atualize a tela antes de salvar', 409);
    const depois = { ...antes };
    if (dados.data_prevista !== undefined) depois.data_prevista = dataPlanilha(dados.data_prevista) || antes.data_prevista;
    if (dados.prioridade !== undefined) depois.prioridade = prioridade(dados.prioridade) ?? antes.prioridade;
    if (dados.responsavel_id !== undefined) {
      depois.responsavel_id = dados.responsavel_id ? Number(dados.responsavel_id) : null;
      if (depois.responsavel_id && !configuracaoCarteira().pessoas.some((p) => p.id === depois.responsavel_id)) throw erro('Responsável inválido');
    }
    if (dados.observacao !== undefined) depois.observacao = texto(dados.observacao).slice(0, 4000);
    if (dados.status !== undefined) {
      if (!['pendente','andamento','bloqueada'].includes(dados.status)) throw erro('A conclusão depende da confirmação no Senior');
      depois.status = dados.status;
    }
    // Por que ainda não foi lançada: lista fechada, para render contagem por causa.
    // Vale para qualquer status em aberto, não só bloqueada — a nota pode estar parada sem bloqueio.
    if (dados.motivo !== undefined) {
      const m = texto(dados.motivo);
      if (m && !MOTIVOS[m]) throw erro('Motivo desconhecido');
      depois.motivo = m || null;
    }
    depois.motivo_bloqueio = depois.status === 'bloqueada' ? texto(dados.motivo_bloqueio ?? antes.motivo_bloqueio).slice(0, 2000) : '';
    if (depois.status === 'bloqueada' && !depois.motivo && !depois.motivo_bloqueio) throw erro('Escolha o motivo do bloqueio');
    if (hash(antes) === hash(depois)) return antes;
    depois.atualizado_em = novaVersao(antes.atualizado_em);
    run(`UPDATE carteira_notas SET prioridade=?, data_prevista=?, responsavel_id=?, observacao=?, status=?, motivo=?, motivo_bloqueio=?, atualizado_em=? WHERE id=?`,
      [depois.prioridade, depois.data_prevista, depois.responsavel_id, depois.observacao, depois.status, depois.motivo ?? null, depois.motivo_bloqueio, depois.atualizado_em, antes.id]);
    historico(antes.id, usuarioId, 'alterar_programacao', antes, depois);
    return depois;
  });
}

export function alterarAndamentoCarteira(id, dados, usuarioId) {
  const permitidos = new Set(['versao', 'status', 'motivo', 'motivo_bloqueio']);
  if (!dados || typeof dados !== 'object' || Array.isArray(dados) || Object.keys(dados).some((k) => !permitidos.has(k))) {
    throw erro('O Membro pode alterar somente o andamento e o motivo da nota', 403);
  }
  return tx(() => {
    // Enquanto a planilha não define responsável, qualquer nota ativa pode ser tratada: o perfil
    // decide as telas, não a dona da nota. Para voltar a restringir, exija n.responsavel_id === usuarioId.
    const n = get('SELECT responsavel_id FROM carteira_notas WHERE id = ? AND excluida_em IS NULL', [Number(id)]);
    if (!n) throw erro('Nota não encontrada na carteira', 404);
    return alterarNotaCarteira(id, dados, usuarioId);
  });
}

export function listarImportacoesCarteira() {
  return all(`SELECT i.id, i.arquivo, i.criada_em, i.confirmada_em, i.resumo, u.nome AS usuario
    FROM carteira_importacoes i LEFT JOIN usuarios u ON u.id = i.usuario_id
    WHERE i.confirmada_em IS NOT NULL AND i.excluida_em IS NULL ORDER BY i.id DESC`)
    .map((i) => ({ ...i, resumo: JSON.parse(i.resumo) }));
}

export function previaExclusaoCarteira(id) {
  const lote = get('SELECT * FROM carteira_importacoes WHERE id = ? AND confirmada_em IS NOT NULL', [Number(id)]);
  if (!lote) throw erro('Importação não encontrada', 404);
  if (lote.excluida_em) return { id: lote.id, arquivo: lote.arquivo, ja_excluida: true, removidas: 0, preservadas: 0, notas: [] };
  const identidades = new Set(JSON.parse(lote.dados).map((i) => i.nota.identidade));
  const outras = new Set(all(`SELECT dados FROM carteira_importacoes WHERE id <> ?
    AND confirmada_em IS NOT NULL AND excluida_em IS NULL`, [lote.id]).flatMap((i) => JSON.parse(i.dados).map((n) => n.nota.identidade)));
  const notas = all('SELECT * FROM carteira_notas WHERE excluida_em IS NULL').filter((n) => identidades.has(n.identidade));
  const exclusivas = notas.filter((n) => !outras.has(n.identidade));
  return { id: lote.id, arquivo: lote.arquivo, removidas: exclusivas.length, preservadas: notas.length - exclusivas.length, notas: exclusivas,
    versao: hash(notas.map((n) => [n.id, n.atualizado_em, outras.has(n.identidade)])) };
}

export function excluirImportacaoCarteira(id, usuarioId, versao) {
  return tx(() => {
    const previa = previaExclusaoCarteira(id);
    if (!previa.ja_excluida && versao && versao !== previa.versao) throw erro('A carteira mudou. Feche esta confirmação e revise a exclusão novamente', 409);
    if (!previa.ja_excluida) {
      const em = agora();
      for (const n of previa.notas) {
        const depois = { ...n, excluida_em: em, atualizado_em: novaVersao(n.atualizado_em) };
        run('UPDATE carteira_notas SET excluida_em = ?, atualizado_em = ? WHERE id = ?', [em, depois.atualizado_em, n.id]);
        historico(n.id, usuarioId, 'excluir_importacao', n, depois);
      }
      run('UPDATE carteira_importacoes SET excluida_em = ?, excluida_por = ? WHERE id = ?', [em, usuarioId, previa.id]);
    }
    const { notas, ...resumo } = previa;
    return resumo;
  });
}

// A carteira usa os mesmos documentos e anexos de “Todas as notas”. Os vínculos são relidos
// a cada consulta: um PDF recebido depois da planilha aparece sem precisar reimportar.
export function vincularArquivosCarteira(notas) {
  if (!notas.length) return notas;
  const docs = all(`SELECT id, tipo, chave_acesso, numero, serie, emitente_cnpj, destinatario_cnpj,
    destinatario_nome, pdf_anexo_id FROM documentos WHERE duplicado_de_id IS NULL`);
  const chaves = new Map(), numeros = new Map();
  const numero = (n) => texto(n).replace(/^0+(?=\d)/, '');
  const tipo = (t) => {
    const s = normal(t).replace(/[^a-z]/g, '');
    return ['nfse', 'nfce', 'nfe', 'cte'].find((p) => s.startsWith(p)) ?? s;
  };
  const cpfCnpj = (s) => digitos(s).padStart(14, '0');
  for (const d of docs) {
    if (d.chave_acesso) chaves.set(texto(d.chave_acesso), d);
    const k = `${cpfCnpj(d.emitente_cnpj)}|${numero(d.numero)}|${cpfCnpj(d.destinatario_cnpj)}`;
    const lista = numeros.get(k) ?? []; lista.push(d); numeros.set(k, lista);
  }
  const vinculadas = notas.map((n) => {
    let candidatas;
    if (n.chave) candidatas = chaves.has(n.chave) ? [chaves.get(n.chave)] : [];
    else if (n.tomador_cnpj) candidatas = (numeros.get(`${cpfCnpj(n.cnpj_fornecedor)}|${numero(n.numero)}|${cpfCnpj(n.tomador_cnpj)}`) ?? [])
      .filter((d) => (!n.serie || texto(d.serie) === n.serie) && tipo(d.tipo) === tipo(n.documento));
    else candidatas = [];
    candidatas = candidatas.filter((d) => (!n.tomador_cnpj || !d.destinatario_cnpj || cpfCnpj(d.destinatario_cnpj) === cpfCnpj(n.tomador_cnpj))
      && (!n.cnpj_fornecedor || !d.emitente_cnpj || cpfCnpj(d.emitente_cnpj) === cpfCnpj(n.cnpj_fornecedor)));
    const d = candidatas.length === 1 ? candidatas[0] : null;
    return { ...n, documento_id: d?.id ?? null, tomador_nome: d?.destinatario_nome || n.tomador_nome || n.empresa,
      tomador_cnpj: n.tomador_cnpj || d?.destinatario_cnpj || null, pdfs_nota: [], pdfs_boleto: [],
      vinculo_documento: d ? 'localizado' : candidatas.length > 1 ? 'ambiguo' : !n.chave && !n.tomador_cnpj ? 'sem_tomador' : 'nao_localizado' };
  });
  const ids = [...new Set(vinculadas.map((n) => n.documento_id).filter(Boolean))];
  const anexos = new Map();
  const docsId = new Map(docs.map((d) => [d.id, d]));
  for (let i = 0; i < ids.length; i += 400) {
    const lote = ids.slice(i, i + 400);
    const alvos = new Set(lote), pdfs = new Map();
    for (const id of lote) {
      const pdf = docsId.get(id)?.pdf_anexo_id;
      if (pdf) pdfs.set(pdf, [...(pdfs.get(pdf) ?? []), id]);
    }
    for (const a of all(`SELECT id, documento_id, nome_arquivo, mime, tipo_detectado FROM anexos
      WHERE documento_id IN (${lote.map(() => '?').join(',')})${pdfs.size ? ` OR id IN (${[...pdfs.keys()].map(() => '?').join(',')})` : ''}`, [...lote, ...pdfs.keys()])) {
      for (const docId of new Set([a.documento_id, ...(pdfs.get(a.id) ?? [])].filter((id) => alvos.has(id)))) {
        const lista = anexos.get(docId) ?? []; lista.push(a); anexos.set(docId, lista);
      }
    }
  }
  for (const n of vinculadas) {
    const d = docsId.get(n.documento_id);
    for (const a of anexos.get(n.documento_id) ?? []) {
      if (a.mime !== 'application/pdf' && !/\.pdf$/i.test(a.nome_arquivo)) continue;
      const arquivo = { id: a.id, nome: a.nome_arquivo };
      if (a.tipo_detectado === 'boleto_pdf') n.pdfs_boleto.push(arquivo);
      else if (a.id === d?.pdf_anexo_id || ['danfe_pdf','dacte_pdf','nfse_pdf'].includes(a.tipo_detectado)) n.pdfs_nota.push(arquivo);
    }
  }
  return vinculadas;
}

export function anexoPermitidoCarteira(id) {
  const notas = all('SELECT * FROM carteira_notas WHERE excluida_em IS NULL');
  return vincularArquivosCarteira(notas).some((n) => [...n.pdfs_nota, ...n.pdfs_boleto].some((a) => a.id === id));
}

export function aplicarTomadoresCarteira(filiais) {
  return tx(() => {
    const porFilial = new Map(filiais.map((f) => [`${Number(f.CODEMP)}/${Number(f.CODFIL)}`, f]));
    let atualizadas = 0;
    for (const n of all("SELECT * FROM carteira_notas WHERE excluida_em IS NULL AND COALESCE(tomador_cnpj,'') = ''")) {
      const f = porFilial.get(n.empfil);
      const cnpj = f ? digitos(f.NUMCGC).padStart(14, '0') : '';
      if (!/^\d{14}$/.test(cnpj) || /^0+$/.test(cnpj)) continue;
      const depois = { ...n, tomador_cnpj: cnpj, tomador_nome: n.tomador_nome || texto(f.NOMFIL) || n.empresa,
        atualizado_em: novaVersao(n.atualizado_em) };
      run('UPDATE carteira_notas SET tomador_cnpj=?, tomador_nome=?, atualizado_em=? WHERE id=?',
        [depois.tomador_cnpj, depois.tomador_nome, depois.atualizado_em, n.id]);
      historico(n.id, null, 'complementar_tomador', n, depois); atualizadas++;
    }
    return { atualizadas };
  });
}

let tomadoresEmCurso = null;
export function preencherTomadoresCarteira() {
  if (tomadoresEmCurso) return tomadoresEmCurso;
  tomadoresEmCurso = (async () => {
    if (!seniorConfigurado()) return { atualizadas: 0 };
    const notas = all("SELECT DISTINCT empfil FROM carteira_notas WHERE excluida_em IS NULL AND COALESCE(tomador_cnpj,'') = ''");
    const linhas = [];
    const prefixo = (process.env.SENIOR_DB_TIPO || '').toLowerCase() === 'oracle' ? ':' : '@';
    for (let i = 0; i < notas.length; i += 100) {
      const params = {};
      const termos = notas.slice(i, i + 100).map((n,j) => {
        const [emp, fil] = n.empfil.split('/').map(Number); params[`e${j}`] = emp; params[`f${j}`] = fil;
        return `(CODEMP=${prefixo}e${j} AND CODFIL=${prefixo}f${j})`;
      });
      linhas.push(...await consultar(`SELECT CODEMP, CODFIL, NUMCGC, NOMFIL FROM E070FIL WHERE ${termos.join(' OR ')}`, null, params));
    }
    return aplicarTomadoresCarteira(linhas);
  })().catch((e) => {
    log('alerta', 'carteira', `Não foi possível complementar os tomadores pelo Senior: ${e.message}`);
    return { atualizadas: 0, aviso: 'Não foi possível complementar os tomadores pelo Senior' };
  }).finally(() => { tomadoresEmCurso = null; });
  return tomadoresEmCurso;
}

export function listarCarteira(filtros = {}, usuarioId) {
  const dia = dataPlanilha(filtros.dia) || hojeCarteira();
  const todas = vincularArquivosCarteira(all(`SELECT n.*, u.nome AS responsavel, u.email AS responsavel_email FROM carteira_notas n
    LEFT JOIN usuarios u ON u.id = n.responsavel_id WHERE n.excluida_em IS NULL`))
    .map((n) => ({ ...n, motivo_rotulo: n.motivo ? (MOTIVOS[n.motivo] ?? n.motivo) : null }));
  const chaveTomador = (n) => n.tomador_cnpj ? digitos(n.tomador_cnpj) : `nome:${normal(n.tomador_nome || n.empresa)}`;
  const tipoNota = (n) => texto(n.tipo_nota) || 'Não informado';
  const ordenar = (itens) => itens.sort((a,b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR', { numeric: true }));
  const disponiveis = {
    empresas: ordenar([...new Map(todas.map((n) => {
      const chave = n.empfil.split('/')[0]; return [chave, { chave, rotulo: `Empresa ${chave}` }];
    })).values()]),
    filiais: ordenar([...new Map(todas.map((n) => [n.empfil, {
      chave: n.empfil, empresa: n.empfil.split('/')[0], rotulo: `${n.empfil}${n.empresa ? ` ${n.empresa}` : ''}`,
    }])).values()]),
    tomadores: ordenar([...new Map(todas.map((n) => [chaveTomador(n), {
      chave: chaveTomador(n), rotulo: n.tomador_nome || n.empresa || 'Tomador não informado', cnpj: n.tomador_cnpj || null,
    }])).values()]),
    tipos_nota: ordenar([...new Map(todas.map((n) => [tipoNota(n), { chave: tipoNota(n), rotulo: tipoNota(n) }])).values()]),
  };
  let notas = todas;
  if (filtros.minha === '1') notas = notas.filter((n) => n.responsavel_id === usuarioId);
  else if (filtros.responsavel === 'sem') notas = notas.filter((n) => !n.responsavel_id);
  else if (filtros.responsavel) notas = notas.filter((n) => n.responsavel_id === Number(filtros.responsavel));
  if (filtros.empresa) notas = notas.filter((n) => n.empfil.split('/')[0] === String(Number(filtros.empresa)));
  if (filtros.empfil) notas = notas.filter((n) => n.empfil === filtros.empfil);
  if (filtros.tomador) {
    const chave = /^nome:/i.test(String(filtros.tomador)) ? `nome:${normal(String(filtros.tomador).slice(5))}` : digitos(filtros.tomador);
    notas = notas.filter((n) => chaveTomador(n) === chave);
  }
  if (filtros.tipo_nota) notas = notas.filter((n) => normal(tipoNota(n)) === normal(filtros.tipo_nota));
  // Emissão: nota sem data fica de fora quando o período é informado, senão ela apareceria sempre
  const emissaoDe = dataPlanilha(filtros.emissao_de);
  const emissaoAte = dataPlanilha(filtros.emissao_ate);
  if (emissaoDe) notas = notas.filter((n) => n.emissao && n.emissao >= emissaoDe);
  if (emissaoAte) notas = notas.filter((n) => n.emissao && n.emissao <= emissaoAte);
  if (filtros.prioridade) {
    const p = prioridade(filtros.prioridade);
    notas = notas.filter((n) => n.prioridade === p);
  }
  if (filtros.status) notas = notas.filter((n) => n.status === filtros.status);
  if (filtros.motivo) notas = notas.filter((n) => (n.motivo ?? '') === (filtros.motivo === 'sem' ? '' : filtros.motivo));
  if (filtros.busca) notas = notas.filter((n) => normal([n.numero, n.fornecedor, n.chave, n.empresa, n.tomador_nome, n.tomador_cnpj].join(' ')).includes(normal(filtros.busca)));
  const abertas = notas.filter((n) => n.status !== 'lancada');
  const plano = notas.filter((n) => n.data_prevista === dia);
  // Atraso se mede contra HOJE, nunca contra o dia escolhido: abrir um dia passado zerava o
  // indicador, porque as notas daquele dia não são anteriores a ele. O foco da tela é o dia
  // escolhido MAIS tudo que já venceu, para que o atraso não some ao navegar para trás.
  const hoje = hojeCarteira();
  const vencida = (n) => n.status !== 'lancada' && n.data_prevista < hoje;
  const noFoco = (n) => n.data_prevista <= dia || vencida(n);
  const k = { programadas: plano.length, concluidas_plano: plano.filter((n) => n.status === 'lancada').length,
    restantes: plano.filter((n) => n.status !== 'lancada').length,
    atrasadas: abertas.filter(vencida).length,
    bloqueadas: abertas.filter((n) => n.status === 'bloqueada' && noFoco(n)).length,
    sem_responsavel: abertas.filter((n) => !n.responsavel_id).length,
    lancadas_dia: notas.filter((n) => n.lancada_em === dia).length };
  const porPessoa = new Map();
  const porFilial = new Map();
  for (const n of notas.filter((n) => noFoco(n) && (n.status !== 'lancada' || n.data_prevista === dia))) {
    for (const [mapa, chave, rotulo] of [[porPessoa, n.responsavel_id ?? 'sem', n.responsavel ?? 'Sem responsável'], [porFilial, n.empfil, `${n.empfil} ${n.empresa || ''}`]]) {
      const p = mapa.get(chave) ?? { chave, rotulo, total: 0, lancadas: 0, atrasadas: 0, bloqueadas: 0 };
      p.total++; p.lancadas += n.status === 'lancada' ? 1 : 0;
      p.atrasadas += vencida(n) ? 1 : 0;
      p.bloqueadas += n.status === 'bloqueada' ? 1 : 0;
      mapa.set(chave, p);
    }
  }
  // Por que as notas em aberto estão paradas, e há quanto tempo.
  // A idade conta do RECEBIMENTO (recebida_em), que é a única data de entrada confiável aqui —
  // a data prevista é reprogramável e não serve para medir espera.
  const FAIXAS_IDADE = [
    { id: '0-5', rotulo: 'Até 5 dias', ate: 5 },
    { id: '6-15', rotulo: '6 a 15 dias', ate: 15 },
    { id: '16-30', rotulo: '16 a 30 dias', ate: 30 },
    { id: '31+', rotulo: 'Mais de 30 dias', ate: Infinity },
  ];
  const idadeDe = (n) => (n.recebida_em ? Math.max(0, Math.round((new Date(`${dia}T12:00:00Z`) - new Date(`${n.recebida_em}T12:00:00Z`)) / 86400000)) : null);
  const porMotivo = [...abertas.reduce((m, n) => {
    const chave = n.motivo || 'sem_motivo';
    const a = m.get(chave) ?? {
      chave, rotulo: n.motivo ? (MOTIVOS[n.motivo] ?? n.motivo) : 'Sem motivo registrado',
      qtd: 0, valor: 0, idades: [], faixas: Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, 0])),
    };
    a.qtd += 1; a.valor += Number(n.valor) || 0;
    const idade = idadeDe(n);
    if (idade != null) {
      a.idades.push(idade);
      a.faixas[FAIXAS_IDADE.find((f) => idade <= f.ate).id] += 1;
    }
    return m.set(chave, a);
  }, new Map()).values()].map(({ idades, ...a }) => ({
    ...a, valor: Math.round(a.valor * 100) / 100,
    idade_media: idades.length ? Math.round((idades.reduce((s, v) => s + v, 0) / idades.length) * 10) / 10 : null,
    mais_antiga: idades.length ? Math.max(...idades) : null,
  })).sort((a, b) => b.qtd - a.qtd);

  if (filtros.visao === 'historico') notas = notas.filter((n) => n.status === 'lancada');
  else if (filtros.visao === 'carteira') notas = abertas;
  else if (filtros.visao !== 'todas') notas = notas.filter((n) => noFoco(n) && (n.status !== 'lancada' || n.data_prevista === dia));
  notas.sort((a,b) => Number(a.status === 'lancada') - Number(b.status === 'lancada')
    || Number(vencida(b)) - Number(vencida(a)) || a.prioridade - b.prioridade
    || a.data_prevista.localeCompare(b.data_prevista) || a.id - b.id);
  return { dia, indicadores: k, itens: notas, por_pessoa: [...porPessoa.values()], por_filial: [...porFilial.values()],
    por_motivo: porMotivo, faixas_idade: FAIXAS_IDADE.map(({ id, rotulo }) => ({ id, rotulo })), motivos: MOTIVOS, filtros: disponiveis,
    filiais: all('SELECT DISTINCT empfil, empresa FROM carteira_notas WHERE excluida_em IS NULL ORDER BY empfil'),
    ultima_conferencia: get('SELECT MAX(verificada_em) AS em FROM carteira_notas WHERE excluida_em IS NULL')?.em,
    senior_configurado: seniorConfigurado() };
}

export function historicoCarteira(id) {
  return all(`SELECT h.*, u.nome AS usuario FROM carteira_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id
    WHERE h.nota_id = ? ORDER BY h.id DESC`, [Number(id)]).map((h) => ({ ...h, antes: h.antes ? JSON.parse(h.antes) : null, depois: JSON.parse(h.depois) }));
}

export function aplicarConferenciaCarteira(notas, linhas, usuarioId) {
  return tx(() => {
    let concluidas = 0, reabertas = 0, ambiguas = 0;
    const em = agora();
    const porChave = new Map(), porNumero = new Map();
    for (const l of linhas) {
      const filial = `${l.CODEMP}/${l.CODFIL}`;
      for (const [mapa, k] of [[porChave, `${filial}|${texto(l.CHVNEL)}`],
        [porNumero, `${filial}|${digitos(l.CNPJFOR).padStart(14, '0')}|${String(l.NUMNFC).replace(/^0+(?=\d)/, '')}`]]) {
        const lista = mapa.get(k) ?? []; lista.push(l); mapa.set(k, lista);
      }
    }
    for (const consultada of notas) {
      const n = get('SELECT * FROM carteira_notas WHERE id = ?', [consultada.id]);
      if (!n || n.excluida_em) continue;
      const candidatas = n.chave ? porChave.get(`${n.empfil}|${n.chave}`) ?? []
        : (porNumero.get(`${n.empfil}|${n.cnpj_fornecedor.padStart(14, '0')}|${n.numero.replace(/^0+(?=\d)/, '')}`) ?? [])
          .filter((l) => !n.serie || texto(l.CODSNF) === n.serie);
      const ativas = candidatas.filter((l) => String(l.SITNFC) === '2');
      if (ativas.length > 1) ambiguas++;
      let depois = { ...n, verificada_em: em };
      let acao = null;
      if (ativas.length === 1) {
        const l = ativas[0];
        const dataLancada = l.DATGER instanceof Date ? l.DATGER.toISOString().slice(0,10) : texto(l.DATGER).slice(0,10);
        depois = { ...depois, status: 'lancada', lancada_em: dataPlanilha(dataLancada) || null,
          senior_ref: `${l.CODEMP}/${l.CODFIL}/${l.NUMNFC}/${texto(l.CODSNF)}` };
        if (n.status !== 'lancada') { acao = 'confirmar_senior'; concluidas++; }
      } else if (n.status === 'lancada') {
        // Uma entrada cancelada ou excluída volta à carteira e preserva o prazo e a programação.
        const h = get("SELECT antes FROM carteira_historico WHERE nota_id = ? AND acao = 'confirmar_senior' ORDER BY id DESC LIMIT 1", [n.id]);
        const anterior = h?.antes ? JSON.parse(h.antes) : null;
        depois = { ...depois, status: anterior?.status === 'bloqueada' ? 'bloqueada' : 'pendente', lancada_em: null, senior_ref: null };
        acao = 'reabrir_senior'; reabertas++;
      }
      depois.atualizado_em = acao ? novaVersao(n.atualizado_em) : n.atualizado_em;
      run('UPDATE carteira_notas SET status=?, lancada_em=?, senior_ref=?, verificada_em=?, atualizado_em=? WHERE id=?',
        [depois.status, depois.lancada_em, depois.senior_ref, em, depois.atualizado_em, n.id]);
      if (acao) historico(n.id, usuarioId, acao, n, depois);
    }
    return { conferidas: notas.length, concluidas, reabertas, ambiguas, em };
  });
}

export function consultaConferenciaCarteira(lote, dialeto = process.env.SENIOR_DB_TIPO) {
  const params = {};
  const prefixo = dialeto === 'oracle' ? ':' : '@';
  const termos = lote.map((n, j) => {
    const [emp, fil] = n.empfil.split('/').map(Number);
    params[`e${j}`] = emp; params[`f${j}`] = fil;
    let termo;
    if (n.chave) { params[`k${j}`] = n.chave; termo = `n.CHVNEL = ${prefixo}k${j}`; }
    else {
      // Números municipais podem exceder 14 dígitos. Preserve o texto completo,
      // sem arredondar ou cortar ano/sequência. Fora da precisão do banco, não há casamento.
      const numero = texto(n.numero).replace(/^0+(?=\d)/, '');
      params[`c${j}`] = n.cnpj_fornecedor;
      params[`n${j}`] = /^\d{1,38}$/.test(numero) ? numero : null;
      termo = `f.CGCCPF = CAST(${prefixo}c${j} AS NUMERIC(14,0)) AND n.NUMNFC = CAST(${prefixo}n${j} AS NUMERIC(38,0))`;
    }
    return `(n.CODEMP = ${prefixo}e${j} AND n.CODFIL = ${prefixo}f${j} AND ${termo})`;
  });
  return { sql: `SELECT n.CODEMP, n.CODFIL, n.NUMNFC, n.CODSNF, n.CHVNEL, n.SITNFC, n.DATGER, f.CGCCPF AS CNPJFOR
    FROM E440NFC n JOIN E095FOR f ON f.CODFOR = n.CODFOR WHERE ${termos.length ? termos.join(' OR ') : '1 = 0'}`, params };
}

let conferenciaEmCurso = null;
export function conferirCarteira(usuarioId = null) {
  if (conferenciaEmCurso) return conferenciaEmCurso;
  conferenciaEmCurso = (async () => {
    if (!seniorConfigurado()) throw erro('Senior não configurado. A carteira continua disponível; configure a integração para confirmar os lançamentos');
    await preencherTomadoresCarteira();
    const notas = all('SELECT * FROM carteira_notas WHERE excluida_em IS NULL');
    const linhas = [];
    // Consulta as identidades da carteira, sem limite de período: uma nota antiga não desaparece.
    for (let i = 0; i < notas.length; i += 100) {
      const { sql, params } = consultaConferenciaCarteira(notas.slice(i, i + 100));
      linhas.push(...await consultar(sql, null, params));
    }
    // Termos sobrepostos nos lotes podem devolver a mesma entrada mais de uma vez.
    const unicas = [...new Map(linhas.map((l) => [`${l.CODEMP}/${l.CODFIL}/${l.CNPJFOR}/${l.NUMNFC}/${l.CODSNF}`, l])).values()];
    return aplicarConferenciaCarteira(notas, unicas, usuarioId);
  })().finally(() => { conferenciaEmCurso = null; });
  return conferenciaEmCurso;
}
