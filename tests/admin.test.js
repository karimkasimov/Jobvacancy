'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let t, admin;
before(async () => {
  t = await H.startTestApp();
  admin = await H.makeAdmin(t);
});
after(async () => { await t.stop(); });

test('панель: статистика, список и карточка пользователей, фильтры', async () => {
  const cand = await H.registerCandidate(t, { fullName: 'Поиск Кандидатов' });
  const emp = await H.registerEmployer(t, { organizationName: 'ООО «Для списка»' });
  const stats = await admin.c.get('/api/admin/stats');
  assert.ok(stats.data.users.byRole.candidate >= 1);
  assert.ok(stats.data.users.byRole.admin >= 1);
  const byRole = await admin.c.get('/api/admin/users?role=employer');
  assert.ok(byRole.data.items.every((u) => u.role === 'employer'));
  assert.ok(byRole.data.items.some((u) => u.organizationName === 'ООО «Для списка»'));
  const search = await admin.c.get(`/api/admin/users?q=${encodeURIComponent('ПОИСК')}`);
  assert.equal(search.data.total, 1);
  const detail = await admin.c.get(`/api/admin/users/${cand.id}`);
  assert.equal(detail.data.profile.candidateType, 'applicant');
  assert.ok(!JSON.stringify(detail.data).includes('password'));
  const edit = await admin.c.patch(`/api/admin/users/${emp.id}`, { fullName: 'Исправленное Имя', phone: '+7 900 000-00-01' });
  assert.equal(edit.data.user.fullName, 'Исправленное Имя');
});

test('управление ролями и защита последнего администратора и самого себя', async () => {
  const cand = await H.registerCandidate(t);
  const emp = await H.registerEmployer(t);
  assert.equal((await admin.c.patch(`/api/admin/users/${admin.id}`, { role: 'candidate' })).status, 403);
  assert.equal((await admin.c.post(`/api/admin/users/${admin.id}/block`)).status, 403);
  // смена кандидат ↔ работодатель нарушила бы связанные данные
  assert.equal((await admin.c.patch(`/api/admin/users/${cand.id}`, { role: 'employer' })).status, 409);
  assert.equal((await admin.c.patch(`/api/admin/users/${emp.id}`, { role: 'candidate' })).status, 409);
  // повышение до администратора и понижение обратно
  const up = await admin.c.patch(`/api/admin/users/${cand.id}`, { role: 'admin' });
  assert.equal(up.data.user.role, 'admin');
  assert.equal((await cand.c.get('/api/auth/me')).data.user, null); // сессия сброшена при смене роли
  const second = t.client();
  await second.post('/api/auth/login', { email: cand.email, password: H.PASSWORD });
  assert.equal((await second.get('/api/admin/stats')).status, 200);
  const down = await admin.c.patch(`/api/admin/users/${cand.id}`, { role: 'candidate' });
  assert.equal(down.data.user.role, 'candidate');
  assert.ok(t.db.get('SELECT 1 AS x FROM candidate_profiles WHERE user_id = ?', cand.id));
});

test('создание второго администратора: временный пароль и обязательная смена', async () => {
  const r = await admin.c.post('/api/admin/users', { email: 'staff@test.example', fullName: 'Сотрудник Колледжа' });
  assert.equal(r.status, 201);
  const c = t.client();
  const login = await c.post('/api/auth/login', { email: 'staff@test.example', password: r.data.temporaryPassword });
  assert.equal(login.data.user.mustChangePassword, true);
  assert.equal((await c.get('/api/admin/stats')).status, 403);
  await c.post('/api/auth/change-password', { currentPassword: r.data.temporaryPassword, newPassword: 'Staff12345' });
  assert.equal((await c.get('/api/admin/stats')).status, 200);
});

