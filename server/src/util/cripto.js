import crypto from 'node:crypto';
import { config } from '../config.js';

const chave = () => crypto.createHash('sha256').update(`tokens:${config.appSecret}`).digest();

/** AES-256-GCM. Usado para o refresh token OAuth (nenhuma senha de e-mail é armazenada). */
export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join('.');
}

export function decifrar(pacote) {
  const [v, iv, tag, dados] = String(pacote).split('.');
  if (v !== 'v1') throw new Error('Formato de token cifrado desconhecido');
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
}

export const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const tokenAleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Estado assinado (HMAC) para o fluxo OAuth. */
export function assinarEstado(obj) {
  const corpo = Buffer.from(JSON.stringify({ ...obj, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.appSecret).update(corpo).digest('base64url');
  return `${corpo}.${sig}`;
}
export function verificarEstado(estado, validadeMs = 15 * 60 * 1000) {
  const [corpo, sig] = String(estado || '').split('.');
  const esperado = crypto.createHmac('sha256', config.appSecret).update(corpo || '').digest('base64url');
  if (!sig || sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) throw new Error('Estado OAuth inválido');
  const obj = JSON.parse(Buffer.from(corpo, 'base64url').toString());
  if (Date.now() - obj.t > validadeMs) throw new Error('Estado OAuth expirado');
  return obj;
}
