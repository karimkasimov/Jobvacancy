import { api, qs } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, createTabs, field, values, withLoading, handleFormError, toast, modal, confirmDialog, promptDialog, emptyState, errorState, fmtDate, fmtDateTime, fmtNumber, table, pager, numOrNull, textOrNull, debounce, loadingBlock, downloadLink } from '../ui.js';
import { appBadge, vacancyBadge, orgBadge, verifBadge, badge, notificationsPanel, accountSettings } from '../components.js';
import { openVacancyForm } from '../vacancyForm.js';
import { applicationDetailView } from '../appDetail.js';

const { user } = await initLayout({ require: 'admin' });
const app = document.getElementById('app');
const panel = (...kids) => h('section', { class: 'cabinet-panel-card stack' }, kids);
const metric = (num, label, attention) => h('div', { class: `metric${attention ? ' is-attention' : ''}` }, h('div', { class: 'num' }, fmtNumber(num)), h('div', { class: 'label' }, label));
const close = (m) => h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Закрыть');

/** Кнопка действия: блокируется на время запроса, ошибки показываются тостом. */
const act = (label, cls, fn) => h('button', { type: 'button', class: `${cls} btn-sm`, onclick: async (e) => {
  await withLoading(e.currentTarget, async () => { try { await fn(); } catch (err) { toast(err.message, 'error'); } });
} }, label);

/** Список с пагинацией: fetcher(page) → {items,total,pages,page}; render(items, reload) → узел. */
function pagedList(fetcher, render, { empty = 'Ничего не найдено' } = {}) {
  const box = h('div', { class: 'stack', 'aria-live': 'polite' });
  let page = 1;
  const self = {
    el: box,
    async reload() {
      try {
        const data = await fetcher(page);
        if (page > data.pages) { page = data.pages; return self.reload(); }
        mount(box, data.items.length ? [h('div', { class: 'result-count' }, `Всего: ${data.total}`), render(data.items, self.reload), pager(data, (n) => { page = n; self.reload(); })] : emptyState(empty));
      } catch (err) { mount(box, errorState(err.message, self.reload)); }
    },
    first() { page = 1; return self.reload(); },
  };
  mount(box, loadingBlock());
  self.reload();
  return self;
}

function secretModal(title, intro, secret) {
  const m = modal({ title, body: h('div', { class: 'stack' }, h('p', {}, intro), h('div', { class: 'code-box' }, secret),
    h('div', { class: 'alert alert-warn' }, 'Пароль показывается один раз. Передайте его пользователю безопасным способом — при первом входе потребуется сменить пароль.')),
  actions: [h('button', { type: 'button', class: 'btn-outline', onclick: async () => { try { await navigator.clipboard.writeText(secret); toast('Скопировано.', 'ok'); } catch { toast('Не удалось скопировать — выделите текст вручную.', 'error'); } } }, 'Копировать'), close({ close: () => m.close() })] });
}

const sel = (label, name, options, value = '') => field({ label, name, options, value });
const opts = (all, map) => [{ value: '', label: all }, ...Object.entries(map).map(([value, label]) => ({ value, label }))];

// ------------------------------------------------------------------ обзор
async function overviewTab() {
  const s = await api.get('/api/admin/stats');
  setPending(s.pending);
  const v = s.vacancies;
  return panel(h('h2', { class: 'section-title' }, 'Сводка по порталу'),
    h('div', { class: 'metrics' },
      metric(s.pending.vacancies, 'Вакансий на модерации', s.pending.vacancies > 0), metric(s.pending.organizations, 'Заявок организаций', s.pending.organizations > 0), metric(s.pending.students, 'Заявок студентов и выпускников', s.pending.students > 0)),
    h('h3', { class: 'section-title mt-16' }, 'Пользователи'),
    h('div', { class: 'metrics' }, metric(s.users.byRole.candidate || 0, 'Соискателей'), metric(s.users.byRole.employer || 0, 'Работодателей'), metric(s.users.byRole.admin || 0, 'Администраторов'), metric(s.users.blocked, 'Заблокировано'), metric(s.users.newThisWeek, 'Новых за 7 дней')),
    h('h3', { class: 'section-title mt-16' }, 'Вакансии и отклики'),
    h('div', { class: 'metrics' }, metric(v.published || 0, 'Опубликовано'), metric(v.closed || 0, 'Закрыто'), metric(v.draft || 0, 'Черновиков'), metric(v.rejected || 0, 'Отклонено'), metric(s.applications.total, 'Всего откликов'), metric(s.applications.thisWeek, 'Откликов за 7 дней')),
    h('h3', { class: 'section-title mt-16' }, 'Организации и реестр'),
    h('div', { class: 'metrics' }, metric(s.organizations.total, 'Организаций'), metric(s.organizations.byVerification.verified || 0, 'Проверено'), metric(s.organizations.listed, 'В каталоге партнёров'), metric(s.registryRecords, 'Записей реестра студентов')));
}

// ------------------------------------------------------------------ пользователи
const ROLE_LABEL = { candidate: 'Соискатель', employer: 'Работодатель', admin: 'Администратор' };

