'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openDatabase, migrate } = require('./db');
const S = require('./lib/security');
const { ensureAdmin } = require('./create-admin');

/**
 * Демонстрационные данные для разработки. Вакансии и партнёры взяты из исходной статической версии сайта;
 * записи реестра студентов — ВЫМЫШЛЕННЫЕ тестовые (is_test = 1). Реальные данные студентов сюда не попадают.
 * Все демо-вакансии и демо-организации помечены is_demo = 1.
 */
const MONTHS = { января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12 };
const parseDate = (s) => {
  const m = /(\d{1,2})\s+([а-я]+)\s+(\d{4})/.exec(s);
  return m ? new Date(Date.UTC(+m[3], MONTHS[m[2]] - 1, +m[1], 9, 0, 0)).toISOString() : new Date().toISOString();
};
const parseSalary = (s) => {
  const nums = (String(s).replace(/[\u00A0\u202F]/g, ' ').match(/\d[\d ]*\d/g) || []).map((n) => parseInt(n.replace(/ /g, ''), 10));
  return { min: nums[0] || null, max: nums[1] || null };
};
function experienceOf(text) {
  if (/без опыта/i.test(text)) return 'none';
  if (/6 месяцев/i.test(text)) return 'lt1';
  if (/от 1 года/i.test(text)) return '1-3';
  return 'lt1';
}
const CATEGORY = { '09.02.07': 'programming', '09.02.06': 'networks', '10.02.05': 'infosec', '38.02.01': 'economics' };
const INDUSTRY = { 'part-1': 'Информационные технологии', 'part-2': 'Телекоммуникации', 'part-3': 'Агропромышленный комплекс', 'part-4': 'Государственные информационные системы', 'part-5': 'Информационные технологии', 'part-6': 'Финансы и консалтинг' };

const COLLEGE_NAME = 'ГБПОУ «Грозненский государственный колледж информационных технологий»';

const REGISTRY = [
  { n: 'TEST-STU-001', name: 'Тестов Иван Петрович', kind: 'student', group: 'ИСиП-31 (3 курс)', code: '09.02.07', spec: 'Информационные системы и программирование', years: '2024–2027' },
  { n: 'TEST-STU-002', name: 'Образцова Мария Ивановна', kind: 'student', group: 'ССА-42 (4 курс)', code: '09.02.06', spec: 'Сетевое и системное администрирование', years: '2023–2026' },
  { n: 'TEST-GRAD-001', name: 'Примерова Елена Сергеевна', kind: 'graduate', group: 'Выпуск 2025 (ЭБ-31)', code: '38.02.01', spec: 'Экономика и бухгалтерский учёт', years: '2022–2025' },
  { n: 'TEST-GRAD-002', name: 'Шаблонов Пётр Андреевич', kind: 'graduate', group: 'Выпуск 2024 (ИБ-41)', code: '10.02.05', spec: 'Обеспечение информационной безопасности АС', years: '2021–2024' },
];

