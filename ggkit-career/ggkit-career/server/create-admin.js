'use strict';
const { loadConfig } = require('./config');
const { openDatabase, migrate } = require('./db');
const S = require('./lib/security');
const V = require('./lib/validate');

/**
 * Создаёт (или обновляет пароль у) администратора.
 * Данные берутся из ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME. Если пароль не задан, генерируется временный
 * и при первом входе потребуется его сменить. Пароли в репозитории не хранятся.
 */
async function ensureAdmin(db, config, { email, fullName, password }) {
  const cleanEmail = V.email()(email);
  const generated = !password;
  const plain = password || S.temporaryPassword();
  if (!generated) V.password(config.passwordMinLength)(plain);
  const hash = await S.hashPassword(plain, config.scrypt);
  const existing = db.get('SELECT id, role FROM users WHERE email = ?', cleanEmail);
  if (existing && existing.role !== 'admin') throw new Error(`Пользователь ${cleanEmail} уже существует и не является администратором.`);
  if (existing) {
    db.run("UPDATE users SET password_hash = ?, must_change_password = ?, status = 'active', failed_logins = 0, locked_until = NULL WHERE id = ?", hash, generated ? 1 : 0, existing.id);
  } else {
    db.run("INSERT INTO users (email, password_hash, role, full_name, must_change_password) VALUES (?, ?, 'admin', ?, ?)", cleanEmail, hash, fullName || 'Администратор портала', generated ? 1 : 0);
  }
  return { email: cleanEmail, password: generated ? plain : null, generated, created: !existing };
}

async function main() {
  const config = loadConfig();
  const env = process.env;
  const email = env.ADMIN_EMAIL || process.argv[2];
  if (!email) {
    console.error('Укажите email администратора: ADMIN_EMAIL=admin@example.ru npm run create-admin\n(необязательно: ADMIN_PASSWORD, ADMIN_NAME)');
    process.exit(1);
  }
  const db = openDatabase(config.databasePath);
  migrate(db, config.migrationsDir);
  try {
    const r = await ensureAdmin(db, config, { email, fullName: env.ADMIN_NAME, password: env.ADMIN_PASSWORD });
    console.log(`${r.created ? 'Создан' : 'Обновлён'} администратор: ${r.email}`);
    if (r.generated) console.log(`Временный пароль (показывается один раз, при входе потребуется смена): ${r.password}`);
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { ensureAdmin };
