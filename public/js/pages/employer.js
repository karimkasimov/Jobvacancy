import { api, qs } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, createTabs, field, values, withLoading, handleFormError, toast, modal, confirmDialog, emptyState, fmtDate, fmtDateTime, table, pager, numOrNull, textOrNull, debounce, loadingBlock } from '../ui.js';
import { appBadge, vacancyBadge, orgBadge, orgLogo, notificationsPanel, accountSettings, badge } from '../components.js';
import { openVacancyForm } from '../vacancyForm.js';
import { applicationDetailView } from '../appDetail.js';

const { user } = await initLayout({ require: 'employer' });
const app = document.getElementById('app');
const panel = (...kids) => h('section', { class: 'cabinet-panel-card stack' }, kids);
const metric = (num, label, attention) => h('div', { class: `metric${attention ? ' is-attention' : ''}` }, h('div', { class: 'num' }, String(num)), h('div', { class: 'label' }, label));

// ------------------------------------------------------------------ обзор
async function overviewTab() {
  const [s, orgData] = await Promise.all([api.get('/api/employer/stats'), api.get('/api/employer/organization')]);
  const o = orgData.organization;
  const v = s.vacanciesByStatus;
  tabs.setBadge('applications', s.newApplications);
  return panel(
    h('h2', { class: 'section-title' }, o.name),
    o.verificationStatus !== 'verified' ? h('div', { class: `alert ${o.verificationStatus === 'rejected' ? 'alert-error' : 'alert-warn'}` },
      h('strong', {}, `Организация: ${o.verificationLabel.toLowerCase()}. `),
      o.verificationStatus === 'pending' ? 'Заявка на проверку рассматривается администратором.' : o.verificationStatus === 'rejected' ? `Причина: ${o.verificationNote || 'не указана'}. Исправьте данные и отправьте заявку повторно.` : 'Заполните карточку организации и отправьте заявку на проверку — проверенные организации вызывают больше доверия у кандидатов.',
      ' ', h('a', { href: '#organization' }, 'Открыть карточку организации')) : null,
    h('div', { class: 'metrics' },
      metric(s.newApplications, 'Новых откликов', s.newApplications > 0), metric(s.applicationsTotal, 'Всего откликов'), metric(v.published || 0, 'Опубликовано вакансий'),
      metric(v.pending || 0, 'На модерации'), metric((v.draft || 0) + (v.rejected || 0), 'Черновики и отклонённые'), metric(s.views, 'Просмотров вакансий')),
    h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn-primary', onclick: () => { location.hash = 'vacancies'; createVacancy(); } }, 'Создать вакансию'), h('a', { class: 'btn-outline', href: '#applications' }, 'Перейти к откликам')));
}

// ------------------------------------------------------------------ организация
async function organizationTab() {
  const { organization: o, verificationRequest: vr } = await api.get('/api/employer/organization');
  const fields = [
    field({ label: 'Название организации', name: 'name', value: o.name, required: true, maxlength: 200, full: true, hint: o.verificationStatus === 'verified' ? 'При смене названия проверка организации будет сброшена.' : undefined }),
    field({ label: 'Описание', name: 'description', textarea: true, rows: 5, value: o.description || '', maxlength: 2000, full: true }),
    field({ label: 'Город', name: 'city', value: o.city, required: true, maxlength: 80 }),
    field({ label: 'Сфера деятельности', name: 'industry', value: o.industry || '', maxlength: 100 }),
    field({ label: 'Адрес', name: 'address', value: o.address || '', maxlength: 250, full: true }),
    field({ label: 'Специальности колледжа, интересные организации', name: 'specialties', value: o.specialties || '', maxlength: 300, full: true, placeholder: '09.02.07 · 09.02.06' }),
    field({ label: 'Сайт', name: 'website', value: o.website || '', maxlength: 300, placeholder: 'example.ru' }),
    field({ label: 'Контактное лицо', name: 'contactPerson', value: o.contactPerson || '', maxlength: 150 }),
    field({ label: 'Контактный email', name: 'contactEmail', type: 'email', value: o.contactEmail || '', maxlength: 254 }),
    field({ label: 'Контактный телефон', name: 'contactPhone', type: 'tel', value: o.contactPhone || '', maxlength: 25 }),
  ];
  const saveBtn = h('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить');
  const logoInput = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp', class: 'hidden', 'aria-label': 'Выбрать логотип', onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await api.upload('/api/employer/organization/logo', file); toast('Логотип обновлён.', 'ok'); tabs.reload(); } catch (err) { toast(err.message, 'error'); }
  } });
  const msg = field({ label: 'Сообщение администратору (необязательно)', name: 'message', textarea: true, rows: 3, maxlength: 1000 });
  const reqBtn = h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
    await withLoading(e.currentTarget, async () => {
      try { await api.post('/api/employer/organization/verification-request', { message: textOrNull(msg.value()) }); toast('Заявка на проверку отправлена.', 'ok'); tabs.reload(); } catch (err) { handleFormError(err, [msg]); }
    });
  } }, 'Отправить заявку на проверку');

  return h('div', { class: 'stack-lg' },
    panel(h('h2', { class: 'section-title' }, 'Логотип'), h('div', { class: 'logo-editor' }, orgLogo(o, true),
      h('div', { class: 'stack-sm' }, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: () => logoInput.click() }, o.logoUrl ? 'Заменить логотип' : 'Загрузить логотип'),
        o.logoUrl ? h('button', { type: 'button', class: 'btn-danger btn-sm', onclick: async () => { try { await api.del('/api/employer/organization/logo'); toast('Логотип удалён.', 'ok'); tabs.reload(); } catch (err) { toast(err.message, 'error'); } } }, 'Удалить') : null), h('span', { class: 'field-hint' }, 'PNG, JPG или WebP до 1 МБ. SVG не принимается.'), logoInput))),
    panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Карточка организации'), orgBadge(o.verificationStatus)),
      h('p', { class: 'muted small' }, 'Название, описание, контакты и логотип отображаются на публичных страницах вакансий и в каталоге партнёров (после включения организации в каталог администратором).'),
      h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        const v = values(fields);
        await withLoading(saveBtn, async () => {
          try {
            await api.put('/api/employer/organization', { name: v.name, description: textOrNull(v.description), city: v.city, industry: textOrNull(v.industry), address: textOrNull(v.address), specialties: textOrNull(v.specialties), website: textOrNull(v.website), contactPerson: textOrNull(v.contactPerson), contactEmail: textOrNull(v.contactEmail), contactPhone: textOrNull(v.contactPhone) });
            toast('Карточка организации сохранена.', 'ok'); tabs.reload();
          } catch (err) { handleFormError(err, fields); }
        });
      } }, h('div', { class: 'form-grid' }, fields.map((f) => f.el)), h('div', { class: 'form-actions' }, saveBtn))),
    panel(h('h2', { class: 'section-title' }, 'Проверка организации'),
      vr ? h('div', { class: `alert ${vr.status === 'approved' ? 'alert-ok' : vr.status === 'rejected' ? 'alert-error' : 'alert-info'}` },
        `Последняя заявка от ${fmtDateTime(vr.createdAt)}: ${{ pending: 'на рассмотрении', approved: 'одобрена', rejected: 'отклонена' }[vr.status]}.`, vr.reviewNote ? ` Комментарий администратора: ${vr.reviewNote}` : '') : null,
      o.verificationStatus === 'verified' ? h('div', { class: 'alert alert-ok' }, 'Организация проверена администратором.')
        : o.verificationStatus === 'pending' ? h('p', { class: 'muted' }, 'Заявка рассматривается. Мы сообщим о решении в уведомлениях.')
          : [h('p', { class: 'muted' }, 'Перед отправкой заполните контактный email или телефон организации. Администратор проверит данные и присвоит статус «Проверена».'), msg.el, h('div', {}, reqBtn)]));
}

