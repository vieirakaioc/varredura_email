// Cliente HTTP da API. O token de sessão fica no sessionStorage e vai sempre no header.
const CHAVE = 'vf_sessao';

export const sessao = {
  get() { try { return JSON.parse(sessionStorage.getItem(CHAVE)); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(CHAVE, JSON.stringify(v)); } catch { /* sem storage */ } },
  limpar() { try { sessionStorage.removeItem(CHAVE); } catch { /* sem storage */ } },
};

export class ErroApi extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function req(metodo, caminho, corpo, { bruto = false } = {}) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  let body;
  if (corpo instanceof FormData) body = corpo;
  else if (corpo !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(corpo); }
  const r = await fetch(`/api${caminho}`, { method: metodo, headers, body });
  if (r.status === 401 && !caminho.startsWith('/auth/login')) {
    sessao.limpar();
    window.dispatchEvent(new Event('sessao-expirada'));
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new ErroApi(j.erro || `Erro ${r.status}`, r.status);
  }
  // Qualquer gravação (conciliar, decidir, salvar configuração...) avisa as telas abertas para se atualizarem
  if (metodo !== 'GET' && !caminho.startsWith('/auth/') && caminho !== '/exportar') setTimeout(() => window.dispatchEvent(new Event('dados-alterados')), 0);
  return bruto ? r : r.json();
}

export const api = {
  get: (c) => req('GET', c),
  post: (c, b) => req('POST', c, b ?? {}),
  put: (c, b) => req('PUT', c, b ?? {}),
  upload: (c, formData) => req('POST', c, formData),
  del: (c) => req('DELETE', c),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * Exporta para Excel as linhas que estão na tela.
 * colunas: [{ titulo, valor: (linha) => any, tipo?: 'texto'|'moeda'|'numero'|'data' }]
 */
export async function exportarExcel(titulo, colunas, linhas) {
  const r = await req('POST', '/exportar', {
    titulo, colunas: colunas.map(({ titulo: t, tipo }) => ({ titulo: t, tipo })),
    linhas: linhas.map((l) => colunas.map((c) => { const v = c.valor(l); return v === undefined ? null : v; })),
  }, { bruto: true });
  const url = URL.createObjectURL(await r.blob());
  const nome = decodeURIComponent(r.headers.get('Content-Disposition')?.match(/filename="?([^"]+)"?/)?.[1] ?? 'exportacao.xlsx');
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Baixa um arquivo autenticado (o token nunca vai para a URL). */
export async function baixar(caminho, nomePadrao = 'arquivo', abrir = false) {
  const r = await req('GET', caminho, undefined, { bruto: true });
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  if (abrir) {
    window.open(url, '_blank', 'noopener');
  } else {
    const nome = decodeURIComponent(r.headers.get('Content-Disposition')?.match(/filename="?([^"]+)"?/)?.[1] ?? nomePadrao);
    const a = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
