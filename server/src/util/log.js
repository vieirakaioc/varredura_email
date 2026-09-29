import { run } from '../db/index.js';

/** Log técnico do processamento (captura, parser, IA...). */
export function log(nivel, modulo, mensagem, contexto) {
  const linha = `[${new Date().toISOString()}] ${nivel.toUpperCase()} ${modulo}: ${mensagem}`;
  (nivel === 'erro' ? console.error : console.log)(linha);
  try {
    run('INSERT INTO logs_processamento (nivel, modulo, mensagem, contexto) VALUES (?,?,?,?)',
      [nivel, modulo, mensagem, contexto ? JSON.stringify(contexto) : null]);
  } catch { /* não interrompe o fluxo por falha de log */ }
}

/** Trilha de auditoria de ações de usuários. */
export function auditar(usuarioId, acao, entidade, entidadeId, detalhes, ip) {
  run('INSERT INTO logs_auditoria (usuario_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?,?,?,?,?,?)',
    [usuarioId ?? null, acao, entidade ?? null, entidadeId != null ? String(entidadeId) : null,
      detalhes ? JSON.stringify(detalhes) : null, ip ?? null]);
}
