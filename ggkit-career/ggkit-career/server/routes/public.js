'use strict';
const fs = require('node:fs');
const V = require('../lib/validate');
const C = require('../lib/constants');
const { notFound, forbidden } = require('../lib/errors');
const { vacancyDto, VACANCY_SELECT, organizationDto } = require('../lib/dto');
const { pageParams, pageResult, getVacancyRow } = require('../lib/queries');
const { storedPath } = require('../lib/uploads');
const { requireRole } = require('../lib/guards');

const CONTENT_KEYS = [
  'hero_title', 'hero_subtitle', 'about_title', 'about_text', 'about_founded',
  'contact_address', 'contact_phone', 'contact_email', 'footer_note',
];

// Значения по умолчанию взяты из текстов исходного сайта. Контакты не придумываются — их задаёт администратор.
const DEFAULT_CONTENT = {
  hero_title: 'Работа и карьера в ГГКИТ и у наших партнёров в Чеченской Республике',
  hero_subtitle: 'Единая кадровая площадка Грозненского государственного колледжа информационных технологий и проверенных организаций-партнёров колледжа в регионе.',
  about_title: 'О нас — ГБПОУ «Грозненский государственный колледж информационных технологий»',
  about_text:
    'Кадровый портал создан на базе ГБПОУ «Грозненский государственный колледж информационных технологий» (ГГКИТ). Площадка объединяет открытые вакансии подразделений самого колледжа и актуальные предложения организаций-партнёров, с которыми колледж сотрудничает в Чеченской Республике.\n\n' +
    'Каждая вакансия открывается на своей странице с описанием от работодателя, адресом места работы в ЧР (с переходом на карту) и рабочими контактами.\n\n' +
    'Подготовка специалистов в области информационных систем, программирования, сетевого администрирования, информационной безопасности и экономики.',
  about_founded: '1933',
  contact_address: '',
  contact_phone: '',
  contact_email: '',
  footer_note: 'Официальный кадровый портал «ГГКИТ Карьера ЧР»',
};