test('проверка студентов: реестр закрыт, заявка → сверка → решение администратора → история', async () => {
  const reg = await admin.c.post('/api/admin/students', { studentNumber: 'test-stu-777', fullName: 'Тестов Тест Тестович', kind: 'student', groupName: 'ИС-31', specialtyCode: '09.02.07', specialtyName: 'Программирование', studyYears: '2024–2027', isTest: true });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.record.studentNumber, 'TEST-STU-777');
  assert.equal((await admin.c.post('/api/admin/students', { studentNumber: 'TEST-STU-777', fullName: 'Дубль', kind: 'student' })).status, 422);

  const cand = await H.registerCandidate(t, { fullName: 'Тестов Тест Тестович' });
  // кандидат не видит реестр и результат сверки
  assert.equal((await cand.c.get('/api/admin/students')).status, 403);
  const sub = await cand.c.post('/api/me/verification', { claimedKind: 'student', studentNumber: 'TEST-STU-777', comment: 'Студент 3 курса' });
  assert.equal(sub.status, 201);
  assert.equal(sub.data.status, 'pending');
  assert.ok(!JSON.stringify(sub.data).includes('match'));
  assert.ok(!JSON.stringify(sub.data).includes('ИС-31'));
  assert.equal((await cand.c.post('/api/me/verification', { claimedKind: 'student', studentNumber: 'TEST-STU-777' })).status, 409);

  const list = await admin.c.get('/api/admin/verification-requests?status=pending');
  const req = list.data.items.find((r) => r.user.id === cand.id);
  assert.equal(req.registryMatch, 'match');
  assert.equal(req.registry.groupName, 'ИС-31');

  const ok = await admin.c.post(`/api/admin/verification-requests/${req.id}/approve`, {});
  assert.equal(ok.status, 200);
  const prof = await cand.c.get('/api/me/profile');
  assert.equal(prof.data.profile.verificationStatus, 'verified');
  assert.equal(prof.data.profile.candidateType, 'student');
  assert.equal(prof.data.profile.groupName, 'ИС-31');
  // подтверждённый статус нельзя сменить самому
  await cand.c.put('/api/me/profile', { candidateType: 'graduate' });
  assert.equal((await cand.c.get('/api/me/profile')).data.profile.candidateType, 'student');
  assert.equal((await cand.c.post('/api/me/verification', { claimedKind: 'student', studentNumber: 'TEST-STU-777' })).status, 409);

  const stats = (await t.client().get('/api/stats')).data;
  assert.equal(stats.verifiedStudents, 1);
  // публичный API не содержит данных реестра
  assert.ok(!JSON.stringify(stats).includes('Тестов'));

  const revoke = await admin.c.post(`/api/admin/users/${cand.id}/revoke-verification`, { note: 'Отчислен' });
  assert.equal(revoke.status, 200);
  const hist = await cand.c.get('/api/me/verification');
  assert.deepEqual(hist.data.history.map((h) => h.action), ['revoked', 'approved', 'submitted']);
  const adminHist = await admin.c.get(`/api/admin/verification-history?userId=${cand.id}`);
  assert.equal(adminHist.data.total, 3);
});

test('заявка без совпадения в реестре: одобрение только с обоснованием; отклонение требует причину', async () => {
  const cand = await H.registerCandidate(t, { fullName: 'Незнакомов Иван' });
  await cand.c.post('/api/me/verification', { claimedKind: 'graduate', studentNumber: 'NO-SUCH-1' });
  const req = (await admin.c.get('/api/admin/verification-requests?status=pending')).data.items.find((r) => r.user.id === cand.id);
  assert.equal(req.registryMatch, 'not_found');
  assert.equal((await admin.c.post(`/api/admin/verification-requests/${req.id}/approve`, {})).status, 422);
  assert.equal((await admin.c.post(`/api/admin/verification-requests/${req.id}/reject`, {})).status, 422);
  assert.equal((await admin.c.post(`/api/admin/verification-requests/${req.id}/reject`, { note: 'Номер не найден в реестре' })).status, 200);
  const prof = await cand.c.get('/api/me/verification');
  assert.equal(prof.data.status, 'rejected');
  assert.equal((await admin.c.post(`/api/admin/verification-requests/${req.id}/reject`, { note: 'ещё раз' })).status, 409);
  // после отказа можно подать новую заявку
  assert.equal((await cand.c.post('/api/me/verification', { claimedKind: 'graduate', studentNumber: 'NO-SUCH-2' })).status, 201);
});

