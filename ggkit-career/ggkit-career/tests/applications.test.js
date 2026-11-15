'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let t, admin, empA, empB, vacancyId;
before(async () => {
  t = await H.startTestApp();
  admin = await H.makeAdmin(t);
  empA = await H.registerEmployer(t, { organizationName: 'ООО «Альфа»' });
  empB = await H.registerEmployer(t, { organizationName: 'АО «Бета»' });
  vacancyId = await H.publishedVacancy(empA, admin, { title: 'Вакансия для откликов' });
});
after(async () => { await t.stop(); });

test('кандидат откликается с резюме и сопроводительным письмом; работодатель получает уведомление', async () => {
  const cand = await H.registerCandidate(t, { fullName: 'Сидоров Сидор' });
  const resumeId = await H.createResume(cand);
  const r = await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId, coverLetter: 'Хочу работать у вас.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.application.status, 'sent');
  assert.equal(r.data.application.statusLabel, 'Отправлен');
  assert.equal(r.data.application.coverLetter, 'Хочу работать у вас.');

  const notes = await empA.c.get('/api/me/notifications');
  assert.ok(notes.data.items.some((n) => n.type === 'application.new'));
  const mine = await cand.c.get('/api/me/applications');
  assert.equal(mine.data.total, 1);
  assert.equal(mine.data.items[0].vacancy.title, 'Вакансия для откликов');
});

test('дубликаты откликов запрещены, после отзыва можно откликнуться снова', async () => {
  const cand = await H.registerCandidate(t);
  const resumeId = await H.createResume(cand);
  const first = await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId });
  assert.equal(first.status, 201);
  const dup = await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'duplicate_application');
  const wd = await cand.c.post(`/api/applications/${first.data.application.id}/withdraw`);
  assert.equal(wd.data.application.status, 'withdrawn');
  assert.equal((await cand.c.post(`/api/applications/${first.data.application.id}/withdraw`)).status, 409);
  const again = await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId });
  assert.equal(again.status, 201);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ?', cand.id).n, 2);
});

test('отклик требует собственное резюме; чужое резюме использовать нельзя', async () => {
  const a = await H.registerCandidate(t);
  const b = await H.registerCandidate(t);
  const resumeOfB = await H.createResume(b);
  const noResume = await a.c.post(`/api/vacancies/${vacancyId}/apply`, {});
  assert.equal(noResume.status, 422);
  const foreign = await a.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId: resumeOfB });
  assert.equal(foreign.status, 422);
  assert.equal((await a.c.post('/api/vacancies/99999/apply', { resumeId: 1 })).status, 404);
});

test('работодатель и администратор не могут откликаться', async () => {
  assert.equal((await empB.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId: 1 })).status, 403);
  assert.equal((await admin.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId: 1 })).status, 403);
  assert.equal((await t.client().post(`/api/vacancies/${vacancyId}/apply`, { resumeId: 1 })).status, 401);
});

test('жизненный цикл: просмотр → статус → комментарий; кандидат видит статусы, но не комментарии', async () => {
  const cand = await H.registerCandidate(t, { fullName: 'Кандидатов Кандидат' });
  const resumeId = await H.createResume(cand, { title: 'Моё резюме', experience: 'Два года практики' });
  const app = (await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId, coverLetter: 'Письмо' })).data.application;

  const list = await empA.c.get(`/api/employer/applications?vacancyId=${vacancyId}&status=sent`);
  assert.ok(list.data.items.some((a) => a.id === app.id));

  const detail = await empA.c.get(`/api/employer/applications/${app.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.application.status, 'viewed'); // автоматически при первом открытии
  assert.equal(detail.data.application.candidate.fullName, 'Кандидатов Кандидат');
  assert.equal(detail.data.application.resume.title, 'Моё резюме');
  assert.equal(detail.data.application.coverLetter, 'Письмо');

  assert.equal((await empA.c.patch(`/api/employer/applications/${app.id}/status`, { status: 'sent' })).status, 422);
  assert.equal((await empA.c.patch(`/api/employer/applications/${app.id}/status`, { status: 'withdrawn' })).status, 422);
  const inv = await empA.c.patch(`/api/employer/applications/${app.id}/status`, { status: 'interview' });
  assert.equal(inv.data.application.status, 'interview');
  assert.deepEqual(inv.data.application.history.map((h) => h.status), ['sent', 'viewed', 'interview']);

  const com = await empA.c.post(`/api/employer/applications/${app.id}/comments`, { body: 'Позвонить во вторник' });
  assert.equal(com.status, 201);
  assert.equal(com.data.application.comments.length, 1);

  const mine = await cand.c.get('/api/me/applications');
  const row = mine.data.items.find((a) => a.id === app.id);
  assert.equal(row.status, 'interview');
  assert.equal(row.statusLabel, 'Приглашение на собеседование');
  assert.equal(row.comments, undefined);
  assert.ok(!JSON.stringify(mine.data).includes('Позвонить во вторник'));
  const notes = await cand.c.get('/api/me/notifications');
  assert.ok(notes.data.items.some((n) => n.type === 'application.status' && /собеседование/.test(n.title)));

  // принятый/отклонённый отклик отозвать нельзя
  await empA.c.patch(`/api/employer/applications/${app.id}/status`, { status: 'accepted' });
  const wd = await cand.c.post(`/api/applications/${app.id}/withdraw`);
  assert.equal(wd.status, 409);
});

test('работодатель не видит и не меняет отклики другой организации', async () => {
  const cand = await H.registerCandidate(t);
  const app = (await cand.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId: await H.createResume(cand) })).data.application;
  assert.equal((await empB.c.get(`/api/employer/applications/${app.id}`)).status, 404);
  assert.equal((await empB.c.patch(`/api/employer/applications/${app.id}/status`, { status: 'rejected' })).status, 404);
  assert.equal((await empB.c.post(`/api/employer/applications/${app.id}/comments`, { body: 'x' })).status, 404);
  assert.ok(!(await empB.c.get('/api/employer/applications')).data.items.some((a) => a.id === app.id));
  assert.equal(t.db.get('SELECT status FROM applications WHERE id = ?', app.id).status, 'sent');
});

test('кандидат не может отозвать чужой отклик', async () => {
  const a = await H.registerCandidate(t);
  const b = await H.registerCandidate(t);
  const app = (await a.c.post(`/api/vacancies/${vacancyId}/apply`, { resumeId: await H.createResume(a) })).data.application;
  assert.equal((await b.c.post(`/api/applications/${app.id}/withdraw`)).status, 404);
  assert.equal((await b.c.get('/api/me/applications')).data.total, 0);
});

test('администратор видит все отклики с фильтрами и деталями', async () => {
  const all = await admin.c.get('/api/admin/applications');
  assert.ok(all.data.total >= 4);
  const filtered = await admin.c.get('/api/admin/applications?status=accepted');
  assert.ok(filtered.data.items.every((a) => a.status === 'accepted'));
  const detail = await admin.c.get(`/api/admin/applications/${all.data.items[0].id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.application.history.length >= 1);
});

test('статистика вакансии для работодателя', async () => {
  const s = await empA.c.get(`/api/employer/vacancies/${vacancyId}/stats`);
  assert.equal(s.status, 200);
  assert.ok(s.data.applications >= 4);
  assert.ok(s.data.byStatus.sent >= 1);
  assert.equal((await empB.c.get(`/api/employer/vacancies/${vacancyId}/stats`)).status, 404);
  const overall = await empA.c.get('/api/employer/stats');
  assert.ok(overall.data.applicationsTotal >= 4);
});
