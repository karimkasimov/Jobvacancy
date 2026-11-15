// Переиспользуемые компоненты: бейджи статусов, карточка вакансии, логотип, общие блоки кабинетов.
import { api } from './api.js';
import { h, fmtDate, initials, toast, field, values, handleFormError, withLoading, load, emptyState, confirmDialog, fmtDateTime, pager, mount } from './ui.js';

const KIND = {
  application: { sent: 'info', reviewing: 'info', viewed: 'info', interview: 'ok', accepted: 'ok', rejected: 'err', withdrawn: 'muted' },
  vacancy: { draft: 'muted', pending: 'warn', published: 'ok', rejected: 'err', closed: 'muted' },
  org: { unverified: 'muted', pending: 'warn', verified: 'ok', rejected: 'err' },
  verification: { none: 'muted', pending: 'warn', verified: 'ok', rejected: 'err', approved: 'ok' },
  user: { active: 'ok', blocked: 'err' },
};
export const badge = (type, key, label) => h('span', { class: `badge badge-${(KIND[type] || {})[key] || 'muted'}` }, label || key);

export const STATUS_LABELS = {
  application: { sent: 'Отправлен', reviewing: 'На рассмотрении', viewed: 'Просмотрен', interview: 'Приглашение на собеседование', accepted: 'Принят', rejected: 'Отклонён', withdrawn: 'Отозван' },
  vacancy: { draft: 'Черновик', pending: 'На модерации', published: 'Опубликована', rejected: 'Отклонена', closed: 'Закрыта' },
  org: { unverified: 'Не проверена', pending: 'На проверке', verified: 'Проверена', rejected: 'Отклонена' },
  verification: { none: 'Не подтверждён', pending: 'На проверке', verified: 'Подтверждён', rejected: 'Отклонён' },
};
export const appBadge = (s) => badge('application', s, STATUS_LABELS.application[s]);
export const vacancyBadge = (s) => badge('vacancy', s, STATUS_LABELS.vacancy[s]);
export const orgBadge = (s) => badge('org', s, STATUS_LABELS.org[s]);
export const verifBadge = (s) => badge('verification', s, STATUS_LABELS.verification[s] || s);

export function orgLogo(org, large = false) {
  if (org.logoUrl) return h('img', { class: `employer-custom-logo${large ? ' is-large' : ''}`, src: org.logoUrl, alt: `Логотип: ${org.name}`, loading: 'lazy', width: large ? 84 : 52, height: large ? 84 : 52 });
  return h('span', { class: `org-initials${large ? ' is-large' : ''}`, 'aria-hidden': 'true' }, initials(org.name));
}

const contactLine = (label, value, href) => (value ? h('p', {}, h('span', {}, `${label}: `), href ? h('a', { href }, value) : value) : null);

