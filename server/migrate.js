'use strict';
const { loadConfig } = require('./config');
const { openDatabase, migrate } = require('./db');

const config = loadConfig();
const db = openDatabase(config.databasePath);
const done = migrate(db, config.migrationsDir);
console.log(done.length ? `Применены миграции: ${done.join(', ')}` : 'База данных актуальна, новых миграций нет.');
console.log(`Файл базы данных: ${config.databasePath}`);
db.close();
