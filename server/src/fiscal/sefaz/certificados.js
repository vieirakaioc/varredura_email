// Certificados digitais A1 (.pfx/.p12) usados nas consultas à SEFAZ.
// O arquivo fica em data/certificados e a senha é cifrada com o APP_SECRET (nunca é devolvida pela API).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import forge from 'node-forge';
import { all, get, insert, run } from '../../db/index.js';
import { paths } from '../../config.js';
import { cifrar, decifrar } from '../../util/cripto.js';
import { limparId } from '../validadores.js';

const pastaCertificados = path.join(paths.dados, 'certificados');

/** Lê titular, CNPJ e validade de dentro do .pfx (sem expor a chave privada). */
export function lerDadosPfx(buffer, senha) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary'))), senha);
  } catch (e) {
    throw new Error(/mac|password|invalid/i.test(e.message) ? 'Senha do certificado incorreta (ou arquivo não é um .pfx/.p12 válido)' : `Certificado inválido: ${e.message}`);
  }
  // O .pfx traz a cadeia inteira: interessa o certificado da empresa (e-CNPJ), não as autoridades certificadoras
  const daCadeia = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.map((b) => b.cert).filter(Boolean) ?? [];
  const folhas = daCadeia.filter((c) => c.getExtension('basicConstraints')?.cA !== true);
  const cert = folhas.find((c) => /:\d{11,14}$/.test(c.subject.getField('CN')?.value ?? ''))
    ?? folhas.sort((a, b) => a.validity.notAfter - b.validity.notAfter)[0]
    ?? daCadeia[0];
  if (!cert) throw new Error('Certificado sem parte pública (verifique o arquivo)');
  const nome = cert.subject.getField('CN')?.value ?? '';
  // e-CNPJ: "RAZAO SOCIAL:12345678000199"; o CNPJ também aparece nas extensões (otherName)
  const cnpjNome = nome.match(/(\d{14})/)?.[1];
  const cnpjExt = JSON.stringify(cert.extensions ?? '').match(/(\d{14})/)?.[1];
  return {
    titular: nome.replace(/:\d{14}$/, '').trim(),
    cnpj: cnpjNome ?? cnpjExt ?? null,
    valido_de: cert.validity.notBefore.toISOString().slice(0, 10),
    valido_ate: cert.validity.notAfter.toISOString().slice(0, 10),
  };
}

/** Guarda o .pfx e a senha (cifrada). Substitui o certificado do mesmo CNPJ (renovação). */
export function salvarCertificado({ buffer, nomeArquivo, senha, cnpjInformado, empresaId }) {
  const dados = lerDadosPfx(buffer, senha);
  const cnpj = limparId(cnpjInformado || dados.cnpj || '');
  if (cnpj.length !== 14) throw new Error('Não consegui identificar o CNPJ do certificado; informe o CNPJ ao enviar');
  // Confere o certificado no TLS: garante que o par chave/senha funciona de verdade
  tls.createSecureContext({ pfx: buffer, passphrase: senha });
  fs.mkdirSync(pastaCertificados, { recursive: true });
  const arquivo = `${cnpj}_${crypto.randomUUID().slice(0, 8)}${path.extname(nomeArquivo || '.pfx') || '.pfx'}`;
  fs.writeFileSync(path.join(pastaCertificados, arquivo), buffer, { mode: 0o600 });
  const empresa = empresaId ? get('SELECT id FROM empresas WHERE id = ?', [empresaId])
    : get("SELECT id FROM empresas WHERE replace(replace(replace(cnpj, '.', ''), '/', ''), '-', '') = ?", [cnpj]);
  const atual = get('SELECT * FROM certificados_digitais WHERE cnpj = ?', [cnpj]);
  const registro = { cnpj, empresa_id: empresa?.id ?? null, titular: dados.titular, arquivo, senha_enc: cifrar(senha), valido_de: dados.valido_de, valido_ate: dados.valido_ate, ativo: 1, ultimo_erro: null };
  if (atual) {
    run(`UPDATE certificados_digitais SET empresa_id = ?, titular = ?, arquivo = ?, senha_enc = ?, valido_de = ?, valido_ate = ?, ativo = 1, ultimo_erro = NULL WHERE id = ?`,
      [registro.empresa_id, registro.titular, arquivo, registro.senha_enc, registro.valido_de, registro.valido_ate, atual.id]);
    apagarArquivo(atual.arquivo);
  } else {
    insert('certificados_digitais', registro);
  }
  return { ...dados, cnpj, empresa_id: registro.empresa_id, substituido: Boolean(atual) };
}

