// Cache curto, em memória, das consultas ao Senior.
//
// As telas leem as linhas uma vez e aplicam os filtros (empresa, situação, espécie, fornecedor)
// sobre elas: só o período muda o SQL. Sem isso, cada troca de filtro refazia uma consulta de
// 2 a 6 segundos no banco do ERP. Guardamos a promessa, e não o resultado, para que chamadas
// simultâneas iguais esperem a mesma consulta em vez de abrirem outra conexão.
const entradas = new Map();
const LIMITE = 6;
// Passado esse tempo sem uso, a próxima consulta espera pelo banco em vez de devolver algo velho
const TOLERADO = 10 * 60_000;

/**
 * Executa `consulta` guardando o resultado por `ttlMs`. Com ttlMs = 0 a consulta é sempre refeita
 * (é o que o botão "Atualizar" das telas faz) e o valor guardado é substituído.
 */
export async function comCache(chave, ttlMs, consulta) {
  const agora = Date.now();
  const atual = entradas.get(chave);
  if (atual && ttlMs > 0) {
    const idade = agora - atual.em;
    if (idade < ttlMs) return atual.valor;
    if (idade < TOLERADO && !atual.renovando) {
      // Já passou do prazo, mas ainda é recente: devolve o que temos e busca o novo por baixo,
      // para quem estiver mexendo nos filtros não esperar o banco.
      atual.renovando = true;
      Promise.resolve()
        .then(consulta)
        .then((novo) => entradas.set(chave, { em: Date.now(), valor: Promise.resolve(novo) }))
        .catch(() => { atual.renovando = false; });
      return atual.valor;
    }
  }

  const valor = consulta();
  entradas.set(chave, { em: agora, valor });
  if (entradas.size > LIMITE) {
    const [maisAntiga] = [...entradas.entries()].sort((a, b) => a[1].em - b[1].em);
    if (maisAntiga && maisAntiga[0] !== chave) entradas.delete(maisAntiga[0]);
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
