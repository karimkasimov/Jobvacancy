'use strict';
const C = require('./constants');
const { candidateProfileDto } = require('./queries');

/** Представление отклика для работодателя и администратора. */
const APP_SELECT = `
  SELECT a.*, v.title AS vacancy_title, v.organization_id, o.name AS org_name,
         u.full_name AS candidate_name, u.email AS candidate_email, u.phone AS candidate_phone
  FROM applications a
  JOIN vacancies v ON v.id = a.vacancy_id
  JOIN organizations o ON o.id = v.organization_id
  JOIN users u ON u.id = a.candidate_id`;

const safeJson = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

function appListDto(a) {
  return {
    id: a.id,
    status: a.status,
    statusLabel: C.APPLICATION_STATUSES[a.status],
    createdAt: a.created_at,
    statusChangedAt: a.status_changed_at,
    vacancy: { id: a.vacancy_id, title: a.vacancy_title },
    organization: { id: a.organization_id, name: a.org_name },
    candidate: { id: a.candidate_id, fullName: a.candidate_name },
    resumeTitle: (safeJson(a.resume_snapshot) || {}).title || null,
  };
}

function applicationDetail(db, a) {
  const doc = a.resume_document_id ? db.get('SELECT id, original_name, size FROM documents WHERE id = ?', a.resume_document_id) : null;
  const profile = candidateProfileDto(db, a.candidate_id);
  return {
    ...appListDto(a),
    coverLetter: a.cover_letter,
    candidate: {
      id: a.candidate_id,
      fullName: a.candidate_name,
      email: a.candidate_email,
      phone: a.candidate_phone,
      city: profile.city,
      about: profile.about,
      skills: profile.skills,
      desiredPosition: profile.desiredPosition,
      // Работодателю показывается только факт подтверждения статуса, но не данные из реестра колледжа.
      collegeStatus: profile.verificationStatus === 'verified' ? profile.candidateTypeLabel : null,
    },
    resume: safeJson(a.resume_snapshot),
    resumeFile: doc ? { id: doc.id, name: doc.original_name, size: doc.size } : null,
    history: db.all('SELECT to_status, created_at FROM application_status_history WHERE application_id = ? ORDER BY created_at, id', a.id)
      .map((h) => ({ status: h.to_status, statusLabel: C.APPLICATION_STATUSES[h.to_status], createdAt: h.created_at })),
    comments: db.all(
      `SELECT c.id, c.body, c.created_at, u.full_name AS author FROM application_comments c
       LEFT JOIN users u ON u.id = c.author_id WHERE c.application_id = ? ORDER BY c.created_at, c.id`, a.id,
    ).map((c) => ({ id: c.id, body: c.body, author: c.author, createdAt: c.created_at })),
  };
}

module.exports = { APP_SELECT, appListDto, applicationDetail };