function editUser(u, reload) {
  const fields = [
    field({ label: 'ФИО', name: 'fullName', value: u.fullName, required: true, maxlength: 120, full: true }),
    field({ label: 'Email', name: 'email', type: 'email', value: u.email, required: true, maxlength: 254 }),
    field({ label: 'Телефон', name: 'phone', value: u.phone || '', maxlength: 25 }),
    field({ label: 'Роль', name: 'role', value: u.role, full: true, disabled: u.id === user.id, options: Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })),
      hint: 'Допустимы повышение до администратора и возврат администратора в соискатели. Переход между ролями соискателя и работодателя невозможен: у них разные данные.' }),
  ];
  const m = modal({ title: `Пользователь: ${u.fullName}`, body: h('form', { class: 'form-grid', novalidate: true, onsubmit: (e) => e.preventDefault() }, fields.map((f) => f.el)),
    actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
      const v = values(fields);
      await withLoading(e.currentTarget, async () => {
        try {
          const body = { fullName: v.fullName, email: v.email, phone: textOrNull(v.phone) };
          if (v.role !== u.role) body.role = v.role;
          await api.patch(`/api/admin/users/${u.id}`, body); m.close(); toast('Данные пользователя сохранены.', 'ok'); reload();
        } catch (err) { handleFormError(err, fields); }
      });
    } }, 'Сохранить')] });
}

function createAdmin(reload) {
  const fields = [field({ label: 'ФИО', name: 'fullName', required: true, maxlength: 120, full: true }), field({ label: 'Email', name: 'email', type: 'email', required: true, maxlength: 254 }), field({ label: 'Телефон', name: 'phone', maxlength: 25 })];
  const m = modal({ title: 'Новый администратор', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Будет создан аккаунт со временным паролем; при первом входе его потребуется сменить.'), h('div', { class: 'form-grid' }, fields.map((f) => f.el))),
    actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
      const v = values(fields);
      await withLoading(e.currentTarget, async () => {
        try { const r = await api.post('/api/admin/users', { fullName: v.fullName, email: v.email, phone: textOrNull(v.phone) }); m.close(); reload(); secretModal('Администратор создан', `Временный пароль для ${r.user.email}:`, r.temporaryPassword); } catch (err) { handleFormError(err, fields); }
      });
    } }, 'Создать')] });
}

async function usersTab() {
  const role = sel('Роль', 'role', opts('Все роли', ROLE_LABEL)); const status = sel('Статус', 'status', opts('Все', { active: 'Активные', blocked: 'Заблокированные' }));
  const q = field({ label: 'Поиск', name: 'q', type: 'search', placeholder: 'ФИО или email', maxlength: 100 });
  const pl = pagedList((page) => api.get(`/api/admin/users${qs({ role: role.value(), status: status.value(), q: q.value().trim(), page })}`), (items, reload) => table(['Пользователь', 'Роль', 'Статус', 'Связано', 'Последний вход', 'Действия!'], items.map((u) => h('tr', {},
    h('td', {}, h('span', { class: 'cell-title' }, u.fullName), h('span', { class: 'sub' }, u.email)), h('td', {}, ROLE_LABEL[u.role]),
    h('td', {}, badge('user', u.status, u.status === 'active' ? 'Активен' : 'Заблокирован'), u.locked ? h('span', { class: 'sub' }, 'временно заблокирован за неверные пароли') : null, u.mustChangePassword ? h('span', { class: 'sub' }, 'ожидает смены пароля') : null),
    h('td', {}, u.organizationName || (u.verificationStatus ? verifBadge(u.verificationStatus) : '—')), h('td', { class: 'nowrap' }, u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'не входил'),
    h('td', { class: 'actions' }, h('div', { class: 'table-actions' },
      act('Изменить', 'btn-outline', async () => editUser(u, reload)),
      u.id === user.id ? null : u.status === 'active'
        ? act('Заблокировать', 'btn-danger', async () => { const reason = await promptDialog({ title: `Заблокировать ${u.fullName}?`, label: 'Причина блокировки', required: false, confirmText: 'Заблокировать', danger: true }); if (reason === null && !(await confirmDialog({ title: 'Заблокировать без причины?', message: u.email, confirmText: 'Заблокировать', danger: true }))) return; await api.post(`/api/admin/users/${u.id}/block`, { reason: reason || undefined }); toast('Аккаунт заблокирован.', 'ok'); reload(); })
        : act('Разблокировать', 'btn-outline', async () => { await api.post(`/api/admin/users/${u.id}/unblock`); toast('Аккаунт разблокирован.', 'ok'); reload(); }),
      u.id === user.id ? null : act('Сбросить пароль', 'btn-outline', async () => { if (!(await confirmDialog({ title: 'Сбросить пароль?', message: `Для ${u.email} будет создан временный пароль, все сеансы пользователя завершатся.`, confirmText: 'Сбросить' }))) return; const r = await api.post(`/api/admin/users/${u.id}/reset-password`); secretModal('Временный пароль', `Новый временный пароль для ${u.email}:`, r.temporaryPassword); reload(); }),
      u.verificationStatus === 'verified' ? act('Отозвать подтверждение', 'btn-outline', async () => { const note = await promptDialog({ title: 'Отозвать подтверждение статуса?', label: 'Причина', confirmText: 'Отозвать', danger: true }); if (note) { await api.post(`/api/admin/users/${u.id}/revoke-verification`, { note }); toast('Подтверждение отозвано.', 'ok'); reload(); } }) : null)))), { empty: 'Пользователи не найдены' }));
  for (const f of [role, status]) f.input.addEventListener('change', () => pl.first());
  q.input.addEventListener('input', debounce(() => pl.first()));
  return panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Пользователи'), h('button', { type: 'button', class: 'btn-primary btn-sm', onclick: () => createAdmin(pl.reload) }, 'Создать администратора')), h('div', { class: 'toolbar' }, role.el, status.el, q.el), pl.el);
}