function apagarArquivo(arquivo) {
  try { if (arquivo) fs.unlinkSync(path.join(pastaCertificados, arquivo)); } catch { /* já removido */ }
}

export function removerCertificado(id) {
  const c = get('SELECT * FROM certificados_digitais WHERE id = ?', [id]);
  if (!c) return false;
  run('DELETE FROM certificados_digitais WHERE id = ?', [id]);
  apagarArquivo(c.arquivo);
  return true;
}

/** Certificados cadastrados (sem senha). `vencido`/`vence_em_dias` ajudam a avisar antes de parar. */
export function listarCertificados() {
  const hoje = new Date().toLocaleDateString('sv-SE');
  return all(`SELECT c.id, c.cnpj, c.empresa_id, c.titular, c.valido_de, c.valido_ate, c.ativo, c.ultimo_erro, c.created_at,
      COALESCE(e.nome_fantasia, e.razao_social) AS empresa,
      (SELECT COUNT(*) FROM empresas x WHERE replace(replace(replace(x.cnpj, '.', ''), '/', ''), '-', '') = c.cnpj) AS empresas_no_cnpj,
      d.ult_nsu, d.max_nsu, d.ultima_consulta, d.ultimo_status, d.ultimo_aviso, d.ultimo_erro AS dfe_erro, d.documentos,
    CASE WHEN d.max_nsu IS NOT NULL AND CAST(d.ult_nsu AS INTEGER) < CAST(d.max_nsu AS INTEGER) THEN CAST(d.max_nsu AS INTEGER) - CAST(d.ult_nsu AS INTEGER) ELSE 0 END AS faltam
    FROM certificados_digitais c
    LEFT JOIN empresas e ON e.id = c.empresa_id
    LEFT JOIN dfe_controle d ON d.cnpj = c.cnpj
    ORDER BY c.valido_ate`).map((c) => ({
    ...c,
    vencido: Boolean(c.valido_ate && c.valido_ate < hoje),
    vence_em_dias: c.valido_ate ? Math.round((new Date(`${c.valido_ate}T12:00:00`) - new Date(`${hoje}T12:00:00`)) / 86400000) : null,
  }));
}

/** Material para a conexão TLS com a SEFAZ (usado só em memória, no momento da consulta). */
export function materialTls(cnpj) {
  const c = get('SELECT * FROM certificados_digitais WHERE cnpj = ? AND ativo = 1', [cnpj]);
  if (!c) throw new Error(`Sem certificado cadastrado para o CNPJ ${cnpj}`);
  const arquivo = path.join(pastaCertificados, c.arquivo);
  if (!fs.existsSync(arquivo)) throw new Error(`Arquivo do certificado não encontrado (${c.arquivo}); envie novamente`);
  return { pfx: fs.readFileSync(arquivo), passphrase: decifrar(c.senha_enc), certificado: c };
}

// ------------------------------------------------------------------ importação em lote
/** Palavras do nome do arquivo que podem ser a senha ("... senha Perfil1234", "(Caminhoes@2026)"). */
function senhasDoNome(nome) {
  const base = path.basename(nome).replace(/\.(pfx|p12)$/i, '');
  const depoisDeSenha = [...base.matchAll(/senha[:\s-]*([^\s()]{4,40})/gi)].map((m) => m[1]);
  const entreParenteses = [...base.matchAll(/\(([^)]{4,40})\)/g)].map((m) => m[1]);
  // Palavras do nome que podem ser senha. Nomes de empresa (só letras) são descartados, mas
  // "Eucafil@2026" ou "Florestal2026@@" continuam valendo: senha costuma ter número ou símbolo.
  const soNome = /^(LTDA|S\.?A|EIRELI|ME|EPP|PARTICIPACOES|HOLDING|PATRIMONIAL|COMELLI|COMBER|COMPANHIA|RENOVAVEL|ENERGIA|BRASILEIRA|INDUSTRIA|LOGISTICA|BIOMASSA|FLORESTAL|SEMINOVOS|LOCACOES|CAMINHOES|EUCAFIL|VENCIMENTO|vencido|senha|certificado)$/i;
  const palavras = base.split(/[\s_]+/)
    .filter((p) => p.length >= 6 && /[A-Za-z]/.test(p) && !/^\d+$/.test(p) && !soNome.test(p))
    .filter((p) => /[\d@#$%!.*-]/.test(p) || !/^[A-Za-zÀ-ú]+$/.test(p) || p.length >= 8);
  return [...new Set([...depoisDeSenha, ...entreParenteses, ...palavras])];
}

/** Lê os .txt da pasta (listas de senhas) e devolve as palavras candidatas. */
function senhasDosTxt(pasta) {
  const saida = [];
  for (const arq of arquivosDaPasta(pasta, /\.txt$/i)) {
    try {
      for (const linha of fs.readFileSync(arq, 'latin1').split(/\r?\n/)) {
        for (const p of linha.split(/[\s:;,]+/)) if (p.length >= 4 && p.length <= 40) saida.push(p);
      }
    } catch { /* ignora arquivo ilegível */ }
  }
  return [...new Set(saida)];
}

function arquivosDaPasta(pasta, filtro) {
  const saida = [];
  const andar = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, item.name);
      if (item.isDirectory()) andar(completo);
      else if (filtro.test(item.name)) saida.push(completo);
    }
  };
  andar(pasta);
  return saida;
}

