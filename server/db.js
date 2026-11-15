'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Тонкий слой доступа к данным поверх встроенного node:sqlite.
 * Все значения передаются только параметрами (защита от SQL-инъекций), undefined заменяется на null.
 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  // lower() в SQLite не понимает кириллицу — регистрируем свою функцию для регистронезависимого поиска.
  raw.function('lc', { deterministic: true }, (v) => (v === null || v === undefined ? null : String(v).toLowerCase()));

  const cache = new Map();
  const prepare = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = raw.prepare(sql);
      if (cache.size > 300) cache.clear();
      cache.set(sql, st);
    }
    return st;
  };
  const norm = (params) => params.map((p) => (p === undefined ? null : p));

  const db = {
    raw,
    get: (sql, ...params) => prepare(sql).get(...norm(params)),
    all: (sql, ...params) => prepare(sql).all(...norm(params)),
    run: (sql, ...params) => prepare(sql).run(...norm(params)),
    exec: (sql) => raw.exec(sql),
    /** Транзакция (без вложенности). Откатывается при любом исключении. */
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* уже откатилась */ }
        throw err;
      }
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
  return db;
}

/** Применяет SQL-файлы из каталога migrations по порядку имён; применённые пропускает. */
function migrate(db, dir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const done = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.tx(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', file);
    });
    done.push(file);
  }
  return done;
}

module.exports = { openDatabase, migrate };