// ------------------------------------------------------------------ вакансии
async function vacanciesTab() {
  const status = sel('Статус', 'status', opts('Все статусы', { pending: 'На модерации', published: 'Опубликованные', rejected: 'Отклонённые', closed: 'Закрытые', draft: 'Черновики' }), 'pending');
  const q = field({ label: 'Поиск', name: 'q', type: 'search', placeholder: 'Должность или организация', maxlength: 100 });
  const pl = pagedList((page) => api.get(`/api/admin/vacancies${qs({ status: status.value(), q: q.value().trim(), page })}`), (items, reload) => table(['Вакансия', 'Организация', 'Статус', 'Отклики', 'Изменена', 'Действия!'], items.map((v) => h('tr', {},
    h('td', {}, h('a', { class: 'cell-title', href: `/vacancies/${v.id}` }, v.title), h('span', { class: 'sub' }, `${v.city} · ${v.salaryText}`), v.isFeatured ? h('span', { class: 'badge badge-info' }, 'Рекомендуемая') : null, v.moderationNote ? h('span', { class: 'sub' }, `Причина отклонения: ${v.moderationNote}`) : null),
    h('td', {}, v.organization.name, h('span', { class: 'sub' }, v.organization.verificationLabel)), h('td', {}, vacancyBadge(v.status)), h('td', {}, String(v.applicationsCount)), h('td', { class: 'nowrap' }, fmtDate(v.updatedAt)),
    h('td', { class: 'actions' }, h('div', { class: 'table-actions' },
      v.status === 'pending' ? act('Одобрить', 'btn-primary', async () => { await api.post(`/api/admin/vacancies/${v.id}/approve`); toast('Вакансия опубликована.', 'ok'); reload(); refreshPending(); }) : null,
      v.status === 'pending' ? act('Отклонить', 'btn-danger', async () => { const note = await promptDialog({ title: `Отклонить «${v.title}»?`, label: 'Причина отклонения (увидит работодатель)', confirmText: 'Отклонить', danger: true }); if (note) { await api.post(`/api/admin/vacancies/${v.id}/reject`, { note }); toast('Вакансия отклонена.', 'ok'); reload(); refreshPending(); } }) : null,
      act('Изменить', 'btn-outline', async () => openVacancyForm({ vacancy: v, title: 'Редактирование вакансии (администратор)', buttons: [{ label: 'Сохранить', kind: 'primary', run: async (b) => { await api.patch(`/api/admin/vacancies/${v.id}`, b); toast('Вакансия обновлена.', 'ok'); reload(); } }] })),
      v.status === 'published' ? act(v.isFeatured ? 'Убрать из рекомендуемых' : 'В рекомендуемые', 'btn-outline', async () => { await api.patch(`/api/admin/vacancies/${v.id}`, { isFeatured: !v.isFeatured }); reload(); }) : null,
      ['published', 'pending'].includes(v.status) ? act('Закрыть', 'btn-outline', async () => { if (await confirmDialog({ title: 'Закрыть вакансию?', message: v.title, confirmText: 'Закрыть' })) { await api.post(`/api/admin/vacancies/${v.id}/close`); toast('Вакансия закрыта.', 'ok'); reload(); refreshPending(); } }) : null,
      act('Удалить', 'btn-danger', async () => { if (await confirmDialog({ title: 'Удалить вакансию?', message: `«${v.title}» и все отклики на неё (${v.applicationsCount}) будут удалены безвозвратно.`, confirmText: 'Удалить', danger: true })) { await api.del(`/api/admin/vacancies/${v.id}`); toast('Вакансия удалена.', 'ok'); reload(); refreshPending(); } })))))));
  status.input.addEventListener('change', () => pl.first());
  q.input.addEventListener('input', debounce(() => pl.first()));
  return panel(h('h2', { class: 'section-title' }, 'Вакансии и модерация'), h('div', { class: 'toolbar' }, status.el, q.el), pl.el);
}

