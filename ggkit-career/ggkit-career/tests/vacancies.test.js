'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let t, admin, empA, empB;
before(async () => {
  t = await H.startTestApp();
  admin = await H.makeAdmin(t);
  empA = await H.registerEmployer(t, { organizationName: 'ООО «Альфа»' });
  empB = await H.registerEmployer(t, { organizationName: 'АО «Бета»' });
});
after(async () => { await t.stop(); });

test('новая вакансия не публикуется без модерации', async () => {
  const draft = await empA.c.post('/api/employer/vacancies', H.vacancyBody({ title: 'Черновик вакансии' }));
  assert.equal(draft.status, 201);
  assert.equal(draft.data.vacancy.status, 'draft');
  const sub = await empA.c.post('/api/employer/vacancies', { ...H.vacancyBody({ title: 'Ожидает модерации' }), submit: true });
  assert.equal(sub.data.vacancy.status, 'pending');

  const list = await t.client().get('/api/vacancies?q=модерации');
  assert.equal(list.data.total, 0);
  assert.equal((await t.client().get(`/api/vacancies/${sub.data.vacancy.id}`)).status, 404);
  assert.equal((await t.client().get(`/api/vacancies/${draft.data.vacancy.id}`)).status, 404);
  // владелец и администратор видят
  assert.equal((await empA.c.get(`/api/vacancies/${sub.data.vacancy.id}`)).status, 200);
  assert.equal((await admin.c.get(`/api/vacancies/${sub.data.vacancy.id}`)).status, 200);
  // чужой работодатель — нет
  assert.equal((await empB.c.get(`/api/vacancies/${sub.data.vacancy.id}`)).status, 404);
});

