'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./config');
const { openDatabase, migrate } = require('./db');
const { ApiError, forbidden, notFound } = require('./lib/errors');
const H = require('./lib/http');
const { sha256, safeEqual } = require('./lib/security');
const { RateLimiter } = require('./lib/rateLimit');
const { Router } = require('./lib/router');
const { createMailer } = require('./lib/mailer');
const { parseMultipart } = require('./lib/uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Красивые адреса страниц → HTML-файлы. Идентификатор вакансии/организации читает JS страницы из URL.
const PAGE_ROUTES = [
  [/^\/$/, 'index.html'],
  [/^\/vacancies\/?$/, 'vacancies.html'],
  [/^\/vacancies\/\d+\/?$/, 'vacancy-details.html'],
  [/^\/partners\/?$/, 'partners.html'],
  [/^\/partners\/\d+\/?$/, 'partner.html'],
  [/^\/(cabinet|employer|admin|login|register|forgot-password|reset-password|help)\/?$/, null],
];

const MUST_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password']);

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = overrides.db || openDatabase(config.databasePath);
  migrate(db, config.migrationsDir);
  const mailer = createMailer(config);
  const limiter = new RateLimiter();
  const router = new Router();
  const deps = { config, db, mailer, limiter };

  for (const name of ['auth', 'account', 'public', 'candidate', 'applications', 'employer', 'admin']) {
    require(`./routes/${name}`).register(router, deps);
  }

  const baseHeaders = H.securityHeaders(config);

  function loadSession(req) {
    const token = H.parseCookies(req.headers.cookie)[config.cookieName];
    if (!token || token.length > 100) return { user: null, session: null };
    const row = db.get(
      `SELECT s.id AS sid, s.csrf_token, s.expires_at, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      sha256(token),
    );
    if (!row) return { user: null, session: null };
    if (row.expires_at <= new Date().toISOString() || row.status !== 'active') {
      db.run('DELETE FROM sessions WHERE id = ?', row.sid);
      return { user: null, session: null };
    }
    if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60_000) {
      db.run("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", row.sid);
    }
    const { sid, csrf_token, expires_at, last_seen_at, password_hash, failed_logins, locked_until, ...user } = row;
    return { user, session: { id: sid, csrfToken: csrf_token, expiresAt: expires_at } };
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { throw forbidden('Недопустимый источник запроса.', 'bad_origin'); }
    if (host !== req.headers.host) throw forbidden('Недопустимый источник запроса.', 'bad_origin');
  }

  function checkRate(group, ip) {
    const rule = config.rateLimits[group];
    if (!rule) return;
    const r = limiter.hit(`${group}:${ip}`, rule);
    if (!r.allowed) {
      const err = new ApiError(429, 'rate_limited', 'Слишком много запросов. Повторите попытку позже.');
      err.retryAfter = r.retryAfterSeconds;
      throw err;
    }
  }

  async function handleApi(req, res, url, ip) {
    const method = req.method;
    const matched = router.match(method === 'HEAD' ? 'GET' : method, url.pathname);
    if (!matched) throw notFound('Метод API не найден.');
    if (matched.methodNotAllowed) throw new ApiError(405, 'method_not_allowed', 'Метод не поддерживается.');

    const { route, params } = matched;
    checkRate('api', ip);
    if (route.options.limit) checkRate(route.options.limit, ip);

    const { user, session } = loadSession(req);
    const ctx = {
      req, res, method, pathname: url.pathname, params, ip, user, session,
      query: Object.fromEntries(url.searchParams), body: {}, status: 200, cookies: [], handled: false,
      setCookie(c) { this.cookies.push(c); },
      sendRaw(status, buffer, headers = {}) {
        this.handled = true;
        const extra = this.cookies.length ? { 'Set-Cookie': this.cookies } : {};
        res.writeHead(status, { ...baseHeaders, 'Content-Length': buffer.length, ...extra, ...headers });
        res.end(method === 'HEAD' ? undefined : buffer);
      },
      async readMultipart(maxBytes) {
        const buf = await H.readBody(req, maxBytes + 65536);
        return parseMultipart(buf, req.headers['content-type']);
      },
    };

    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (unsafe) {
      checkOrigin(req);
      const type = String(req.headers['content-type'] || '').toLowerCase();
      const hasBody = parseInt(req.headers['content-length'] || '0', 10) > 0 || req.headers['transfer-encoding'];
      if (route.options.multipart) {
        if (!type.startsWith('multipart/form-data')) throw new ApiError(415, 'unsupported_media_type', 'Ожидается отправка файла (multipart/form-data).');
      } else if (hasBody) {
        if (!type.startsWith('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Ожидается JSON.');
        const raw = await H.readBody(req, 1024 * 1024);
        try { ctx.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new ApiError(400, 'invalid_json', 'Некорректный JSON в теле запроса.'); }
      }
      // CSRF: для авторизованных запросов обязателен токен сессии. Публичные формы входа защищены проверкой Origin и типом контента.
      if (ctx.user && route.options.csrf !== false) {
        const sent = req.headers['x-csrf-token'];
        if (!sent || !safeEqual(sent, ctx.session.csrfToken)) throw forbidden('Недействительный токен защиты формы. Обновите страницу.', 'csrf');
      }
    }

    if (ctx.user && ctx.user.must_change_password && !MUST_CHANGE_ALLOWED.has(url.pathname)) {
      throw forbidden('Необходимо сменить временный пароль.', 'password_change_required');
    }

    const handlers = route.handlers;
    for (let i = 0; i < handlers.length - 1; i += 1) await handlers[i](ctx);
    const result = await handlers[handlers.length - 1](ctx);
    if (ctx.handled) return;
    const headers = { ...baseHeaders };
    if (ctx.cookies.length) headers['Set-Cookie'] = ctx.cookies;
    if (result === undefined) {
      res.writeHead(204, headers);
      res.end();
    } else {
      H.sendJson(res, ctx.status, result, headers);
    }
  }

  async function serveFile(req, res, file, status = 200) {
    const stat = await fsp.stat(file);
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...baseHeaders,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const data = await fsp.readFile(file);
    res.writeHead(status, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handleStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...baseHeaders, Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/__bad__'; }

    let relative = null;
    for (const [re, file] of PAGE_ROUTES) {
      const m = re.exec(pathname);
      if (m) { relative = file || `${m[1]}.html`; break; }
    }
    if (!relative) relative = pathname.replace(/^\/+/, '');

    const segments = relative.split('/');
    const unsafePath = !relative || pathname.includes('\0') || segments.some((s) => s === '..' || s.startsWith('.'));
    const full = path.join(config.publicDir, relative);
    if (!unsafePath && full.startsWith(config.publicDir + path.sep)) {
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile()) return serveFile(req, res, full);
      } catch { /* падаем в 404 */ }
    }
    const notFoundPage = path.join(config.publicDir, '404.html');
    if (fs.existsSync(notFoundPage) && (req.headers.accept || '').includes('text/html')) return serveFile(req, res, notFoundPage, 404);
    res.writeHead(404, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Страница не найдена');
  }

  async function handle(req, res) {
    const ip = H.getIp(req, config.trustProxy);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, ip);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof ApiError) {
        const headers = { ...baseHeaders };
        if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
        if (err.status === 413) headers.Connection = 'close';
        H.sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } }, headers);
        return;
      }
      console.error('[error]', req.method, url.pathname, err);
      H.sendJson(res, 500, { error: { code: 'internal_error', message: 'Внутренняя ошибка сервера. Попробуйте позже.' } }, baseHeaders);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  const sweepTimer = setInterval(() => {
    try {
      db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
      db.run('DELETE FROM password_resets WHERE expires_at < ?', new Date(Date.now() - 86_400_000).toISOString());
    } catch { /* база может быть уже закрыта */ }
  }, 10 * 60_000);
  sweepTimer.unref();

  return {
    server, db, config, mailer, limiter,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(sweepTimer);
      limiter.close();
      return new Promise((resolve) => {
        server.close(() => { try { db.close(); } catch { /* уже закрыта */ } resolve(); });
        server.closeAllConnections?.();
      });
    },
  };
}


module.exports = { createApp };
