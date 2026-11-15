# REST API ГГКИТ Карьера ЧР

Базовый адрес: тот же origin, что и у сайта (`/api/...`). Формат — JSON, кодировка UTF-8. Все сообщения об ошибках — на русском.

## Общие правила

**Аутентификация.** После входа сервер ставит cookie `ggkit_sid` (`HttpOnly`, `SameSite=Lax`, в production — `Secure`).
Роль и права берутся из сессии на сервере.

**CSRF.** Все изменяющие запросы (`POST/PUT/PATCH/DELETE`) авторизованного пользователя должны содержать заголовок
`X-CSRF-Token`. Токен возвращается в ответах `GET /api/auth/me`, `POST /api/auth/login` и `POST /api/auth/register`
в поле `csrfToken`. Публичные формы (`login`, `register`, `forgot`, `reset`) токена не требуют, но проверяются по `Origin`.
Тело изменяющих запросов — `Content-Type: application/json` (для загрузок — `multipart/form-data`).

**Ответы.** Успех — JSON-объект (`200`/`201`) или `204`. Списки:
`{ "items": [...], "total": 42, "page": 1, "pageSize": 20, "pages": 3 }` (параметры `page`, `pageSize`).

**Ошибки.** `{ "error": { "code": "…", "message": "…", "fields": { "поле": "сообщение" } } }`

| Статус | Значение |
|---|---|
| 400 | некорректный запрос (`invalid_json`, `invalid_file_type`, `invalid_file_content`, `invalid_token`) |
| 401 | нужен вход (`unauthorized`, `invalid_credentials`) |
| 403 | нет прав (`forbidden`, `csrf`, `bad_origin`, `account_blocked`, `password_change_required`) |
| 404 | не найдено (в том числе чужие данные — их существование не раскрывается) |
| 405 / 415 | неверный метод / тип содержимого |
| 409 | конфликт состояния (`duplicate_application`, `vacancy_closed`, `already_pending`, `has_applications`, …) |
| 413 | слишком большой запрос или файл |
| 422 | ошибка валидации — подробности в `error.fields` |
| 429 | лимит запросов (`rate_limited`, `account_locked`), заголовок `Retry-After` |

**Временный пароль.** Пока `user.mustChangePassword = true`, доступны только `/api/auth/me`, `/api/auth/logout`, `/api/auth/change-password`.

**Лимиты (на IP, скользящее окно):** общий — 600/мин; вход — 10 за 15 мин; регистрация — 10/ч; восстановление — 5/ч;
загрузки — 30/ч; заявки на подтверждение статуса — 10/ч.

Справочные значения:
- тип занятости `employmentType`: `full`, `part`, `internship`, `project`;
- опыт `experience`: `none`, `lt1`, `1-3`, `3plus`;
- статус вакансии: `draft`, `pending`, `published`, `rejected`, `closed`;
- статус отклика: `sent` Отправлен · `reviewing` На рассмотрении · `viewed` Просмотрен · `interview` Приглашение на собеседование · `accepted` Принят · `rejected` Отклонён · `withdrawn` Отозван.

Условные обозначения доступа: 🌐 все · 🔐 любой вошедший · 👤 соискатель · 🏢 работодатель · 🛡 администратор.

---

## Аутентификация и аккаунт

| Метод и путь | Доступ | Описание |
|---|---|---|
| `GET /api/auth/me` | 🌐 | `{ user, csrfToken }` или `{ user: null }` |
| `POST /api/auth/register` | 🌐 | Регистрация. `role`: `candidate` \| `employer`; `email`, `password` (≥ 8, буквы и цифры), `fullName`, `phone?`, `consent: true`; для работодателя — `organizationName`, `city`, `positionTitle?`; для соискателя — `candidateType?` (`applicant`/`student`/`graduate`). `201` |
| `POST /api/auth/login` | 🌐 | `{ email, password }` → `{ user, csrfToken }`. 5 неудач → блокировка на 15 мин |
| `POST /api/auth/logout` | 🔐 | Завершает сессию |
| `POST /api/auth/change-password` | 🔐 | `{ currentPassword, newPassword }`; закрывает остальные сессии |
| `POST /api/auth/forgot` | 🌐 | `{ email }` → `{ ok, mail }`, где `mail` = `sent` / `console` / `not_configured`. Ответ одинаков для существующих и несуществующих адресов |
| `POST /api/auth/reset` | 🌐 | `{ token, newPassword }`; токен одноразовый, действует 60 мин |
| `PATCH /api/me/account` | 🔐 | `{ fullName?, phone? }` |
| `POST /api/me/email` | 🔐 | `{ email, password }` — смена email |
| `DELETE /api/me/account` | 👤🏢 | `{ password }` — удаление аккаунта и данных |
| `GET /api/me/notifications` | 🔐 | `?unread=1&page=` → список + `unreadCount` |
| `POST /api/me/notifications/read-all` | 🔐 | Отметить все прочитанными |
| `POST /api/me/notifications/:id/read` | 🔐 | Отметить прочитанным |
| `DELETE /api/me/notifications/:id` | 🔐 | Удалить |

