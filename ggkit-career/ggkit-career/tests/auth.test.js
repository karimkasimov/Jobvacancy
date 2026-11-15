'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, registerCandidate, registerEmployer, makeAdmin, PASSWORD } = require('./helpers');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.stop(); });

test('регистрация соискателя создаёт сессию, пароль хранится только в виде scrypt-хеша', async () => {
  const cand = await registerCandidate(t, { email: 'hash@test.example' });
  assert.equal(cand.user.role, 'candidate');
  const me = await cand.c.get('/api/auth/me');
  assert.equal(me.data.user.email, 'hash@test.example');
  const row = t.db.get('SELECT password_hash FROM users WHERE email = ?', 'hash@test.example');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  // В базе нет открытых токенов сессии: хранится только SHA-256
  const sid = t.db.get('SELECT id FROM sessions WHERE user_id = ?', cand.id).id;
  assert.notEqual(sid, cand.c.cookies.ggkit_sid);
  assert.equal(sid.length, 64);
});

test('cookie сессии HttpOnly + SameSite', async () => {
  const c = t.client();
  const res = await c.raw('POST', '/api/auth/register', {
    body: { role: 'candidate', email: 'cookie@test.example', password: PASSWORD, fullName: 'Кукин Иван', consent: true },
  });
  const setCookie = res.headers.getSetCookie().join(';');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('слабый пароль, неверный email и отсутствие согласия отклоняются с описанием полей', async () => {
  const c = t.client();
  const r = await c.post('/api/auth/register', { role: 'candidate', email: 'bad', password: 'short', fullName: 'А', consent: false });
  assert.equal(r.status, 422);
  assert.ok(r.data.error.fields.email);
  assert.ok(r.data.error.fields.password);
  assert.ok(r.data.error.fields.fullName);
  assert.ok(r.data.error.fields.consent);
  const noDigits = await c.post('/api/auth/register', { role: 'candidate', email: 'x@test.example', password: 'onlyletters', fullName: 'Иван Иванов', consent: true });
  assert.equal(noDigits.status, 422);
});

test('повторная регистрация того же email (в другом регистре) — 409', async () => {
  await registerCandidate(t, { email: 'dup@test.example' });
  const r = await t.client().post('/api/auth/register', { role: 'candidate', email: 'DUP@test.example', password: PASSWORD, fullName: 'Дубль Дублёв', consent: true });
  assert.equal(r.status, 409);
});

test('через регистрацию нельзя получить роль администратора', async () => {
  const r = await t.client().post('/api/auth/register', { role: 'admin', email: 'evil@test.example', password: PASSWORD, fullName: 'Злой Админ', consent: true });
  assert.equal(r.status, 422);
  assert.ok(!t.db.get('SELECT 1 AS x FROM users WHERE email = ?', 'evil@test.example'));
});

test('вход: одинаковая ошибка для неверного пароля и несуществующего email', async () => {
  await registerCandidate(t, { email: 'login@test.example' });
  const a = await t.client().post('/api/auth/login', { email: 'login@test.example', password: 'Wrong12345' });
  const b = await t.client().post('/api/auth/login', { email: 'nobody@test.example', password: 'Wrong12345' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.data.error.message, b.data.error.message);
  const ok = await t.client().post('/api/auth/login', { email: 'LOGIN@test.example', password: PASSWORD });
  assert.equal(ok.status, 200);
});

test('после 5 неудачных попыток аккаунт временно блокируется даже при верном пароле', async () => {
  await registerCandidate(t, { email: 'lock@test.example' });
  for (let i = 0; i < 5; i += 1) {
    const r = await t.client().post('/api/auth/login', { email: 'lock@test.example', password: 'Wrong12345' });
    assert.equal(r.status, 401);
  }
  const r = await t.client().post('/api/auth/login', { email: 'lock@test.example', password: PASSWORD });
  assert.equal(r.status, 429);
  assert.equal(r.data.error.code, 'account_locked');
});

test('выход уничтожает сессию на сервере', async () => {
  const cand = await registerCandidate(t);
  const stolen = cand.c.cookies.ggkit_sid;
  assert.equal((await cand.c.post('/api/auth/logout')).status, 200);
  const other = t.client();
  other.cookies.ggkit_sid = stolen;
  assert.equal((await other.get('/api/auth/me')).data.user, null);
});

test('CSRF: запрос с сессией без токена отклоняется, с токеном проходит', async () => {
  const cand = await registerCandidate(t);
  const bad = await cand.c.post('/api/me/resumes', { title: 'Резюме' }, { noCsrf: true });
  assert.equal(bad.status, 403);
  assert.equal(bad.data.error.code, 'csrf');
  const wrong = await cand.c.raw('POST', '/api/me/resumes', { body: { title: 'Резюме' }, headers: { 'X-CSRF-Token': 'wrong' }, noCsrf: true });
  assert.equal(wrong.status, 403);
  const ok = await cand.c.post('/api/me/resumes', { title: 'Резюме' });
  assert.equal(ok.status, 201);
});

test('чужой Origin и не-JSON тело отклоняются', async () => {
  const c = t.client();
  const evil = await c.raw('POST', '/api/auth/login', { body: { email: 'a@b.cc', password: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const form = await c.raw('POST', '/api/auth/login', { rawBody: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const broken = await c.raw('POST', '/api/auth/login', { rawBody: '{oops', headers: { 'Content-Type': 'application/json' } });
  assert.equal(broken.status, 400);
});

test('смена пароля: проверка текущего, завершение других сессий', async () => {
  const cand = await registerCandidate(t, { email: 'chg@test.example' });
  const second = t.client();
  await second.post('/api/auth/login', { email: 'chg@test.example', password: PASSWORD });
  const wrong = await cand.c.post('/api/auth/change-password', { currentPassword: 'Nope12345', newPassword: 'NewPass123' });
  assert.equal(wrong.status, 422);
  const same = await cand.c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
  assert.equal(same.status, 422);
  const ok = await cand.c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NewPass123' });
  assert.equal(ok.status, 200);
  assert.equal((await cand.c.get('/api/auth/me')).data.user.email, 'chg@test.example');
  assert.equal((await second.get('/api/auth/me')).data.user, null);
  assert.equal((await t.client().post('/api/auth/login', { email: 'chg@test.example', password: PASSWORD })).status, 401);
  assert.equal((await t.client().post('/api/auth/login', { email: 'chg@test.example', password: 'NewPass123' })).status, 200);
});

test('восстановление пароля: токен одноразовый, письмо уходит через провайдер, старые сессии закрываются', async () => {
  const cand = await registerCandidate(t, { email: 'reset@test.example' });
  const c = t.client();
  t.app.mailer.outbox.length = 0;
  const f = await c.post('/api/auth/forgot', { email: 'reset@test.example' });
  assert.equal(f.status, 200);
  assert.equal(f.data.mail, 'sent');
  assert.equal(t.app.mailer.outbox.length, 1);
  const token = /token=([\w-]+)/.exec(t.app.mailer.outbox[0].text)[1];
  // токен не хранится открыто
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?', token).n, 0);
  assert.equal((await c.post('/api/auth/reset', { token: 'wrong-token-value', newPassword: 'Another123' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token, newPassword: 'Another123' })).status, 200);
  assert.equal((await c.post('/api/auth/reset', { token, newPassword: 'Another456' })).status, 400);
  assert.equal((await cand.c.get('/api/auth/me')).data.user, null);
  assert.equal((await t.client().post('/api/auth/login', { email: 'reset@test.example', password: 'Another123' })).status, 200);
  // для несуществующего email ответ тот же, письмо не уходит
  t.app.mailer.outbox.length = 0;
  const nobody = await c.post('/api/auth/forgot', { email: 'ghost@test.example' });
  assert.equal(nobody.status, 200);
  assert.equal(t.app.mailer.outbox.length, 0);
});

test('без настроенной почты API честно сообщает, что письмо не отправлено', async () => {
  const t2 = await startTestApp({ mail: { provider: 'none' } });
  try {
    const cand = await registerCandidate(t2, { email: 'nomail@test.example' });
    const r = await t2.client().post('/api/auth/forgot', { email: 'nomail@test.example' });
    assert.equal(r.data.mail, 'not_configured');
    assert.equal(t2.db.get('SELECT COUNT(*) AS n FROM password_resets').n, 0);
    assert.ok(cand.id);
  } finally { await t2.stop(); }
});

test('rate limit на вход возвращает 429 и Retry-After', async () => {
  const t2 = await startTestApp({ rateLimits: { api: { limit: 100000, windowMs: 60000 }, login: { limit: 3, windowMs: 60000 }, register: { limit: 1000, windowMs: 60000 }, forgot: { limit: 1000, windowMs: 60000 }, upload: { limit: 1000, windowMs: 60000 }, verification: { limit: 1000, windowMs: 60000 } } });
  try {
    const c = t2.client();
    for (let i = 0; i < 3; i += 1) assert.equal((await c.post('/api/auth/login', { email: 'x@test.example', password: 'Wrong12345' })).status, 401);
    const r = await c.post('/api/auth/login', { email: 'x@test.example', password: 'Wrong12345' });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally { await t2.stop(); }
});

test('заблокированный пользователь не может войти, его сессии закрываются', async () => {
  const cand = await registerCandidate(t, { email: 'blocked@test.example' });
  const admin = await makeAdmin(t);
  assert.equal((await admin.c.post(`/api/admin/users/${cand.id}/block`, { reason: 'тест' })).status, 200);
  assert.equal((await cand.c.get('/api/auth/me')).data.user, null);
  const r = await t.client().post('/api/auth/login', { email: 'blocked@test.example', password: PASSWORD });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'account_blocked');
  assert.equal((await admin.c.post(`/api/admin/users/${cand.id}/unblock`)).status, 200);
  assert.equal((await t.client().post('/api/auth/login', { email: 'blocked@test.example', password: PASSWORD })).status, 200);
});

test('временный пароль после сброса администратором: до смены доступны только вход и смена пароля', async () => {
  const cand = await registerCandidate(t, { email: 'temp@test.example' });
  const admin = await makeAdmin(t);
  const reset = await admin.c.post(`/api/admin/users/${cand.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.ok(reset.data.temporaryPassword);
  assert.equal((await cand.c.get('/api/auth/me')).data.user, null);
  const c = t.client();
  const login = await c.post('/api/auth/login', { email: 'temp@test.example', password: reset.data.temporaryPassword });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  const blocked = await c.get('/api/me/profile');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'password_change_required');
  assert.equal((await c.post('/api/auth/change-password', { currentPassword: reset.data.temporaryPassword, newPassword: 'Fresh12345' })).status, 200);
  assert.equal((await c.get('/api/me/profile')).status, 200);
});

test('регистрация работодателя создаёт непроверенную организацию', async () => {
  const emp = await registerEmployer(t, { organizationName: 'ООО «Новая»' });
  const org = await emp.c.get('/api/employer/organization');
  assert.equal(org.data.organization.name, 'ООО «Новая»');
  assert.equal(org.data.organization.verificationStatus, 'unverified');
  assert.equal(org.data.organization.isPartnerListed, false);
});
