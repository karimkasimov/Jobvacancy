'use strict';

const EMPLOYMENT_TYPES = {
  full: 'Полная занятость',
  part: 'Частичная занятость',
  internship: 'Стажировка',
  project: 'Проектная работа',
};

const EXPERIENCE_LEVELS = {
  none: 'Без опыта',
  lt1: 'До 1 года',
  '1-3': 'От 1 до 3 лет',
  '3plus': 'От 3 лет',
};

const APPLICATION_STATUSES = {
  sent: 'Отправлен',
  reviewing: 'На рассмотрении',
  viewed: 'Просмотрен',
  interview: 'Приглашение на собеседование',
  accepted: 'Принят',
  rejected: 'Отклонён',
  withdrawn: 'Отозван',
};
// Статусы, которые может выставить работодатель. «Отправлен» и «Отозван» — только системные.
const EMPLOYER_SETTABLE_STATUSES = ['reviewing', 'viewed', 'interview', 'accepted', 'rejected'];
// Из этих статусов кандидат не может отозвать отклик.
const FINAL_APPLICATION_STATUSES = ['accepted', 'rejected', 'withdrawn'];

const VACANCY_STATUSES = {
  draft: 'Черновик',
  pending: 'На модерации',
  published: 'Опубликована',
  rejected: 'Отклонена',
  closed: 'Закрыта',
};

const ORG_VERIFICATION = {
  unverified: 'Не проверена',
  pending: 'На проверке',
  verified: 'Проверена',
  rejected: 'Отклонена',
};

const CANDIDATE_TYPES = { applicant: 'Соискатель', student: 'Студент ГГКИТ', graduate: 'Выпускник ГГКИТ' };
const VERIFICATION_STATUSES = { none: 'Не подтверждён', pending: 'На проверке', verified: 'Подтверждён', rejected: 'Отклонён' };
const ROLES = { candidate: 'Соискатель', employer: 'Работодатель', admin: 'Администратор' };

module.exports = {
  EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, APPLICATION_STATUSES, EMPLOYER_SETTABLE_STATUSES,
  FINAL_APPLICATION_STATUSES, VACANCY_STATUSES, ORG_VERIFICATION, CANDIDATE_TYPES,
  VERIFICATION_STATUSES, ROLES,
};
