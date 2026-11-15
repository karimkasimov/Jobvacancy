'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { ensureAdmin } = require('../server/create-admin');

const BIG = { limit: 1_000_000, windowMs: 60_000 };

async function startTestApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggkit-test-'));
  const app = createApp({
    databasePath: path.join(dir, 'test.sqlite'),
    uploadDir: path.join(dir, 'uploads'),
    scrypt: { N: 1024 },
    mail: { provider: 'memory' },
    rateLimits: { api: BIG, login: BIG, register: BIG, forgot: BIG, upload: BIG, verification: BIG },
    ...overrides,
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return {
    app, base, db: app.db, dir,
    client: () => new Client(base),
    async stop() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** HTTP-клиент с cookie и автоматической подстановкой CSRF-токена. */
class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.csrf = null; }

  async raw(method, url, { body, headers = {}, rawBody, noCsrf } = {}) {
    const h = { ...headers };
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    let payload = rawBody;
    if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = JSON.stringify(body); }
    if (this.csrf && !noCsrf && !['GET', 'HEAD'].includes(method)) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || value === '') delete this.cookies[name];
      else this.cookies[name] = value;
    }
    return res;
  }

  async call(method, url, body, opts = {}) {
    const res = await this.raw(method, url, { body, ...opts });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : res.status === 204 ? null : await res.text();
    if (data && data.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }

  get(url) { return this.call('GET', url); }
  post(url, body, opts) { return this.call('POST', url, body ?? {}, opts); }
  put(url, body) { return this.call('PUT', url, body ?? {}); }
  patch(url, body) { return this.call('PATCH', url, body ?? {}); }
  delete(url, body) { return this.call('DELETE', url, body); }

  async upload(url, filename, buffer, fields = {}, field = 'file') {
    const boundary = `----test${Math.random().toString(16).slice(2)}`;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
    const res = await this.raw('POST', url, { rawBody: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  }
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter += 1)}`;
const PASSWORD = 'Test12345';

async function registerCandidate(t, over = {}) {
  const c = t.client();
  const email = over.email || `cand-${uniq()}@test.example`;
  const r = await c.post('/api/auth/register', { role: 'candidate', email, password: PASSWORD, fullName: over.fullName || 'Иванов Иван Иванович', phone: '+7 900 111-22-33', consent: true, ...over });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  return { c, email, id: r.data.user.id, user: r.data.user };
}

async function registerEmployer(t, over = {}) {
  const c = t.client();
  const email = over.email || `emp-${uniq()}@test.example`;
  const r = await c.post('/api/auth/register', {
    role: 'employer', email, password: PASSWORD, fullName: 'Петров Пётр Петрович', phone: '+7 900 222-33-44',
    organizationName: over.organizationName || `ООО «Тест ${uniq()}»`, city: 'Грозный', consent: true, ...over,
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  return { c, email, id: r.data.user.id, user: r.data.user, orgId: r.data.user.organization.id };
}

async function makeAdmin(t, email = `admin-${uniq()}@test.example`) {
  await ensureAdmin(t.db, t.app.config, { email, fullName: 'Админ Тестовый', password: PASSWORD });
  const c = t.client();
  const r = await c.post('/api/auth/login', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.data)}`);
  return { c, email, id: r.data.user.id };
}

const vacancyBody = (over = {}) => ({
  title: 'Младший программист', categoryId: 1, city: 'Грозный', address: 'ул. Ломоносова, 25', employmentType: 'full', experience: 'none',
  salaryMin: 50000, salaryMax: 80000, description: 'Разработка и сопровождение внутренних сервисов компании.',
  responsibilities: ['Писать код'], requirements: ['Знание JavaScript'], conditions: ['Офис в Грозном'], contactPhone: '+7 928 000-00-00', ...over,
});

/** Создаёт вакансию работодателем и публикует её через модерацию администратора. */
async function publishedVacancy(emp, admin, over = {}) {
  const created = await emp.c.post('/api/employer/vacancies', { ...vacancyBody(over), submit: true });
  if (created.status !== 201) throw new Error(`vacancy create failed: ${JSON.stringify(created.data)}`);
  const id = created.data.vacancy.id;
  const ok = await admin.c.post(`/api/admin/vacancies/${id}/approve`);
  if (ok.status !== 200) throw new Error(`approve failed: ${JSON.stringify(ok.data)}`);
  return id;
}

async function createResume(cand, over = {}) {
  const r = await cand.c.post('/api/me/resumes', { title: 'Резюме разработчика', desiredPosition: 'Программист', skills: 'JavaScript', ...over });
  if (r.status !== 201) throw new Error(`resume failed: ${JSON.stringify(r.data)}`);
  return r.data.resume.id;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

module.exports = { startTestApp, registerCandidate, registerEmployer, makeAdmin, vacancyBody, publishedVacancy, createResume, PASSWORD, PDF, PNG, uniq };