test('частичное совпадение (другая фамилия) помечается как partial', async () => {
  await admin.c.post('/api/admin/students', { studentNumber: 'TEST-GRAD-555', fullName: 'Другов Пётр', kind: 'graduate', studyYears: '2021–2024', isTest: true });
  const cand = await H.registerCandidate(t, { fullName: 'Чужой Иван' });
  await cand.c.post('/api/me/verification', { claimedKind: 'graduate', studentNumber: 'test-grad-555' });
  const req = (await admin.c.get('/api/admin/verification-requests?status=pending')).data.items.find((r) => r.user.id === cand.id);
  assert.equal(req.registryMatch, 'partial');
});

test('проверка организаций: заявка работодателя → решение администратора', async () => {
  const emp = await H.registerEmployer(t, { organizationName: 'ООО «На проверку»' });
  // без контактов подать заявку нельзя
  assert.equal((await emp.c.post('/api/employer/organization/verification-request', { message: 'Проверьте' })).status, 422);
  await emp.c.put('/api/employer/organization', { contactEmail: 'hr@proverka.example', contactPhone: '+7 928 111-11-11', website: 'proverka.example', description: 'Описание организации' });
  const sub = await emp.c.post('/api/employer/organization/verification-request', { message: 'Проверьте, пожалуйста' });
  assert.equal(sub.status, 201);
  assert.equal(sub.data.organization.verificationStatus, 'pending');
  assert.equal((await emp.c.post('/api/employer/organization/verification-request', {})).status, 409);

  const reqs = await admin.c.get('/api/admin/organization-requests?status=pending');
  const req = reqs.data.items.find((r) => r.organization.id === emp.orgId);
  assert.ok(req);
  assert.equal((await admin.c.post(`/api/admin/organization-requests/${req.id}/reject`, {})).status, 422);
  assert.equal((await admin.c.post(`/api/admin/organization-requests/${req.id}/approve`, { note: 'Данные подтверждены' })).status, 200);
  const org = await emp.c.get('/api/employer/organization');
  assert.equal(org.data.organization.verificationStatus, 'verified');
  // переименование проверенной организации сбрасывает проверку
  const renamed = await emp.c.put('/api/employer/organization', { name: 'ООО «Переименованная»' });
  assert.equal(renamed.data.organization.verificationStatus, 'unverified');
  const notes = await emp.c.get('/api/me/notifications');
  assert.ok(notes.data.items.some((n) => n.type === 'organization.verified'));
});

test('каталог партнёров: попадают только организации с флагом администратора', async () => {
  const emp = await H.registerEmployer(t, { organizationName: 'ООО «Партнёр-кандидат»' });
  const pub = t.client();
  assert.ok(!(await pub.get('/api/organizations')).data.items.some((o) => o.id === emp.orgId));
  assert.equal((await pub.get(`/api/organizations/${emp.orgId}`)).status, 404);
  const set = await admin.c.patch(`/api/admin/organizations/${emp.orgId}`, { isPartnerListed: true, industry: 'ИТ', verificationStatus: 'verified' });
  assert.equal(set.data.organization.isPartnerListed, true);
  const list = await pub.get('/api/organizations?verified=1');
  assert.ok(list.data.items.some((o) => o.id === emp.orgId));
  const filtered = await pub.get(`/api/organizations?industry=${encodeURIComponent('ИТ')}&city=${encodeURIComponent('грозный')}`);
  assert.ok(filtered.data.items.some((o) => o.id === emp.orgId));
  const card = await pub.get(`/api/organizations/${emp.orgId}`);
  assert.equal(card.data.organization.verificationLabel, 'Проверена');
  assert.equal(card.data.organization.email, undefined);
  // администратор создаёт организацию вручную
  const made = await admin.c.post('/api/admin/organizations', { name: 'ГБУ «Созданное админом»', city: 'Шали', isPartnerListed: true, verificationStatus: 'verified' });
  assert.equal(made.status, 201);
  assert.equal((await admin.c.delete(`/api/admin/organizations/${emp.orgId}`)).status, 409);
  assert.equal((await admin.c.delete(`/api/admin/organizations/${made.data.organization.id}`)).status, 200);
});

