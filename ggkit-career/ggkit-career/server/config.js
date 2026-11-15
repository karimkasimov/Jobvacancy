'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Минимальный разбор .env (без внешних зависимостей). Реальные переменные окружения приоритетнее. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const toBool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function loadConfig(overrides = {}) {
  const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const port = toInt(env.PORT, 3000);

  const config = {
    root: ROOT,
    nodeEnv,
    isProduction,
    host: env.HOST || '127.0.0.1',
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    publicDir: path.join(ROOT, 'public'),
    migrationsDir: path.join(ROOT, 'migrations'),
    databasePath: path.resolve(ROOT, env.DATABASE_PATH || 'data/ggkit.sqlite'),
    uploadDir: path.resolve(ROOT, env.UPLOAD_DIR || 'uploads'),
    maxUploadBytes: toInt(env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
    maxLogoBytes: 1024 * 1024,
    sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 24 * 7),
    cookieName: 'ggkit_sid',
    cookieSecure: toBool(env.COOKIE_SECURE, isProduction),
    trustProxy: toBool(env.TRUST_PROXY, false),
    passwordMinLength: 8,
    scrypt: { N: toInt(env.SCRYPT_COST, 32768), r: 8, p: 1 },
    loginMaxFailures: 5,
    loginLockMinutes: 15,
    resetTokenMinutes: 60,
    mail: {
      provider: env.MAIL_PROVIDER || 'none', // none | console | webhook
      from: env.MAIL_FROM || '',
      webhookUrl: env.MAIL_WEBHOOK_URL || '',
      webhookToken: env.MAIL_WEBHOOK_TOKEN || '',
    },
    // Ограничения частоты запросов: { limit, windowMs } на IP
    rateLimits: {
      api: { limit: 600, windowMs: 60_000 },
      login: { limit: 10, windowMs: 15 * 60_000 },
      register: { limit: 10, windowMs: 60 * 60_000 },
      forgot: { limit: 5, windowMs: 60 * 60_000 },
      upload: { limit: 30, windowMs: 60 * 60_000 },
      verification: { limit: 10, windowMs: 60 * 60_000 },
    },
  };

  const merged = { ...config, ...overrides };
  merged.scrypt = { ...config.scrypt, ...(overrides.scrypt || {}) };
  merged.mail = { ...config.mail, ...(overrides.mail || {}) };
  merged.rateLimits = { ...config.rateLimits, ...(overrides.rateLimits || {}) };
  return merged;
}

module.exports = { loadConfig, ROOT };
