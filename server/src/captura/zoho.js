// Conector Zoho Mail (API REST oficial + OAuth 2.0). Escopos somente leitura:
// o sistema não move, exclui, marca como lido nem altera e-mails.
// Documentação: https://www.zoho.com/mail/help/api/
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { cifrar, decifrar, assinarEstado } from '../util/cripto.js';

const tokensEmMemoria = new Map(); // caixaId -> { token, expira }

export function zohoConfigurado() {
  return Boolean(config.zoho.clientId && config.zoho.clientSecret);
}

/** `todas`: a autorização concedida vale para todas as caixas Zoho ativas (troca da conta autorizada). */
export function urlAutorizacao(caixaId, { todas = false } = {}) {
  const p = new URLSearchParams({
    scope: config.zoho.scopes,
    client_id: config.zoho.clientId,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    redirect_uri: config.zoho.redirectUri,
    state: assinarEstado({ caixaId, todas }),
  });
  return `${config.zoho.accountsUrl}/oauth/v2/auth?${p}`;
}

async function postToken(params) {
  const r = await fetch(`${config.zoho.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.zoho.clientId, client_secret: config.zoho.clientSecret, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Zoho OAuth: ${j.error || r.status}`);
  return j;
}

async function apiZoho(caixa, caminho, { binario = false } = {}) {
  const token = await tokenAcesso(caixa);
  const r = await fetch(`${config.zoho.mailApiUrl}/api${caminho}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 401) tokensEmMemoria.delete(caixa.id);
  if (!r.ok) throw new Error(`Zoho Mail API ${r.status} em ${caminho.split('?')[0]}`);
  if (binario) return Buffer.from(await r.arrayBuffer());
  const j = await r.json();
  return j.data;
}

const enderecosDaConta = (c) => [c.primaryEmailAddress, c.mailboxAddress, ...(c.emailAddress || []).map((e) => e.mailId)]
  .filter(Boolean).map((e) => String(e).toLowerCase());

/**
 * Descobre como ler a caixa com o token gravado:
 * - a conta autorizada É a caixa  -> leitura direta das pastas configuradas;
 * - caso contrário (caixa compartilhada/grupo) -> "modo membro": lê a conta do membro e considera
 *   apenas e-mails endereçados à caixa (Para/Cc). Nada é alterado na conta do membro.
 */
export async function resolverConta(caixaId) {
  const caixa = get('SELECT * FROM caixas_email WHERE id = ?', [caixaId]);
  const contas = await apiZoho(caixa, '/accounts');
  const alvo = caixa.email.toLowerCase();
  const propria = contas.find((c) => enderecosDaConta(c).includes(alvo));
  if (propria) {
    run(`UPDATE caixas_email SET provedor = 'zoho', provedor_conta_id = ?, conta_autorizada = ?, filtro_destinatario = 0,
      status = 'conectada', ultimo_erro = NULL WHERE id = ?`, [String(propria.accountId), propria.primaryEmailAddress ?? alvo, caixa.id]);
    return { modo: 'direto', conta: propria.primaryEmailAddress };
  }
  const membro = contas.find((c) => c.type === 'ZOHO_ACCOUNT') ?? contas[0];
  if (!membro) throw new Error('Nenhuma conta Zoho retornada para o usuário autorizado');
  // Confirma que a conta do membro recebe e-mails da caixa compartilhada (amostra recente).
  const amostra = await apiZoho(caixa, `/accounts/${membro.accountId}/messages/view?limit=200&sortorder=false&includeto=true`);
  const recebe = (amostra ?? []).some((m) => enderecadoA(m, alvo));
  run(`UPDATE caixas_email SET provedor = 'zoho', provedor_conta_id = ?, conta_autorizada = ?, filtro_destinatario = 1,
    status = 'conectada', ultimo_erro = ? WHERE id = ?`,
  [String(membro.accountId), membro.primaryEmailAddress, recebe ? null
    : `Conectada via ${membro.primaryEmailAddress}, mas nenhum dos últimos 200 e-mails dessa conta é endereçado a ${caixa.email}. Confirme se esse usuário é membro da caixa compartilhada.`, caixa.id]);
  return { modo: 'membro', conta: membro.primaryEmailAddress, recebe };
}

/** Troca o código de autorização pelo refresh token, grava o token cifrado e identifica o modo de leitura. */
export async function concluirAutorizacao(caixaId, code, { todas = false } = {}) {
  const caixa = get('SELECT * FROM caixas_email WHERE id = ?', [caixaId]);
  if (!caixa) throw new Error('Caixa não encontrada');
  const tokens = await postToken({ grant_type: 'authorization_code', code, redirect_uri: config.zoho.redirectUri });
  if (!tokens.refresh_token) throw new Error('Zoho não retornou refresh_token (verifique access_type=offline)');
  const ids = todas ? all("SELECT id FROM caixas_email WHERE provedor = 'zoho' AND ativo = 1").map((c) => c.id) : [caixa.id];
  if (!ids.includes(caixa.id)) ids.push(caixa.id);
  const resultados = [];
  for (const id of ids) {
    tokensEmMemoria.set(id, { token: tokens.access_token, expira: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 60000 });
    run('UPDATE caixas_email SET oauth_token_enc = ? WHERE id = ?', [cifrar(tokens.refresh_token), id]);
    try { resultados.push({ id, ...(await resolverConta(id)) }); } catch (e) {
      run("UPDATE caixas_email SET status = 'erro', ultimo_erro = ? WHERE id = ?", [e.message.slice(0, 500), id]);
      resultados.push({ id, erro: e.message });
    }
  }
  return todas ? resultados : resultados[0];
}

async function tokenAcesso(caixa) {
  const mem = tokensEmMemoria.get(caixa.id);
  if (mem && mem.expira > Date.now()) return mem.token;
  const atual = get('SELECT oauth_token_enc FROM caixas_email WHERE id = ?', [caixa.id]);
  if (!atual?.oauth_token_enc) throw new Error('Caixa não autorizada no Zoho');
  const tokens = await postToken({ grant_type: 'refresh_token', refresh_token: decifrar(atual.oauth_token_enc) });
  tokensEmMemoria.set(caixa.id, { token: tokens.access_token, expira: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 60000 });
  return tokens.access_token;
}

const desescapar = (s) => (s == null ? s : String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
function enderecadoA(m, email) {
  const alvo = email.toLowerCase();
  return `${desescapar(m.toAddress)},${desescapar(m.ccAddress)}`.toLowerCase().split(/[,;<>\s"]+/).includes(alvo);
}

// Pastas nunca lidas no modo membro (mensagens enviadas pelo próprio membro, rascunhos etc.).
const TIPOS_IGNORADOS = new Set(['Sent', 'Drafts', 'Outbox', 'Templates']);

function mensagemParaCaptura(caixa, conta, m, pastaNome) {
  return {
    idProvedor: String(m.messageId),
    internetMessageId: null,
    pasta: pastaNome,
    remetente: desescapar(m.fromAddress),
    remetenteNome: desescapar(m.sender),
    destinatarios: desescapar(m.toAddress),
    cc: desescapar(m.ccAddress),
    assunto: m.subject,
    data: new Date(Number(m.receivedTime)).toISOString(),
    carregarAnexos: async () => {
      const info = await apiZoho(caixa, `/accounts/${conta}/folders/${m.folderId}/messages/${m.messageId}/attachmentinfo`);
      return (info?.attachments ?? []).map((a) => ({
        nome: a.attachmentName, tamanho: Number(a.attachmentSize),
        baixar: () => apiZoho(caixa, `/accounts/${conta}/folders/${m.folderId}/messages/${m.messageId}/attachments/${a.attachmentId}`, { binario: true }),
      }));
    },
  };
}

/**
 * Itera sobre mensagens com anexo recebidas desde `desde` (Date).
 * Gera { idProvedor, internetMessageId, pasta, remetente, remetenteNome, destinatarios, cc, assunto, data, carregarAnexos() }.
 */
export async function* listarMensagens(caixa, desde) {
  const conta = caixa.provedor_conta_id;
  const pastas = await apiZoho(caixa, `/accounts/${conta}/folders`);
  const porId = new Map(pastas.map((p) => [String(p.folderId), p]));
  const limite = 200;

  if (caixa.filtro_destinatario) {
    // Modo membro: todas as pastas da conta, só o que foi endereçado à caixa compartilhada.
    // A listagem geral não vem estritamente ordenada entre pastas: para quando uma página inteira é anterior ao período.
    for (let inicio = 1, paginas = 0; paginas < 100; inicio += limite, paginas++) {
      const msgs = await apiZoho(caixa, `/accounts/${conta}/messages/view?start=${inicio}&limit=${limite}&sortorder=false&includeto=true`);
      if (!msgs?.length) break;
      let algumNoPeriodo = false;
      for (const m of msgs) {
        if (new Date(Number(m.receivedTime)) < desde) continue;
        algumNoPeriodo = true;
        const pasta = porId.get(String(m.folderId));
        if (TIPOS_IGNORADOS.has(pasta?.folderType)) continue;
        if (String(m.hasAttachment) !== '1' || !enderecadoA(m, caixa.email)) continue;
        yield mensagemParaCaptura(caixa, conta, m, pasta?.path ?? pasta?.folderName ?? String(m.folderId));
      }
      if (!algumNoPeriodo || msgs.length < limite) break;
    }
    return;
  }

  const desejadas = (JSON.parse(caixa.pastas || 'null') || ['Inbox']).map((p) => p.toLowerCase());
  const alvo = pastas.filter((p) => desejadas.includes(String(p.folderName).toLowerCase()) || desejadas.includes(String(p.path || '').toLowerCase().replace(/^\//, '')));
  for (const pasta of alvo) {
    for (let inicio = 1; ; inicio += limite) {
      const msgs = await apiZoho(caixa, `/accounts/${conta}/messages/view?folderId=${pasta.folderId}&start=${inicio}&limit=${limite}&sortorder=false&includeto=true`);
      if (!msgs?.length) break;
      let passouDoPeriodo = false;
      for (const m of msgs) {
        if (new Date(Number(m.receivedTime)) < desde) { passouDoPeriodo = true; break; }
        if (String(m.hasAttachment) !== '1') continue;
        yield mensagemParaCaptura(caixa, conta, { ...m, folderId: m.folderId ?? pasta.folderId }, pasta.folderName);
      }
      if (passouDoPeriodo || msgs.length < limite) break;
    }
  }
}