test('модерация вакансий администратором: правка, избранная, закрытие, удаление', async () => {
  const emp = await H.registerEmployer(t);
  const id = await H.publishedVacancy(emp, admin, { title: 'Для админских операций' });
  const edit = await admin.c.patch(`/api/admin/vacancies/${id}`, { title: 'Исправлено администратором', isFeatured: true });
  assert.equal(edit.data.vacancy.title, 'Исправлено администратором');
  assert.equal(edit.data.vacancy.status, 'published');
  assert.equal((await t.client().get('/api/vacancies?featured=1')).data.total >= 1, true);
  assert.equal((await admin.c.post(`/api/admin/vacancies/${id}/close`)).data.vacancy.status, 'closed');
  assert.equal((await admin.c.patch(`/api/admin/vacancies/${id}`, { isFeatured: true })).status, 409);
  assert.equal((await admin.c.delete(`/api/admin/vacancies/${id}`)).status, 200);
  assert.equal((await t.client().get(`/api/vacancies/${id}`)).status, 404);
});

test('журнал действий фиксирует операции с фильтрами; контент сайта редактируется', async () => {
  const logs = await admin.c.get('/api/admin/logs?action=admin.vacancy');
  assert.ok(logs.data.items.length >= 3);
  assert.ok(logs.data.items.every((l) => l.action.startsWith('admin.vacancy')));
  assert.ok(logs.data.items[0].actor.email);
  const byActor = await admin.c.get(`/api/admin/logs?actorId=${admin.id}`);
  assert.ok(byActor.data.total >= 1);
  const text = JSON.stringify(logs.data);
  assert.ok(!/password|scrypt\$/i.test(text));

  const put = await admin.c.put('/api/admin/content', { hero_title: 'Новый заголовок', contact_phone: '+7 (8712) 00-00-00' });
  assert.equal(put.status, 200);
  const site = await t.client().get('/api/site');
  assert.equal(site.data.content.hero_title, 'Новый заголовок');
  await admin.c.put('/api/admin/content', { hero_title: '' });
  assert.notEqual((await t.client().get('/api/site')).data.content.hero_title, 'Новый заголовок'); // вернулся текст по умолчанию
});

test('документ кандидата, приложенный откликом, доступен работодателю, а проверочный — нет', async () => {
  const emp = await H.registerEmployer(t);
  const id = await H.publishedVacancy(emp, admin, { title: 'С файлом резюме' });
  const cand = await H.registerCandidate(t);
  const doc = (await cand.c.upload('/api/me/documents', 'resume.pdf', H.PDF, { kind: 'resume' })).data.document;
  const other = (await cand.c.upload('/api/me/documents', 'scan.pdf', H.PDF, { kind: 'verification' })).data.document;
  assert.equal((await emp.c.get(`/api/documents/${doc.id}/download`)).status, 404); // пока не откликался
  const resumeId = await H.createResume(cand, { documentId: doc.id });
  assert.equal((await cand.c.post('/api/me/resumes', { title: 'Со сканом', documentId: other.id })).status, 422);
  await cand.c.post(`/api/vacancies/${id}/apply`, { resumeId });
  const dl = await emp.c.get(`/api/documents/${doc.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal((await emp.c.get(`/api/documents/${other.id}/download`)).status, 404);
  const other2 = await H.registerEmployer(t);
  assert.equal((await other2.c.get(`/api/documents/${doc.id}/download`)).status, 404);
});