async function main() {
  const config = loadConfig();
  if (config.isProduction && !process.argv.includes('--force')) {
    console.error('Демо-данные нельзя загружать в production. Для создания администратора используйте: npm run create-admin');
    process.exit(1);
  }
  const db = openDatabase(config.databasePath);
  migrate(db, config.migrationsDir);
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data', 'legacy-demo.json'), 'utf8'));
  const shared = process.env.SEED_PASSWORD || null;
  const credentials = [];

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@ggkit.example';
  if (db.get('SELECT 1 AS x FROM users WHERE email = ?', adminEmail)) {
    console.log(`Администратор ${adminEmail} уже существует — пароль не меняется.`);
  } else {
    const admin = await ensureAdmin(db, config, {
      email: adminEmail,
      fullName: 'Администратор портала',
      password: process.env.ADMIN_PASSWORD || shared || undefined,
    });
    credentials.push(['Администратор', admin.email, admin.password || process.env.ADMIN_PASSWORD || shared]);
  }

  const userByEmail = (email) => db.get('SELECT id FROM users WHERE email = ?', email);
  async function makeUser(email, role, fullName, phone) {
    const existing = userByEmail(email);
    if (existing) return { id: existing.id, created: false };
    const password = shared || S.temporaryPassword();
    const hash = await S.hashPassword(password, config.scrypt);
    const r = db.run('INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, ?, ?, ?)', email, hash, role, fullName, phone);
    credentials.push([role === 'employer' ? 'Работодатель' : 'Соискатель', email, password]);
    return { id: Number(r.lastInsertRowid), created: true };
  }

  // Организации: колледж + партнёры из исходного сайта.
  const orgIds = {};
  function ensureOrg(key, o) {
    const ex = db.get('SELECT id FROM organizations WHERE name = ?', o.name);
    if (ex) { orgIds[key] = ex.id; return; }
    const r = db.run(
      `INSERT INTO organizations (name, description, city, address, industry, specialties_text, contact_person, contact_email, contact_phone,
         is_college_unit, is_partner_listed, verification_status, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified', 1)`,
      o.name, o.description, o.city, o.address, o.industry, o.specialties, o.person, o.email, o.phone, o.college ? 1 : 0,
    );
    orgIds[key] = Number(r.lastInsertRowid);
  }
  const v1 = legacy.vacancies[0];
  ensureOrg('college', {
    name: COLLEGE_NAME, city: 'Грозный', address: v1.address.replace(/\s*\(.*\)$/, ''), industry: 'Образование',
    description: 'Профильное учебное заведение: подготовка специалистов в области информационных систем, программирования, сетевого администрирования, информационной безопасности и экономики.',
    specialties: '09.02.07 · 09.02.06 · 10.02.05 · 38.02.01', person: v1.contactPerson, email: v1.contactEmail, phone: v1.contactPhone, college: true,
  });
  for (const p of legacy.partners) {
    ensureOrg(p.id, { name: p.name, city: p.city, industry: INDUSTRY[p.id], description: p.desc, specialties: p.specs });
  }
  const orgOfVacancy = (v) => {
    if (v.contour === 'college') return 'college';
    return legacy.partners.find((p) => p.name === v.org)?.id;
  };

  // Работодатели: по одному на организацию, у которой есть вакансии.
  const employerOf = {};
  let i = 0;
  for (const key of new Set(legacy.vacancies.map(orgOfVacancy))) {
    i += 1;
    const u = await makeUser(`demo.employer${i}@ggkit.example`, 'employer', `Представитель организации №${i}`, null);
    employerOf[key] = u.id;
    db.run('INSERT OR IGNORE INTO employer_profiles (user_id, organization_id, position_title) VALUES (?, ?, ?)', u.id, orgIds[key], 'Специалист по подбору персонала');
  }

  // Вакансии.
  const cats = Object.fromEntries(db.all('SELECT id, slug FROM categories').map((c) => [c.slug, c.id]));
  for (const v of legacy.vacancies) {
    const key = orgOfVacancy(v);
    if (db.get('SELECT 1 AS x FROM vacancies WHERE title = ? AND organization_id = ?', v.title, orgIds[key])) continue;
    const sal = parseSalary(v.salaryText);
    const type = 'full'; // в исходных данных все вакансии — полная занятость (вариант «полная или частичная» тоже сохраняется как полная)
    const exp = experienceOf(v.experience);
    const category = /Преподаватель/i.test(v.title) ? 'education' : CATEGORY[v.specCode] || 'other';
    const published = parseDate(v.published);
    db.run(
      `INSERT INTO vacancies (organization_id, created_by, category_id, title, city, address, employment_type, experience, salary_min, salary_max,
         work_format, department, description, responsibilities, requirements, conditions, contact_person, contact_phone, contact_email,
         status, is_featured, is_demo, published_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, 1, ?, ?)`,
      orgIds[key], employerOf[key], cats[category], v.title, v.city, v.address, type, exp, sal.min, sal.max, v.format, v.department,
      v.description, JSON.stringify(v.duties), JSON.stringify(v.requirements), JSON.stringify(v.conditions),
      v.contactPerson, v.contactPhone, v.contactEmail, v.contour === 'partner' && ['vac-2', 'vac-3'].includes(v.id) ? 1 : 0, published, published,
    );
  }

  // Закрытый реестр: только вымышленные тестовые записи.
  for (const r of REGISTRY) {
    db.run(
      'INSERT OR IGNORE INTO student_registry (student_number, full_name, kind, group_name, specialty_code, specialty_name, study_years, is_test) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      r.n, r.name, r.kind, r.group, r.code, r.spec, r.years,
    );
  }

  // Демо-соискатели.
  for (const [email, name, type] of [['demo.student@ggkit.example', 'Тестов Иван Петрович', 'student'], ['demo.graduate@ggkit.example', 'Примерова Елена Сергеевна', 'graduate']]) {
    const u = await makeUser(email, 'candidate', name, '+7 (900) 000-00-00');
    if (u.created) db.run('INSERT INTO candidate_profiles (user_id, candidate_type) VALUES (?, ?)', u.id, type);
  }

  // Контакты в подвале взяты из данных подразделения колледжа в исходном проекте — проверьте их в админ-панели («Контент»).
  const content = { contact_address: v1.address.replace(/\s*\(.*\)$/, ''), contact_phone: v1.contactPhone, contact_email: v1.contactEmail };
  for (const [k, val] of Object.entries(content)) db.run('INSERT OR IGNORE INTO site_content (key, value) VALUES (?, ?)', k, val);

  console.log('\nДемо-данные загружены.\n');
  console.log('Учётные записи для разработки (пароли показываются ОДИН раз):');
  for (const [role, email, password] of credentials) console.log(`  ${role.padEnd(13)} ${email.padEnd(34)} ${password || '(без изменений)'}`);
  if (!shared) console.log('\nЧтобы задать один известный пароль для всех демо-аккаунтов локально: SEED_PASSWORD=Demo12345 npm run seed (на чистой базе).');
  console.log('\nТестовые номера для проверки статуса студента/выпускника: ' + REGISTRY.map((r) => r.n).join(', '));
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
