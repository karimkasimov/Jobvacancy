'use strict';
const V = require('../lib/validate');
const C = require('../lib/constants');
const { ApiError, notFound, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/guards');
const { logActivity, notify, notifyMany, orgEmployerIds } = require('../lib/activity');
const { pageParams, pageResult } = require('../lib/queries');

/** Отклики со стороны кандидата: отправка, история, отзыв. */
function register(router, { db }) {
  const candidateOnly = requireRole('candidate');
  const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);

  function historyFor(applicationId) {
    return db.all('SELECT to_status, created_at FROM application_status_history WHERE application_id = ? ORDER BY created_at, id', applicationId)
      .map((h) => ({ status: h.to_status, statusLabel: C.APPLICATION_STATUSES[h.to_status], createdAt: h.created_at }));
  }

  function candidateApplicationDto(a) {
    let resume = null;
    try { resume = a.resume_snapshot ? JSON.parse(a.resume_snapshot) : null; } catch { resume = null; }
    return {
      id: a.id,
      status: a.status,
      statusLabel: C.APPLICATION_STATUSES[a.status],
      coverLetter: a.cover_letter,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      statusChangedAt: a.status_changed_at,
      canWithdraw: !C.FINAL_APPLICATION_STATUSES.includes(a.status),
      resumeTitle: resume ? resume.title : null,
      vacancy: { id: a.vacancy_id, title: a.vacancy_title, status: a.vacancy_status, organizationName: a.org_name, city: a.vacancy_city },
      history: historyFor(a.id),
    };
  }

  const APP_SELECT = `
    SELECT a.*, v.title AS vacancy_title, v.status AS vacancy_status, v.city AS vacancy_city, o.name AS org_name
    FROM applications a
    JOIN vacancies v ON v.id = a.vacancy_id
    JOIN organizations o ON o.id = v.organization_id`;

  router.post('/api/vacancies/:id/apply', candidateOnly, (ctx) => {
    const vacancyId = V.parseId(ctx.params.id);
    const vacancy = vacancyId && db.get('SELECT id, title, status, organization_id FROM vacancies WHERE id = ?', vacancyId);
    if (!vacancy || !['published', 'closed'].includes(vacancy.status)) throw notFound('Вакансия не найдена.');
    if (vacancy.status !== 'published') throw conflict('Вакансия закрыта — отклики больше не принимаются.', 'vacancy_closed');

    const data = V.parse(ctx.body, {
      resumeId: V.int({ min: 1 }),
      coverLetter: V.str({ max: 2000, multiline: true, optional: true }),
    });
    const resume = db.get('SELECT * FROM resumes WHERE id = ? AND user_id = ?', data.resumeId, ctx.user.id);
    if (!resume) throw invalid({ resumeId: 'Выберите одно из ваших резюме.' });

    if (db.get("SELECT 1 AS x FROM applications WHERE vacancy_id = ? AND candidate_id = ? AND status <> 'withdrawn'", vacancyId, ctx.user.id)) {
      throw conflict('Вы уже откликались на эту вакансию.', 'duplicate_application');
    }
    const doc = resume.document_id ? db.get('SELECT id, original_name FROM documents WHERE id = ?', resume.document_id) : null;
    const snapshot = JSON.stringify({
      title: resume.title, desiredPosition: resume.desired_position, about: resume.about, experience: resume.experience,
      education: resume.education, skills: resume.skills, documentName: doc ? doc.original_name : null,
    });

    let appId;
    try {
      appId = db.tx(() => {
        const r = db.run(
          `INSERT INTO applications (vacancy_id, candidate_id, resume_id, resume_document_id, resume_snapshot, cover_letter)
           VALUES (?, ?, ?, ?, ?, ?)`,
          vacancyId, ctx.user.id, resume.id, doc ? doc.id : null, snapshot, data.coverLetter,
        );
        const id = Number(r.lastInsertRowid);
        db.run("INSERT INTO application_status_history (application_id, from_status, to_status, changed_by) VALUES (?, NULL, 'sent', ?)", id, ctx.user.id);
        return id;
      });
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err.message))) throw conflict('Вы уже откликались на эту вакансию.', 'duplicate_application');
      throw err;
    }
    notifyMany(db, orgEmployerIds(db, vacancy.organization_id), {
      type: 'application.new', title: 'Новый отклик', body: `${ctx.user.full_name} откликнулся на вакансию «${vacancy.title}».`, link: '/employer#applications',
    });
    logActivity(db, ctx, 'application.created', 'application', appId, { vacancyId });
    ctx.status = 201;
    return { application: candidateApplicationDto(db.get(`${APP_SELECT} WHERE a.id = ?`, appId)) };
  });

  router.get('/api/me/applications', candidateOnly, (ctx) => {
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 50 });
    const status = C.APPLICATION_STATUSES[ctx.query.status] ? ctx.query.status : null;
    const where = `a.candidate_id = ?${status ? ' AND a.status = ?' : ''}`;
    const params = status ? [ctx.user.id, status] : [ctx.user.id];
    const total = db.get(`SELECT COUNT(*) AS n FROM applications a WHERE ${where}`, ...params).n;
    const rows = db.all(`${APP_SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(candidateApplicationDto), total, pg);
  });

  router.post('/api/applications/:id/withdraw', candidateOnly, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const app = id && db.get(`${APP_SELECT} WHERE a.id = ? AND a.candidate_id = ?`, id, ctx.user.id);
    if (!app) throw notFound('Отклик не найден.');
    if (C.FINAL_APPLICATION_STATUSES.includes(app.status)) {
      throw conflict(app.status === 'withdrawn' ? 'Отклик уже отозван.' : 'Отклик уже рассмотрен, отозвать его нельзя.', 'cannot_withdraw');
    }
    const now = new Date().toISOString();
    db.tx(() => {
      db.run("UPDATE applications SET status = 'withdrawn', updated_at = ?, status_changed_at = ? WHERE id = ?", now, now, id);
      db.run("INSERT INTO application_status_history (application_id, from_status, to_status, changed_by) VALUES (?, ?, 'withdrawn', ?)", id, app.status, ctx.user.id);
    });
    const org = db.get('SELECT organization_id FROM vacancies WHERE id = ?', app.vacancy_id);
    notifyMany(db, orgEmployerIds(db, org.organization_id), {
      type: 'application.withdrawn', title: 'Отклик отозван', body: `${ctx.user.full_name} отозвал отклик на «${app.vacancy_title}».`, link: '/employer#applications',
    });
    logActivity(db, ctx, 'application.withdrawn', 'application', id);
    return { application: candidateApplicationDto(db.get(`${APP_SELECT} WHERE a.id = ?`, id)) };
  });
}

module.exports = { register };