// ------------------------------------------------------------------ организации
function orgForm(o, reload) {
  const isNew = !o;
  const x = o || {};
  const fields = [
    field({ label: 'Название', name: 'name', value: x.name || '', required: true, maxlength: 200, full: true }),
    field({ label: 'Описание', name: 'description', textarea: true, rows: 4, value: x.description || '', maxlength: 2000, full: true }),
    field({ label: 'Город', name: 'city', value: x.city || 'Грозный', required: true, maxlength: 80 }),
    field({ label: 'Сфера деятельности', name: 'industry', value: x.industry || '', maxlength: 100 }),
    field({ label: 'Адрес', name: 'address', value: x.address || '', maxlength: 250, full: true }),
    field({ label: 'Специальности', name: 'specialties', value: x.specialties || '', maxlength: 300, full: true }),
    field({ label: 'Сайт', name: 'website', value: x.website || '', maxlength: 300 }),
    field({ label: 'Контактное лицо', name: 'contactPerson', value: x.contactPerson || '', maxlength: 150 }),
    field({ label: 'Email', name: 'contactEmail', type: 'email', value: x.contactEmail || '', maxlength: 254 }),
    field({ label: 'Телефон', name: 'contactPhone', value: x.contactPhone || '', maxlength: 25 }),
    field({ name: 'isPartnerListed', type: 'checkbox', value: !!x.isPartnerListed, label: 'x', checkboxLabel: 'Показывать в каталоге партнёров' }),
    field({ name: 'isCollegeUnit', type: 'checkbox', value: !!x.isCollegeUnit, label: 'x', checkboxLabel: 'Подразделение колледжа (вакансии ГГКИТ)' }),
  ];
  const ver = x.verificationStatus === 'pending' ? null : field({ label: 'Статус проверки', name: 'verificationStatus', value: x.verificationStatus || 'unverified', full: true, options: [{ value: 'unverified', label: 'Не проверена' }, { value: 'verified', label: 'Проверена' }, { value: 'rejected', label: 'Отклонена' }] });
  const all = ver ? [...fields, ver] : fields;
  const m = modal({ title: isNew ? 'Новая организация' : `Организация: ${x.name}`, wide: true,
    body: h('div', { class: 'stack' }, !ver ? h('div', { class: 'alert alert-info' }, 'Организация ожидает решения по заявке — примите его в разделе «Заявки на проверку».') : null, h('form', { class: 'form-grid', novalidate: true, onsubmit: (e) => e.preventDefault() }, all.map((f) => f.el))),
    actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
      const v = values(all);
      await withLoading(e.currentTarget, async () => {
        try {
          const body = { name: v.name, description: textOrNull(v.description), city: v.city, industry: textOrNull(v.industry), address: textOrNull(v.address), specialties: textOrNull(v.specialties), website: textOrNull(v.website), contactPerson: textOrNull(v.contactPerson), contactEmail: textOrNull(v.contactEmail), contactPhone: textOrNull(v.contactPhone), isPartnerListed: v.isPartnerListed, isCollegeUnit: v.isCollegeUnit };
          if (ver) body.verificationStatus = v.verificationStatus;
          if (isNew) await api.post('/api/admin/organizations', body); else await api.patch(`/api/admin/organizations/${x.id}`, body);
          m.close(); toast('Организация сохранена.', 'ok'); reload();
        } catch (err) { handleFormError(err, all); }
      });
    } }, 'Сохранить')] });
}

