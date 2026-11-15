'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const H = require('./helpers');

let t;
before(async () => { t = await H.startTestApp(); });
after(async () => { await t.stop(); });

const get = (p, headers = {}) => fetch(t.base + p, { headers });

test('страницы отдаются, у вакансии и организации — уникальные URL', async () => {
  for (const p of ['/', '/vacancies', '/vacancies/1', '/vacancies/123456', '/partners', '/partners/7', '/login', '/register', '/forgot-password', '/reset-password', '/cabinet', '/employer', '/admin', '/index.html', '/vacancies.html', '/vacancy-details.html', '/partners.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
  }
  assert.match(await (await get('/vacancies/5')).text(), /vacancy\.js/);
  assert.match(await (await get('/partners/3')).text(), /partner\.js/);
});

test('защитные заголовки: CSP без unsafe-inline, nosniff, запрет фреймов', async () => {
  const r = await get('/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('referrer-policy'));
  const api = await get('/api/stats');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});

test('несуществующая страница: 404 с HTML для браузера, обычный 404 для остальных', async () => {
  const html = await get('/net-takoj-stranicy', { Accept: 'text/html' });
  assert.equal(html.status, 404);
  assert.match(await html.text(), /notfound\.js/);
  const plain = await get('/missing.js');
  assert.equal(plain.status, 404);
});

test('вне каталога public ничего не раздаётся: сервер, миграции, база, загрузки, .env, package.json', async () => {
  fs.mkdirSync(t.app.config.uploadDir, { recursive: true });
  const secret = 'SECRET-MARKER-12345';
  fs.writeFileSync(path.join(t.app.config.uploadDir, 'probe.txt'), secret);
  const probes = [
    '/server/app.js', '/server/config.js', '/migrations/001_init.sql', '/package.json', '/.env', '/.env.example', '/.gitignore',
    '/data/ggkit.sqlite', '/uploads/probe.txt', '/uploads/documents/x.pdf', '/tests/helpers.js', '/README.md', '/node_modules/x',
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/css/../../package.json', '/css/%2e%2e/%2e%2e/package.json',
    '/js/..%5c..%5cpackage.json', '/%00', '/css/style.css%00.html', '/.git/config', '/js/.hidden',
  ];
  for (const p of probes) {
    const r = await get(p);
    const body = await r.text();
    assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    assert.ok(!body.includes(secret) && !body.includes('createApp') && !body.includes('CREATE TABLE'), `${p} раскрыл содержимое`);
  }
});

test('необработанные пути не ломают сервер (сырой запрос с обходом каталога)', async () => {
  const port = new URL(t.base).port;
  const res = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /../../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('end', () => resolve(data));
    s.on('error', reject);
  });
  assert.match(res, /^HTTP\/1\.1 404/);
  assert.ok(!/root:/.test(res));
  assert.equal((await get('/api/health')).status, 200);
});

test('публичные файлы не содержат реестра студентов и персональных данных', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(t.app.config.publicDir).filter((f) => /\.(html|js|css|json)$/.test(f))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/studentsRegistry|TEST-STU-0|TEST-GRAD-0|Тестов Иван|Образцова Мария|Примерова Елена|Шаблонов Пётр/i.test(text), `${file}: найден реестр студентов`);
    assert.ok(!/localStorage|sessionStorage/.test(text), `${file}: используется браузерное хранилище`);
    if (file.endsWith('.html')) {
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(text), `${file}: inline-скрипт`);
      assert.ok(!/\sstyle\s*=/i.test(text), `${file}: inline-стиль`);
      assert.ok(!/\son[a-z]+\s*=/i.test(text), `${file}: inline-обработчик событий`);
    }
  }
});

test('HTML-страницы: lang=ru, заголовок, подключены стили и скрипты-модули', () => {
  for (const f of fs.readdirSync(t.app.config.publicDir).filter((n) => n.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(t.app.config.publicDir, f), 'utf8');
    assert.match(text, /<html lang="ru">/, f);
    assert.match(text, /<title>[^<]+<\/title>/, f);
    assert.match(text, /\/css\/style\.css/, f);
    assert.match(text, /type="module" src="\/js\/pages\/\w+\.js"/, f);
  }
});

test('все клиентские скрипты страниц существуют, а импорты разрешаются', () => {
  const jsDir = path.join(t.app.config.publicDir, 'js');
  const files = [...fs.readdirSync(jsDir).filter((n) => n.endsWith('.js')).map((n) => path.join(jsDir, n)), ...fs.readdirSync(path.join(jsDir, 'pages')).map((n) => path.join(jsDir, 'pages', n))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from '(\.[^']+)'/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${file}: нет модуля ${m[1]}`);
  }
  for (const f of fs.readdirSync(t.app.config.publicDir).filter((n) => n.endsWith('.html'))) {
    const src = /src="\/js\/pages\/(\w+\.js)"/.exec(fs.readFileSync(path.join(t.app.config.publicDir, f), 'utf8'))[1];
    assert.ok(fs.existsSync(path.join(jsDir, 'pages', src)), `${f}: нет ${src}`);
  }
});

test('ETag и условные запросы для статики', async () => {
  const first = await get('/css/app.css');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await get('/css/app.css', { 'If-None-Match': etag });
  assert.equal(second.status, 304);
});
