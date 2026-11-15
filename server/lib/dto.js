'use strict';
const C = require('./constants');

function parseList(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const fmtMoney = (n) => new Intl.NumberFormat('ru-RU').format(n).replace(/\u00A0|\u202F/g, ' ');

function salaryText(min, max) {
  if (min && max) return min === max ? `${fmtMoney(min)} ₽` : `${fmtMoney(min)} – ${fmtMoney(max)} ₽`;
  if (min) return `от ${fmtMoney(min)} ₽`;
  if (max) return `до ${fmtMoney(max)} ₽`;
  return 'По договорённости';
}

const mapUrl = (address, city) => `https://yandex.ru/maps/?text=${encodeURIComponent(address || city || '')}`;

function userDto(u, extra = {}) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    phone: u.phone,
    role: u.role,
    roleLabel: C.ROLES[u.role],
    status: u.status,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    ...extra,
  };
}

/** Публичное представление организации: контакты организации публикуются по её собственной воле. */
function organizationDto(o, extra = {}) {
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    city: o.city,
    address: o.address,
    industry: o.industry,
    specialties: o.specialties_text,
    website: o.website,
    contactPerson: o.contact_person,
    contactEmail: o.contact_email,
    contactPhone: o.contact_phone,
    logoUrl: o.logo_path ? `/api/organizations/${o.id}/logo` : null,
    isCollegeUnit: !!o.is_college_unit,
    isPartnerListed: !!o.is_partner_listed,
    verificationStatus: o.verification_status,
    verificationLabel: C.ORG_VERIFICATION[o.verification_status],
    createdAt: o.created_at,
    ...extra,
  };
}

/** Вакансия + краткая организация. Ожидает строку из запроса VACANCY_SELECT. */
function vacancyDto(v) {
  return {
    id: v.id,
    title: v.title,
    status: v.status,
    statusLabel: C.VACANCY_STATUSES[v.status],
    category: { id: v.category_id, slug: v.category_slug, name: v.category_name, specialtyCode: v.specialty_code },
    city: v.city,
    address: v.address,
    mapUrl: mapUrl(v.address, v.city),
    employmentType: v.employment_type,
    employmentTypeLabel: C.EMPLOYMENT_TYPES[v.employment_type],
    experience: v.experience,
    experienceLabel: C.EXPERIENCE_LEVELS[v.experience],
    salaryMin: v.salary_min,
    salaryMax: v.salary_max,
    salaryText: salaryText(v.salary_min, v.salary_max),
    workFormat: v.work_format,
    department: v.department,
    description: v.description,
    responsibilities: parseList(v.responsibilities),
    requirements: parseList(v.requirements),
    conditions: parseList(v.conditions),
    contactPerson: v.contact_person,
    contactPhone: v.contact_phone,
    contactEmail: v.contact_email,
    isFeatured: !!v.is_featured,
    views: v.views,
    publishedAt: v.published_at,
    closedAt: v.closed_at,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    organization: {
      id: v.organization_id,
      name: v.org_name,
      city: v.org_city,
      logoUrl: v.org_has_logo ? `/api/organizations/${v.organization_id}/logo` : null,
      verificationStatus: v.org_verification,
      verificationLabel: C.ORG_VERIFICATION[v.org_verification],
      isCollegeUnit: !!v.org_is_college,
      isPartnerListed: !!v.org_is_listed,
    },
  };
}

const VACANCY_SELECT = `
  SELECT v.*, c.slug AS category_slug, c.name AS category_name, c.specialty_code,
         o.name AS org_name, o.city AS org_city, (o.logo_path IS NOT NULL) AS org_has_logo,
         o.verification_status AS org_verification, o.is_college_unit AS org_is_college,
         o.is_partner_listed AS org_is_listed
  FROM vacancies v
  JOIN organizations o ON o.id = v.organization_id
  JOIN categories c ON c.id = v.category_id`;

function resumeDto(r, doc) {
  return {
    id: r.id,
    title: r.title,
    desiredPosition: r.desired_position,
    about: r.about,
    experience: r.experience,
    education: r.education,
    skills: r.skills,
    isPrimary: !!r.is_primary,
    document: doc ? { id: doc.id, name: doc.original_name, size: doc.size } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function documentDto(d) {
  return { id: d.id, kind: d.kind, name: d.original_name, mime: d.mime, size: d.size, createdAt: d.created_at };
}

module.exports = {
  parseList, salaryText, mapUrl, userDto, organizationDto, vacancyDto, VACANCY_SELECT, resumeDto, documentDto,
};
