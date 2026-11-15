-- ГГКИТ Карьера ЧР — начальная схема базы данных (SQLite)
-- Все даты хранятся в UTC в формате ISO 8601.

-- ---------------------------------------------------------------------------
-- Роли и пользователи
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  name  TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
INSERT INTO roles (name, title) VALUES
  ('candidate', 'Соискатель'),
  ('employer',  'Работодатель'),
  ('admin',     'Администратор');

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL REFERENCES roles(name),
  full_name            TEXT NOT NULL,
  phone                TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_users_role_status ON users(role, status);

-- В cookie хранится случайный токен, в базе — только его SHA-256.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- ---------------------------------------------------------------------------
-- Организации и работодатели
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  description         TEXT,
  city                TEXT NOT NULL,
  address             TEXT,
  industry            TEXT,
  specialties_text    TEXT,
  website             TEXT,
  contact_person      TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  logo_path           TEXT,
  logo_mime           TEXT,
  is_college_unit     INTEGER NOT NULL DEFAULT 0 CHECK (is_college_unit IN (0, 1)),
  is_partner_listed   INTEGER NOT NULL DEFAULT 0 CHECK (is_partner_listed IN (0, 1)),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  verification_note   TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_organizations_listed ON organizations(is_partner_listed, verification_status);
CREATE INDEX idx_organizations_city ON organizations(city);

CREATE TABLE employer_profiles (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_title  TEXT
);
CREATE INDEX idx_employer_profiles_org ON employer_profiles(organization_id);

CREATE TABLE organization_verification_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TEXT,
  review_note     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX uq_org_verif_pending ON organization_verification_requests(organization_id) WHERE status = 'pending';
CREATE INDEX idx_org_verif_status ON organization_verification_requests(status, created_at);

-- ---------------------------------------------------------------------------
-- Соискатели, документы, резюме
-- ---------------------------------------------------------------------------
CREATE TABLE candidate_profiles (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city                TEXT,
  about               TEXT,
  skills              TEXT,
  desired_position    TEXT,
  desired_salary      INTEGER CHECK (desired_salary IS NULL OR desired_salary >= 0),
  -- Статус, который указал сам пользователь. Подтверждённым он становится только после проверки.
  candidate_type      TEXT NOT NULL DEFAULT 'applicant' CHECK (candidate_type IN ('applicant', 'student', 'graduate')),
  verification_status TEXT NOT NULL DEFAULT 'none' CHECK (verification_status IN ('none', 'pending', 'verified', 'rejected')),
  verified_kind       TEXT CHECK (verified_kind IS NULL OR verified_kind IN ('student', 'graduate')),
  verified_at         TEXT,
  group_name          TEXT,
  specialty_code      TEXT,
  graduation_year     INTEGER,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('resume', 'verification', 'other')),
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size > 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_documents_user ON documents(user_id);

CREATE TABLE resumes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  desired_position TEXT,
  about            TEXT,
  experience       TEXT,
  education        TEXT,
  skills           TEXT,
  document_id      INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  is_primary       INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_resumes_user ON resumes(user_id);

-- ---------------------------------------------------------------------------
-- Вакансии
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  specialty_code TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0
);
INSERT INTO categories (slug, name, specialty_code, sort_order) VALUES
  ('programming', 'Программирование',                 '09.02.07', 1),
  ('networks',    'Сети и системное администрирование', '09.02.06', 2),
  ('infosec',     'Информационная безопасность',       '10.02.05', 3),
  ('economics',   'Экономика и бухгалтерский учёт',    '38.02.01', 4),
  ('education',   'Образование и наставничество',      NULL,       5),
  ('other',       'Другое',                            NULL,       6);

