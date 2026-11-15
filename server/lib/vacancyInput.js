'use strict';
const V = require('./validate');
const C = require('./constants');
const { ApiError } = require('./errors');

const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);

const schema = {
  title: V.str({ min: 3, max: 150 }),
  categoryId: V.int({ min: 1 }),
  city: V.str({ min: 2, max: 80 }),
  address: V.str({ max: 250, optional: true }),
  employmentType: V.oneOf(C.EMPLOYMENT_TYPES),
  experience: V.oneOf(C.EXPERIENCE_LEVELS),
  salaryMin: V.int({ min: 0, max: 10_000_000, optional: true }),
  salaryMax: V.int({ min: 0, max: 10_000_000, optional: true }),
  workFormat: V.str({ max: 120, optional: true }),
  department: V.str({ max: 150, optional: true }),
  description: V.str({ min: 20, max: 5000, multiline: true }),
  responsibilities: V.stringList(),
  requirements: V.stringList(),
  conditions: V.stringList(),
  contactPerson: V.str({ max: 150, optional: true }),
  contactPhone: V.phone(),
  contactEmail: V.email({ optional: true }),
};

const COLUMNS = {
  title: 'title', categoryId: 'category_id', city: 'city', address: 'address', employmentType: 'employment_type',
  experience: 'experience', salaryMin: 'salary_min', salaryMax: 'salary_max', workFormat: 'work_format',
  department: 'department', description: 'description', responsibilities: 'responsibilities',
  requirements: 'requirements', conditions: 'conditions', contactPerson: 'contact_person',
  contactPhone: 'contact_phone', contactEmail: 'contact_email',
};

const LIST_FIELDS = ['responsibilities', 'requirements', 'conditions'];

function checkCategory(db, categoryId) {
  if (categoryId !== undefined && !db.get('SELECT 1 AS x FROM categories WHERE id = ?', categoryId)) {
    throw invalid({ categoryId: 'Выберите категорию из списка.' });
  }
}

function checkSalary(min, max) {
  if (min !== null && min !== undefined && max !== null && max !== undefined && max < min) {
    throw invalid({ salaryMax: 'Максимальная зарплата не может быть меньше минимальной.' });
  }
}

/** Преобразует проверенные данные в пары колонка/значение (списки сериализуются в JSON). */
function toColumnValues(data) {
  const cols = [];
  const vals = [];
  for (const [key, col] of Object.entries(COLUMNS)) {
    if (!(key in data)) continue;
    cols.push(col);
    vals.push(LIST_FIELDS.includes(key) ? JSON.stringify(data[key]) : data[key]);
  }
  return { cols, vals };
}

function insertVacancy(db, { organizationId, userId, data, status, isDemo = 0 }) {
  checkCategory(db, data.categoryId);
  checkSalary(data.salaryMin, data.salaryMax);
  const { cols, vals } = toColumnValues(data);
  const all = [...cols, 'organization_id', 'created_by', 'status', 'is_demo'];
  const r = db.run(
    `INSERT INTO vacancies (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`,
    ...vals, organizationId, userId, status, isDemo,
  );
  return Number(r.lastInsertRowid);
}

function updateVacancyColumns(db, id, existing, data, extraSets = {}) {
  if ('categoryId' in data) checkCategory(db, data.categoryId);
  checkSalary('salaryMin' in data ? data.salaryMin : existing.salary_min, 'salaryMax' in data ? data.salaryMax : existing.salary_max);
  const { cols, vals } = toColumnValues(data);
  const sets = cols.map((c) => `${c} = ?`);
  const values = [...vals];
  for (const [col, val] of Object.entries(extraSets)) { sets.push(`${col} = ?`); values.push(val); }
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  db.run(`UPDATE vacancies SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
}

module.exports = { schema, insertVacancy, updateVacancyColumns };
