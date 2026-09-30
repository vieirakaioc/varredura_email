// Cache em memória das consultas ao Senior.
//
// As telas leem as linhas uma vez e aplicam os filtros (empresa, situação, espécie, fornecedor)
// sobre elas: só o período muda o SQL. Sem isso, cada troca de filtro refazia uma consulta de
// 2 a 6 segundos no banco do ERP. Guardamos a promessa, e não o resultado, para que chamadas
// simultâneas iguais esperem a mesma consulta em vez de abrirem outra conexão.
//
// Ninguém deve esperar o banco ao abrir uma tela já usada:
//  - vencido o prazo (ttl), devolvemos na hora o que temos e buscamos o novo por baixo;
//  - consultas usadas nas últimas 2 horas são renovadas sozinhas em segundo plano ao vencer,
//    então quem volta à tela já encontra o dado atualizado. Sem uso, param de ser renovadas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const entradas = new Map();
const LIMITE = 24;
// Passado esse tempo sem renovação, a próxima consulta espera pelo banco em vez de devolver algo velho
const TOLERADO = 60 * 60_000;
// Consultas usadas há menos que isso continuam sendo renovadas em segundo plano
const EM_USO = 2 * 3600_000;

// Cópia em disco do último resultado de cada consulta: depois de reiniciar o servidor (ou de uma
// atualização), a tela abre na hora com ela enquanto a consulta nova roda por baixo.
const PASTA = path.join(config.dataDir, 'cache-senior');
const DISCO_VALIDO = 24 * 3600_000;
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
    if (bruto.chave !== chave || Date.now() - bruto.em > DISCO_VALIDO) return null;
    return bruto;
  } catch { return null; }
}

function renovar(chave, atual) {
  if (atual.renovando) return;
  atual.renovando = true;
  Promise.resolve()
    .then(atual.consulta)
    .then((novo) => {
      // só substitui se ninguém tiver trocado a entrada enquanto isso (ex.: "Atualizar")
      if (entradas.get(chave) === atual) {
        entradas.set(chave, { ...atual, em: Date.now(), valor: Promise.resolve(novo), renovando: false });
        gravarDisco(chave, novo);
      }
    })
    .catch(() => { atual.renovando = false; });
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
    const idade = agora - atual.em;
    if (idade < ttlMs) return atual.valor;
    if (idade < TOLERADO) {
      // Já passou do prazo, mas ainda é recente: devolve o que temos e busca o novo por baixo
      renovar(chave, atual);
      return atual.valor;
    }
  }

  // Primeira vez desde que o servidor subiu: usa a cópia em disco (se recente) e renova por baixo
  if (!atual && ttlMs > 0) {
    const disco = lerDisco(chave);
    if (disco) {
      const entrada = { em: disco.em, usado: agora, ttl: ttlMs, valor: Promise.resolve(disco.valor), consulta, renovando: false };
      entradas.set(chave, entrada);
      if (agora - disco.em >= ttlMs) renovar(chave, entrada);
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

// Renovação em segundo plano das consultas em uso (uma por vez, para não sobrecarregar o banco do ERP)
setInterval(() => {
  const agora = Date.now();
  const vencida = [...entradas.entries()]
    .filter(([, e]) => !e.renovando && agora - e.usado < EM_USO && agora - e.em >= e.ttl)
    .sort((a, b) => b[1].usado - a[1].usado)[0];
  if (vencida) renovar(vencida[0], vencida[1]);
}, 20_000).unref();

/** Minuto da data, para a chave do cache não mudar a cada milissegundo quando o fim do período é "agora". */
export const ateOMinuto = (d) => new Date(d).toISOString().slice(0, 16);

export function limparCache() { entradas.clear(); }