async function organizationsTab() {
  const reqStatus = sel('Статус заявок', 'rs', opts('Все', { pending: 'Ожидают', approved: 'Одобренные', rejected: 'Отклонённые' }), 'pending');
  const reqList = pagedList((page) => api.get(`/api/admin/organization-requests${qs({ status: reqStatus.value(), page, pageSize: 10 })}`), (items, reload) => table(['Организация', 'Контакты', 'Сообщение', 'Подана', 'Статус', 'Действия!'], items.map((r) => h('tr', {},
    h('td', {}, h('span', { class: 'cell-title' }, r.organization.name), h('span', { class: 'sub' }, r.organization.city)),
    h('td', {}, r.organization.contactEmail || '—', h('span', { class: 'sub' }, r.organization.contactPhone || '')), h('td', {}, r.message || '—'), h('td', { class: 'nowrap' }, fmtDateTime(r.createdAt)),
    h('td', {}, badge('verification', r.status, { pending: 'Ожидает', approved: 'Одобрена', rejected: 'Отклонена' }[r.status]), r.reviewNote ? h('span', { class: 'sub' }, r.reviewNote) : null),
    h('td', { class: 'actions' }, r.status === 'pending' ? h('div', { class: 'table-actions' },
      act('Одобрить', 'btn-primary', async () => { const note = await promptDialog({ title: `Подтвердить «${r.organization.name}»?`, label: 'Комментарий (необязательно)', required: false, confirmText: 'Подтвердить' }); if (note !== null || await confirmDialog({ title: 'Подтвердить организацию?', message: r.organization.name, confirmText: 'Подтвердить' })) { await api.post(`/api/admin/organization-requests/${r.id}/approve`, { note: note || undefined }); toast('Организация проверена.', 'ok'); reload(); orgList.reload(); refreshPending(); } }),
      act('Отклонить', 'btn-danger', async () => { const note = await promptDialog({ title: 'Отклонить проверку?', label: 'Причина (увидит работодатель)', confirmText: 'Отклонить', danger: true }); if (note) { await api.post(`/api/admin/organization-requests/${r.id}/reject`, { note }); toast('Заявка отклонена.', 'ok'); reload(); orgList.reload(); refreshPending(); } })) : null)))), { empty: 'Заявок нет' });
  reqStatus.input.addEventListener('change', () => reqList.first());

  const ver = sel('Проверка', 'v', opts('Любая', { unverified: 'Не проверена', pending: 'На проверке', verified: 'Проверена', rejected: 'Отклонена' }));
  const listed = sel('Каталог', 'l', [{ value: '', label: 'Все' }, { value: '1', label: 'В каталоге' }, { value: '0', label: 'Не в каталоге' }]);
  const q = field({ label: 'Поиск', name: 'q', type: 'search', maxlength: 100, placeholder: 'Название' });
  const orgList = pagedList((page) => api.get(`/api/admin/organizations${qs({ verification: ver.value(), listed: listed.value(), q: q.value().trim(), page })}`), (items, reload) => table(['Организация', 'Проверка', 'Каталог', 'Вакансии / сотрудники', 'Действия!'], items.map((o) => h('tr', {},
    h('td', {}, h('span', { class: 'cell-title' }, o.name), h('span', { class: 'sub' }, [o.city, o.industry].filter(Boolean).join(' · ')), o.isDemo ? h('span', { class: 'badge badge-muted' }, 'демо-данные') : null, o.isCollegeUnit ? h('span', { class: 'badge-ggkit' }, 'ГГКИТ') : null),
    h('td', {}, orgBadge(o.verificationStatus)), h('td', {}, o.isPartnerListed ? badge('org', 'verified', 'В каталоге') : badge('org', 'unverified', 'Скрыта')), h('td', {}, `${o.vacanciesCount} / ${o.employersCount}`),
    h('td', { class: 'actions' }, h('div', { class: 'table-actions' }, act('Изменить', 'btn-outline', async () => orgForm(o, reload)),
      act(o.isPartnerListed ? 'Скрыть из каталога' : 'В каталог', 'btn-outline', async () => { await api.patch(`/api/admin/organizations/${o.id}`, { isPartnerListed: !o.isPartnerListed }); toast(o.isPartnerListed ? 'Организация скрыта из каталога.' : 'Организация добавлена в каталог.', 'ok'); reload(); }),
      act('Удалить', 'btn-danger', async () => { if (await confirmDialog({ title: 'Удалить организацию?', message: `${o.name}. Удаление возможно только если нет вакансий и работодателей.`, confirmText: 'Удалить', danger: true })) { await api.del(`/api/admin/organizations/${o.id}`); toast('Организация удалена.', 'ok'); reload(); } })))))));
  for (const f of [ver, listed]) f.input.addEventListener('change', () => orgList.first());
  q.input.addEventListener('input', debounce(() => orgList.first()));

  return h('div', { class: 'stack-lg' },
    panel(h('h2', { class: 'section-title' }, 'Заявки на проверку организаций'), h('div', { class: 'toolbar' }, reqStatus.el), reqList.el),
    panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Организации и каталог партнёров'), h('button', { type: 'button', class: 'btn-primary btn-sm', onclick: () => orgForm(null, orgList.reload) }, 'Добавить организацию')), h('div', { class: 'toolbar' }, ver.el, listed.el, q.el), orgList.el));
}

// ------------------------------------------------------------------ студенты и выпускники
const MATCH = { match: ['ok', 'Совпадает с реестром'], partial: ['warn', 'Частичное совпадение'], not_found: ['err', 'Нет в реестре'] };
const HIST = { submitted: 'Заявка подана', approved: 'Подтверждено', rejected: 'Отклонено', revoked: 'Подтверждение отозвано' };

function registryForm(r, reload) {
  const x = r || {};
  const fields = [
    field({ label: 'Номер студенческого / зачётной книжки', name: 'studentNumber', value: x.studentNumber || '', required: true, maxlength: 40, full: true }),
    field({ label: 'ФИО', name: 'fullName', value: x.fullName || '', required: true, maxlength: 150, full: true }),
    field({ label: 'Статус', name: 'kind', value: x.kind || 'student', options: [{ value: 'student', label: 'Студент' }, { value: 'graduate', label: 'Выпускник' }] }),
    field({ label: 'Группа', name: 'groupName', value: x.groupName || '', maxlength: 80 }),
    field({ label: 'Код специальности', name: 'specialtyCode', value: x.specialtyCode || '', maxlength: 20 }),
    field({ label: 'Специальность', name: 'specialtyName', value: x.specialtyName || '', maxlength: 150 }),
    field({ label: 'Годы обучения', name: 'studyYears', value: x.studyYears || '', maxlength: 40, placeholder: '2022–2025' }),
    field({ name: 'isTest', type: 'checkbox', value: r ? x.isTest : true, label: 'x', checkboxLabel: 'Тестовая запись (вымышленные данные)' }),
  ];
  const m = modal({ title: r ? 'Запись реестра' : 'Новая запись реестра', wide: true, body: h('form', { class: 'form-grid', novalidate: true, onsubmit: (e) => e.preventDefault() }, fields.map((f) => f.el)),
    actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
      const v = values(fields);
      await withLoading(e.currentTarget, async () => {
        try {
          const body = { studentNumber: v.studentNumber, fullName: v.fullName, kind: v.kind, groupName: textOrNull(v.groupName), specialtyCode: textOrNull(v.specialtyCode), specialtyName: textOrNull(v.specialtyName), studyYears: textOrNull(v.studyYears), isTest: v.isTest };
          if (r) await api.patch(`/api/admin/students/${r.id}`, body); else await api.post('/api/admin/students', body);
          m.close(); toast('Запись сохранена.', 'ok'); reload();
        } catch (err) { handleFormError(err, fields); }
      });
    } }, 'Сохранить')] });
}