test('администратор одобряет вакансию — она появляется в каталоге по своему URL; работодатель получает уведомление', async () => {
  const sub = await empA.c.post('/api/employer/vacancies', { ...H.vacancyBody({ title: 'Инженер Одобряемый' }), submit: true });
  const id = sub.data.vacancy.id;
  const ok = await admin.c.post(`/api/admin/vacancies/${id}/approve`);
  assert.equal(ok.data.vacancy.status, 'published');
  const detail = await t.client().get(`/api/vacancies/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.vacancy.title, 'Инженер Одобряемый');
  assert.equal(detail.data.vacancy.organization.name, 'ООО «Альфа»');
  assert.equal(detail.data.vacancy.views, undefined);
  const notes = await empA.c.get('/api/me/notifications');
  assert.ok(notes.data.items.some((n) => n.type === 'vacancy.approved'));
  // повторно одобрить нельзя
  assert.equal((await admin.c.post(`/api/admin/vacancies/${id}/approve`)).status, 409);
});

test('отклонение требует причину, причина видна работодателю; после правки вакансию можно снова отправить', async () => {
  const sub = await empA.c.post('/api/employer/vacancies', { ...H.vacancyBody({ title: 'Спорная вакансия' }), submit: true });
  const id = sub.data.vacancy.id;
  assert.equal((await admin.c.post(`/api/admin/vacancies/${id}/reject`, {})).status, 422);
  assert.equal((await admin.c.post(`/api/admin/vacancies/${id}/reject`, { note: 'Не указаны условия труда' })).status, 200);
  const mine = await empA.c.get(`/api/employer/vacancies/${id}`);
  assert.equal(mine.data.vacancy.status, 'rejected');
  assert.equal(mine.data.vacancy.moderationNote, 'Не указаны условия труда');
  const edit = await empA.c.put(`/api/employer/vacancies/${id}`, { conditions: ['Официальное оформление'], submit: true });
  assert.equal(edit.data.vacancy.status, 'pending');
  assert.equal(edit.data.vacancy.moderationNote, null);
});

test('правка опубликованной вакансии возвращает её на модерацию и скрывает из каталога', async () => {
  const id = await H.publishedVacancy(empA, admin, { title: 'Правим после публикации' });
  assert.equal((await t.client().get(`/api/vacancies/${id}`)).status, 200);
  const edit = await empA.c.put(`/api/employer/vacancies/${id}`, { title: 'Правим после публикации (новая версия)' });
  assert.equal(edit.data.vacancy.status, 'pending');
  assert.equal((await t.client().get(`/api/vacancies/${id}`)).status, 404);
});

test('работодатель управляет только своими вакансиями', async () => {
  const id = await H.publishedVacancy(empA, admin, { title: 'Вакансия Альфы' });
  assert.equal((await empB.c.get(`/api/employer/vacancies/${id}`)).status, 404);
  assert.equal((await empB.c.put(`/api/employer/vacancies/${id}`, { title: 'Взлом названия' })).status, 404);
  assert.equal((await empB.c.post(`/api/employer/vacancies/${id}/close`)).status, 404);
  assert.equal((await empB.c.delete(`/api/employer/vacancies/${id}`)).status, 404);
  const listB = await empB.c.get('/api/employer/vacancies');
  assert.ok(!listB.data.items.some((v) => v.id === id));
  assert.equal(t.db.get('SELECT title FROM vacancies WHERE id = ?', id).title, 'Вакансия Альфы');
});

test('закрытие вакансии, статусы active/closed в каталоге и запрет откликов', async () => {
  const id = await H.publishedVacancy(empA, admin, { title: 'Закрываемая вакансия' });
  assert.equal((await empA.c.post(`/api/employer/vacancies/${id}/close`)).data.vacancy.status, 'closed');
  assert.equal((await t.client().get('/api/vacancies?q=закрываемая')).data.total, 0);
  assert.equal((await t.client().get('/api/vacancies?q=закрываемая&status=closed')).data.total, 1);
  assert.equal((await t.client().get('/api/vacancies?q=закрываемая&status=all')).data.total, 1);
  const cand = await H.registerCandidate(t);
  const resume = await H.createResume(cand);
  const apply = await cand.c.post(`/api/vacancies/${id}/apply`, { resumeId: resume });
  assert.equal(apply.status, 409);
  assert.equal(apply.data.error.code, 'vacancy_closed');
});

test('удаление: вакансию с откликами удалить нельзя, без откликов можно', async () => {
  const id = await H.publishedVacancy(empA, admin, { title: 'Удаляемая с откликом' });
  const cand = await H.registerCandidate(t);
  await cand.c.post(`/api/vacancies/${id}/apply`, { resumeId: await H.createResume(cand) });
  const denied = await empA.c.delete(`/api/employer/vacancies/${id}`);
  assert.equal(denied.status, 409);
  const free = await empA.c.post('/api/employer/vacancies', H.vacancyBody({ title: 'Просто черновик' }));
  assert.equal((await empA.c.delete(`/api/employer/vacancies/${free.data.vacancy.id}`)).status, 200);
});

test('валидация вакансии: зарплата, категория, обязательные поля', async () => {
  const bad = await empA.c.post('/api/employer/vacancies', H.vacancyBody({ salaryMin: 90000, salaryMax: 50000 }));
  assert.equal(bad.status, 422);
  assert.ok(bad.data.error.fields.salaryMax);
  const cat = await empA.c.post('/api/employer/vacancies', H.vacancyBody({ categoryId: 999 }));
  assert.equal(cat.status, 422);
  const empty = await empA.c.post('/api/employer/vacancies', { title: 'x' });
  assert.equal(empty.status, 422);
  assert.ok(empty.data.error.fields.description);
});

test('каталог: фильтры работают вместе, сортировка и пагинация', async () => {
  const t2 = await H.startTestApp();
  try {
    const adm = await H.makeAdmin(t2);
    const e1 = await H.registerEmployer(t2, { organizationName: 'Грозный-Софт' });
    const e2 = await H.registerEmployer(t2, { organizationName: 'Аргун-Сети' });
    await H.publishedVacancy(e1, adm, { title: 'Python разработчик', city: 'Грозный', salaryMin: 90000, salaryMax: 120000, experience: '1-3', employmentType: 'full', categoryId: 1 });
    await H.publishedVacancy(e1, adm, { title: 'Бухгалтер', city: 'Грозный', salaryMin: 40000, salaryMax: 55000, experience: 'none', employmentType: 'part', categoryId: 4 });
    await H.publishedVacancy(e2, adm, { title: 'Сетевой инженер', city: 'Аргун', salaryMin: 70000, salaryMax: 90000, experience: 'lt1', employmentType: 'full', categoryId: 2 });
    await H.publishedVacancy(e2, adm, { title: 'Стажёр-программист', city: 'Аргун', salaryMin: null, salaryMax: null, experience: 'none', employmentType: 'internship', categoryId: 1 });
    const c = t2.client();
    const q = async (qs) => (await c.get(`/api/vacancies?${qs}`)).data;

    assert.equal((await q('')).total, 4);
    // поиск по должности без учёта регистра (кириллица)
    assert.deepEqual((await q('position=PYTHON')).items.map((v) => v.title), ['Python разработчик']);
    assert.equal((await q('position=бухгалтер')).total, 1);
    assert.equal((await q(`q=${encodeURIComponent('БУХГАЛТЕР')}`)).total, 1);
    // по работодателю и городу
    assert.equal((await q(`employer=${encodeURIComponent('аргун')}`)).total, 2);
    assert.equal((await q(`city=${encodeURIComponent('грозный')}`)).total, 2);
    // совместные фильтры: город + тип занятости
    assert.deepEqual((await q(`city=${encodeURIComponent('Грозный')}&type=part`)).items.map((v) => v.title), ['Бухгалтер']);
    assert.equal((await q(`city=${encodeURIComponent('Аргун')}&experience=none`)).total, 1);
    assert.equal((await q('category=programming')).total, 2);
    assert.equal((await q(`category=programming&city=${encodeURIComponent('Аргун')}`)).total, 1);
    // зарплата: вакансии без зарплаты не попадают
    assert.deepEqual((await q('salaryFrom=100000')).items.map((v) => v.title), ['Python разработчик']);
    assert.equal((await q('salaryFrom=60000')).total, 2);
    assert.equal((await q('salaryFrom=60000&type=full&experience=lt1')).total, 1);
    // комбинация, дающая пустой результат
    assert.equal((await q('salaryFrom=100000&city=' + encodeURIComponent('Аргун'))).total, 0);
    // сортировка по зарплате: вакансия без зарплаты в конце
    const bySalary = (await q('sort=salary&order=desc')).items.map((v) => v.title);
    assert.deepEqual(bySalary, ['Python разработчик', 'Сетевой инженер', 'Бухгалтер', 'Стажёр-программист']);
    const asc = (await q('sort=salary&order=asc')).items.map((v) => v.title);
    assert.equal(asc[0], 'Бухгалтер');
    assert.equal(asc[asc.length - 1], 'Стажёр-программист');
    // пагинация
    const p1 = await q('pageSize=3&page=1');
    const p2 = await q('pageSize=3&page=2');
    assert.equal(p1.items.length, 3);
    assert.equal(p2.items.length, 1);
    assert.equal(p1.pages, 2);
    assert.equal(p1.total, 4);
    assert.ok(!p1.items.some((v) => p2.items.some((w) => w.id === v.id)));
    // спецсимволы LIKE не работают как шаблон
    assert.equal((await q(`q=${encodeURIComponent('%')}`)).total, 0);
    assert.equal((await q(`q=${encodeURIComponent("'; DROP TABLE vacancies;--")}`)).total, 0);
    assert.equal((await q('')).total, 4);
  } finally { await t2.stop(); }
});

test('мета-данные и статистика считаются по базе', async () => {
  const meta = await t.client().get('/api/meta');
  assert.ok(meta.data.categories.length >= 5);
  const stats = (await t.client().get('/api/stats')).data;
  assert.equal(stats.activeVacancies, t.db.get("SELECT COUNT(*) AS n FROM vacancies WHERE status='published'").n);
  assert.equal(stats.candidates, t.db.get("SELECT COUNT(*) AS n FROM users WHERE role='candidate'").n);
});

test('избранное: добавление, список, удаление; работодатель не может сохранять', async () => {
  const id = await H.publishedVacancy(empA, admin, { title: 'Для избранного' });
  const cand = await H.registerCandidate(t);
  assert.equal((await cand.c.put(`/api/me/saved/${id}`)).data.saved, true);
  assert.equal((await cand.c.put(`/api/me/saved/${id}`)).status, 200);
  const list = await cand.c.get('/api/me/saved');
  assert.equal(list.data.items.filter((v) => v.id === id).length, 1);
  const cat = await cand.c.get('/api/vacancies?q=избранного');
  assert.equal(cat.data.items[0].saved, true);
  assert.equal((await cand.c.delete(`/api/me/saved/${id}`)).data.saved, false);
  assert.equal((await cand.c.get('/api/me/saved')).data.items.length, 0);
  assert.equal((await empA.c.put(`/api/me/saved/${id}`)).status, 403);
  assert.equal((await cand.c.put('/api/me/saved/99999')).status, 404);
});