function register(router, { config, db }) {
  const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  router.get('/api/health', () => ({ ok: true }));

  router.get('/api/meta', () => ({
    categories: db.all('SELECT id, slug, name, specialty_code AS specialtyCode FROM categories ORDER BY sort_order'),
    employmentTypes: Object.entries(C.EMPLOYMENT_TYPES).map(([value, label]) => ({ value, label })),
    experienceLevels: Object.entries(C.EXPERIENCE_LEVELS).map(([value, label]) => ({ value, label })),
    applicationStatuses: Object.entries(C.APPLICATION_STATUSES).map(([value, label]) => ({ value, label })),
    employerStatuses: C.EMPLOYER_SETTABLE_STATUSES,
    vacancyStatuses: Object.entries(C.VACANCY_STATUSES).map(([value, label]) => ({ value, label })),
    cities: db.all("SELECT DISTINCT city FROM vacancies WHERE status IN ('published','closed') ORDER BY city").map((r) => r.city),
    industries: db.all("SELECT DISTINCT industry FROM organizations WHERE is_partner_listed = 1 AND industry IS NOT NULL ORDER BY industry").map((r) => r.industry),
  }));

  // Статистика считается по реальным записям базы данных; персональные данные не раскрываются.
  router.get('/api/stats', () => {
    const one = (sql) => db.get(sql).n;
    return {
      activeVacancies: one("SELECT COUNT(*) AS n FROM vacancies WHERE status = 'published'"),
      verifiedOrganizations: one("SELECT COUNT(*) AS n FROM organizations WHERE verification_status = 'verified'"),
      partners: one('SELECT COUNT(*) AS n FROM organizations WHERE is_partner_listed = 1'),
      candidates: one("SELECT COUNT(*) AS n FROM users WHERE role = 'candidate' AND status = 'active'"),
      verifiedStudents: one("SELECT COUNT(*) AS n FROM candidate_profiles WHERE verified_kind = 'student' AND verification_status = 'verified'"),
      verifiedGraduates: one("SELECT COUNT(*) AS n FROM candidate_profiles WHERE verified_kind = 'graduate' AND verification_status = 'verified'"),
      applications: one("SELECT COUNT(*) AS n FROM applications WHERE status <> 'withdrawn'"),
      byCategory: db.all(
        `SELECT c.slug, c.name, COUNT(v.id) AS count FROM categories c
         LEFT JOIN vacancies v ON v.category_id = c.id AND v.status = 'published'
         GROUP BY c.id ORDER BY c.sort_order`,
      ),
    };
  });

  const siteContent = () => {
    const out = { ...DEFAULT_CONTENT };
    for (const r of db.all('SELECT key, value FROM site_content')) if (CONTENT_KEYS.includes(r.key)) out[r.key] = r.value;
    return out;
  };
  router.get('/api/site', () => ({ content: siteContent() }));

  router.get('/api/admin/content', requireRole('admin'), () => ({ content: siteContent(), keys: CONTENT_KEYS }));
  router.put('/api/admin/content', requireRole('admin'), (ctx) => {
    const schema = {};
    for (const k of CONTENT_KEYS) schema[k] = V.str({ max: k === 'about_text' ? 4000 : 400, multiline: true, optional: true });
    const data = V.parse(ctx.body, schema, { partial: true });
    db.tx(() => {
      for (const [k, v] of Object.entries(data)) {
        if (v === null) db.run('DELETE FROM site_content WHERE key = ?', k);
        else db.run(
          "INSERT INTO site_content (key, value, updated_by) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
          k, v, ctx.user.id,
        );
      }
    });
    require('../lib/activity').logActivity(db, ctx, 'content.updated', 'site_content', null, { keys: Object.keys(data) });
    return { content: siteContent() };
  });

  // ---------------------------------------------------------------- каталог вакансий
  function buildFilters(q) {
    const where = [];
    const params = [];
    const status = q.status === 'closed' ? ['closed'] : q.status === 'all' ? ['published', 'closed'] : ['published'];
    where.push(`v.status IN (${status.map(() => '?').join(',')})`);
    params.push(...status);

    const like = (s) => `%${V.escapeLike(String(s).toLowerCase())}%`;
    const text = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

    // Общий поиск: каждое слово должно встретиться в должности, организации, городе или категории.
    const terms = text(q.q, 200).split(/\s+/).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      where.push("(lc(v.title) LIKE ? ESCAPE '\\' OR lc(o.name) LIKE ? ESCAPE '\\' OR lc(v.city) LIKE ? ESCAPE '\\' OR lc(c.name) LIKE ? ESCAPE '\\')");
      const l = like(term);
      params.push(l, l, l, l);
    }
    if (text(q.position)) { where.push("lc(v.title) LIKE ? ESCAPE '\\'"); params.push(like(text(q.position))); }
    if (text(q.employer)) { where.push("lc(o.name) LIKE ? ESCAPE '\\'"); params.push(like(text(q.employer))); }
    if (text(q.city)) { where.push("lc(v.city) LIKE ? ESCAPE '\\'"); params.push(like(text(q.city))); }
    if (text(q.category, 40)) { where.push('c.slug = ?'); params.push(text(q.category, 40)); }
    if (C.EMPLOYMENT_TYPES[q.type]) { where.push('v.employment_type = ?'); params.push(q.type); }
    if (C.EXPERIENCE_LEVELS[q.experience]) { where.push('v.experience = ?'); params.push(q.experience); }
    const salaryFrom = parseInt(q.salaryFrom, 10);
    if (Number.isFinite(salaryFrom) && salaryFrom > 0) { where.push('COALESCE(v.salary_max, v.salary_min) >= ?'); params.push(salaryFrom); }
    if (q.source === 'college') where.push('o.is_college_unit = 1');
    if (q.source === 'partner') where.push('o.is_college_unit = 0');
    const orgId = V.parseId(q.organizationId);
    if (orgId) { where.push('v.organization_id = ?'); params.push(orgId); }
    if (q.featured === '1') where.push('v.is_featured = 1');
    return { where: where.join(' AND '), params };
  }

  function orderClause(q) {
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    if (q.sort === 'salary') {
      return `(v.salary_min IS NULL AND v.salary_max IS NULL), COALESCE(v.salary_max, v.salary_min) ${dir}, v.published_at DESC, v.id DESC`;
    }
    return `v.published_at ${dir}, v.id ${dir}`;
  }

  router.get('/api/vacancies', (ctx) => {
    const q = ctx.query;
    const { where, params } = buildFilters(q);
    const pg = pageParams(q, { defaultSize: 12, maxSize: 50 });
    const total = db.get(`SELECT COUNT(*) AS n FROM vacancies v JOIN organizations o ON o.id = v.organization_id JOIN categories c ON c.id = v.category_id WHERE ${where}`, ...params).n;
    const rows = db.all(`${VACANCY_SELECT} WHERE ${where} ORDER BY ${orderClause(q)} LIMIT ? OFFSET ?`, ...params, pg.pageSize, pg.offset);

    let saved = new Set();
    let applied = new Map();
    if (ctx.user && ctx.user.role === 'candidate' && rows.length) {
      const ids = rows.map((r) => r.id);
      const ph = ids.map(() => '?').join(',');
      saved = new Set(db.all(`SELECT vacancy_id FROM saved_vacancies WHERE user_id = ? AND vacancy_id IN (${ph})`, ctx.user.id, ...ids).map((r) => r.vacancy_id));
      applied = new Map(db.all(`SELECT vacancy_id, status FROM applications WHERE candidate_id = ? AND status <> 'withdrawn' AND vacancy_id IN (${ph})`, ctx.user.id, ...ids).map((r) => [r.vacancy_id, r.status]));
    }
    const items = rows.map((r) => {
      const d = vacancyDto(r);
      return {
        ...d,
        description: truncate(d.description, 220),
        responsibilities: undefined, requirements: undefined, conditions: undefined,
        saved: saved.has(r.id),
        applicationStatus: applied.get(r.id) || null,
      };
    });
    return pageResult(items, total, pg);
  });

  router.get('/api/vacancies/:id', (ctx) => {
    const id = V.parseId(ctx.params.id);
    const row = id && getVacancyRow(db, id);
    if (!row) throw notFound('Вакансия не найдена.');

    let isManager = false;
    if (ctx.user && ctx.user.role === 'admin') isManager = true;
    if (ctx.user && ctx.user.role === 'employer') {
      isManager = !!db.get('SELECT 1 AS x FROM employer_profiles WHERE user_id = ? AND organization_id = ?', ctx.user.id, row.organization_id);
    }
    const isPublic = row.status === 'published' || row.status === 'closed';
    if (!isPublic && !isManager) throw notFound('Вакансия не найдена.');
    if (row.status === 'published' && !isManager) db.run('UPDATE vacancies SET views = views + 1 WHERE id = ?', id);

    const dto = vacancyDto(row);
    if (!isManager) dto.views = undefined;
    const org = db.get('SELECT * FROM organizations WHERE id = ?', row.organization_id);
    dto.organization = organizationDto(org);
    if (isManager) dto.moderationNote = row.moderation_note;

    const viewer = { role: ctx.user ? ctx.user.role : null, saved: false, application: null };
    if (ctx.user && ctx.user.role === 'candidate') {
      viewer.saved = !!db.get('SELECT 1 AS x FROM saved_vacancies WHERE user_id = ? AND vacancy_id = ?', ctx.user.id, id);
      const app = db.get("SELECT id, status FROM applications WHERE vacancy_id = ? AND candidate_id = ? AND status <> 'withdrawn'", id, ctx.user.id);
      if (app) viewer.application = { id: app.id, status: app.status, statusLabel: C.APPLICATION_STATUSES[app.status] };
    }
    return { vacancy: dto, viewer };
  });

  // ---------------------------------------------------------------- партнёры
  const publiclyVisibleOrg = "(o.is_partner_listed = 1 OR EXISTS (SELECT 1 FROM vacancies pv WHERE pv.organization_id = o.id AND pv.status IN ('published','closed')))";

  router.get('/api/organizations', (ctx) => {
    const q = ctx.query;
    const where = ['o.is_partner_listed = 1'];
    const params = [];
    const like = (s) => `%${V.escapeLike(String(s).trim().toLowerCase())}%`;
    if (typeof q.q === 'string' && q.q.trim()) {
      where.push("(lc(o.name) LIKE ? ESCAPE '\\' OR lc(o.description) LIKE ? ESCAPE '\\')");
      params.push(like(q.q.slice(0, 100)), like(q.q.slice(0, 100)));
    }
    if (typeof q.city === 'string' && q.city.trim()) { where.push("lc(o.city) LIKE ? ESCAPE '\\'"); params.push(like(q.city.slice(0, 80))); }
    if (typeof q.industry === 'string' && q.industry.trim()) { where.push('o.industry = ?'); params.push(q.industry.slice(0, 100)); }
    if (q.verified === '1') where.push("o.verification_status = 'verified'");
    if (q.source === 'college') where.push('o.is_college_unit = 1');
    if (q.source === 'partner') where.push('o.is_college_unit = 0');
    const pg = pageParams(q, { defaultSize: 12, maxSize: 50 });
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM organizations o WHERE ${w}`, ...params).n;
    const rows = db.all(
      `SELECT o.*, (SELECT COUNT(*) FROM vacancies v WHERE v.organization_id = o.id AND v.status = 'published') AS vacancies_count
       FROM organizations o WHERE ${w} ORDER BY (o.verification_status = 'verified') DESC, o.name LIMIT ? OFFSET ?`,
      ...params, pg.pageSize, pg.offset,
    );
    return pageResult(rows.map((o) => organizationDto(o, { vacanciesCount: o.vacancies_count })), total, pg);
  });

  router.get('/api/organizations/:id', (ctx) => {
    const id = V.parseId(ctx.params.id);
    const org = id && db.get(`SELECT o.* FROM organizations o WHERE o.id = ? AND ${publiclyVisibleOrg}`, id);
    if (!org) throw notFound('Организация не найдена.');
    const vacancies = db.all(`${VACANCY_SELECT} WHERE v.organization_id = ? AND v.status = 'published' ORDER BY v.published_at DESC, v.id DESC`, id)
      .map((r) => ({ ...vacancyDto(r), description: truncate(r.description, 200), responsibilities: undefined, requirements: undefined, conditions: undefined }));
    return { organization: organizationDto(org, { vacanciesCount: vacancies.length }), vacancies };
  });

  router.get('/api/organizations/:id/logo', (ctx) => {
    const id = V.parseId(ctx.params.id);
    const org = id && db.get(`SELECT o.logo_path, o.logo_mime FROM organizations o WHERE o.id = ? AND o.logo_path IS NOT NULL AND ${publiclyVisibleOrg}`, id);
    const file = org && storedPath(config.uploadDir, 'logos', org.logo_path);
    if (!file) throw notFound('Логотип не найден.');
    ctx.sendRaw(200, fs.readFileSync(file), {
      'Content-Type': org.logo_mime,
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });
}

module.exports = { register, CONTENT_KEYS, DEFAULT_CONTENT };
