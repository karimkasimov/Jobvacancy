'use strict';
const fs = require('node:fs');
const V = require('../lib/validate');
const C = require('../lib/constants');
const { ApiError, notFound, conflict, forbidden } = require('../lib/errors');
const { requireRole, requireUser } = require('../lib/guards');
const { vacancyDto, VACANCY_SELECT, resumeDto, documentDto } = require('../lib/dto');
const { meDto, candidateProfileDto } = require('../lib/queries');
const { logActivity, notify, adminIds } = require('../lib/activity');
const U = require('../lib/uploads');
const { contentDisposition } = require('../lib/http');
const registry = require('../lib/registry');

const MAX_RESUMES = 5;
const MAX_DOCUMENTS = 20;

function register(router, { config, db }) {
  const nowIso = () => new Date().toISOString();
  const candidateOnly = requireRole('candidate');
  const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);

  // ------------------------------------------------------------------ профиль
  router.get('/api/me/profile', candidateOnly, (ctx) => ({
    user: meDto(db, ctx.user),
    profile: candidateProfileDto(db, ctx.user.id),
  }));

  router.put('/api/me/profile', candidateOnly, (ctx) => {
    const data = V.parse(ctx.body, {
      fullName: V.str({ min: 2, max: 120 }),
      phone: V.phone(),
      city: V.str({ max: 80, optional: true }),
      about: V.str({ max: 2000, multiline: true, optional: true }),
      skills: V.str({ max: 1000, multiline: true, optional: true }),
      desiredPosition: V.str({ max: 120, optional: true }),
      desiredSalary: V.int({ min: 0, max: 10_000_000, optional: true }),
      candidateType: V.oneOf(['applicant', 'student', 'graduate']),
    }, { partial: true });

    db.tx(() => {
      const u = [];
      const uv = [];
      if ('fullName' in data) { u.push('full_name = ?'); uv.push(data.fullName); }
      if ('phone' in data) { u.push('phone = ?'); uv.push(data.phone); }
      if (u.length) db.run(`UPDATE users SET ${u.join(', ')}, updated_at = ? WHERE id = ?`, ...uv, nowIso(), ctx.user.id);

      const map = { city: 'city', about: 'about', skills: 'skills', desiredPosition: 'desired_position', desiredSalary: 'desired_salary', candidateType: 'candidate_type' };
      const p = [];
      const pv = [];
      const current = db.get('SELECT verification_status FROM candidate_profiles WHERE user_id = ?', ctx.user.id);
      for (const [key, col] of Object.entries(map)) {
        if (!(key in data)) continue;
        // Подтверждённый статус студента/выпускника меняет только администратор.
        if (key === 'candidateType' && current && current.verification_status === 'verified') continue;
        p.push(`${col} = ?`);
        pv.push(data[key]);
      }
      if (p.length) db.run(`UPDATE candidate_profiles SET ${p.join(', ')}, updated_at = ? WHERE user_id = ?`, ...pv, nowIso(), ctx.user.id);
    });
    logActivity(db, ctx, 'profile.updated', 'user', ctx.user.id);
    const fresh = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { user: meDto(db, fresh), profile: candidateProfileDto(db, ctx.user.id) };
  });

  // ------------------------------------------------------------------ документы
  const ownDocument = (userId, id) => db.get('SELECT * FROM documents WHERE id = ? AND user_id = ?', id, userId);

  router.get('/api/me/documents', candidateOnly, (ctx) => ({
    items: db.all('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC, id DESC', ctx.user.id).map(documentDto),
  }));

  router.post('/api/me/documents', { limit: 'upload', multipart: true }, candidateOnly, async (ctx) => {
    const { fields, files } = await ctx.readMultipart(config.maxUploadBytes);
    const kind = ['resume', 'verification', 'other'].includes(fields.kind) ? fields.kind : 'other';
    const file = files.find((f) => f.field === 'file');
    const info = U.validateFile(file, { allowed: U.DOCUMENT_EXTENSIONS, maxBytes: config.maxUploadBytes });
    if (db.get('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?', ctx.user.id).n >= MAX_DOCUMENTS) {
      throw conflict(`Достигнут лимит документов (${MAX_DOCUMENTS}). Удалите ненужные файлы.`, 'documents_limit');
    }
    const stored = U.storeFile(config.uploadDir, 'documents', info.ext, file.data);
    const r = db.run('INSERT INTO documents (user_id, kind, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
      ctx.user.id, kind, info.originalName, stored, info.mime, file.data.length);
    logActivity(db, ctx, 'document.uploaded', 'document', Number(r.lastInsertRowid), { kind, size: file.data.length });
    ctx.status = 201;
    return { document: documentDto(db.get('SELECT * FROM documents WHERE id = ?', Number(r.lastInsertRowid))) };
  });

  router.delete('/api/me/documents/:id', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const doc = id && ownDocument(ctx.user.id, id);
    if (!doc) throw notFound('Документ не найден.');
    const pending = db.get("SELECT 1 AS x FROM verification_requests WHERE document_id = ? AND status = 'pending'", id);
    if (pending) throw conflict('Документ прикреплён к заявке на подтверждение статуса, которая ещё рассматривается.');
    db.run('DELETE FROM documents WHERE id = ?', id);
    U.removeFile(config.uploadDir, 'documents', doc.stored_name);
    logActivity(db, ctx, 'document.deleted', 'document', id);
    return { ok: true };
  });

  // Скачивание: владелец, администратор или работодатель, которому кандидат отправил это резюме откликом.
  router.get('/api/documents/:id/download', requireUser, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const doc = id && db.get('SELECT * FROM documents WHERE id = ?', id);
    if (!doc) throw notFound('Документ не найден.');
    let allowed = ctx.user.role === 'admin' || doc.user_id === ctx.user.id;
    if (!allowed && ctx.user.role === 'employer') {
      allowed = !!db.get(
        `SELECT 1 AS x FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         JOIN employer_profiles ep ON ep.organization_id = v.organization_id
         WHERE a.resume_document_id = ? AND ep.user_id = ?`,
        id, ctx.user.id,
      );
    }
    if (!allowed) throw notFound('Документ не найден.');
    const file = U.storedPath(config.uploadDir, 'documents', doc.stored_name);
    if (!file) throw notFound('Файл не найден на сервере.');
    if (ctx.user.role === 'admin' && doc.user_id !== ctx.user.id) logActivity(db, ctx, 'document.viewed_by_admin', 'document', id);
    ctx.sendRaw(200, fs.readFileSync(file), {
      'Content-Type': doc.mime,
      'Content-Disposition': contentDisposition('attachment', doc.original_name),
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  // ------------------------------------------------------------------ резюме
  const resumeSchema = {
    title: V.str({ min: 2, max: 120 }),
    desiredPosition: V.str({ max: 120, optional: true }),
    about: V.str({ max: 2000, multiline: true, optional: true }),
    experience: V.str({ max: 4000, multiline: true, optional: true }),
    education: V.str({ max: 2000, multiline: true, optional: true }),
    skills: V.str({ max: 1000, multiline: true, optional: true }),
    documentId: V.int({ min: 1, optional: true }),
    isPrimary: V.bool({ optional: true }),
  };

  function checkDocumentOwnership(userId, documentId) {
    if (documentId === null || documentId === undefined) return;
    const d = ownDocument(userId, documentId);
    if (!d || d.kind === 'verification') throw invalid({ documentId: 'Файл не найден среди ваших документов.' });
  }

  const loadResume = (userId, id) => {
    const r = id && db.get('SELECT * FROM resumes WHERE id = ? AND user_id = ?', id, userId);
    if (!r) throw notFound('Резюме не найдено.');
    return r;
  };
  const resumeWithDoc = (r) => resumeDto(r, r.document_id ? db.get('SELECT id, original_name, size FROM documents WHERE id = ?', r.document_id) : null);

  router.get('/api/me/resumes', candidateOnly, (ctx) => ({
    items: db.all('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_primary DESC, updated_at DESC', ctx.user.id).map(resumeWithDoc),
  }));

  router.post('/api/me/resumes', candidateOnly, (ctx) => {
    const data = V.parse(ctx.body, resumeSchema);
    checkDocumentOwnership(ctx.user.id, data.documentId);
    const count = db.get('SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?', ctx.user.id).n;
    if (count >= MAX_RESUMES) throw conflict(`Можно создать не более ${MAX_RESUMES} резюме.`, 'resumes_limit');
    const makePrimary = count === 0 || data.isPrimary === true;
    const id = db.tx(() => {
      if (makePrimary) db.run('UPDATE resumes SET is_primary = 0 WHERE user_id = ?', ctx.user.id);
      const r = db.run(
        `INSERT INTO resumes (user_id, title, desired_position, about, experience, education, skills, document_id, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.user.id, data.title, data.desiredPosition, data.about, data.experience, data.education, data.skills, data.documentId, makePrimary ? 1 : 0,
      );
      return Number(r.lastInsertRowid);
    });
    logActivity(db, ctx, 'resume.created', 'resume', id);
    ctx.status = 201;
    return { resume: resumeWithDoc(loadResume(ctx.user.id, id)) };
  });

  router.put('/api/me/resumes/:id', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const existing = loadResume(ctx.user.id, id);
    const data = V.parse(ctx.body, resumeSchema, { partial: true });
    if ('documentId' in data) checkDocumentOwnership(ctx.user.id, data.documentId);
    const map = { title: 'title', desiredPosition: 'desired_position', about: 'about', experience: 'experience', education: 'education', skills: 'skills', documentId: 'document_id' };
    db.tx(() => {
      const sets = [];
      const vals = [];
      for (const [k, col] of Object.entries(map)) if (k in data) { sets.push(`${col} = ?`); vals.push(data[k]); }
      if (data.isPrimary === true) {
        db.run('UPDATE resumes SET is_primary = 0 WHERE user_id = ?', ctx.user.id);
        sets.push('is_primary = 1');
      }
      if (sets.length) db.run(`UPDATE resumes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), existing.id);
    });
    logActivity(db, ctx, 'resume.updated', 'resume', id);
    return { resume: resumeWithDoc(loadResume(ctx.user.id, id)) };
  });

  router.delete('/api/me/resumes/:id', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const existing = loadResume(ctx.user.id, id);
    db.tx(() => {
      db.run('DELETE FROM resumes WHERE id = ?', id);
      if (existing.is_primary) {
        const next = db.get('SELECT id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', ctx.user.id);
        if (next) db.run('UPDATE resumes SET is_primary = 1 WHERE id = ?', next.id);
      }
    });
    logActivity(db, ctx, 'resume.deleted', 'resume', id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ избранное
  router.get('/api/me/saved', candidateOnly, (ctx) => {
    const rows = db.all(
      `${VACANCY_SELECT} JOIN saved_vacancies sv ON sv.vacancy_id = v.id
       WHERE sv.user_id = ? AND v.status IN ('published', 'closed') ORDER BY sv.created_at DESC LIMIT 200`,
      ctx.user.id,
    );
    return { items: rows.map((r) => ({ ...vacancyDto(r), responsibilities: undefined, requirements: undefined, conditions: undefined, saved: true })) };
  });

  router.put('/api/me/saved/:vacancyId', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.vacancyId);
    const v = id && db.get("SELECT id FROM vacancies WHERE id = ? AND status IN ('published', 'closed')", id);
    if (!v) throw notFound('Вакансия не найдена.');
    db.run('INSERT OR IGNORE INTO saved_vacancies (user_id, vacancy_id) VALUES (?, ?)', ctx.user.id, id);
    return { saved: true };
  });

  router.delete('/api/me/saved/:vacancyId', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.vacancyId);
    if (id) db.run('DELETE FROM saved_vacancies WHERE user_id = ? AND vacancy_id = ?', ctx.user.id, id);
    return { saved: false };
  });

  // ------------------------------------------------------------------ подтверждение статуса студента / выпускника
  const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я\s-]/g, ' ').trim().split(/\s+/);

  function verificationState(userId) {
    const profile = candidateProfileDto(db, userId);
    const pending = db.get("SELECT * FROM verification_requests WHERE user_id = ? AND status = 'pending'", userId);
    const history = db.all(
      `SELECT h.action, h.note, h.created_at, vr.claimed_kind FROM verification_history h
       LEFT JOIN verification_requests vr ON vr.id = h.request_id
       WHERE h.user_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 50`,
      userId,
    ).map((h) => ({ action: h.action, note: h.note, kind: h.claimed_kind, createdAt: h.created_at }));
    return {
      status: profile.verificationStatus,
      statusLabel: profile.verificationLabel,
      verifiedKind: profile.verifiedKind,
      verifiedAt: profile.verifiedAt,
      groupName: profile.groupName,
      pending: pending ? { id: pending.id, kind: pending.claimed_kind, studentNumber: pending.student_number, createdAt: pending.created_at } : null,
      history,
    };
  }

  router.get('/api/me/verification', candidateOnly, (ctx) => verificationState(ctx.user.id));

  // Кандидату не сообщается, нашлась ли запись в реестре: результат сверки видит только администратор.
  router.post('/api/me/verification', { limit: 'verification' }, candidateOnly, async (ctx) => {
    const data = V.parse(ctx.body, {
      claimedKind: V.oneOf(['student', 'graduate']),
      studentNumber: V.str({ min: 3, max: 40, pattern: /^[A-Za-zА-Яа-яЁё0-9._\-/]+$/, message: 'Допустимы буквы, цифры и символы . _ - /' }),
      documentId: V.int({ min: 1, optional: true }),
      comment: V.str({ max: 500, multiline: true, optional: true }),
    });
    const profile = db.get('SELECT verification_status FROM candidate_profiles WHERE user_id = ?', ctx.user.id);
    if (profile.verification_status === 'verified') throw conflict('Ваш статус уже подтверждён.', 'already_verified');
    if (db.get("SELECT 1 AS x FROM verification_requests WHERE user_id = ? AND status = 'pending'", ctx.user.id)) {
      throw conflict('Заявка уже отправлена и ожидает проверки.', 'already_pending');
    }
    if (data.documentId) {
      const d = ownDocument(ctx.user.id, data.documentId);
      if (!d) throw invalid({ documentId: 'Файл не найден среди ваших документов.' });
    }
    const reg = await registry.findByNumber(db, data.studentNumber);
    let match = 'not_found';
    if (reg) {
      const surnameOk = normName(reg.full_name)[0] === normName(ctx.user.full_name)[0];
      match = reg.kind === data.claimedKind && surnameOk ? 'match' : 'partial';
    }
    const reqId = db.tx(() => {
      const r = db.run(
        `INSERT INTO verification_requests (user_id, claimed_kind, student_number, document_id, comment, registry_id, registry_match)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ctx.user.id, data.claimedKind, data.studentNumber.toUpperCase(), data.documentId, data.comment, reg ? reg.id : null, match,
      );
      const id = Number(r.lastInsertRowid);
      db.run("UPDATE candidate_profiles SET verification_status = 'pending', updated_at = ? WHERE user_id = ?", nowIso(), ctx.user.id);
      db.run("INSERT INTO verification_history (request_id, user_id, action, actor_id) VALUES (?, ?, 'submitted', ?)", id, ctx.user.id, ctx.user.id);
      return id;
    });
    for (const adminId of adminIds(db)) {
      notify(db, adminId, { type: 'verification.submitted', title: 'Новая заявка на подтверждение статуса', body: `${ctx.user.full_name} просит подтвердить статус.`, link: '/admin#students' });
    }
    logActivity(db, ctx, 'verification.submitted', 'verification_request', reqId);
    ctx.status = 201;
    return verificationState(ctx.user.id);
  });
}

module.exports = { register };
