// Calendário de dias úteis para a meta de lançamento.
//
// A meta só pode ser cobrada em dia trabalhado. Fim de semana já saía pela jornada
// (dias_semana de cada pessoa); feriado não saía — um mês com três feriados cobrava meta cheia
// de quem não trabalhou nesses dias. Aqui ficam os feriados.
//
// Os nacionais são calculados, não cadastrados: fixos por lei e os móveis derivados da Páscoa.
// Feriado estadual, municipal e recesso da empresa variam demais para adivinhar — esses entram
// pela configuração das metas (campo "feriados"), e qualquer data da lista automática pode ser
// desligada em "feriados_ignorados" quando a empresa trabalha nela.

const dataIso = (d) => d.toISOString().slice(0, 10);
const somarDias = (iso, n) => dataIso(new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000));

/** Domingo de Páscoa do ano, pelo algoritmo de Meeus/Butcher (calendário gregoriano). */
export function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Fixos por lei federal. Consciência Negra é nacional desde a Lei 14.759/2023.
const FIXOS = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Consciência Negra'],
  ['12-25', 'Natal'],
];

/**
 * Feriados nacionais do ano: data ISO → { nome, tipo }.
 * tipo 'nacional' = feriado por lei; 'facultativo' = ponto facultativo em que o escritório
 * costuma fechar (Carnaval e Corpus Christi). Os facultativos entram por padrão porque na
 * prática ninguém lança nota neles; para cobrar meta neles, basta ignorá-los na configuração.
 */
export function feriadosNacionais(ano) {
  const p = pascoa(ano);
  const lista = [
    ...FIXOS.map(([md, nome]) => [`${ano}-${md}`, { nome, tipo: 'nacional' }]),
    [somarDias(p, -2), { nome: 'Sexta-feira Santa', tipo: 'nacional' }],
    [somarDias(p, -48), { nome: 'Carnaval (segunda)', tipo: 'facultativo' }],
    [somarDias(p, -47), { nome: 'Carnaval (terça)', tipo: 'facultativo' }],
    [somarDias(p, 60), { nome: 'Corpus Christi', tipo: 'facultativo' }],
  ];
  return new Map(lista.sort((a, b) => a[0].localeCompare(b[0])));
}

// Só aceita data real: o formato certo não basta, '2026-13-99' tem a cara de data e não existe.
export const dataFeriado = (v) => {
  const d = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(t.getTime()) || dataIso(t) !== d ? null : d;
};
const iso = dataFeriado;

/**
 * Monta o calendário em vigor a partir da configuração das metas.
 *   extras    = feriados da empresa: estadual, municipal, recesso. ['2026-06-24', ...] ou
 *               { '2026-06-24': 'São João' }
 *   ignorados = datas da lista automática em que a empresa trabalha
 *
 * Devolve `feriadoEm(dia)` (→ { nome, tipo } ou null) e `doAno(ano)` para a tela listar.
 * O ano é calculado uma vez só e guardado: a meta percorre centenas de dias por consulta.
 */
export function calendarioFeriados({ extras, ignorados } = {}) {
  const nomeExtra = new Map(Array.isArray(extras)
    ? extras.map((d) => [iso(d), null]).filter(([d]) => d)
    : Object.entries(extras ?? {}).map(([d, n]) => [iso(d), String(n ?? '').trim() || null]).filter(([d]) => d));
  const fora = new Set((ignorados ?? []).map(iso).filter(Boolean));
  const cache = new Map();
  const doAno = (ano) => {
    if (cache.has(ano)) return cache.get(ano);
    const m = new Map();
    for (const [dia, f] of feriadosNacionais(ano)) if (!fora.has(dia)) m.set(dia, f);
    for (const [dia, nome] of nomeExtra) {
      if (dia.slice(0, 4) === String(ano) && !fora.has(dia)) m.set(dia, { nome: nome ?? 'Feriado da empresa', tipo: 'empresa' });
    }
    cache.set(ano, m);
    return m;
  };
  return {
    doAno,
    extras: [...nomeExtra].map(([dia, nome]) => ({ dia, nome })).sort((a, b) => a.dia.localeCompare(b.dia)),
    ignorados: [...fora].sort(),
    feriadoEm: (dia) => {
      const d = iso(dia);
      return d ? doAno(Number(d.slice(0, 4))).get(d) ?? null : null;
    },
  };
}
