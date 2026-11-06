// Cache em memória das consultas ao Senior.
//
// As telas leem as linhas uma vez e aplicam os filtros (empresa, situação, espécie, fornecedor)
// sobre elas: só o período muda o SQL. Sem isso, cada troca de filtro refazia uma consulta de
// 2 a 6 segundos no banco do ERP. Guardamos a promessa, e não o resultado, para que chamadas
// simultâneas iguais esperem a mesma consulta em vez de abrirem outra conexão.
//
// Resultados existentes são reutilizados até o botão Atualizar (ttlMs = 0).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const entradas = new Map();
const LIMITE = 24;
const PASTA = path.join(config.dataDir, 'cache-senior');
const arquivo = (chave) => path.join(PASTA, `${crypto.createHash('sha1').update(chave).digest('hex')}.json`);
const DATA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function gravarDisco(chave, valor) {
  fs.promises.mkdir(PASTA, { recursive: true })
    .then(() => fs.promises.writeFile(arquivo(chave), JSON.stringify({ chave, em: Date.now(), valor })))
    .catch(() => {}); // sem disco, segue só com a memória
}
function lerDisco(chave) {
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivo(chave), 'utf8'), (k, v) => (typeof v === 'string' && DATA_ISO.test(v) ? new Date(v) : v));
    if (bruto.chave !== chave) return null;
    return bruto;
  } catch { return null; }
}

/**
 * Executa `consulta` guardando o resultado por `ttlMs`. Com ttlMs = 0 a consulta é sempre refeita
 * (é o que o botão "Atualizar" das telas faz) e o valor guardado é substituído.
 */
export async function comCache(chave, ttlMs, consulta) {
  const agora = Date.now();
  const atual = entradas.get(chave);
  if (atual && ttlMs > 0) {
    atual.usado = agora;
    atual.consulta = consulta;
    return atual.valor;
  }

  // Primeira vez desde que o servidor subiu: usa a última cópia em disco sem renovar
  if (!atual && ttlMs > 0) {
    const disco = lerDisco(chave);
    if (disco) {
      const entrada = { em: disco.em, usado: agora, ttl: ttlMs, valor: Promise.resolve(disco.valor), consulta, renovando: false };
      entradas.set(chave, entrada);
      return entrada.valor;
    }
  }

  const valor = consulta();
  entradas.set(chave, { em: agora, usado: agora, ttl: ttlMs || 60_000, valor, consulta, renovando: false });
  valor.then((v) => { if (entradas.get(chave)?.valor === valor) gravarDisco(chave, v); }).catch(() => {});
  if (entradas.size > LIMITE) {
    // sai a que está há mais tempo sem uso
    const [menosUsada] = [...entradas.entries()].filter(([k]) => k !== chave).sort((a, b) => a[1].usado - b[1].usado);
    if (menosUsada) entradas.delete(menosUsada[0]);
  }
  try {
    return await valor;
  } catch (e) {
    entradas.delete(chave);  // erro não fica guardado: a próxima tentativa vai ao banco
    throw e;
  }
}

/** Minuto da data, para a chave do cache não mudar a cada milissegundo quando o fim do período é "agora". */
export const ateOMinuto = (d) => new Date(d).toISOString().slice(0, 16);

export function limparCache() { entradas.clear(); }

/**
 * Marca curta do SQL, para entrar na chave do cache: mudou a consulta (uma coluna nova, por exemplo),
 * a chave muda e o resultado antigo — inclusive a cópia em disco — deixa de ser usado.
 */
export const versaoSql = (sql) => crypto.createHash('sha1').update(String(sql)).digest('hex').slice(0, 8);