## Публичные данные

| Метод и путь | Описание |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/meta` | категории, типы занятости, уровни опыта, статусы, города и сферы из базы |
| `GET /api/stats` | статистика по реальным записям БД (вакансии, организации, соискатели, подтверждённые студенты и выпускники, отклики, вакансии по категориям) |
| `GET /api/site` | редактируемый контент сайта (`content`) |
| `GET /api/vacancies` | каталог (см. ниже) |
| `GET /api/vacancies/:id` | `{ vacancy, viewer }`; опубликованные и закрытые — публично, остальные — только владельцу и администратору |
| `GET /api/organizations` | каталог партнёров: `q, city, industry, verified=1, source=college\|partner, page, pageSize` |
| `GET /api/organizations/:id` | `{ organization, vacancies }` — организации из каталога или с публичными вакансиями |
| `GET /api/organizations/:id/logo` | изображение логотипа |

### `GET /api/vacancies`

| Параметр | Значение |
|---|---|
| `q` | общий поиск: каждое слово должно встретиться в должности, организации, городе или категории |
| `position`, `employer`, `city` | частичное совпадение без учёта регистра (в т. ч. кириллица) |
| `category` | slug категории: `programming`, `networks`, `infosec`, `economics`, `education`, `other` |
| `type`, `experience` | коды из справочника выше |
| `salaryFrom` | вакансии, у которых верхняя граница зарплаты (или единственная) ≥ значения; без зарплаты — не попадают |
| `status` | `active` (по умолчанию) \| `closed` \| `all` |
| `source` | `college` (вакансии ГГКИТ) \| `partner` |
| `organizationId`, `featured=1` | по организации; только рекомендуемые |
| `sort` | `date` (по умолчанию) \| `salary` (вакансии без зарплаты — в конце) |
| `order` | `desc` (по умолчанию) \| `asc` |
| `page`, `pageSize` | страница и размер (до 50) |

Все фильтры применяются одновременно (логическое «И»).

## Соискатель 👤

| Метод и путь | Описание |
|---|---|
| `GET /api/me/profile`, `PUT /api/me/profile` | профиль: `fullName, phone, city, about, skills, desiredPosition, desiredSalary, candidateType`. Подтверждённый статус сам изменить нельзя |
| `GET /api/me/documents` | список документов |
| `POST /api/me/documents` | загрузка (`multipart`: поле `file`, поле `kind` = `resume`/`verification`/`other`). PDF, DOC, DOCX, PNG, JPG; размер ≤ `MAX_UPLOAD_MB`; тип проверяется по содержимому; до 20 файлов |
| `DELETE /api/me/documents/:id` | удалить документ и файл |
| `GET /api/documents/:id/download` | 🔐 скачать: владелец, администратор или работодатель, которому резюме отправлено откликом |
| `GET/POST /api/me/resumes`, `PUT/DELETE /api/me/resumes/:id` | резюме (до 5): `title, desiredPosition, about, experience, education, skills, documentId?, isPrimary?` |
| `GET /api/me/saved`, `PUT/DELETE /api/me/saved/:vacancyId` | избранное |
| `GET /api/me/verification` | статус подтверждения, активная заявка, история |
| `POST /api/me/verification` | заявка `{ claimedKind, studentNumber, documentId?, comment? }`. Результат сверки с реестром кандидату **не возвращается** |
| `POST /api/vacancies/:id/apply` | отклик `{ resumeId, coverLetter? }`; `409 duplicate_application`, `409 vacancy_closed` |
| `GET /api/me/applications` | `?status=&page=` история откликов со статусами |
| `POST /api/applications/:id/withdraw` | отозвать (недоступно для «Принят», «Отклонён», «Отозван») |

## Работодатель 🏢

| Метод и путь | Описание |
|---|---|
| `GET/PUT /api/employer/organization` | карточка организации + последняя заявка на проверку |
| `POST/DELETE /api/employer/organization/logo` | логотип (`multipart`, PNG/JPG/WebP ≤ 1 МБ) |
| `POST /api/employer/organization/verification-request` | `{ message? }`; нужен контактный email или телефон |
| `GET /api/employer/vacancies` | `?status=&q=&page=` с числом откликов |
| `POST /api/employer/vacancies` | создать (`submit: true` — сразу на модерацию, иначе черновик) |
| `GET/PUT/DELETE /api/employer/vacancies/:id` | просмотр, правка (правка опубликованной возвращает её на модерацию), удаление (нельзя при наличии откликов) |
| `POST /api/employer/vacancies/:id/publish` | отправить на модерацию (из черновика, отклонённой, закрытой) |
| `POST /api/employer/vacancies/:id/close` | закрыть |
| `GET /api/employer/vacancies/:id/stats`, `GET /api/employer/stats` | статистика |
| `GET /api/employer/applications` | `?vacancyId=&status=&q=&page=` |
| `GET /api/employer/applications/:id` | детали: профиль, резюме, письмо, история, комментарии. Первое открытие переводит «Отправлен» → «Просмотрен» |
| `PATCH /api/employer/applications/:id/status` | `{ status }`: `reviewing`, `viewed`, `interview`, `accepted`, `rejected` |
| `POST /api/employer/applications/:id/comments` | `{ body }` — внутренний комментарий (кандидату не виден) |

Работодатель видит только вакансии и отклики своей организации; чужие записи отвечают `404`.

## Администратор 🛡

| Метод и путь | Описание |
|---|---|
| `GET /api/admin/stats` | сводка и счётчики ожидающих заявок |
| `GET /api/admin/users`, `GET /api/admin/users/:id` | `?role=&status=&q=&page=` |
| `POST /api/admin/users` | создать администратора → временный пароль (показывается один раз) |
| `PATCH /api/admin/users/:id` | `fullName, phone, email, role` (допустимо: любой → администратор, администратор → соискатель) |
| `POST /api/admin/users/:id/block`, `/unblock` | блокировка (завершает сессии); нельзя себя и последнего администратора |
| `POST /api/admin/users/:id/reset-password` | временный пароль + обязательная смена |
| `POST /api/admin/users/:id/revoke-verification` | `{ note }` — отозвать подтверждённый статус |
| `GET /api/admin/vacancies`, `GET /api/admin/vacancies/:id` | `?status=&q=&organizationId=` (на модерации — первыми) |
| `PATCH /api/admin/vacancies/:id` | правка полей и `isFeatured` |
| `POST /api/admin/vacancies/:id/approve` / `reject` / `close` | модерация (`reject` требует `{ note }`) |
| `DELETE /api/admin/vacancies/:id` | удаление вместе с откликами |
| `GET/POST /api/admin/organizations`, `GET/PATCH/DELETE /api/admin/organizations/:id` | организации, `isPartnerListed`, `isCollegeUnit`, `verificationStatus` |
| `GET /api/admin/organization-requests` | заявки на проверку |
| `POST /api/admin/organization-requests/:id/approve` / `reject` | решение (`reject` требует `{ note }`) |
| `GET/POST /api/admin/students`, `PATCH/DELETE /api/admin/students/:id` | закрытый реестр студентов и выпускников |
| `GET /api/admin/verification-requests` | заявки + результат сверки (`match` / `partial` / `not_found`) |
| `POST /api/admin/verification-requests/:id/approve` / `reject` | при несовпадении с реестром подтверждение требует `{ note }` |
| `GET /api/admin/verification-history` | история проверок (`?userId=`) |
| `GET /api/admin/applications`, `GET /api/admin/applications/:id` | `?status=&vacancyId=&organizationId=&q=` — только просмотр |
| `GET /api/admin/logs` | журнал: `action` (префикс), `actorId`, `entityType`, `from`, `to`, `page` |
| `GET/PUT /api/admin/content` | контент сайта: `hero_title, hero_subtitle, about_title, about_text, about_founded, contact_address, contact_phone, contact_email, footer_note` (пустое значение возвращает текст по умолчанию) |
