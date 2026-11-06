// Amplia o CHECK de perfis em bases existentes sem mudar ids, sessões ou referências.
export function garantirPerfilMembro(db) {
  const tabela = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'usuarios'").get();
  const check = tabela?.sql.match(/CHECK\s*\(\s*perfil\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (!check || /'membro'/i.test(check[1])) return false;
  const criacao = tabela.sql.replace(check[0], `CHECK (perfil IN (${check[1]},'membro'))`)
    .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:usuarios|"usuarios"|\[usuarios\]|`usuarios`)/i, 'CREATE TABLE usuarios_perfil_migracao');
  if (criacao === tabela.sql || !criacao.includes('CREATE TABLE usuarios_perfil_migracao')) throw new Error('Não foi possível preparar a migração de perfis');
  const colunas = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => `"${c.name.replaceAll('"','""')}"`).join(',');
  const objetos = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'usuarios' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  const fk = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(criacao);
      db.exec(`INSERT INTO usuarios_perfil_migracao (${colunas}) SELECT ${colunas} FROM usuarios`);
      db.exec('DROP TABLE usuarios');
      db.exec('ALTER TABLE usuarios_perfil_migracao RENAME TO usuarios');
      for (const o of objetos) db.exec(o.sql);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('A migração de perfis encontrou referências inválidas');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec(`PRAGMA foreign_keys = ${fk ? 'ON' : 'OFF'}`); }
  return true;
}
