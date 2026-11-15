'use strict';
const V = require('../lib/validate');
const C = require('../lib/constants');
const { ApiError, notFound, conflict, forbidden } = require('../lib/errors');
const { requireRole } = require('../lib/guards');
const S = require('../lib/security');
const { vacancyDto, organizationDto, VACANCY_SELECT, userDto } = require('../lib/dto');
const { getVacancyRow, pageParams, pageResult, candidateProfileDto } = require('../lib/queries');
const { logActivity, notify, notifyMany, orgEmployerIds } = require('../lib/activity');
const VI = require('../lib/vacancyInput');
const AV = require('../lib/applicationView');
const U = require('../lib/uploads');

function register(router, { config, db }) {
  const adminOnly = requireRole('admin');
  const nowIso = () => new Date().toISOString();
  const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);
  const likeOf = (s) => `%${V.escapeLike(String(s).trim().toLowerCase().slice(0, 100))}%`;
  const hasText = (s) => typeof s === 'string' && s.trim().length > 0;
  const idOr404 = (v, what = 'Запись') => {
    const id = V.parseId(v);
    if (!id) throw notFound(`${what} не найдена.`);
    return id;
  };
  const noteRequired = V.str({ min: 3, max: 500, multiline: true });
  const noteOptional = V.str({ max: 500, multiline: true, optional: true });

  // ------------------------------------------------------------------ статистика
  router.get('/api/admin/stats', adminOnly, () => {
    const count = (sql, ...p) => db.get(sql, ...p).n;
    const group = (sql) => Object.fromEntries(db.all(sql).map((r) => [r.k, r.n]));
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return {
      users: {
        byRole: group('SELECT role AS k, COUNT(*) AS n FROM users GROUP BY role'),
        blocked: count("SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'"),
        newThisWeek: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', weekAgo),
      },
      vacancies: group('SELECT status AS k, COUNT(*) AS n FROM vacancies GROUP BY status'),
      applications: {
        total: count('SELECT COUNT(*) AS n FROM applications'),
        byStatus: group('SELECT status AS k, COUNT(*) AS n FROM applications GROUP BY status'),
        thisWeek: count('SELECT COUNT(*) AS n FROM applications WHERE created_at >= ?', weekAgo),
      },
      organizations: {
        total: count('SELECT COUNT(*) AS n FROM organizations'),
        byVerification: group('SELECT verification_status AS k, COUNT(*) AS n FROM organizations GROUP BY verification_status'),
        listed: count('SELECT COUNT(*) AS n FROM organizations WHERE is_partner_listed = 1'),
      },
      pending: {
        vacancies: count("SELECT COUNT(*) AS n FROM vacancies WHERE status = 'pending'"),
        organizations: count("SELECT COUNT(*) AS n FROM organization_verification_requests WHERE status = 'pending'"),
        students: count("SELECT COUNT(*) AS n FROM verification_requests WHERE status = 'pending'"),
      },
      registryRecords: count('SELECT COUNT(*) AS n FROM student_registry'),
    };
  });

  // ------------------------------------------------------------------ пользователи
  function userRow(u) {
    return {
      ...userDto(u),
      organizationName: u.org_name || null,
      verificationStatus: u.verification_status || null,
      locked: !!(u.locked_until && u.locked_until > nowIso()),
    };
  }
  const USER_SELECT = `
    SELECT u.*, o.name AS org_name, cp.verification_status
    FROM users u
    LEFT JOIN employer_profiles ep ON ep.user_id = u.id
    LEFT JOIN organizations o ON o.id = ep.organization_id
    LEFT JOIN candidate_profiles cp ON cp.user_id = u.id`;

  router.get('/api/admin/users', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (C.ROLES[q.role]) { where.push('u.role = ?'); params.push(q.role); }
    if (['active', 'blocked'].includes(q.status)) { where.push('u.status = ?'); params.push(q.status); }
    if (hasText(q.q)) {
      where.push("(lc(u.full_name) LIKE ? ESCAPE '\\' OR lc(u.email) LIKE ? ESCAPE '\\')");
      params.push(likeOf(q.q), likeOf(q.q));
    }
    const pg = pageParams(q, { defaultSize: 20, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM users u WHERE ${w}`, ...params).n;
    const rows = db.all(`${USER_SELECT} WHERE ${w} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(userRow), total, pg);
  });

  router.get('/api/admin/users/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    const u = db.get(`${USER_SELECT} WHERE u.id = ?`, id);
    if (!u) throw notFound('Пользователь не найден.');
    const out = { user: userRow(u) };
    if (u.role === 'candidate') {
      out.profile = candidateProfileDto(db, id);
      out.applicationsCount = db.get('SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ?', id).n;
    }
    if (u.role === 'employer') {
      const ep = db.get('SELECT organization_id FROM employer_profiles WHERE user_id = ?', id);
      out.organizationId = ep ? ep.organization_id : null;
      out.vacanciesCount = db.get('SELECT COUNT(*) AS n FROM vacancies WHERE created_by = ?', id).n;
    }
    return out;
  });

  const activeAdmins = () => db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").n;

  // Администраторов-сотрудников создаёт только администратор; пароль временный и показывается один раз.
  router.post('/api/admin/users', adminOnly, async (ctx) => {
    const data = V.parse(ctx.body, { email: V.email(), fullName: V.str({ min: 2, max: 120 }), phone: V.phone() });
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', data.email)) throw invalid({ email: 'Этот email уже используется.' });
    const temp = S.temporaryPassword();
    const hash = await S.hashPassword(temp, config.scrypt);
    const r = db.run("INSERT INTO users (email, password_hash, role, full_name, phone, must_change_password) VALUES (?, ?, 'admin', ?, ?, 1)", data.email, hash, data.fullName, data.phone);
    logActivity(db, ctx, 'admin.user_created', 'user', Number(r.lastInsertRowid), { role: 'admin' });
    ctx.status = 201;
    return { user: userRow(db.get(`${USER_SELECT} WHERE u.id = ?`, Number(r.lastInsertRowid))), temporaryPassword: temp };
  });

  router.patch('/api/admin/users/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    const u = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('Пользователь не найден.');
    const data = V.parse(ctx.body, {
      fullName: V.str({ min: 2, max: 120 }), phone: V.phone(), email: V.email(),
      role: V.oneOf(['candidate', 'employer', 'admin']),
    }, { partial: true });

    if ('email' in data && data.email !== u.email && db.get('SELECT 1 AS x FROM users WHERE email = ? AND id <> ?', data.email, id)) {
      throw invalid({ email: 'Этот email уже используется.' });
    }
    if ('role' in data && data.role !== u.role) {
      if (id === ctx.user.id) throw forbidden('Нельзя изменить собственную роль.');
      // Безопасные переходы: любой → администратор, администратор → соискатель. Остальное нарушило бы связанные данные.
      const allowed = data.role === 'admin' || (u.role === 'admin' && data.role === 'candidate');
      if (!allowed) throw conflict('Эту смену роли выполнить нельзя: у соискателя и работодателя разные профили данных.', 'role_change_unsupported');
      if (u.role === 'admin' && u.status === 'active' && activeAdmins() <= 1) throw conflict('Нельзя лишить роли последнего администратора.');
    }
    db.tx(() => {
      const map = { fullName: 'full_name', phone: 'phone', email: 'email', role: 'role' };
      const sets = [];
      const vals = [];
      for (const [k, col] of Object.entries(map)) if (k in data) { sets.push(`${col} = ?`); vals.push(data[k]); }
      if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
      if (data.role === 'candidate' && u.role !== 'candidate') db.run('INSERT OR IGNORE INTO candidate_profiles (user_id) VALUES (?)', id);
      if (data.role && data.role !== u.role) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    logActivity(db, ctx, 'admin.user_updated', 'user', id, { fields: Object.keys(data), role: data.role });
    return { user: userRow(db.get(`${USER_SELECT} WHERE u.id = ?`, id)) };
  });

  router.post('/api/admin/users/:id/block', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    const u = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('Пользователь не найден.');
    if (id === ctx.user.id) throw forbidden('Нельзя заблокировать собственный аккаунт.');
    if (u.role === 'admin' && u.status === 'active' && activeAdmins() <= 1) throw conflict('Нельзя заблокировать последнего администратора.');
    const { reason } = V.parse(ctx.body, { reason: noteOptional });
    db.tx(() => {
      db.run("UPDATE users SET status = 'blocked', updated_at = ? WHERE id = ?", nowIso(), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    logActivity(db, ctx, 'admin.user_blocked', 'user', id, { reason });
    return { user: userRow(db.get(`${USER_SELECT} WHERE u.id = ?`, id)) };
  });

  router.post('/api/admin/users/:id/unblock', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    if (!db.get('SELECT 1 AS x FROM users WHERE id = ?', id)) throw notFound('Пользователь не найден.');
    db.run("UPDATE users SET status = 'active', failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?", nowIso(), id);
    logActivity(db, ctx, 'admin.user_unblocked', 'user', id);
    return { user: userRow(db.get(`${USER_SELECT} WHERE u.id = ?`, id)) };
  });

  router.post('/api/admin/users/:id/reset-password', adminOnly, async (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    if (!db.get('SELECT 1 AS x FROM users WHERE id = ?', id)) throw notFound('Пользователь не найден.');
    if (id === ctx.user.id) throw forbidden('Свой пароль меняйте в настройках аккаунта.');
    const temp = S.temporaryPassword();
    const hash = await S.hashPassword(temp, config.scrypt);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, nowIso(), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    logActivity(db, ctx, 'admin.password_reset', 'user', id);
    return { temporaryPassword: temp };
  });

  // ------------------------------------------------------------------ вакансии
  const LIST_SELECT = VACANCY_SELECT.replace('FROM vacancies v', `,
    (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.id AND a.status <> 'withdrawn') AS applications_count
    FROM vacancies v`);
  const vacancyRow = (v) => ({ ...vacancyDto(v), moderationNote: v.moderation_note, applicationsCount: v.applications_count });

  router.get('/api/admin/vacancies', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (C.VACANCY_STATUSES[q.status]) { where.push('v.status = ?'); params.push(q.status); }
    const orgId = V.parseId(q.organizationId);
    if (orgId) { where.push('v.organization_id = ?'); params.push(orgId); }
    if (hasText(q.q)) {
      where.push("(lc(v.title) LIKE ? ESCAPE '\\' OR lc(o.name) LIKE ? ESCAPE '\\')");
      params.push(likeOf(q.q), likeOf(q.q));
    }
    const pg = pageParams(q, { defaultSize: 20, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM vacancies v JOIN organizations o ON o.id = v.organization_id WHERE ${w}`, ...params).n;
    // Вакансии на модерации — первыми.
    const rows = db.all(`${LIST_SELECT} WHERE ${w} ORDER BY (v.status = 'pending') DESC, v.updated_at DESC, v.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(vacancyRow), total, pg);
  });

  const loadVacancy = (id) => {
    const v = db.get(`${LIST_SELECT} WHERE v.id = ?`, id);
    if (!v) throw notFound('Вакансия не найдена.');
    return v;
  };

  router.get('/api/admin/vacancies/:id', adminOnly, (ctx) => ({ vacancy: vacancyRow(loadVacancy(idOr404(ctx.params.id, 'Вакансия'))) }));

  router.patch('/api/admin/vacancies/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Вакансия');
    const existing = loadVacancy(id);
    const { isFeatured } = V.parse(ctx.body, { isFeatured: V.bool({ optional: true }) });
    const data = V.parse(ctx.body, VI.schema, { partial: true });
    const extra = {};
    if (isFeatured !== undefined) {
      if (isFeatured && existing.status !== 'published') throw conflict('В избранные можно добавить только опубликованную вакансию.');
      extra.is_featured = isFeatured ? 1 : 0;
    }
    db.tx(() => VI.updateVacancyColumns(db, id, existing, data, extra));
    logActivity(db, ctx, 'admin.vacancy_updated', 'vacancy', id, { fields: Object.keys(data), featured: isFeatured });
    return { vacancy: vacancyRow(loadVacancy(id)) };
  });

  router.post('/api/admin/vacancies/:id/approve', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Вакансия');
    const v = loadVacancy(id);
    if (v.status !== 'pending') throw conflict('Одобрить можно только вакансию, ожидающую модерации.');
    const now = nowIso();
    db.run("UPDATE vacancies SET status = 'published', published_at = COALESCE(published_at, ?), closed_at = NULL, moderation_note = NULL, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", now, ctx.user.id, now, now, id);
    notify(db, v.created_by, { type: 'vacancy.approved', title: 'Вакансия опубликована', body: `«${v.title}» прошла модерацию.`, link: '/employer#vacancies' });
    logActivity(db, ctx, 'admin.vacancy_approved', 'vacancy', id);
    return { vacancy: vacancyRow(loadVacancy(id)) };
  });

  router.post('/api/admin/vacancies/:id/reject', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Вакансия');
    const v = loadVacancy(id);
    if (v.status !== 'pending') throw conflict('Отклонить можно только вакансию, ожидающую модерации.');
    const { note } = V.parse(ctx.body, { note: noteRequired });
    const now = nowIso();
    db.run("UPDATE vacancies SET status = 'rejected', moderation_note = ?, is_featured = 0, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", note, ctx.user.id, now, now, id);
    notify(db, v.created_by, { type: 'vacancy.rejected', title: 'Вакансия отклонена', body: `«${v.title}»: ${note}`, link: '/employer#vacancies' });
    logActivity(db, ctx, 'admin.vacancy_rejected', 'vacancy', id, { note });
    return { vacancy: vacancyRow(loadVacancy(id)) };
  });

  router.post('/api/admin/vacancies/:id/close', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Вакансия');
    const v = loadVacancy(id);
    if (!['published', 'pending'].includes(v.status)) throw conflict('Закрыть можно только опубликованную вакансию или вакансию на модерации.');
    db.run("UPDATE vacancies SET status = 'closed', closed_at = ?, is_featured = 0, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
    notify(db, v.created_by, { type: 'vacancy.closed', title: 'Вакансия закрыта администратором', body: `«${v.title}».`, link: '/employer#vacancies' });
    logActivity(db, ctx, 'admin.vacancy_closed', 'vacancy', id);
    return { vacancy: vacancyRow(loadVacancy(id)) };
  });

  router.delete('/api/admin/vacancies/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Вакансия');
    const v = loadVacancy(id);
    db.run('DELETE FROM vacancies WHERE id = ?', id);
    notify(db, v.created_by, { type: 'vacancy.deleted', title: 'Вакансия удалена администратором', body: `«${v.title}».` });
    logActivity(db, ctx, 'admin.vacancy_deleted', 'vacancy', id, { title: v.title, applications: v.applications_count });
    return { ok: true };
  });

  // ------------------------------------------------------------------ организации
  const orgSchema = {
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
    isCollegeUnit: V.bool({ optional: true }),
    isPartnerListed: V.bool({ optional: true }),
    verificationStatus: V.oneOf(['unverified', 'verified', 'rejected']),
  };
  const ORG_COLS = {
    name: 'name', description: 'description', city: 'city', address: 'address', industry: 'industry', specialties: 'specialties_text',
    website: 'website', contactPerson: 'contact_person', contactEmail: 'contact_email', contactPhone: 'contact_phone',
    isCollegeUnit: 'is_college_unit', isPartnerListed: 'is_partner_listed', verificationStatus: 'verification_status',
  };
  const orgRow = (o) => organizationDto(o, {
    verificationNote: o.verification_note,
    isDemo: !!o.is_demo,
    vacanciesCount: o.vacancies_count,
    employersCount: o.employers_count,
  });
  const ORG_SELECT = `
    SELECT o.*,
      (SELECT COUNT(*) FROM vacancies v WHERE v.organization_id = o.id) AS vacancies_count,
      (SELECT COUNT(*) FROM employer_profiles ep WHERE ep.organization_id = o.id) AS employers_count
    FROM organizations o`;

  router.get('/api/admin/organizations', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (['unverified', 'pending', 'verified', 'rejected'].includes(q.verification)) { where.push('o.verification_status = ?'); params.push(q.verification); }
    if (q.listed === '1' || q.listed === '0') { where.push('o.is_partner_listed = ?'); params.push(Number(q.listed)); }
    if (hasText(q.q)) { where.push("lc(o.name) LIKE ? ESCAPE '\\'"); params.push(likeOf(q.q)); }
    const pg = pageParams(q, { defaultSize: 20, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM organizations o WHERE ${w}`, ...params).n;
    const rows = db.all(`${ORG_SELECT} WHERE ${w} ORDER BY (o.verification_status = 'pending') DESC, o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(orgRow), total, pg);
  });

  router.get('/api/admin/organizations/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Организация');
    const o = db.get(`${ORG_SELECT} WHERE o.id = ?`, id);
    if (!o) throw notFound('Организация не найдена.');
    return {
      organization: orgRow(o),
      employers: db.all('SELECT u.id, u.full_name, u.email, u.status FROM employer_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.organization_id = ?', id)
        .map((u) => ({ id: u.id, fullName: u.full_name, email: u.email, status: u.status })),
      requests: db.all('SELECT id, status, message, review_note, created_at, reviewed_at FROM organization_verification_requests WHERE organization_id = ? ORDER BY id DESC', id)
        .map((r) => ({ id: r.id, status: r.status, message: r.message, reviewNote: r.review_note, createdAt: r.created_at, reviewedAt: r.reviewed_at })),
    };
  });

  router.post('/api/admin/organizations', adminOnly, (ctx) => {
    const data = V.parse(ctx.body, orgSchema);
    const cols = Object.keys(data).map((k) => ORG_COLS[k]);
    const vals = Object.values(data).map((v) => (typeof v === 'boolean' ? Number(v) : v));
    const r = db.run(`INSERT INTO organizations (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`, ...vals, ctx.user.id);
    logActivity(db, ctx, 'admin.organization_created', 'organization', Number(r.lastInsertRowid));
    ctx.status = 201;
    return { organization: orgRow(db.get(`${ORG_SELECT} WHERE o.id = ?`, Number(r.lastInsertRowid))) };
  });

  router.patch('/api/admin/organizations/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Организация');
    if (!db.get('SELECT 1 AS x FROM organizations WHERE id = ?', id)) throw notFound('Организация не найдена.');
    const data = V.parse(ctx.body, orgSchema, { partial: true });
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(data)) { sets.push(`${ORG_COLS[k]} = ?`); vals.push(typeof v === 'boolean' ? Number(v) : v); }
    if (sets.length) db.run(`UPDATE organizations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
    logActivity(db, ctx, 'admin.organization_updated', 'organization', id, { fields: Object.keys(data) });
    return { organization: orgRow(db.get(`${ORG_SELECT} WHERE o.id = ?`, id)) };
  });

  router.delete('/api/admin/organizations/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Организация');
    const o = db.get(`${ORG_SELECT} WHERE o.id = ?`, id);
    if (!o) throw notFound('Организация не найдена.');
    if (o.vacancies_count > 0 || o.employers_count > 0) throw conflict('Нельзя удалить организацию, к которой привязаны вакансии или работодатели.');
    db.run('DELETE FROM organizations WHERE id = ?', id);
    if (o.logo_path) U.removeFile(config.uploadDir, 'logos', o.logo_path);
    logActivity(db, ctx, 'admin.organization_deleted', 'organization', id, { name: o.name });
    return { ok: true };
  });

  router.get('/api/admin/organization-requests', adminOnly, (ctx) => {
    const status = ['pending', 'approved', 'rejected'].includes(ctx.query.status) ? ctx.query.status : null;
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 100 });
    const where = status ? 'WHERE r.status = ?' : '';
    const params = status ? [status] : [];
    const total = db.get(`SELECT COUNT(*) AS n FROM organization_verification_requests r ${where}`, ...params).n;
    const rows = db.all(
      `SELECT r.*, o.name AS org_name, o.city AS org_city, o.contact_email, o.contact_phone, u.full_name AS requester
       FROM organization_verification_requests r
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users u ON u.id = r.requested_by ${where}
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map((r) => ({
      id: r.id, status: r.status, message: r.message, reviewNote: r.review_note, createdAt: r.created_at, reviewedAt: r.reviewed_at,
      organization: { id: r.organization_id, name: r.org_name, city: r.org_city, contactEmail: r.contact_email, contactPhone: r.contact_phone },
      requester: r.requester,
    })), total, pg);
  });

  function reviewOrgRequest(ctx, approve) {
    const id = idOr404(ctx.params.id, 'Заявка');
    const r = db.get('SELECT * FROM organization_verification_requests WHERE id = ?', id);
    if (!r) throw notFound('Заявка не найдена.');
    if (r.status !== 'pending') throw conflict('Заявка уже рассмотрена.');
    const { note } = V.parse(ctx.body, { note: approve ? noteOptional : noteRequired });
    const org = db.get('SELECT * FROM organizations WHERE id = ?', r.organization_id);
    const now = nowIso();
    db.tx(() => {
      db.run('UPDATE organization_verification_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', approve ? 'approved' : 'rejected', ctx.user.id, now, note, id);
      db.run('UPDATE organizations SET verification_status = ?, verification_note = ?, updated_at = ? WHERE id = ?', approve ? 'verified' : 'rejected', note, now, org.id);
    });
    notifyMany(db, orgEmployerIds(db, org.id), {
      type: approve ? 'organization.verified' : 'organization.rejected',
      title: approve ? 'Организация проверена' : 'Проверка организации отклонена',
      body: approve ? `«${org.name}» получила статус проверенной.` : `«${org.name}»: ${note}`,
      link: '/employer#organization',
    });
    logActivity(db, ctx, approve ? 'admin.organization_verified' : 'admin.organization_verification_rejected', 'organization', org.id, { note });
    return { ok: true };
  }
  router.post('/api/admin/organization-requests/:id/approve', adminOnly, (ctx) => reviewOrgRequest(ctx, true));
  router.post('/api/admin/organization-requests/:id/reject', adminOnly, (ctx) => reviewOrgRequest(ctx, false));

  // ------------------------------------------------------------------ студенты и выпускники (закрытый реестр)
  const registryDto = (r) => ({
    id: r.id, studentNumber: r.student_number, fullName: r.full_name, kind: r.kind, kindLabel: r.kind === 'student' ? 'Студент' : 'Выпускник',
    groupName: r.group_name, specialtyCode: r.specialty_code, specialtyName: r.specialty_name, studyYears: r.study_years, isTest: !!r.is_test, createdAt: r.created_at,
  });
  const registrySchema = {
    studentNumber: V.str({ min: 3, max: 40, pattern: /^[A-Za-zА-Яа-яЁё0-9._\-/]+$/, message: 'Допустимы буквы, цифры и символы . _ - /' }),
    fullName: V.str({ min: 2, max: 150 }),
    kind: V.oneOf(['student', 'graduate']),
    groupName: V.str({ max: 80, optional: true }),
    specialtyCode: V.str({ max: 20, optional: true }),
    specialtyName: V.str({ max: 150, optional: true }),
    studyYears: V.str({ max: 40, optional: true }),
    isTest: V.bool({ optional: true }),
  };
  const REG_COLS = { studentNumber: 'student_number', fullName: 'full_name', kind: 'kind', groupName: 'group_name', specialtyCode: 'specialty_code', specialtyName: 'specialty_name', studyYears: 'study_years', isTest: 'is_test' };

  router.get('/api/admin/students', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (['student', 'graduate'].includes(q.kind)) { where.push('kind = ?'); params.push(q.kind); }
    if (hasText(q.q)) {
      where.push("(lc(full_name) LIKE ? ESCAPE '\\' OR lc(student_number) LIKE ? ESCAPE '\\')");
      params.push(likeOf(q.q), likeOf(q.q));
    }
    const pg = pageParams(q, { defaultSize: 20, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM student_registry WHERE ${w}`, ...params).n;
    const rows = db.all(`SELECT * FROM student_registry WHERE ${w} ORDER BY full_name LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    logActivity(db, ctx, 'admin.registry_viewed', 'student_registry', null, { q: hasText(q.q) ? 'search' : 'list' });
    return pageResult(rows.map(registryDto), total, pg);
  });

  router.post('/api/admin/students', adminOnly, (ctx) => {
    const data = V.parse(ctx.body, registrySchema);
    data.studentNumber = data.studentNumber.toUpperCase();
    if (db.get('SELECT 1 AS x FROM student_registry WHERE student_number = ?', data.studentNumber)) throw invalid({ studentNumber: 'Запись с таким номером уже существует.' });
    const cols = Object.keys(data).map((k) => REG_COLS[k]);
    const vals = Object.values(data).map((v) => (typeof v === 'boolean' ? Number(v) : v));
    const r = db.run(`INSERT INTO student_registry (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...vals);
    logActivity(db, ctx, 'admin.registry_created', 'student_registry', Number(r.lastInsertRowid));
    ctx.status = 201;
    return { record: registryDto(db.get('SELECT * FROM student_registry WHERE id = ?', Number(r.lastInsertRowid))) };
  });

  router.patch('/api/admin/students/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Запись');
    if (!db.get('SELECT 1 AS x FROM student_registry WHERE id = ?', id)) throw notFound('Запись не найдена.');
    const data = V.parse(ctx.body, registrySchema, { partial: true });
    if (data.studentNumber) {
      data.studentNumber = data.studentNumber.toUpperCase();
      if (db.get('SELECT 1 AS x FROM student_registry WHERE student_number = ? AND id <> ?', data.studentNumber, id)) throw invalid({ studentNumber: 'Запись с таким номером уже существует.' });
    }
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(data)) { sets.push(`${REG_COLS[k]} = ?`); vals.push(typeof v === 'boolean' ? Number(v) : v); }
    if (sets.length) db.run(`UPDATE student_registry SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
    logActivity(db, ctx, 'admin.registry_updated', 'student_registry', id, { fields: Object.keys(data) });
    return { record: registryDto(db.get('SELECT * FROM student_registry WHERE id = ?', id)) };
  });

  router.delete('/api/admin/students/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Запись');
    if (!db.run('DELETE FROM student_registry WHERE id = ?', id).changes) throw notFound('Запись не найдена.');
    logActivity(db, ctx, 'admin.registry_deleted', 'student_registry', id);
    return { ok: true };
  });

  const VR_SELECT = `
    SELECT vr.*, u.full_name AS user_name, u.email AS user_email, sr.full_name AS reg_name, sr.kind AS reg_kind,
           sr.group_name AS reg_group, sr.specialty_name AS reg_specialty, sr.study_years AS reg_years,
           d.original_name AS doc_name, rv.full_name AS reviewer
    FROM verification_requests vr
    JOIN users u ON u.id = vr.user_id
    LEFT JOIN student_registry sr ON sr.id = vr.registry_id
    LEFT JOIN documents d ON d.id = vr.document_id
    LEFT JOIN users rv ON rv.id = vr.reviewed_by`;
  const vrDto = (r) => ({
    id: r.id, status: r.status, claimedKind: r.claimed_kind, studentNumber: r.student_number, comment: r.comment,
    registryMatch: r.registry_match, createdAt: r.created_at, reviewedAt: r.reviewed_at, reviewNote: r.review_note, reviewer: r.reviewer,
    user: { id: r.user_id, fullName: r.user_name, email: r.user_email },
    document: r.document_id ? { id: r.document_id, name: r.doc_name } : null,
    registry: r.registry_id ? { fullName: r.reg_name, kind: r.reg_kind, groupName: r.reg_group, specialtyName: r.reg_specialty, studyYears: r.reg_years } : null,
  });

  router.get('/api/admin/verification-requests', adminOnly, (ctx) => {
    const status = ['pending', 'approved', 'rejected'].includes(ctx.query.status) ? ctx.query.status : null;
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 100 });
    const where = status ? 'WHERE vr.status = ?' : '';
    const params = status ? [status] : [];
    const total = db.get(`SELECT COUNT(*) AS n FROM verification_requests vr ${where}`, ...params).n;
    const rows = db.all(`${VR_SELECT} ${where} ORDER BY (vr.status = 'pending') DESC, vr.created_at DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(vrDto), total, pg);
  });

  router.post('/api/admin/verification-requests/:id/approve', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Заявка');
    const r = db.get('SELECT * FROM verification_requests WHERE id = ?', id);
    if (!r) throw notFound('Заявка не найдена.');
    if (r.status !== 'pending') throw conflict('Заявка уже рассмотрена.');
    const { note } = V.parse(ctx.body, { note: noteOptional });
    if (r.registry_match !== 'match' && !note) {
      throw invalid({ note: 'Запись в реестре не найдена или не совпадает. Укажите основание для подтверждения.' });
    }
    const reg = r.registry_id ? db.get('SELECT * FROM student_registry WHERE id = ?', r.registry_id) : null;
    const now = nowIso();
    db.tx(() => {
      db.run("UPDATE verification_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?", ctx.user.id, now, note, id);
      const gradYear = reg && reg.kind === 'graduate' ? (parseInt(String(reg.study_years).match(/\d{4}/g)?.pop(), 10) || null) : null;
      db.run(
        `UPDATE candidate_profiles SET verification_status = 'verified', verified_kind = ?, candidate_type = ?, verified_at = ?,
           group_name = ?, specialty_code = ?, graduation_year = ?, updated_at = ? WHERE user_id = ?`,
        r.claimed_kind, r.claimed_kind, now, reg ? reg.group_name : null, reg ? reg.specialty_code : null, gradYear, now, r.user_id,
      );
      db.run("INSERT INTO verification_history (request_id, user_id, action, actor_id, note) VALUES (?, ?, 'approved', ?, ?)", id, r.user_id, ctx.user.id, note);
    });
    notify(db, r.user_id, { type: 'verification.approved', title: 'Статус подтверждён', body: 'Ваш статус студента или выпускника ГГКИТ подтверждён.', link: '/cabinet#status' });
    logActivity(db, ctx, 'admin.verification_approved', 'verification_request', id, { match: r.registry_match });
    return { ok: true };
  });

  router.post('/api/admin/verification-requests/:id/reject', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Заявка');
    const r = db.get('SELECT * FROM verification_requests WHERE id = ?', id);
    if (!r) throw notFound('Заявка не найдена.');
    if (r.status !== 'pending') throw conflict('Заявка уже рассмотрена.');
    const { note } = V.parse(ctx.body, { note: noteRequired });
    const now = nowIso();
    db.tx(() => {
      db.run("UPDATE verification_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?", ctx.user.id, now, note, id);
      db.run("UPDATE candidate_profiles SET verification_status = 'rejected', updated_at = ? WHERE user_id = ?", now, r.user_id);
      db.run("INSERT INTO verification_history (request_id, user_id, action, actor_id, note) VALUES (?, ?, 'rejected', ?, ?)", id, r.user_id, ctx.user.id, note);
    });
    notify(db, r.user_id, { type: 'verification.rejected', title: 'Заявка на подтверждение статуса отклонена', body: note, link: '/cabinet#status' });
    logActivity(db, ctx, 'admin.verification_rejected', 'verification_request', id);
    return { ok: true };
  });

  router.post('/api/admin/users/:id/revoke-verification', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Пользователь');
    const p = db.get('SELECT verification_status FROM candidate_profiles WHERE user_id = ?', id);
    if (!p) throw notFound('Профиль соискателя не найден.');
    if (p.verification_status !== 'verified') throw conflict('У пользователя нет подтверждённого статуса.');
    const { note } = V.parse(ctx.body, { note: noteRequired });
    db.tx(() => {
      db.run("UPDATE candidate_profiles SET verification_status = 'none', verified_kind = NULL, verified_at = NULL, group_name = NULL, specialty_code = NULL, graduation_year = NULL, updated_at = ? WHERE user_id = ?", nowIso(), id);
      db.run("INSERT INTO verification_history (user_id, action, actor_id, note) VALUES (?, 'revoked', ?, ?)", id, ctx.user.id, note);
    });
    notify(db, id, { type: 'verification.revoked', title: 'Подтверждение статуса отозвано', body: note, link: '/cabinet#status' });
    logActivity(db, ctx, 'admin.verification_revoked', 'user', id);
    return { ok: true };
  });

  router.get('/api/admin/verification-history', adminOnly, (ctx) => {
    const pg = pageParams(ctx.query, { defaultSize: 30, maxSize: 100 });
    const userId = V.parseId(ctx.query.userId);
    const where = userId ? 'WHERE h.user_id = ?' : '';
    const params = userId ? [userId] : [];
    const total = db.get(`SELECT COUNT(*) AS n FROM verification_history h ${where}`, ...params).n;
    const rows = db.all(
      `SELECT h.*, u.full_name AS user_name, a.full_name AS actor_name FROM verification_history h
       JOIN users u ON u.id = h.user_id LEFT JOIN users a ON a.id = h.actor_id ${where}
       ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map((h) => ({
      id: h.id, action: h.action, note: h.note, createdAt: h.created_at,
      user: { id: h.user_id, fullName: h.user_name }, actor: h.actor_name,
    })), total, pg);
  });

  // ------------------------------------------------------------------ отклики
  router.get('/api/admin/applications', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (C.APPLICATION_STATUSES[q.status]) { where.push('a.status = ?'); params.push(q.status); }
    const vid = V.parseId(q.vacancyId);
    if (vid) { where.push('a.vacancy_id = ?'); params.push(vid); }
    const oid = V.parseId(q.organizationId);
    if (oid) { where.push('v.organization_id = ?'); params.push(oid); }
    if (hasText(q.q)) {
      where.push("(lc(u.full_name) LIKE ? ESCAPE '\\' OR lc(v.title) LIKE ? ESCAPE '\\')");
      params.push(likeOf(q.q), likeOf(q.q));
    }
    const pg = pageParams(q, { defaultSize: 20, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id JOIN users u ON u.id = a.candidate_id WHERE ${w}`, ...params).n;
    const rows = db.all(`${AV.APP_SELECT} WHERE ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map(AV.appListDto), total, pg);
  });

  router.get('/api/admin/applications/:id', adminOnly, (ctx) => {
    const id = idOr404(ctx.params.id, 'Отклик');
    const a = db.get(`${AV.APP_SELECT} WHERE a.id = ?`, id);
    if (!a) throw notFound('Отклик не найден.');
    return { application: AV.applicationDetail(db, a) };
  });

  // ------------------------------------------------------------------ журнал действий
  router.get('/api/admin/logs', adminOnly, (ctx) => {
    const q = ctx.query;
    const where = ['1 = 1'];
    const params = [];
    if (hasText(q.action)) { where.push('l.action LIKE ?'); params.push(`${V.escapeLike(q.action.trim().slice(0, 60))}%`.replace(/^/, '')); }
    const actor = V.parseId(q.actorId);
    if (actor) { where.push('l.actor_id = ?'); params.push(actor); }
    if (hasText(q.entityType)) { where.push('l.entity_type = ?'); params.push(q.entityType.trim().slice(0, 40)); }
    if (hasText(q.from) && !Number.isNaN(Date.parse(q.from))) { where.push('l.created_at >= ?'); params.push(new Date(q.from).toISOString()); }
    if (hasText(q.to) && !Number.isNaN(Date.parse(q.to))) { where.push('l.created_at <= ?'); params.push(new Date(new Date(q.to).getTime() + 86_399_999).toISOString()); }
    const pg = pageParams(q, { defaultSize: 30, maxSize: 100 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM activity_logs l WHERE ${w}`, ...params).n;
    const rows = db.all(
      `SELECT l.*, u.full_name AS actor_name, u.email AS actor_email FROM activity_logs l
       LEFT JOIN users u ON u.id = l.actor_id WHERE ${w} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);
    return pageResult(rows.map((l) => ({
      id: l.id, action: l.action, entityType: l.entity_type, entityId: l.entity_id, ip: l.ip, createdAt: l.created_at,
      actor: l.actor_id ? { id: l.actor_id, fullName: l.actor_name, email: l.actor_email, role: l.actor_role } : null,
      details: (() => { try { return l.details ? JSON.parse(l.details) : null; } catch { return null; } })(),
    })), total, pg);
  });
}

module.exports = { register };
