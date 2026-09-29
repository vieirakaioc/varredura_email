// Conector IMAP (alternativa ao OAuth). A caixa é aberta em modo SOMENTE LEITURA (EXAMINE):
// nenhuma flag é alterada, nada é movido ou excluído.
// Credenciais vêm de variáveis de ambiente (nunca do banco):
//   IMAP_<EMAIL_EM_MAIUSCULAS_COM_UNDERSCORE>_USUARIO / _SENHA  (ex.: senha de aplicativo do Zoho)
import { ImapFlow } from 'imapflow';
import { config } from '../config.js';

function credenciais(email) {
  const k = email.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const usuario = process.env[`IMAP_${k}_USUARIO`] || email;
  const senha = process.env[`IMAP_${k}_SENHA`];
  if (!senha) throw new Error(`Credencial IMAP ausente: defina IMAP_${k}_SENHA no .env (senha de aplicativo)`);
  return { user: usuario, pass: senha };
}

export async function* listarMensagens(caixa, desde) {
  const cliente = new ImapFlow({
    host: config.imap.host, port: config.imap.port, secure: true, auth: credenciais(caixa.email), logger: false,
  });
  await cliente.connect();
  try {
    const pastas = JSON.parse(caixa.pastas || 'null') || ['INBOX'];
    for (const pasta of pastas) {
      const lock = await cliente.getMailboxLock(pasta, { readOnly: true });
      try {
        const uids = (await cliente.search({ since: desde }, { uid: true })) || [];
        for (const uid of uids) {
          const msg = await cliente.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
          const partes = [];
          (function varrer(no) {
            if (!no) return;
            const nome = no.dispositionParameters?.filename || no.parameters?.name;
            if (nome && no.part) partes.push({ part: no.part, nome, tamanho: no.size });
            (no.childNodes || []).forEach(varrer);
          })(msg.bodyStructure);
          if (!partes.length) continue;
          const env = msg.envelope || {};
          const fmt = (l) => (l || []).map((a) => a.address).filter(Boolean).join(', ');
          yield {
            idProvedor: `${pasta}:${msg.uid}`,
            internetMessageId: env.messageId || null,
            pasta,
            remetente: env.from?.[0]?.address,
            remetenteNome: env.from?.[0]?.name,
            destinatarios: fmt(env.to),
            cc: fmt(env.cc),
            assunto: env.subject,
            data: new Date(msg.internalDate || env.date || Date.now()).toISOString(),
            carregarAnexos: async () => partes.map((p) => ({
              nome: p.nome, tamanho: p.tamanho,
              baixar: async () => {
                // download() usa BODY.PEEK: não marca a mensagem como lida
                const { content } = await cliente.download(String(msg.uid), p.part, { uid: true });
                const chunks = [];
                for await (const c of content) chunks.push(c);
                return Buffer.concat(chunks);
              },
            })),
          };
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await cliente.logout().catch(() => {});
  }
}
