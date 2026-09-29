// Conector "pasta local": lê arquivos .eml de uma pasta (exportação de e-mails, testes, contingência).
// Arquivos XML/PDF/ZIP soltos na pasta também são importados como um "e-mail" sintético por arquivo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function parseEnderecos(v) {
  return (v || '').split(',').map((s) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim()).filter(Boolean).join(', ');
}

function decodificarCabecalho(v = '') {
  return v.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return buf.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
  });
}

/** Parser MIME mínimo para extrair cabeçalhos e anexos em base64 de arquivos .eml. */
export function lerEml(buffer) {
  const texto = buffer.toString('latin1');
  const [cabecalhoBruto] = texto.split(/\r?\n\r?\n/);
  const cab = {};
  for (const linha of cabecalhoBruto.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = linha.indexOf(':');
    if (i > 0) cab[linha.slice(0, i).toLowerCase()] = linha.slice(i + 1).trim();
  }
  const anexos = [];
  const blocos = texto.split(/\r?\n--[^\r\n]+/);
  for (const b of blocos) {
    const [h, ...resto] = b.split(/\r?\n\r?\n/);
    const nome = h.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1] ?? h.match(/name="?([^";\r\n]+)"?/i)?.[1];
    if (!nome || !/base64/i.test(h)) continue;
    const dados = resto.join('\n\n').replace(/[^A-Za-z0-9+/=]/g, '');
    anexos.push({ nome: decodificarCabecalho(nome), conteudo: Buffer.from(dados, 'base64') });
  }
  return {
    messageId: cab['message-id'] ?? null,
    remetente: parseEnderecos(cab.from),
    remetenteNome: decodificarCabecalho(cab.from?.split('<')[0]?.replace(/"/g, '').trim()),
    destinatarios: parseEnderecos(cab.to), cc: parseEnderecos(cab.cc),
    assunto: decodificarCabecalho(cab.subject), data: cab.date ? new Date(cab.date) : null, anexos,
  };
}

export async function* listarMensagens(caixa, desde, pastaBase) {
  const dir = pastaBase && path.join(pastaBase, caixa.email);
  if (!dir || !fs.existsSync(dir)) return;
  for (const arq of fs.readdirSync(dir)) {
    const cam = path.join(dir, arq);
    const stat = fs.statSync(cam);
    if (!stat.isFile() || stat.mtime < desde) continue;
    const buf = fs.readFileSync(cam);
    const id = crypto.createHash('sha1').update(buf).digest('hex');
    if (arq.toLowerCase().endsWith('.eml')) {
      const m = lerEml(buf);
      yield {
        idProvedor: id, internetMessageId: m.messageId, pasta: path.basename(dir), remetente: m.remetente, remetenteNome: m.remetenteNome,
        destinatarios: m.destinatarios, cc: m.cc, assunto: m.assunto, data: (m.data ?? stat.mtime).toISOString(),
        carregarAnexos: async () => m.anexos.map((a) => ({ nome: a.nome, tamanho: a.conteudo.length, baixar: async () => a.conteudo })),
      };
    } else if (/\.(xml|pdf|zip)$/i.test(arq)) {
      yield {
        idProvedor: id, internetMessageId: null, pasta: path.basename(dir), remetente: 'importacao@pasta.local', remetenteNome: 'Pasta de importação',
        destinatarios: caixa.email, cc: null, assunto: `Arquivo: ${arq}`, data: stat.mtime.toISOString(),
        carregarAnexos: async () => [{ nome: arq, tamanho: buf.length, baixar: async () => buf }],
      };
    }
  }
}