/**
 * Varre uma pasta (com subpastas), abre cada .pfx testando as senhas candidatas e importa,
 * por CNPJ, o certificado válido de vencimento mais distante. Senhas nunca são gravadas em log.
 * @param {object} opcoes.simular  true = só relatório, sem salvar
 */
export function importarDaPasta({ pasta, senhas = [], simular = false }) {
  if (!pasta || !fs.existsSync(pasta)) throw new Error(`Pasta não encontrada: ${pasta}`);
  const arquivos = arquivosDaPasta(pasta, /\.(pfx|p12)$/i);
  if (!arquivos.length) throw new Error('Nenhum arquivo .pfx ou .p12 na pasta');
  const listaTxt = senhasDosTxt(pasta);
  const hoje = new Date().toLocaleDateString('sv-SE');
  const porCnpj = new Map();
  const falhas = [];

  for (const arq of arquivos) {
    const buffer = fs.readFileSync(arq);
    const candidatas = [...new Set([...senhasDoNome(arq), ...senhas, ...listaTxt])];
    let aberto = null, usada = null;
    for (const senha of candidatas) {
      try { aberto = lerDadosPfx(buffer, senha); usada = senha; break; } catch { /* tenta a próxima */ }
    }
    if (!aberto) { falhas.push({ arquivo: path.relative(pasta, arq), motivo: 'nenhuma senha funcionou', candidatas: candidatas.length }); continue; }
    const cnpj = limparId(aberto.cnpj ?? path.basename(arq).match(/(\d{14})/)?.[1] ?? '');
    if (cnpj.length !== 14) { falhas.push({ arquivo: path.relative(pasta, arq), motivo: 'CNPJ não identificado' }); continue; }
    // o CNPJ identificado (certificado ou nome do arquivo) prevalece sobre o que veio do .pfx
    const registro = { ...aberto, arquivo: arq, relativo: path.relative(pasta, arq), cnpj, senha: usada, vencido: aberto.valido_ate < hoje };
    const atual = porCnpj.get(cnpj);
    // fica com o de validade mais longa (renovação) entre os do mesmo CNPJ
    if (!atual || registro.valido_ate > atual.valido_ate) porCnpj.set(cnpj, registro);
  }

  const escolhidos = [...porCnpj.values()].sort((a, b) => a.cnpj.localeCompare(b.cnpj));
  const importados = [];
  for (const c of escolhidos) {
    if (c.vencido) continue;
    if (!simular) {
      try { salvarCertificado({ buffer: fs.readFileSync(c.arquivo), nomeArquivo: path.basename(c.arquivo), senha: c.senha, cnpjInformado: c.cnpj }); } catch (e) {
        falhas.push({ arquivo: c.relativo, motivo: e.message });
        continue;
      }
    }
    importados.push({ cnpj: c.cnpj, titular: c.titular, valido_ate: c.valido_ate, arquivo: c.relativo });
  }
  return {
    simulacao: simular,
    arquivos: arquivos.length,
    cnpjs_encontrados: escolhidos.length,
    importados,
    vencidos: escolhidos.filter((c) => c.vencido).map((c) => ({ cnpj: c.cnpj, titular: c.titular, valido_ate: c.valido_ate, arquivo: c.relativo })),
    sem_senha: falhas,
  };
}

/** CNPJs com certificado válido hoje (base das consultas automáticas). */
export function cnpjsComCertificado() {
  const hoje = new Date().toLocaleDateString('sv-SE');
  return all('SELECT cnpj FROM certificados_digitais WHERE ativo = 1 AND (valido_ate IS NULL OR valido_ate >= ?) ORDER BY cnpj', [hoje]).map((c) => c.cnpj);
}