export function vacancyCard(v, { user, onSaveToggle } = {}) {
  const closed = v.status === 'closed';
  const canSave = user && user.role === 'candidate';
  const saveBtn = canSave ? h('button', {
    type: 'button', class: 'btn-outline btn-sm', 'aria-pressed': String(!!v.saved),
    onclick: async (e) => {
      const b = e.currentTarget;
      await withLoading(b, async () => {
        try {
          if (v.saved) await api.del(`/api/me/saved/${v.id}`); else await api.put(`/api/me/saved/${v.id}`);
          v.saved = !v.saved;
          b.textContent = v.saved ? 'Убрать из избранного' : 'В избранное';
          b.setAttribute('aria-pressed', String(v.saved));
          toast(v.saved ? 'Вакансия добавлена в избранное.' : 'Вакансия убрана из избранного.', 'ok');
          if (onSaveToggle) onSaveToggle(v);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  }, v.saved ? 'Убрать из избранного' : 'В избранное') : null;

  return h('article', { class: `vacancy-card${closed ? ' is-closed' : ''}` },
    h('div', { class: 'stack' },
      h('div', { class: 'vacancy-card-top' },
        h('div', { class: 'vacancy-card-org' }, orgLogo(v.organization),
          h('div', {}, h('div', { class: 'org-name' }, v.organization.name),
            h('div', { class: 'tag-row mt-8' },
              v.organization.isCollegeUnit ? h('span', { class: 'badge-ggkit' }, 'ВАКАНСИЯ ГГКИТ') : v.organization.isPartnerListed ? h('span', { class: 'tag-chip' }, 'Партнёр ГГКИТ') : null,
              v.organization.verificationStatus === 'verified' ? h('span', { class: 'badge badge-ok' }, 'Организация проверена') : null))),
        h('div', { class: 'salary-value nowrap' }, v.salaryText)),
      h('h3', { class: 'title-h3' }, h('a', { href: `/vacancies/${v.id}` }, v.title)),
      h('div', { class: 'tag-row' }, h('span', { class: 'tag-chip' }, v.category.name), h('span', { class: 'tag-chip' }, v.employmentTypeLabel), closed ? h('span', { class: 'badge badge-muted' }, 'Закрыта') : null),
      h('p', { class: 'vacancy-desc' }, v.description),
      h('div', { class: 'vacancy-conditions-grid' },
        h('div', { class: 'condition-cell' }, h('span', { class: 'condition-label' }, 'Город'), h('span', { class: 'condition-val' }, v.city)),
        h('div', { class: 'condition-cell' }, h('span', { class: 'condition-label' }, 'Опыт'), h('span', { class: 'condition-val' }, v.experienceLabel)),
        h('div', { class: 'condition-cell' }, h('span', { class: 'condition-label' }, 'Формат работы'), h('span', { class: 'condition-val' }, v.workFormat || '—')),
        h('div', { class: 'condition-cell' }, h('span', { class: 'condition-label' }, 'Подразделение'), h('span', { class: 'condition-val' }, v.department || '—')))),
    h('div', { class: 'vacancy-card-bottom' },
      h('span', { class: 'text-meta' }, closed ? `Закрыта ${fmtDate(v.closedAt)}` : `Опубликована ${fmtDate(v.publishedAt)}`,
        v.applicationStatus ? h('span', {}, ' · ', appBadge(v.applicationStatus)) : null),
      h('div', { class: 'row' }, saveBtn, h('a', { class: 'btn-primary btn-sm', href: `/vacancies/${v.id}` }, 'Подробнее'))));
}

export function contactBlock(v) {
  const lines = [
    contactLine('Контактное лицо', v.contactPerson),
    contactLine('Телефон', v.contactPhone, v.contactPhone ? `tel:${v.contactPhone.replace(/[^\d+]/g, '')}` : null),
    contactLine('Почта', v.contactEmail, v.contactEmail ? `mailto:${v.contactEmail}` : null),
  ].filter(Boolean);
  return lines.length ? h('div', { class: 'contact-paragraphs' }, lines) : h('p', { class: 'muted small' }, 'Контакты не указаны.');
}

// ---------- общие панели кабинетов ----------

/** Список уведомлений с отметкой «прочитано» и удалением. onChange вызывается при изменении числа непрочитанных. */
export async function notificationsPanel(onChange) {
  const box = h('div', { class: 'stack' });
  let page = 1;
  async function render() {
    const data = await api.get(`/api/me/notifications?page=${page}&pageSize=15`);
    if (onChange) onChange(data.unreadCount);
    const list = data.items.length
      ? h('div', { class: 'item-list' }, data.items.map((n) => h('article', { class: `item-card${n.read ? '' : ' is-unread'}` },
        h('div', { class: 'grow' }, h('h3', {}, n.title), n.body ? h('p', { class: 'text-body' }, n.body) : null,
          h('div', { class: 'item-meta mt-8' }, h('span', {}, fmtDateTime(n.createdAt)), n.link ? h('a', { href: n.link }, 'Перейти') : null)),
        h('div', { class: 'table-actions' },
          n.read ? null : h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: async () => { await api.post(`/api/me/notifications/${n.id}/read`).catch((e) => toast(e.message, 'error')); await refresh(); } }, 'Прочитано'),
          h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: async () => { await api.del(`/api/me/notifications/${n.id}`).catch((e) => toast(e.message, 'error')); await refresh(); } }, 'Удалить')))))
      : emptyState('Уведомлений пока нет', 'Здесь появятся сообщения о статусах откликов, модерации и других событиях.');
    mount(box,
      data.items.length ? h('div', { class: 'row-between' }, h('span', { class: 'result-count' }, `Всего: ${data.total}`),
        data.unreadCount ? h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: async () => { await api.post('/api/me/notifications/read-all').catch((e) => toast(e.message, 'error')); await refresh(); } }, 'Отметить все прочитанными') : null) : null,
      list, pager(data, (p) => { page = p; refresh(); }));
  }
  const refresh = () => render().catch((e) => toast(e.message, 'error'));
  await render();
  return box;
}

