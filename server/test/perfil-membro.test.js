import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { garantirPerfilMembro } from '../src/db/perfil-membro.js';

test('migração preserva colunas adicionais, índices, triggers e unicidade; segunda execução não reconstrói', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE usuarios(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        perfil TEXT CHECK (perfil IN ('admin','fiscal')), extra TEXT DEFAULT 'mantido');
      CREATE INDEX ix_usuario_extra ON usuarios(extra);
      CREATE TABLE eventos(texto TEXT);
      CREATE TRIGGER usuario_log AFTER INSERT ON usuarios BEGIN INSERT INTO eventos VALUES(new.email); END;
      CREATE TABLE filhos(id INTEGER PRIMARY KEY, usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE);
      INSERT INTO usuarios VALUES(5,'ADMIN@teste','admin','original'); INSERT INTO filhos VALUES(7,5);`);
    assert.equal(garantirPerfilMembro(db), true);
    assert.equal(db.prepare('SELECT extra FROM usuarios WHERE id=5').get().extra, 'original');
    assert.equal(db.prepare('SELECT usuario_id FROM filhos').get().usuario_id, 5);
    assert.equal(db.prepare('PRAGMA foreign_key_list(filhos)').get().table, 'usuarios');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='ix_usuario_extra'").get());
    db.exec("INSERT INTO usuarios(id,email,perfil) VALUES(6,'membro@teste','membro')");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eventos').get().n, 2);
    assert.throws(() => db.exec("INSERT INTO usuarios(id,email,perfil) VALUES(8,'admin@TESTE','membro')"), /UNIQUE/);
    assert.equal(garantirPerfilMembro(db), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('falha de integridade reverte a migração inteira e restaura a verificação de referências', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE usuarios(id INTEGER PRIMARY KEY, perfil TEXT CHECK (perfil IN ('admin','fiscal')));
      CREATE TABLE filhos(usuario_id INTEGER REFERENCES usuarios(id));
      INSERT INTO usuarios VALUES(1,'admin'); INSERT INTO filhos VALUES(999); PRAGMA foreign_keys=ON;`);
    assert.throws(() => garantirPerfilMembro(db), /referências inválidas/);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('SELECT perfil FROM usuarios').get().perfil, 'admin');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='usuarios_perfil_migracao'").get(), undefined);
    assert.throws(() => db.exec("INSERT INTO usuarios VALUES(2,'membro')"), /CHECK/);
  } finally { db.close(); }
});