async function studentsTab() {
  const rs = sel('Заявки', 'rs', opts('Все', { pending: 'Ожидают', approved: 'Одобренные', rejected: 'Отклонённые' }), 'pending');
  const reqList = pagedList((page) => api.get(`/api/admin/verification-requests${qs({ status: rs.value(), page, pageSize: 10 })}`), (items, reload) => table(['Кандидат', 'Заявлено', 'Сверка с реестром', 'Документ', 'Подана', 'Решение', 'Действия!'], items.map((r) => h('tr', {},
    h('td', {}, h('span', { class: 'cell-title' }, r.user.fullName), h('span', { class: 'sub' }, r.user.email)),
    h('td', {}, r.claimedKind === 'graduate' ? 'Выпускник' : 'Студент', h('span', { class: 'sub' }, `№ ${r.studentNumber}`), r.comment ? h('span', { class: 'sub' }, r.comment) : null),
    h('td', {}, h('span', { class: `badge badge-${MATCH[r.registryMatch][0]}` }, MATCH[r.registryMatch][1]),
      r.registry ? h('span', { class: 'sub' }, `${r.registry.fullName} · ${r.registry.kind === 'graduate' ? 'выпускник' : 'студент'}${r.registry.groupName ? ` · ${r.registry.groupName}` : ''}`) : null),
    h('td', {}, r.document ? downloadLink(r.document, 'Открыть') : '—'), h('td', { class: 'nowrap' }, fmtDateTime(r.createdAt)),
    h('td', {}, verifBadge(r.status === 'approved' ? 'verified' : r.status === 'rejected' ? 'rejected' : 'pending'), r.reviewNote ? h('span', { class: 'sub' }, r.reviewNote) : null, r.reviewer ? h('span', { class: 'sub' }, r.reviewer) : null),
    h('td', { class: 'actions' }, r.status === 'pending' ? h('div', { class: 'table-actions' },
      act('Подтвердить', 'btn-primary', async () => {
        const needNote = r.registryMatch !== 'match';
        const note = await promptDialog({ title: `Подтвердить статус: ${r.user.fullName}?`, label: needNote ? 'Основание (обязательно: запись в реестре не найдена или не совпадает)' : 'Комментарий (необязательно)', required: needNote, confirmText: 'Подтвердить' });
        if (note === null && needNote) return;
        if (note === null && !(await confirmDialog({ title: 'Подтвердить статус?', message: `${r.user.fullName} — запись реестра совпадает.`, confirmText: 'Подтвердить' }))) return;
        await api.post(`/api/admin/verification-requests/${r.id}/approve`, { note: note || undefined }); toast('Статус подтверждён.', 'ok'); reload(); hist.reload(); refreshPending();
      }),
      act('Отклонить', 'btn-danger', async () => { const note = await promptDialog({ title: 'Отклонить заявку?', label: 'Причина (увидит кандидат)', confirmText: 'Отклонить', danger: true }); if (note) { await api.post(`/api/admin/verification-requests/${r.id}/reject`, { note }); toast('Заявка отклонена.', 'ok'); reload(); hist.reload(); refreshPending(); } })) : null)))), { empty: 'Заявок нет' });
  rs.input.addEventListener('change', () => reqList.first());

  const kind = sel('Статус', 'k', opts('Все', { student: 'Студенты', graduate: 'Выпускники' }));
  const q = field({ label: 'Поиск', name: 'q', type: 'search', maxlength: 100, placeholder: 'ФИО или номер' });
  const regList = pagedList((page) => api.get(`/api/admin/students${qs({ kind: kind.value(), q: q.value().trim(), page })}`), (items, reload) => table(['Номер', 'ФИО', 'Статус', 'Группа / специальность', 'Годы', 'Действия!'], items.map((r) => h('tr', {},
    h('td', { class: 'nowrap' }, r.studentNumber, r.isTest ? h('span', { class: 'badge badge-muted' }, 'тест') : null), h('td', {}, r.fullName), h('td', {}, r.kindLabel),
    h('td', {}, r.groupName || '—', r.specialtyName ? h('span', { class: 'sub' }, `${r.specialtyCode || ''} ${r.specialtyName}`) : null), h('td', {}, r.studyYears || '—'),
    h('td', { class: 'actions' }, h('div', { class: 'table-actions' }, act('Изменить', 'btn-outline', async () => registryForm(r, reload)),
      act('Удалить', 'btn-danger', async () => { if (await confirmDialog({ title: 'Удалить запись реестра?', message: `${r.studentNumber} — ${r.fullName}`, confirmText: 'Удалить', danger: true })) { await api.del(`/api/admin/students/${r.id}`); toast('Запись удалена.', 'ok'); reload(); } })))))), { empty: 'В реестре нет записей' });
  kind.input.addEventListener('change', () => regList.first());
  q.input.addEventListener('input', debounce(() => regList.first()));

  const hist = pagedList((page) => api.get(`/api/admin/verification-history?page=${page}&pageSize=15`), (items) => table(['Когда', 'Кандидат', 'Событие', 'Администратор', 'Комментарий'], items.map((e) => h('tr', {},
    h('td', { class: 'nowrap' }, fmtDateTime(e.createdAt)), h('td', {}, e.user.fullName), h('td', {}, HIST[e.action] || e.action), h('td', {}, e.actor || '—'), h('td', {}, e.note || '—')))), { empty: 'История пуста' });

  return h('div', { class: 'stack-lg' },
    panel(h('h2', { class: 'section-title' }, 'Заявки на подтверждение статуса'), h('p', { class: 'muted small' }, 'Результат сверки с реестром виден только администраторам. Для заявок без полного совпадения при подтверждении нужно указать основание.'), h('div', { class: 'toolbar' }, rs.el), reqList.el),
    panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Реестр студентов и выпускников'), h('button', { type: 'button', class: 'btn-primary btn-sm', onclick: () => registryForm(null, regList.reload) }, 'Добавить запись')),
      h('div', { class: 'alert alert-info' }, 'Реестр хранится только на сервере и не передаётся в браузер посетителей. В поставку входят лишь вымышленные тестовые записи; к официальной базе колледжа реестр можно подключить через API (см. README).'),
      h('div', { class: 'toolbar' }, kind.el, q.el), regList.el),
    panel(h('h2', { class: 'section-title' }, 'История проверок'), hist.el));
}