/** Форма смены пароля. forced — пароль временный, сменить обязательно. */
export function passwordForm({ forced = false, onDone } = {}) {
  const fields = [
    field({ label: 'Текущий пароль', name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' }),
    field({ label: 'Новый пароль', name: 'newPassword', type: 'password', required: true, autocomplete: 'new-password', hint: 'Не менее 8 символов, буквы и цифры.' }),
    field({ label: 'Повторите новый пароль', name: 'repeat', type: 'password', required: true, autocomplete: 'new-password' }),
  ];
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Сменить пароль');
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const v = values(fields);
    if (v.newPassword !== v.repeat) { fields[2].setError('Пароли не совпадают.'); return; }
    await withLoading(btn, async () => {
      try {
        await api.post('/api/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
        toast('Пароль изменён. Остальные устройства отключены от аккаунта.', 'ok');
        fields.forEach((f) => f.set(''));
        if (onDone) onDone();
      } catch (err) { handleFormError(err, fields); }
    });
  } }, forced ? h('div', { class: 'alert alert-warn' }, h('strong', {}, 'Требуется смена пароля. '), 'Вы вошли с временным паролем — задайте собственный, чтобы продолжить работу.') : null,
  fields.map((f) => f.el), h('div', { class: 'form-actions' }, btn));
  return form;
}

/** Блок «Настройки аккаунта» для соискателя и работодателя: email, пароль, удаление. Для администратора — только пароль. */
export function accountSettings(user, { forced = false } = {}) {
  const wrap = h('div', { class: 'stack-lg' });
  wrap.append(h('section', { class: 'cabinet-panel-card' }, h('h2', { class: 'section-title' }, 'Смена пароля'), passwordForm({ forced })));
  if (user.role === 'admin') return wrap;

  const emailFields = [
    field({ label: 'Новый email', name: 'email', type: 'email', value: user.email, required: true, autocomplete: 'email' }),
    field({ label: 'Пароль для подтверждения', name: 'password', type: 'password', required: true, autocomplete: 'current-password' }),
  ];
  const emailBtn = h('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить email');
  wrap.append(h('section', { class: 'cabinet-panel-card' }, h('h2', { class: 'section-title' }, 'Адрес электронной почты'),
    h('p', { class: 'muted small mb-16' }, 'Адрес используется для входа. Подтверждение письмом не выполняется, поэтому смена защищена паролем.'),
    h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      await withLoading(emailBtn, async () => {
        try { await api.post('/api/me/email', values(emailFields)); toast('Email изменён.', 'ok'); emailFields[1].set(''); } catch (err) { handleFormError(err, emailFields); }
      });
    } }, emailFields.map((f) => f.el), h('div', { class: 'form-actions' }, emailBtn))));

  const delFields = [field({ label: 'Пароль для подтверждения', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })];
  const delBtn = h('button', { type: 'submit', class: 'btn-danger' }, 'Удалить аккаунт');
  wrap.append(h('section', { class: 'cabinet-panel-card' }, h('h2', { class: 'section-title' }, 'Удаление аккаунта'),
    h('p', { class: 'muted small mb-16' }, user.role === 'candidate'
      ? 'Будут безвозвратно удалены профиль, резюме, документы, отклики и избранное.'
      : 'Будет удалён ваш аккаунт. Если вы — единственный представитель организации, её вакансии будут закрыты, а сама организация скрыта из каталога партнёров.'),
    h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!(await confirmDialog({ title: 'Удалить аккаунт?', message: 'Это действие необратимо.', confirmText: 'Удалить навсегда', danger: true }))) return;
      await withLoading(delBtn, async () => {
        try { await api.del('/api/me/account', values(delFields)); location.href = '/'; } catch (err) { handleFormError(err, delFields); }
      });
    } }, delFields.map((f) => f.el), h('div', { class: 'form-actions' }, delBtn))));
  return wrap;
}

export { load };
