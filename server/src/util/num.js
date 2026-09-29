/** Converte número vindo de XML/PDF (aceita "1.234,56" e "1234.56"). */
export function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[R$\s]/g, '');
  if (/,\d{1,4}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const soma = (arr, fn) => arr.reduce((acc, x) => acc + (Number(fn(x)) || 0), 0);
export const quaseIgual = (a, b, tol = 0.02) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol;
export const soDigitos = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));

export const brl = (v) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const pct = (v) => v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