CREATE TABLE vacancies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category_id     INTEGER NOT NULL REFERENCES categories(id),
  title           TEXT NOT NULL,
  city            TEXT NOT NULL,
  address         TEXT,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('full', 'part', 'internship', 'project')),
  experience      TEXT NOT NULL CHECK (experience IN ('none', 'lt1', '1-3', '3plus')),
  salary_min      INTEGER CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max      INTEGER CHECK (salary_max IS NULL OR salary_max >= 0),
  work_format     TEXT,
  department      TEXT,
  description     TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '[]',
  requirements    TEXT NOT NULL DEFAULT '[]',
  conditions      TEXT NOT NULL DEFAULT '[]',
  contact_person  TEXT,
  contact_phone   TEXT,
  contact_email   TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending', 'published', 'rejected', 'closed')),
  moderation_note TEXT,
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TEXT,
  is_featured     INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  is_demo         INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  views           INTEGER NOT NULL DEFAULT 0,
  published_at    TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min)
);
CREATE INDEX idx_vacancies_status_published ON vacancies(status, published_at DESC);
CREATE INDEX idx_vacancies_org ON vacancies(organization_id, status);
CREATE INDEX idx_vacancies_category ON vacancies(category_id);
CREATE INDEX idx_vacancies_city ON vacancies(city);

CREATE TABLE saved_vacancies (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, vacancy_id)
);
CREATE INDEX idx_saved_vacancy ON saved_vacancies(vacancy_id);

-- ---------------------------------------------------------------------------
-- Отклики
-- ---------------------------------------------------------------------------
CREATE TABLE applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  vacancy_id         INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  candidate_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id          INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  resume_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  -- Копия резюме на момент отклика: работодатель видит именно то, что отправил кандидат.
  resume_snapshot    TEXT,
  cover_letter       TEXT,
  status             TEXT NOT NULL DEFAULT 'sent'
                     CHECK (status IN ('sent', 'reviewing', 'viewed', 'interview', 'accepted', 'rejected', 'withdrawn')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status_changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Один активный отклик кандидата на вакансию; после отзыва можно откликнуться снова.
CREATE UNIQUE INDEX uq_applications_active ON applications(vacancy_id, candidate_id) WHERE status <> 'withdrawn';
CREATE INDEX idx_applications_vacancy ON applications(vacancy_id, status);
CREATE INDEX idx_applications_candidate ON applications(candidate_id, created_at DESC);

CREATE TABLE application_status_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  changed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_app_history_app ON application_status_history(application_id, created_at);

-- Внутренние комментарии работодателя: кандидату не показываются.
CREATE TABLE application_comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_app_comments_app ON application_comments(application_id, created_at);

-- ---------------------------------------------------------------------------
-- Подтверждение статуса студента / выпускника
-- ---------------------------------------------------------------------------
-- Закрытое хранилище записей колледжа. Наружу через публичный API и статические файлы не отдаётся.
-- В поставке — только вымышленные тестовые записи (is_test = 1).
CREATE TABLE student_registry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('student', 'graduate')),
  group_name     TEXT,
  specialty_code TEXT,
  specialty_name TEXT,
  study_years    TEXT,
  is_test        INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE verification_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_kind   TEXT NOT NULL CHECK (claimed_kind IN ('student', 'graduate')),
  student_number TEXT NOT NULL,
  document_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  comment        TEXT,
  registry_id    INTEGER REFERENCES student_registry(id) ON DELETE SET NULL,
  registry_match TEXT NOT NULL CHECK (registry_match IN ('match', 'partial', 'not_found')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TEXT,
  review_note    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX uq_verif_pending ON verification_requests(user_id) WHERE status = 'pending';
CREATE INDEX idx_verif_status ON verification_requests(status, created_at);

CREATE TABLE verification_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER REFERENCES verification_requests(id) ON DELETE SET NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected', 'revoked')),
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_verif_history_user ON verification_history(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Уведомления, журнал действий, содержимое сайта
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE activity_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_activity_created ON activity_logs(created_at DESC);
CREATE INDEX idx_activity_actor ON activity_logs(actor_id);
CREATE INDEX idx_activity_entity ON activity_logs(entity_type, entity_id);

CREATE TABLE site_content (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