// ------------------------------------------------------------------ отклики
async function applicationsTab() {
  const status = sel('Статус', 's', opts('Все', { sent: 'Отправлен', reviewing: 'На рассмотрении', viewed: 'Просмотрен', interview: 'Приглашение на собеседование', accepted: 'Принят', rejected: 'Отклонён', withdrawn: 'Отозван' }));
  const q = field({ label: 'Поиск', name: 'q', type: 'search', maxlength: 100, placeholder: 'Кандидат или вакансия' });
  const pl = pagedList((page) => api.get(`/api/admin/applications${qs({ status: status.value(), q: q.value().trim(), page })}`), (items) => table(['Кандидат', 'Вакансия', 'Организация', 'Получен', 'Статус', 'Действия!'], items.map((a) => h('tr', {},
    h('td', {}, h('span', { class: 'cell-title' }, a.candidate.fullName)), h('td', {}, h('a', { href: `/vacancies/${a.vacancy.id}` }, a.vacancy.title)), h('td', {}, a.organization.name),
    h('td', { class: 'nowrap' }, fmtDateTime(a.createdAt)), h('td', {}, appBadge(a.status)),
    h('td', { class: 'actions' }, act('Подробнее', 'btn-outline', async () => {
      const body = h('div', {}, loadingBlock());
      const m = modal({ title: `Отклик №${a.id}`, wide: true, body, actions: [close({ close: () => m.close() })] });
      try { mount(body, applicationDetailView((await api.get(`/api/admin/applications/${a.id}`)).application, { editable: false })); } catch (err) { mount(body, h('div', { class: 'alert alert-error' }, err.message)); }
    }))))));
  status.input.addEventListener('change', () => pl.first());
  q.input.addEventListener('input', debounce(() => pl.first()));
  return panel(h('h2', { class: 'section-title' }, 'Все отклики'), h('p', { class: 'muted small' }, 'Администратор просматривает отклики и их статусы; менять статусы может только работодатель.'), h('div', { class: 'toolbar' }, status.el, q.el), pl.el);
}

// ------------------------------------------------------------------ журнал
const ACTIONS = {
  'auth.login': 'Вход', 'auth.login_failed': 'Неудачный вход', 'auth.logout': 'Выход', 'auth.register': 'Регистрация', 'auth.password_changed': 'Смена пароля', 'auth.reset_requested': 'Запрос сброса пароля', 'auth.password_reset': 'Сброс пароля по ссылке',
  'vacancy.created': 'Создана вакансия', 'vacancy.updated': 'Изменена вакансия', 'vacancy.submitted': 'Вакансия отправлена на модерацию', 'vacancy.closed': 'Вакансия закрыта', 'vacancy.deleted': 'Вакансия удалена',
  'admin.vacancy_approved': 'Вакансия одобрена', 'admin.vacancy_rejected': 'Вакансия отклонена', 'admin.vacancy_updated': 'Вакансия изменена администратором', 'admin.vacancy_closed': 'Вакансия закрыта администратором', 'admin.vacancy_deleted': 'Вакансия удалена администратором',
  'application.created': 'Отклик отправлен', 'application.withdrawn': 'Отклик отозван', 'application.status_changed': 'Статус отклика изменён',
  'admin.user_blocked': 'Пользователь заблокирован', 'admin.user_unblocked': 'Пользователь разблокирован', 'admin.user_updated': 'Данные пользователя изменены', 'admin.user_created': 'Создан администратор', 'admin.password_reset': 'Пароль сброшен администратором',
  'admin.verification_approved': 'Статус студента подтверждён', 'admin.verification_rejected': 'Заявка студента отклонена', 'admin.verification_revoked': 'Подтверждение отозвано', 'verification.submitted': 'Подана заявка на статус студента',
  'admin.organization_verified': 'Организация проверена', 'admin.organization_verification_rejected': 'Проверка организации отклонена', 'organization.verification_requested': 'Заявка на проверку организации',
  'admin.organization_created': 'Организация добавлена', 'admin.organization_updated': 'Организация изменена', 'admin.organization_deleted': 'Организация удалена', 'organization.updated': 'Карточка организации изменена',
  'admin.registry_created': 'Запись реестра добавлена', 'admin.registry_updated': 'Запись реестра изменена', 'admin.registry_deleted': 'Запись реестра удалена', 'admin.registry_viewed': 'Просмотр реестра', 'content.updated': 'Изменён контент сайта', 'document.viewed_by_admin': 'Документ открыт администратором', 'account.deleted': 'Аккаунт удалён',
};

