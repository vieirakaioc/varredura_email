import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

const env = process.env;

function lista(v, padrao = []) {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : padrao;
}

const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || 'data');

/**
 * Chave que cifra o que é guardado no banco (senhas de certificados, tokens do Zoho).
 * Vem do APP_SECRET do .env; sem ele, é gerada uma vez e gravada em data/.app_secret. Antes era
 * sorteada a cada início, e o que tinha sido cifrado (ex.: senha do certificado) ficava ilegível
 * depois de reiniciar o servidor.
 */
function segredoDoApp() {
  if (env.APP_SECRET) return env.APP_SECRET;
  const arquivo = path.join(dataDir, '.app_secret');
  try {
    const salvo = fs.readFileSync(arquivo, 'utf8').trim();
    if (salvo) return salvo;
  } catch { /* ainda não existe */ }
  const novo = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(arquivo, novo, { mode: 0o600 });
    console.warn(`[config] APP_SECRET não definido no .env: gerado e guardado em ${arquivo} (faça backup da pasta data).`);
  } catch (e) {
    console.warn(`[config] APP_SECRET não definido e não consegui gravar ${arquivo} (${e.message}): o que for cifrado não será legível após reiniciar.`);
  }
  return novo;
}

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`,
  dataDir,
  appSecret: segredoDoApp(),
  sessaoHoras: Number(env.SESSAO_HORAS || 12),

  captura: {
    habilitada: env.CAPTURA_AUTOMATICA !== 'false',
    intervaloMin: Number(env.CAPTURA_INTERVALO_MIN || 10),
    diasRetroativos: Number(env.CAPTURA_DIAS_RETROATIVOS || 30),
    caixasPadrao: lista(env.CAIXAS_EMAIL, ['suprimentos@grupocomelli.com.br', 'suprimentos@comber.com.br']),
    pastaImportacao: env.PASTA_IMPORTACAO ? path.resolve(ROOT_DIR, env.PASTA_IMPORTACAO) : null,
  },

  zoho: {
    clientId: env.ZOHO_CLIENT_ID || '',
    clientSecret: env.ZOHO_CLIENT_SECRET || '',
    accountsUrl: env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
    mailApiUrl: env.ZOHO_MAIL_API_URL || 'https://mail.zoho.com',
    redirectUri: env.ZOHO_REDIRECT_URI || `${env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`}/api/oauth/zoho/callback`,
    // Somente leitura: o sistema nunca move, exclui ou marca e-mails.
    scopes: 'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ',
  },

  // IMAP é alternativa ao OAuth. Credenciais ficam apenas em variáveis de ambiente
  // (ex.: senha de aplicativo do Zoho), nunca no banco.
  imap: {
    host: env.IMAP_HOST || 'imap.zoho.com',
    port: Number(env.IMAP_PORT || 993),
  },

  ia: {
    habilitada: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && env.IA_HABILITADA !== 'false',
    modelo: env.IA_MODELO || 'claude-opus-5',
  },
};

export const paths = {
  db: path.join(config.dataDir, 'validador.db'),
  anexos: path.join(config.dataDir, 'anexos'),
  dados: config.dataDir,
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
};
