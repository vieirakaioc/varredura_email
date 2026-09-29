import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config, paths } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(paths.anexos, { recursive: true });

export const db = new DatabaseSync(paths.db);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

// Migrações simples: colunas acrescentadas depois da criação do banco.
function garantirColuna(tabela, coluna, definicao) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
// Caixa compartilhada lida pela conta de um membro: e-mail da conta autorizada + filtro por destinatário.
garantirColuna('caixas_email', 'conta_autorizada', 'TEXT');
garantirColuna('caixas_email', 'filtro_destinatario', 'INTEGER NOT NULL DEFAULT 0');
// NFS-e: valor líquido a pagar e total de retenções (ISS retido, IRRF, INSS, PIS/COFINS/CSLL)
garantirColuna('documentos', 'v_liquido', 'REAL');
garantirColuna('documentos', 'v_retencoes', 'REAL');
// Conciliação com o Senior (notas de entrada lançadas)
garantirColuna('documentos', 'senior_status', 'TEXT');        // lancada | nao_lancada | null (não verificado)
garantirColuna('documentos', 'senior_ref', 'TEXT');
garantirColuna('documentos', 'senior_data_entrada', 'TEXT');
garantirColuna('documentos', 'senior_verificado_em', 'TEXT');
garantirColuna('documentos', 'oc_documento', 'TEXT');   // ordem de compra citada na nota
garantirColuna('documentos', 'senior_ocs', 'TEXT');     // JSON: OCs do Senior (da nota lançada ou em aberto do fornecedor)
garantirColuna('dfe_controle', 'ultimo_aviso', 'TEXT'); // 656 da SEFAZ (janela de 1 hora), separado dos erros

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    s.setAllowUnknownNamedParameters(true); // permite reutilizar o mesmo objeto de filtros em várias consultas
    cache.set(sql, s);
  }
  return s;
}

// node:sqlite não aceita undefined nem boolean como parâmetro.
function norm(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(normValor);
  const o = {};
  for (const [k, v] of Object.entries(params)) o[k] = normValor(v);
  return [o];
}
function normValor(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export const all = (sql, params) => stmt(sql).all(...norm(params));
export const get = (sql, params) => stmt(sql).get(...norm(params));
export const run = (sql, params) => stmt(sql).run(...norm(params));

/** Insere um objeto em uma tabela e devolve o id. */
export function insert(tabela, obj) {
  const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = `INSERT INTO ${tabela} (${cols.join(',')}) VALUES (${cols.map((c) => ':' + c).join(',')})`;
  const o = {};
  for (const c of cols) o[c] = obj[c];
  return Number(run(sql, o).lastInsertRowid);
}

export function update(tabela, id, obj) {
  const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!cols.length) return;
  const o = { __id: id };
  for (const c of cols) o[c] = obj[c];
  run(`UPDATE ${tabela} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :__id`, o);
}

let profundidade = 0;
/** Transação reentrante (savepoints em chamadas aninhadas). */
export function tx(fn) {
  const sp = `sp${profundidade}`;
  db.exec(profundidade === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  profundidade++;
  try {
    const r = fn();
    profundidade--;
    db.exec(profundidade === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    profundidade--;
    db.exec(profundidade === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function getConfig(chave, padrao = null) {
  const r = get('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
  if (!r) return padrao;
  try { return JSON.parse(r.valor); } catch { return r.valor; }
}
export function setConfig(chave, valor) {
  run('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
    [chave, JSON.stringify(valor)]);
}

export function parseJSON(v, padrao = null) {
  if (v == null || v === '') return padrao;
  try { return JSON.parse(v); } catch { return padrao; }
}
