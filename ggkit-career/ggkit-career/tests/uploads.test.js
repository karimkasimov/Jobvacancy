'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let t, cand, emp;
before(async () => {
  t = await H.startTestApp({ maxUploadBytes: 10 * 1024 });
  cand = await H.registerCandidate(t);
  emp = await H.registerEmployer(t);
});
after(async () => { await t.stop(); });

const docsDir = () => path.join(t.app.config.uploadDir, 'documents');

test('PDF принимается, хранится вне публичной папки под случайным именем', async () => {
  const r = await cand.c.upload('/api/me/documents', 'Резюме Иванов.pdf', H.PDF, { kind: 'resume' });
  assert.equal(r.status, 201);
  assert.equal(r.data.document.name, 'Резюме Иванов.pdf');
  assert.equal(r.data.document.mime, 'application/pdf');
  const row = t.db.get('SELECT * FROM documents WHERE id = ?', r.data.document.id);
  assert.match(row.stored_name, /^[a-f0-9]{32}\.pdf$/);
  assert.ok(fs.existsSync(path.join(docsDir(), row.stored_name)));
  assert.ok(!path.join(docsDir(), row.stored_name).startsWith(t.app.config.publicDir));
  const dl = await cand.c.raw('GET', `/api/documents/${r.data.document.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), H.PDF);
});

test('расширение не совпадает с содержимым — отказ', async () => {
  const r = await cand.c.upload('/api/me/documents', 'fake.pdf', H.PNG);
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'invalid_file_content');
  const html = await cand.c.upload('/api/me/documents', 'cv.pdf', Buffer.from('<html><script>alert(1)</script></html>'));
  assert.equal(html.status, 400);
});

test('недопустимые расширения отклоняются', async () => {
  for (const name of ['virus.exe', 'page.html', 'icon.svg', 'script.js', 'noext', 'archive.zip']) {
    const r = await cand.c.upload('/api/me/documents', name, H.PDF);
    assert.equal(r.status, 400, name);
    assert.equal(r.data.error.code, 'invalid_file_type', name);
  }
});

test('ограничение размера файла', async () => {
  const big = Buffer.concat([H.PDF, Buffer.alloc(20 * 1024, 65)]);
  const r = await cand.c.upload('/api/me/documents', 'big.pdf', big);
  assert.equal(r.status, 413);
  assert.equal(r.data.error.code, 'file_too_large');
});

test('имя файла очищается от путей и спецсимволов', async () => {
  const r = await cand.c.upload('/api/me/documents', '../../etc/passwd.pdf', H.PDF);
  assert.equal(r.status, 201);
  assert.equal(r.data.document.name, 'passwd.pdf');
  const r2 = await cand.c.upload('/api/me/documents', '..\\..\\windows\\evil<>.pdf', H.PDF);
  assert.equal(r2.status, 201);
  assert.ok(!/[\\/<>]/.test(r2.data.document.name));
});

test('пустой файл, отсутствие файла и неверный тип запроса', async () => {
  assert.equal((await cand.c.upload('/api/me/documents', 'empty.pdf', Buffer.alloc(0))).status, 400);
  assert.equal((await cand.c.upload('/api/me/documents', 'cv.pdf', H.PDF, {}, 'other_field')).status, 400);
  assert.equal((await cand.c.post('/api/me/documents', {})).status, 415);
});

test('загрузка требует входа и роли соискателя', async () => {
  assert.equal((await t.client().upload('/api/me/documents', 'cv.pdf', H.PDF)).status, 401);
  assert.equal((await emp.c.upload('/api/me/documents', 'cv.pdf', H.PDF)).status, 403);
});

test('удаление документа удаляет файл с диска; чужой документ не удалить', async () => {
  const up = await cand.c.upload('/api/me/documents', 'del.pdf', H.PDF);
  const row = t.db.get('SELECT stored_name FROM documents WHERE id = ?', up.data.document.id);
  const full = path.join(docsDir(), row.stored_name);
  assert.ok(fs.existsSync(full));
  assert.equal((await cand.c.delete(`/api/me/documents/${up.data.document.id}`)).status, 200);
  assert.ok(!fs.existsSync(full));
  assert.equal((await cand.c.get(`/api/documents/${up.data.document.id}/download`)).status, 404);
});

test('логотип организации: PNG принимается, публичная выдача только для видимых организаций, с изоляцией', async () => {
  const r = await emp.c.upload('/api/employer/organization/logo', 'logo.png', H.PNG);
  assert.equal(r.status, 200);
  assert.equal(r.data.organization.logoUrl, `/api/organizations/${emp.orgId}/logo`);
  // организация не в каталоге и без вакансий — логотип не раздаётся публично
  assert.equal((await t.client().get(`/api/organizations/${emp.orgId}/logo`)).status, 404);
  t.db.run('UPDATE organizations SET is_partner_listed = 1 WHERE id = ?', emp.orgId);
  const pub = await t.client().raw('GET', `/api/organizations/${emp.orgId}/logo`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/png');
  assert.equal(pub.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pub.headers.get('content-security-policy'), /sandbox/);
  // неверные форматы логотипа
  assert.equal((await emp.c.upload('/api/employer/organization/logo', 'logo.svg', Buffer.from('<svg onload="alert(1)"/>'))).status, 400);
  assert.equal((await emp.c.upload('/api/employer/organization/logo', 'logo.pdf', H.PDF)).status, 400);
  assert.equal((await cand.c.upload('/api/employer/organization/logo', 'logo.png', H.PNG)).status, 403);
  // замена удаляет старый файл
  const old = t.db.get('SELECT logo_path FROM organizations WHERE id = ?', emp.orgId).logo_path;
  await emp.c.upload('/api/employer/organization/logo', 'new.png', Buffer.concat([H.PNG, Buffer.from('2')]));
  assert.ok(!fs.existsSync(path.join(t.app.config.uploadDir, 'logos', old)));
  assert.equal((await emp.c.delete('/api/employer/organization/logo')).data.organization.logoUrl, null);
});

test('лимит количества документов на пользователя', async () => {
  const c2 = await H.registerCandidate(t);
  for (let i = 0; i < 20; i += 1) assert.equal((await c2.c.upload('/api/me/documents', `f${i}.pdf`, H.PDF)).status, 201);
  const r = await c2.c.upload('/api/me/documents', 'extra.pdf', H.PDF);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'documents_limit');
});