async function logsTab() {
  const action = field({ label: 'Действие (код начинается с)', name: 'action', maxlength: 60, placeholder: 'admin.vacancy' });
  const entity = sel('Объект', 'entity', opts('Все', { user: 'Пользователь', vacancy: 'Вакансия', application: 'Отклик', organization: 'Организация', verification_request: 'Заявка студента', student_registry: 'Реестр', document: 'Документ' }));
  const from = field({ label: 'С даты', name: 'from', type: 'date' }); const to = field({ label: 'По дату', name: 'to', type: 'date' });
  const pl = pagedList((page) => api.get(`/api/admin/logs${qs({ action: action.value().trim(), entityType: entity.value(), from: from.value(), to: to.value(), page, pageSize: 30 })}`), (items) => table(['Время', 'Кто', 'Действие', 'Объект', 'Подробности', 'IP'], items.map((l) => h('tr', {},
    h('td', { class: 'nowrap' }, fmtDateTime(l.createdAt)), h('td', {}, l.actor ? [h('span', { class: 'cell-title' }, l.actor.fullName), h('span', { class: 'sub' }, `${ROLE_LABEL[l.actor.role] || ''}`)] : 'Система / аноним'),
    h('td', {}, ACTIONS[l.action] || l.action, h('span', { class: 'sub' }, l.action)), h('td', { class: 'nowrap' }, l.entityType ? `${l.entityType} #${l.entityId ?? '—'}` : '—'),
    h('td', {}, l.details ? h('div', { class: 'details-json' }, JSON.stringify(l.details)) : '—'), h('td', { class: 'nowrap small' }, l.ip || '—')))), { empty: 'Записей не найдено' });
  for (const f of [entity, from, to]) f.input.addEventListener('change', () => pl.first());
  action.input.addEventListener('input', debounce(() => pl.first()));
  return panel(h('h2', { class: 'section-title' }, 'Журнал действий (аудит)'), h('div', { class: 'toolbar' }, action.el, entity.el, from.el, to.el), pl.el);
}

// ------------------------------------------------------------------ контент
const CONTENT_FIELDS = [
  ['hero_title', 'Заголовок на главной', false], ['hero_subtitle', 'Подзаголовок на главной', true], ['about_title', 'Заголовок блока «О нас»', false], ['about_text', 'Текст «О нас» (абзацы — через пустую строку)', true],
  ['about_founded', 'Год основания колледжа', false], ['contact_address', 'Адрес в подвале сайта', false], ['contact_phone', 'Телефон в подвале', false], ['contact_email', 'Email в подвале', false], ['footer_note', 'Подпись в подвале', false],
];
async function contentTab() {
  const { content } = await api.get('/api/admin/content');
  const fields = CONTENT_FIELDS.map(([name, label, area]) => field({ label, name, value: content[name] || '', textarea: area, rows: name === 'about_text' ? 9 : 3, maxlength: name === 'about_text' ? 4000 : 400, full: true }));
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить');
  return panel(h('h2', { class: 'section-title' }, 'Контент сайта'), h('p', { class: 'muted small' }, 'Очистите поле и сохраните, чтобы вернуть текст по умолчанию. Пустые контакты в подвале не показываются.'),
    h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      await withLoading(btn, async () => { try { await api.put('/api/admin/content', Object.fromEntries(fields.map((f) => [f.name, f.value()]))); toast('Контент сохранён.', 'ok'); tabs.reload(); } catch (err) { handleFormError(err, fields); } });
    } }, fields.map((f) => f.el), h('div', { class: 'form-actions' }, btn)));
}

// ------------------------------------------------------------------ каркас
function setPending(p) {
  tabs.setBadge('vacancies', p.vacancies); tabs.setBadge('organizations', p.organizations); tabs.setBadge('students', p.students);
}
const refreshPending = () => api.get('/api/admin/stats').then((s) => setPending(s.pending)).catch(() => {});

const forced = user.mustChangePassword;
const tabsDef = forced ? [{ id: 'settings', label: 'Настройки', render: async () => accountSettings(user, { forced: true }) }] : [
  { id: 'overview', label: 'Обзор', render: overviewTab }, { id: 'users', label: 'Пользователи', render: usersTab }, { id: 'vacancies', label: 'Вакансии', render: vacanciesTab },
  { id: 'organizations', label: 'Организации', render: organizationsTab }, { id: 'students', label: 'Студенты и выпускники', render: studentsTab }, { id: 'applications', label: 'Отклики', render: applicationsTab },
  { id: 'logs', label: 'Журнал', render: logsTab }, { id: 'content', label: 'Контент', render: contentTab },
  { id: 'notifications', label: 'Уведомления', render: async () => panel(h('h2', { class: 'section-title' }, 'Уведомления'), await notificationsPanel((n) => tabs.setBadge('notifications', n))) },
  { id: 'settings', label: 'Настройки', render: async () => accountSettings(user) },
];
const tabHost = h('div');
mount(app, h('div', { class: 'dash-head' }, h('div', {}, h('h1', { class: 'title-h1' }, 'Панель администратора'), h('p', { class: 'text-meta' }, user.fullName))), tabHost);
const tabs = createTabs(tabHost, tabsDef, { fallback: forced ? 'settings' : 'overview' });
if (!forced) { refreshPending(); api.get('/api/me/notifications?unread=1&pageSize=1').then((d) => tabs.setBadge('notifications', d.unreadCount)).catch(() => {}); }
void numOrNull;
