// Cache em memória das consultas ao Senior.
//
// As telas leem as linhas uma vez e aplicam os filtros (empresa, situação, espécie, fornecedor)
// sobre elas: só o período muda o SQL. Sem isso, cada troca de filtro refazia uma consulta de
// 2 a 6 segundos no banco do ERP. Guardamos a promessa, e não o resultado, para que chamadas
// simultâneas iguais esperem a mesma consulta em vez de abrirem outra conexão.
//
// Ninguém deve esperar o banco ao abrir uma tela já usada:
//  - vencido o prazo (ttl), devolvemos na hora o que temos e buscamos o novo por baixo;
//  - consultas usadas nos últimos 30 minutos são renovadas sozinhas em segundo plano ao vencer,
//    então quem volta à tela já encontra o dado atualizado. Sem uso, param de ser renovadas.
const entradas = new Map();
const LIMITE = 24;
// Passado esse tempo sem renovação, a próxima consulta espera pelo banco em vez de devolver algo velho
const TOLERADO = 60 * 60_000;
// Consultas usadas há menos que isso continuam sendo renovadas em segundo plano
const EM_USO = 30 * 60_000;

function renovar(chave, atual) {
  if (atual.renovando) return;
  atual.renovando = true;
  Promise.resolve()
    .then(atual.consulta)
    .then((novo) => {
      // só substitui se ninguém tiver trocado a entrada enquanto isso (ex.: "Atualizar")
      if (entradas.get(chave) === atual) entradas.set(chave, { ...atual, em: Date.now(), valor: Promise.resolve(novo), renovando: false });
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

  const valor = consulta();
  entradas.set(chave, { em: agora, usado: agora, ttl: ttlMs || 60_000, valor, consulta, renovando: false });
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