// ------------------------------------------------------------------ вакансии
async function createVacancy() {
  await openVacancyForm({
    title: 'Новая вакансия',
    notice: 'Вакансия появится на портале только после проверки администратором.',
    buttons: [
      { label: 'Сохранить черновик', kind: 'outline', run: async (b) => { await api.post('/api/employer/vacancies', b); toast('Черновик сохранён.', 'ok'); tabs.reload(); } },
      { label: 'Отправить на модерацию', kind: 'primary', run: async (b) => { await api.post('/api/employer/vacancies', { ...b, submit: true }); toast('Вакансия отправлена на модерацию.', 'ok'); tabs.reload(); } },
    ],
  });
}

async function editVacancy(v) {
  const live = ['published', 'pending'].includes(v.status);
  await openVacancyForm({
    vacancy: v, title: 'Редактирование вакансии',
    notice: live ? 'После сохранения вакансия будет снята с публикации и повторно отправлена на модерацию.' : v.status === 'rejected' && v.moderationNote ? `Причина отклонения: ${v.moderationNote}` : null,
    buttons: [
      { label: live ? 'Сохранить и отправить на модерацию' : 'Сохранить', kind: live ? 'primary' : 'outline', run: async (b) => { await api.put(`/api/employer/vacancies/${v.id}`, b); toast(live ? 'Изменения отправлены на модерацию.' : 'Изменения сохранены.', 'ok'); tabs.reload(); } },
      ...(live || v.status === 'closed' ? [] : [{ label: 'Сохранить и отправить на модерацию', kind: 'primary', run: async (b) => { await api.put(`/api/employer/vacancies/${v.id}`, { ...b, submit: true }); toast('Вакансия отправлена на модерацию.', 'ok'); tabs.reload(); } }]),
    ],
  });
}

