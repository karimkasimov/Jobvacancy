'use strict';
const C = require('./constants');
const { userDto, VACANCY_SELECT } = require('./dto');
const { forbidden, notFound } = require('./errors');

/** Данные текущего пользователя для /api/auth/me (без секретов). */
function meDto(db, user) {
  const extra = {};
  if (user.role === 'employer') {
    const org = db.get(
      `SELECT o.id, o.name, o.verification_status FROM employer_profiles ep
       JOIN organizations o ON o.id = ep.organization_id WHERE ep.user_id = ?`,
      user.id,
    );
    extra.organization = org ? { id: org.id, name: org.name, verificationStatus: org.verification_status } : null;
  }
  if (user.role === 'candidate') {
    const p = db.get('SELECT candidate_type, verification_status FROM candidate_profiles WHERE user_id = ?', user.id);
    extra.candidate = p ? { type: p.candidate_type, verificationStatus: p.verification_status } : null;
  }
  extra.unreadNotifications = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n;
  return userDto(user, extra);
}

const getVacancyRow = (db, id) => db.get(`${VACANCY_SELECT} WHERE v.id = ?`, id);

/** Организация текущего работодателя; работодатель управляет только ею. */
function employerOrg(db, user) {
  const org = db.get(
    `SELECT o.* FROM employer_profiles ep JOIN organizations o ON o.id = ep.organization_id WHERE ep.user_id = ?`,
    user.id,
  );
  if (!org) throw forbidden('К вашему аккаунту не привязана организация.');
  return org;
}

/** Вакансия, принадлежащая организации работодателя, иначе 404 (не раскрываем чужие записи). */
function ownVacancy(db, user, id) {
  const org = employerOrg(db, user);
  const row = getVacancyRow(db, id);
  if (!row || row.organization_id !== org.id) throw notFound('Вакансия не найдена.');
  return { org, row };
}

function candidateProfileDto(db, userId) {
  const p = db.get('SELECT * FROM candidate_profiles WHERE user_id = ?', userId) || {};
  return {
    city: p.city ?? null,
    about: p.about ?? null,
    skills: p.skills ?? null,
    desiredPosition: p.desired_position ?? null,
    desiredSalary: p.desired_salary ?? null,
    candidateType: p.candidate_type || 'applicant',
    candidateTypeLabel: C.CANDIDATE_TYPES[p.candidate_type || 'applicant'],
    verificationStatus: p.verification_status || 'none',
    verificationLabel: C.VERIFICATION_STATUSES[p.verification_status || 'none'],
    verifiedKind: p.verified_kind ?? null,
    verifiedAt: p.verified_at ?? null,
    groupName: p.group_name ?? null,
    specialtyCode: p.specialty_code ?? null,
    graduationYear: p.graduation_year ?? null,
  };
}

const pageParams = (query, { defaultSize = 20, maxSize = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

const pageResult = (items, total, { page, pageSize }) => ({
  items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
});

module.exports = { meDto, getVacancyRow, employerOrg, ownVacancy, candidateProfileDto, pageParams, pageResult };
