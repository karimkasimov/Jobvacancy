'use strict';
const fs = require('node:fs');
const V = require('../lib/validate');
const C = require('../lib/constants');
const { ApiError, notFound, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/guards');
const { vacancyDto, organizationDto, VACANCY_SELECT } = require('../lib/dto');
const { employerOrg, ownVacancy, getVacancyRow, pageParams, pageResult, candidateProfileDto } = require('../lib/queries');
const { logActivity, notify, adminIds } = require('../lib/activity');
const VI = require('../lib/vacancyInput');
const { APP_SELECT, appListDto, applicationDetail: buildApplicationDetail } = require('../lib/applicationView');
const U = require('../lib/uploads');

function register(router, { config, db }) {
  const employerOnly = requireRole('employer');
  const nowIso = () => new Date().toISOString();
  const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);

  // ------------------------------------------------------------------ организация
  function orgPayload(org) {
    const lastRequest = db.get('SELECT status, message, review_note, created_at, reviewed_at FROM organization_verification_requests WHERE organization_id = ? ORDER BY id DESC LIMIT 1', org.id);
    return {
      organization: organizationDto(org, { verificationNote: org.verification_note }),
      verificationRequest: lastRequest
        ? { status: lastRequest.status, message: lastRequest.message, reviewNote: lastRequest.review_note, createdAt: lastRequest.created_at, reviewedAt: lastRequest.reviewed_at }
        : null,
    };
  }

  router.get('/api/employer/organization', employerOnly, (ctx) => orgPayload(employerOrg(db, ctx.user)));

  router.put('/api/employer/organization', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const data = V.parse(ctx.body, {
      name: V.str({ min: 2, max: 200 }),
      description: V.str({ max: 2000, multiline: true, optional: true }),
      city: V.str({ min: 2, max: 80 }),
      address: V.str({ max: 250, optional: true }),
      industry: V.str({ max: 100, optional: true }),
      specialties: V.str({ max: 300, optional: true }),
      website: V.url(),
      contactPerson: V.str({ max: 150, optional: true }),
      contactEmail: V.email({ optional: true }),
      contactPhone: V.phone(),
    }, { partial: true });
    const map = { name: 'name', description: 'description', city: 'city', address: 'address', industry: 'industry', specialties: 'specialties_text', website: 'website', contactPerson: 'contact_person', contactEmail: 'contact_email', contactPhone: 'contact_phone' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) if (k in data) { sets.push(`${col} = ?`); vals.push(data[k]); }
    // Переименование проверенной организации требует повторной проверки.
    if (data.name && data.name !== org.name && org.verification_status === 'verified') {
      sets.push("verification_status = 'unverified'", "verification_note = 'Название изменено — требуется повторная проверка.'");
    }
    if (sets.length) db.run(`UPDATE organizations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), org.id);
    logActivity(db, ctx, 'organization.updated', 'organization', org.id);
    return orgPayload(db.get('SELECT * FROM organizations WHERE id = ?', org.id));
  });

  router.post('/api/employer/organization/logo', { limit: 'upload', multipart: true }, employerOnly, async (ctx) => {
    const org = employerOrg(db, ctx.user);
    const { files } = await ctx.readMultipart(config.maxLogoBytes);
    const file = files.find((f) => f.field === 'file');
    const info = U.validateFile(file, { allowed: U.LOGO_EXTENSIONS, maxBytes: config.maxLogoBytes });
    const stored = U.storeFile(config.uploadDir, 'logos', info.ext, file.data);
    db.run('UPDATE organizations SET logo_path = ?, logo_mime = ?, updated_at = ? WHERE id = ?', stored, info.mime, nowIso(), org.id);
    if (org.logo_path) U.removeFile(config.uploadDir, 'logos', org.logo_path);
    logActivity(db, ctx, 'organization.logo_uploaded', 'organization', org.id);
    return orgPayload(db.get('SELECT * FROM organizations WHERE id = ?', org.id));
  });

  router.delete('/api/employer/organization/logo', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    if (org.logo_path) {
      db.run('UPDATE organizations SET logo_path = NULL, logo_mime = NULL, updated_at = ? WHERE id = ?', nowIso(), org.id);
      U.removeFile(config.uploadDir, 'logos', org.logo_path);
    }
    return orgPayload(db.get('SELECT * FROM organizations WHERE id = ?', org.id));
  });

  router.post('/api/employer/organization/verification-request', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const { message } = V.parse(ctx.body, { message: V.str({ max: 1000, multiline: true, optional: true }) });
    if (org.verification_status === 'verified') throw conflict('Организация уже проверена.', 'already_verified');
    if (org.verification_status === 'pending') throw conflict('Заявка на проверку уже отправлена.', 'already_pending');
    if (!org.contact_email && !org.contact_phone) throw invalid({ message: 'Перед отправкой заполните контактный email или телефон организации.' });
    db.tx(() => {
      db.run('INSERT INTO organization_verification_requests (organization_id, requested_by, message) VALUES (?, ?, ?)', org.id, ctx.user.id, message);
      db.run("UPDATE organizations SET verification_status = 'pending', updated_at = ? WHERE id = ?", nowIso(), org.id);
    });
    for (const id of adminIds(db)) notify(db, id, { type: 'organization.verification', title: 'Заявка на проверку организации', body: `«${org.name}» просит подтвердить статус.`, link: '/admin#organizations' });
    logActivity(db, ctx, 'organization.verification_requested', 'organization', org.id);
    ctx.status = 201;
    return orgPayload(db.get('SELECT * FROM organizations WHERE id = ?', org.id));
  });

  // ------------------------------------------------------------------ вакансии
  const withCounts = (v) => ({
    ...vacancyDto(v),
    moderationNote: v.moderation_note,
    applicationsCount: v.applications_count,
    newApplicationsCount: v.new_applications_count,
  });
  const LIST_SELECT = `${VACANCY_SELECT.replace('FROM vacancies v', `,
    (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.id AND a.status <> 'withdrawn') AS applications_count,
    (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.id AND a.status = 'sent') AS new_applications_count
    FROM vacancies v`)}`;

  router.get('/api/employer/vacancies', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 100 });
    const where = ['v.organization_id = ?'];
    const params = [org.id];
    if (C.VACANCY_STATUSES[ctx.query.status]) { where.push('v.status = ?'); params.push(ctx.query.status); }
    if (typeof ctx.query.q === 'string' && ctx.query.q.trim()) {
      where.push("lc(v.title) LIKE ? ESCAPE '\\'");
      params.push(`%${V.escapeLike(ctx.query.q.trim().toLowerCase().slice(0, 100))}%`);
    }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM vacancies v WHERE ${w}`, ...params).n;
    const rows = db.all(`${LIST_SELECT} WHERE ${w} ORDER BY v.updated_at DESC, v.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(withCounts), total, pg);
  });

  router.get('/api/employer/vacancies/:id', employerOnly, (ctx) => {
    const { row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    return { vacancy: withCounts(db.get(`${LIST_SELECT} WHERE v.id = ?`, row.id)) };
  });

  router.post('/api/employer/vacancies', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const { submit } = V.parse(ctx.body, { submit: V.bool({ optional: true }) });
    const data = V.parse(ctx.body, VI.schema);
    const status = submit ? 'pending' : 'draft';
    const id = db.tx(() => VI.insertVacancy(db, { organizationId: org.id, userId: ctx.user.id, data, status }));
    if (submit) {
      for (const a of adminIds(db)) notify(db, a, { type: 'vacancy.pending', title: 'Вакансия на модерации', body: `«${data.title}» — ${org.name}.`, link: '/admin#vacancies' });
    }
    logActivity(db, ctx, 'vacancy.created', 'vacancy', id, { status });
    ctx.status = 201;
    return { vacancy: withCounts(db.get(`${LIST_SELECT} WHERE v.id = ?`, id)) };
  });

  router.put('/api/employer/vacancies/:id', employerOnly, (ctx) => {
    const { org, row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    const { submit } = V.parse(ctx.body, { submit: V.bool({ optional: true }) });
    const data = V.parse(ctx.body, VI.schema, { partial: true });
    const extra = {};
    // Любая правка опубликованной или ожидающей вакансии возвращает её на модерацию.
    if (['published', 'pending'].includes(row.status) && Object.keys(data).length) extra.status = 'pending';
    if (submit && ['draft', 'rejected'].includes(row.status)) extra.status = 'pending';
    if (extra.status === 'pending') { extra.moderation_note = null; }
    db.tx(() => VI.updateVacancyColumns(db, row.id, row, data, extra));
    if (extra.status === 'pending') {
      for (const a of adminIds(db)) notify(db, a, { type: 'vacancy.pending', title: 'Вакансия на модерации', body: `«${data.title || row.title}» — ${org.name}.`, link: '/admin#vacancies' });
    }
    logActivity(db, ctx, 'vacancy.updated', 'vacancy', row.id, { status: extra.status || row.status });
    return { vacancy: withCounts(db.get(`${LIST_SELECT} WHERE v.id = ?`, row.id)) };
  });

  router.post('/api/employer/vacancies/:id/publish', employerOnly, (ctx) => {
    const { org, row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    if (['pending', 'published'].includes(row.status)) throw conflict(row.status === 'pending' ? 'Вакансия уже отправлена на модерацию.' : 'Вакансия уже опубликована.');
    db.run("UPDATE vacancies SET status = 'pending', moderation_note = NULL, closed_at = NULL, updated_at = ? WHERE id = ?", nowIso(), row.id);
    for (const a of adminIds(db)) notify(db, a, { type: 'vacancy.pending', title: 'Вакансия на модерации', body: `«${row.title}» — ${org.name}.`, link: '/admin#vacancies' });
    logActivity(db, ctx, 'vacancy.submitted', 'vacancy', row.id);
    return { vacancy: withCounts(db.get(`${LIST_SELECT} WHERE v.id = ?`, row.id)) };
  });

  router.post('/api/employer/vacancies/:id/close', employerOnly, (ctx) => {
    const { row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    if (!['published', 'pending'].includes(row.status)) throw conflict('Закрыть можно только опубликованную вакансию или вакансию на модерации.');
    db.run("UPDATE vacancies SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), row.id);
    logActivity(db, ctx, 'vacancy.closed', 'vacancy', row.id);
    return { vacancy: withCounts(db.get(`${LIST_SELECT} WHERE v.id = ?`, row.id)) };
  });

  router.delete('/api/employer/vacancies/:id', employerOnly, (ctx) => {
    const { row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    const apps = db.get('SELECT COUNT(*) AS n FROM applications WHERE vacancy_id = ?', row.id).n;
    if (apps > 0) throw conflict('У вакансии есть отклики — удалить её нельзя. Закройте вакансию.', 'has_applications');
    db.run('DELETE FROM vacancies WHERE id = ?', row.id);
    logActivity(db, ctx, 'vacancy.deleted', 'vacancy', row.id);
    return { ok: true };
  });

  router.get('/api/employer/vacancies/:id/stats', employerOnly, (ctx) => {
    const { row } = ownVacancy(db, ctx.user, V.parseId(ctx.params.id));
    const byStatus = {};
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM applications WHERE vacancy_id = ? GROUP BY status', row.id)) byStatus[r.status] = r.n;
    return {
      views: row.views,
      applications: Object.entries(byStatus).filter(([s]) => s !== 'withdrawn').reduce((a, [, n]) => a + n, 0),
      byStatus,
      saved: db.get('SELECT COUNT(*) AS n FROM saved_vacancies WHERE vacancy_id = ?', row.id).n,
    };
  });

  router.get('/api/employer/stats', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const vac = {};
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM vacancies WHERE organization_id = ? GROUP BY status', org.id)) vac[r.status] = r.n;
    const apps = {};
    for (const r of db.all('SELECT a.status, COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id WHERE v.organization_id = ? GROUP BY a.status', org.id)) apps[r.status] = r.n;
    return {
      vacanciesByStatus: vac,
      applicationsByStatus: apps,
      applicationsTotal: Object.entries(apps).filter(([s]) => s !== 'withdrawn').reduce((a, [, n]) => a + n, 0),
      newApplications: apps.sent || 0,
      views: db.get('SELECT COALESCE(SUM(views), 0) AS n FROM vacancies WHERE organization_id = ?', org.id).n,
    };
  });

  // ------------------------------------------------------------------ отклики
  const applicationDetail = (row) => buildApplicationDetail(db, row);

  function ownApplication(user, id) {
    const org = employerOrg(db, user);
    const a = id && db.get(`${APP_SELECT} WHERE a.id = ? AND v.organization_id = ?`, id, org.id);
    if (!a) throw notFound('Отклик не найден.');
    return a;
  }

  router.get('/api/employer/applications', employerOnly, (ctx) => {
    const org = employerOrg(db, ctx.user);
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 100 });
    const where = ['v.organization_id = ?'];
    const params = [org.id];
    const vacancyId = V.parseId(ctx.query.vacancyId);
    if (vacancyId) { where.push('a.vacancy_id = ?'); params.push(vacancyId); }
    if (C.APPLICATION_STATUSES[ctx.query.status]) { where.push('a.status = ?'); params.push(ctx.query.status); }
    if (typeof ctx.query.q === 'string' && ctx.query.q.trim()) {
      where.push("lc(u.full_name) LIKE ? ESCAPE '\\'");
      params.push(`%${V.escapeLike(ctx.query.q.trim().toLowerCase().slice(0, 100))}%`);
    }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id JOIN users u ON u.id = a.candidate_id WHERE ${w}`, ...params).n;
    const rows = db.all(`${APP_SELECT} WHERE ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(appListDto), total, pg);
  });

  router.get('/api/employer/applications/:id', employerOnly, (ctx) => {
    const a = ownApplication(ctx.user, V.parseId(ctx.params.id));
    // Первое открытие отклика работодателем автоматически переводит его в статус «Просмотрен».
    if (a.status === 'sent') {
      const now = nowIso();
      db.tx(() => {
        db.run("UPDATE applications SET status = 'viewed', updated_at = ?, status_changed_at = ? WHERE id = ?", now, now, a.id);
        db.run("INSERT INTO application_status_history (application_id, from_status, to_status, changed_by) VALUES (?, 'sent', 'viewed', ?)", a.id, ctx.user.id);
      });
      notify(db, a.candidate_id, { type: 'application.status', title: 'Ваш отклик просмотрен', body: `Вакансия «${a.vacancy_title}».`, link: '/cabinet#applications' });
    }
    return { application: applicationDetail(db.get(`${APP_SELECT} WHERE a.id = ?`, a.id)) };
  });

  router.patch('/api/employer/applications/:id/status', employerOnly, (ctx) => {
    const a = ownApplication(ctx.user, V.parseId(ctx.params.id));
    const { status } = V.parse(ctx.body, { status: V.oneOf(C.EMPLOYER_SETTABLE_STATUSES) });
    if (a.status === 'withdrawn') throw conflict('Кандидат отозвал отклик — изменить статус нельзя.', 'withdrawn');
    if (a.status !== status) {
      const now = nowIso();
      db.tx(() => {
        db.run('UPDATE applications SET status = ?, updated_at = ?, status_changed_at = ? WHERE id = ?', status, now, now, a.id);
        db.run('INSERT INTO application_status_history (application_id, from_status, to_status, changed_by) VALUES (?, ?, ?, ?)', a.id, a.status, status, ctx.user.id);
      });
      notify(db, a.candidate_id, {
        type: 'application.status',
        title: `Статус отклика: ${C.APPLICATION_STATUSES[status]}`,
        body: `Вакансия «${a.vacancy_title}».`,
        link: '/cabinet#applications',
      });
      logActivity(db, ctx, 'application.status_changed', 'application', a.id, { from: a.status, to: status });
    }
    return { application: applicationDetail(db.get(`${APP_SELECT} WHERE a.id = ?`, a.id)) };
  });

  router.post('/api/employer/applications/:id/comments', employerOnly, (ctx) => {
    const a = ownApplication(ctx.user, V.parseId(ctx.params.id));
    const { body } = V.parse(ctx.body, { body: V.str({ min: 1, max: 1000, multiline: true }) });
    db.run('INSERT INTO application_comments (application_id, author_id, body) VALUES (?, ?, ?)', a.id, ctx.user.id, body);
    ctx.status = 201;
    return { application: applicationDetail(db.get(`${APP_SELECT} WHERE a.id = ?`, a.id)) };
  });
}

module.exports = { register };