async function showStats(v) {
  const body = h('div', {}, loadingBlock());
  const m = modal({ title: `Статистика: ${v.title}`, body, actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Закрыть')] });
  try {
    const s = await api.get(`/api/employer/vacancies/${v.id}/stats`);
    const labels = { sent: 'Отправлен', reviewing: 'На рассмотрении', viewed: 'Просмотрен', interview: 'Приглашение на собеседование', accepted: 'Принят', rejected: 'Отклонён', withdrawn: 'Отозван' };
    mount(body, h('div', { class: 'stack' }, h('div', { class: 'metrics' }, metric(s.views, 'Просмотров'), metric(s.applications, 'Откликов'), metric(s.saved, 'Добавили в избранное')),
      h('h3', { class: 'section-title' }, 'Отклики по статусам'),
      Object.keys(s.byStatus).length ? h('ul', { class: 'timeline' }, Object.entries(s.byStatus).map(([k, n]) => h('li', {}, `${labels[k]}: ${n}`))) : h('p', { class: 'muted' }, 'Откликов пока нет.')));
  } catch (err) { mount(body, h('div', { class: 'alert alert-error' }, err.message)); }
}

async function vacanciesTab() {
  let status = ''; let q = ''; let page = 1;
  const list = h('div', { class: 'stack' });
  const sel = field({ label: 'Статус', name: 'status', options: [{ value: '', label: 'Все' }, ...['draft', 'pending', 'published', 'rejected', 'closed'].map((s) => ({ value: s, label: { draft: 'Черновик', pending: 'На модерации', published: 'Опубликована', rejected: 'Отклонена', closed: 'Закрыта' }[s] }))] });
  const search = field({ label: 'Поиск по названию', name: 'q', type: 'search', maxlength: 100 });

  async function render() {
    const data = await api.get(`/api/employer/vacancies${qs({ status, q, page, pageSize: 10 })}`);
    const act = (label, cls, fn) => h('button', { type: 'button', class: `${cls} btn-sm`, onclick: async (e) => { await withLoading(e.currentTarget, async () => { try { await fn(); } catch (err) { toast(err.message, 'error'); } }); } }, label);
    const rows = data.items.map((v) => h('tr', {},
      h('td', {}, h('a', { class: 'cell-title', href: `/vacancies/${v.id}` }, v.title), h('span', { class: 'sub' }, `${v.city} · ${v.salaryText}`), v.status === 'rejected' && v.moderationNote ? h('span', { class: 'sub' }, `Причина отклонения: ${v.moderationNote}`) : null),
      h('td', {}, vacancyBadge(v.status)),
      h('td', {}, String(v.applicationsCount), v.newApplicationsCount ? h('span', { class: 'count-pill' }, `+${v.newApplicationsCount}`) : null),
      h('td', {}, String(v.views)), h('td', { class: 'nowrap' }, fmtDate(v.updatedAt)),
      h('td', { class: 'actions' }, h('div', { class: 'table-actions' },
        act('Изменить', 'btn-outline', async () => editVacancy(v)),
        ['draft', 'rejected', 'closed'].includes(v.status) ? act(v.status === 'closed' ? 'Открыть снова' : 'На модерацию', 'btn-primary', async () => { await api.post(`/api/employer/vacancies/${v.id}/publish`); toast('Вакансия отправлена на модерацию.', 'ok'); render(); }) : null,
        ['published', 'pending'].includes(v.status) ? act('Закрыть', 'btn-outline', async () => { if (await confirmDialog({ title: 'Закрыть вакансию?', message: `«${v.title}» перестанет принимать отклики.`, confirmText: 'Закрыть' })) { await api.post(`/api/employer/vacancies/${v.id}/close`); toast('Вакансия закрыта.', 'ok'); render(); } }) : null,
        act('Статистика', 'btn-outline', async () => showStats(v)),
        act('Удалить', 'btn-danger', async () => { if (await confirmDialog({ title: 'Удалить вакансию?', message: `«${v.title}» будет удалена безвозвратно. Если есть отклики, удаление невозможно — закройте вакансию.`, confirmText: 'Удалить', danger: true })) { await api.del(`/api/employer/vacancies/${v.id}`); toast('Вакансия удалена.', 'ok'); render(); } })))));
    mount(list, data.items.length ? [h('div', { class: 'result-count' }, `Вакансий: ${data.total}`), table(['Вакансия', 'Статус', 'Отклики', 'Просмотры', 'Изменена', 'Действия!'], rows), pager(data, (n) => { page = n; render(); })]
      : emptyState(status || q ? 'Ничего не найдено' : 'У вас пока нет вакансий', status || q ? 'Измените фильтры.' : 'Создайте первую вакансию — после проверки администратором она появится в каталоге.'));
  }
  sel.input.addEventListener('change', () => { status = sel.value(); page = 1; render(); });
  search.input.addEventListener('input', debounce(() => { q = search.value().trim(); page = 1; render().catch((e) => toast(e.message, 'error')); }));
  await render();
  return panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Мои вакансии'), h('button', { type: 'button', class: 'btn-primary btn-sm', onclick: createVacancy }, 'Создать вакансию')),
    h('div', { class: 'toolbar' }, sel.el, search.el), list);
}

// ------------------------------------------------------------------ отклики
async function applicationsTab() {
  let status = ''; let vacancyId = ''; let q = ''; let page = 1;
  const list = h('div', { class: 'stack' });
  const vacs = await api.get('/api/employer/vacancies?pageSize=100');
  const selV = field({ label: 'Вакансия', name: 'vacancyId', options: [{ value: '', label: 'Все вакансии' }, ...vacs.items.map((v) => ({ value: v.id, label: v.title }))] });
  const selS = field({ label: 'Статус', name: 'status', options: [{ value: '', label: 'Все' }, ...Object.entries({ sent: 'Отправлен', reviewing: 'На рассмотрении', viewed: 'Просмотрен', interview: 'Приглашение на собеседование', accepted: 'Принят', rejected: 'Отклонён', withdrawn: 'Отозван' }).map(([value, label]) => ({ value, label }))] });
  const search = field({ label: 'Кандидат', name: 'q', type: 'search', maxlength: 100, placeholder: 'ФИО' });

  async function open(id) {
    const body = h('div', {}, loadingBlock());
    const m = modal({ title: 'Отклик кандидата', wide: true, body, actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Закрыть')], onClose: () => render().catch(() => {}) });
    const show = (a) => mount(body, applicationDetailView(a, { editable: true, onChange: show }));
    try { show((await api.get(`/api/employer/applications/${id}`)).application); } catch (err) { mount(body, h('div', { class: 'alert alert-error' }, err.message)); }
  }

  async function render() {
    const data = await api.get(`/api/employer/applications${qs({ status, vacancyId, q, page, pageSize: 15 })}`);
    const stats = await api.get('/api/employer/stats').catch(() => null);
    if (stats) tabs.setBadge('applications', stats.newApplications);
    mount(list, data.items.length ? [h('div', { class: 'result-count' }, `Откликов: ${data.total}`),
      table(['Кандидат', 'Вакансия', 'Резюме', 'Получен', 'Статус', 'Действия!'], data.items.map((a) => h('tr', { class: a.status === 'sent' ? '' : '' },
        h('td', {}, h('span', { class: 'cell-title' }, a.candidate.fullName)), h('td', {}, h('a', { href: `/vacancies/${a.vacancy.id}` }, a.vacancy.title)),
        h('td', {}, a.resumeTitle || '—'), h('td', { class: 'nowrap' }, fmtDateTime(a.createdAt)), h('td', {}, appBadge(a.status)),
        h('td', { class: 'actions' }, h('button', { type: 'button', class: 'btn-primary btn-sm', onclick: () => open(a.id) }, 'Открыть'))))),
      pager(data, (n) => { page = n; render(); })]
      : emptyState(status || vacancyId || q ? 'Ничего не найдено' : 'Откликов пока нет', status || vacancyId || q ? 'Измените фильтры.' : 'Когда кандидаты откликнутся на ваши вакансии, отклики появятся здесь.'));
  }
  for (const f of [selV, selS]) f.input.addEventListener('change', () => { status = selS.value(); vacancyId = selV.value(); page = 1; render().catch((e) => toast(e.message, 'error')); });
  search.input.addEventListener('input', debounce(() => { q = search.value().trim(); page = 1; render().catch((e) => toast(e.message, 'error')); }));
  await render();
  return panel(h('h2', { class: 'section-title' }, 'Отклики на вакансии'), h('div', { class: 'toolbar' }, selV.el, selS.el, search.el), list);
}

const forced = user.mustChangePassword;
const tabsDef = forced ? [{ id: 'settings', label: 'Настройки', render: async () => accountSettings(user, { forced: true }) }] : [
  { id: 'overview', label: 'Обзор', render: overviewTab },
  { id: 'organization', label: 'Организация', render: organizationTab },
  { id: 'vacancies', label: 'Вакансии', render: vacanciesTab },
  { id: 'applications', label: 'Отклики', render: applicationsTab },
  { id: 'notifications', label: 'Уведомления', render: async () => panel(h('h2', { class: 'section-title' }, 'Уведомления'), await notificationsPanel((n) => tabs.setBadge('notifications', n))) },
  { id: 'settings', label: 'Настройки', render: async () => accountSettings(user) },
];
const tabHost = h('div');
mount(app, h('div', { class: 'dash-head' }, h('div', {}, h('h1', { class: 'title-h1' }, 'Кабинет работодателя'), h('p', { class: 'text-meta' }, `${user.fullName}${user.organization ? ` · ${user.organization.name}` : ''}`))), tabHost);
const tabs = createTabs(tabHost, tabsDef, { fallback: forced ? 'settings' : 'overview' });
if (!forced) {
  api.get('/api/me/notifications?unread=1&pageSize=1').then((d) => tabs.setBadge('notifications', d.unreadCount)).catch(() => {});
  api.get('/api/employer/stats').then((s) => tabs.setBadge('applications', s.newApplications)).catch(() => {});
}
void numOrNull; void badge;
