'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let t, admin, emp, cand;
before(async () => {
  t = await H.startTestApp();
  admin = await H.makeAdmin(t);
  emp = await H.registerEmployer(t);
  cand = await H.registerCandidate(t);
});
after(async () => { await t.stop(); });

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['GET', '/api/admin/vacancies'], ['GET', '/api/admin/organizations'],
  ['GET', '/api/admin/students'], ['GET', '/api/admin/verification-requests'], ['GET', '/api/admin/applications'],
  ['GET', '/api/admin/logs'], ['GET', '/api/admin/content'], ['GET', '/api/admin/organization-requests'], ['GET', '/api/admin/verification-history'],
];
const EMPLOYER_ENDPOINTS = [
  ['GET', '/api/employer/organization'], ['GET', '/api/employer/vacancies'], ['GET', '/api/employer/applications'], ['GET', '/api/employer/stats'],
];
const CANDIDATE_ENDPOINTS = [
  ['GET', '/api/me/profile'], ['GET', '/api/me/resumes'], ['GET', '/api/me/documents'], ['GET', '/api/me/applications'], ['GET', '/api/me/saved'], ['GET', '/api/me/verification'],
];

test('анонимный пользователь получает 401 на всех защищённых эндпоинтах', async () => {
  const c = t.client();
  for (const [m, url] of [...ADMIN_ENDPOINTS, ...EMPLOYER_ENDPOINTS, ...CANDIDATE_ENDPOINTS, ['GET', '/api/me/notifications']]) {
    const r = await c.call(m, url);
    assert.equal(r.status, 401, `${m} ${url}`);
  }
});

test('соискатель не имеет доступа к функциям работодателя и администратора', async () => {
  for (const [m, url] of [...ADMIN_ENDPOINTS, ...EMPLOYER_ENDPOINTS]) {
    const r = await cand.c.call(m, url);
    assert.equal(r.status, 403, `${m} ${url}`);
  }
  assert.equal((await cand.c.post('/api/employer/vacancies', H.vacancyBody())).status, 403);
  assert.equal((await cand.c.post('/api/admin/vacancies/1/approve')).status, 403);
  assert.equal((await cand.c.put('/api/admin/content', { hero_title: 'Взлом' })).status, 403);
});

test('работодатель не имеет доступа к кабинету соискателя и администратора', async () => {
  for (const [m, url] of [...ADMIN_ENDPOINTS, ...CANDIDATE_ENDPOINTS]) {
    const r = await emp.c.call(m, url);
    assert.equal(r.status, 403, `${m} ${url}`);
  }
});

test('администратор не обращается к кабинету соискателя/работодателя как к своему', async () => {
  for (const [m, url] of [...EMPLOYER_ENDPOINTS, ...CANDIDATE_ENDPOINTS]) {
    assert.equal((await admin.c.call(m, url)).status, 403, `${m} ${url}`);
  }
});

test('роль из тела запроса игнорируется сервером', async () => {
  const r = await cand.c.patch('/api/me/account', { fullName: 'Иванов Иван', role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'candidate');
  assert.equal(t.db.get('SELECT role FROM users WHERE id = ?', cand.id).role, 'candidate');
  const prof = await cand.c.put('/api/me/profile', { role: 'admin', city: 'Грозный', verificationStatus: 'verified', candidateType: 'student' });
  assert.equal(prof.data.profile.verificationStatus, 'none');
  assert.equal((await cand.c.get('/api/admin/users')).status, 403);
});

test('пользователь не может подтвердить собственный статус или организацию', async () => {
  const org = await emp.c.put('/api/employer/organization', { name: 'ООО «Своя»', isPartnerListed: true, verificationStatus: 'verified', isCollegeUnit: true });
  assert.equal(org.status, 200);
  const row = t.db.get('SELECT verification_status, is_partner_listed, is_college_unit FROM organizations WHERE id = ?', emp.orgId);
  assert.equal(row.verification_status, 'unverified');
  assert.equal(row.is_partner_listed, 0);
  assert.equal(row.is_college_unit, 0);
});

test('резюме, документы и уведомления доступны только владельцу', async () => {
  const other = await H.registerCandidate(t);
  const resumeId = await H.createResume(cand);
  assert.equal((await other.c.put(`/api/me/resumes/${resumeId}`, { title: 'Чужое' })).status, 404);
  assert.equal((await other.c.delete(`/api/me/resumes/${resumeId}`)).status, 404);
  const up = await cand.c.upload('/api/me/documents', 'cv.pdf', H.PDF, { kind: 'resume' });
  assert.equal(up.status, 201);
  const docId = up.data.document.id;
  assert.equal((await other.c.get(`/api/documents/${docId}/download`)).status, 404);
  assert.equal((await other.c.delete(`/api/me/documents/${docId}`)).status, 404);
  assert.equal((await emp.c.get(`/api/documents/${docId}/download`)).status, 404);
  assert.equal((await cand.c.get(`/api/documents/${docId}/download`)).status, 200);
  assert.equal((await admin.c.get(`/api/documents/${docId}/download`)).status, 200);
  // чужие данные профиля не попадают в ответ
  const prof = await other.c.get('/api/me/profile');
  assert.notEqual(prof.data.user.id, cand.id);
});

test('несуществующий метод API и неверный метод', async () => {
  assert.equal((await t.client().get('/api/nope')).status, 404);
  assert.equal((await t.client().call('DELETE', '/api/stats')).status, 405);
});

test('смена email требует пароль и проверяет уникальность', async () => {
  const other = await H.registerCandidate(t, { email: 'taken@test.example' });
  assert.ok(other.id);
  assert.equal((await cand.c.post('/api/me/email', { email: 'taken@test.example', password: H.PASSWORD })).status, 422);
  assert.equal((await cand.c.post('/api/me/email', { email: 'new@test.example', password: 'Wrong12345' })).status, 422);
  const ok = await cand.c.post('/api/me/email', { email: 'new@test.example', password: H.PASSWORD });
  assert.equal(ok.data.user.email, 'new@test.example');
});

test('удаление аккаунта: нужен пароль; данные удаляются; администратора удалить нельзя', async () => {
  const doomed = await H.registerCandidate(t);
  await H.createResume(doomed);
  assert.equal((await doomed.c.delete('/api/me/account', { password: 'Wrong12345' })).status, 422);
  assert.equal((await doomed.c.delete('/api/me/account', { password: H.PASSWORD })).status, 200);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', doomed.id).n, 0);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?', doomed.id).n, 0);
  assert.equal((await doomed.c.get('/api/auth/me')).data.user, null);
  assert.equal((await admin.c.delete('/api/me/account', { password: H.PASSWORD })).status, 403);
});

test('уведомления: чтение и удаление только своих', async () => {
  const a = await H.registerCandidate(t);
  t.db.run("INSERT INTO notifications (user_id, type, title) VALUES (?, 't', 'Тест')", a.id);
  const id = t.db.get('SELECT id FROM notifications WHERE user_id = ?', a.id).id;
  const b = await H.registerCandidate(t);
  assert.equal((await b.c.post(`/api/me/notifications/${id}/read`)).status, 404);
  assert.equal((await b.c.delete(`/api/me/notifications/${id}`)).status, 404);
  assert.equal((await a.c.get('/api/me/notifications')).data.unreadCount, 1);
  assert.equal((await a.c.post(`/api/me/notifications/${id}/read`)).status, 200);
  assert.equal((await a.c.get('/api/me/notifications')).data.unreadCount, 0);
});
