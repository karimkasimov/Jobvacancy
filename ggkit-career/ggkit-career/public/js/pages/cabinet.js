import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, createTabs, field, values, withLoading, handleFormError, toast, modal, confirmDialog, emptyState, fmtDate, fmtDateTime, fmtSize, downloadLink, numOrNull, textOrNull, pager, plural } from '../ui.js';
import { appBadge, verifBadge, vacancyCard, notificationsPanel, accountSettings } from '../components.js';

const { user } = await initLayout({ require: 'candidate' });
const app = document.getElementById('app');

const KIND_LABEL = { resume: 'Резюме', verification: 'Для подтверждения статуса', other: 'Другое' };
const panel = (...kids) => h('section', { class: 'cabinet-panel-card stack' }, kids);

// ------------------------------------------------------------------ профиль
async function profileTab() {
  const { user: u, profile: p } = await api.get('/api/me/profile');
  const locked = p.verificationStatus === 'verified';
  const fields = [
    field({ label: 'ФИО', name: 'fullName', value: u.fullName, required: true, maxlength: 120, autocomplete: 'name' }),
    field({ label: 'Телефон', name: 'phone', type: 'tel', value: u.phone || '', maxlength: 25, autocomplete: 'tel' }),
    field({ label: 'Город', name: 'city', value: p.city || '', maxlength: 80 }),
    field({ label: 'Статус', name: 'candidateType', value: p.candidateType, disabled: locked, options: [{ value: 'applicant', label: 'Соискатель' }, { value: 'student', label: 'Студент ГГКИТ' }, { value: 'graduate', label: 'Выпускник ГГКИТ' }],
      hint: locked ? 'Подтверждённый статус изменяет только администратор.' : 'Указанный статус не считается подтверждённым, пока его не проверит администратор.' }),
    field({ label: 'Желаемая должность', name: 'desiredPosition', value: p.desiredPosition || '', maxlength: 120 }),
    field({ label: 'Желаемая зарплата, ₽', name: 'desiredSalary', type: 'number', value: p.desiredSalary ?? '', min: 0, max: 10000000, inputmode: 'numeric' }),
    field({ label: 'О себе', name: 'about', textarea: true, rows: 5, value: p.about || '', maxlength: 2000, full: true }),
    field({ label: 'Ключевые навыки', name: 'skills', textarea: true, rows: 3, value: p.skills || '', maxlength: 1000, full: true }),
  ];
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить профиль');
  return panel(
    h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Личные данные'), h('div', { class: 'row' }, verifBadge(p.verificationStatus), p.verifiedKind ? h('span', { class: 'tag-chip' }, p.candidateTypeLabel) : null)),
    h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, u.email), h('dt', {}, 'Регистрация'), h('dd', {}, fmtDate(u.createdAt))),
    h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const v = values(fields);
      await withLoading(btn, async () => {
        try {
          const body = { fullName: v.fullName, phone: textOrNull(v.phone), city: textOrNull(v.city), desiredPosition: textOrNull(v.desiredPosition), desiredSalary: numOrNull(v.desiredSalary), about: textOrNull(v.about), skills: textOrNull(v.skills) };
          if (!locked) body.candidateType = v.candidateType;
          await api.put('/api/me/profile', body);
          toast('Профиль сохранён.', 'ok');
        } catch (err) { handleFormError(err, fields); }
      });
    } }, h('div', { class: 'form-grid' }, fields.map((f) => f.el)), h('div', { class: 'form-actions' }, btn)));
}

// ------------------------------------------------------------------ подтверждение статуса
const ACTION_LABEL = { submitted: 'Заявка отправлена', approved: 'Статус подтверждён', rejected: 'Заявка отклонена', revoked: 'Подтверждение отозвано' };

async function statusTab() {
  const [s, docs] = await Promise.all([api.get('/api/me/verification'), api.get('/api/me/documents')]);
  const history = s.history.length ? h('div', { class: 'mt-16' }, h('h3', { class: 'section-title' }, 'История'),
    h('ul', { class: 'timeline' }, s.history.map((x) => h('li', {}, ACTION_LABEL[x.action] || x.action, x.note ? `: ${x.note}` : '', h('span', { class: 'when' }, fmtDateTime(x.createdAt)))))) : null;

  let body;
  if (s.status === 'verified') {
    body = h('div', { class: 'alert alert-ok' }, h('strong', {}, `${s.verifiedKind === 'graduate' ? 'Выпускник' : 'Студент'} ГГКИТ — статус подтверждён ${fmtDate(s.verifiedAt)}. `), s.groupName ? `Группа: ${s.groupName}.` : '');
  } else if (s.status === 'pending' && s.pending) {
    body = h('div', { class: 'alert alert-info' }, h('strong', {}, 'Заявка на проверке. '), `Номер: ${s.pending.studentNumber}. Отправлена ${fmtDateTime(s.pending.createdAt)}. Решение придёт в уведомлениях.`);
  } else {
    const kind = field({ label: 'Кем вы являетесь', name: 'claimedKind', required: true, options: [{ value: 'student', label: 'Студент ГГКИТ' }, { value: 'graduate', label: 'Выпускник ГГКИТ' }] });
    const number = field({ label: 'Номер студенческого билета / зачётной книжки', name: 'studentNumber', required: true, maxlength: 40, hint: 'Администратор сверит его с записями колледжа. Результат сверки вам не показывается.' });
    const existing = docs.items.filter((d) => d.kind !== 'resume');
    const docSel = field({ label: 'Подтверждающий документ (необязательно)', name: 'documentId', options: [{ value: '', label: 'Не прикреплять' }, ...existing.map((d) => ({ value: d.id, label: `${d.name} (${fmtSize(d.size)})` }))] });
    const fileInput = h('input', { type: 'file', class: 'input-control', accept: '.pdf,.png,.jpg,.jpeg', 'aria-label': 'Загрузить скан или фото документа' });
    const comment = field({ label: 'Комментарий', name: 'comment', textarea: true, rows: 3, maxlength: 500 });
    const fields = [kind, number, docSel, comment];
    const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Отправить на проверку');
    body = h('div', {}, s.status === 'rejected' ? h('div', { class: 'alert alert-error mb-16' }, `Предыдущая заявка отклонена${s.history.find((x) => x.action === 'rejected')?.note ? `: ${s.history.find((x) => x.action === 'rejected').note}` : '.'} Вы можете подать новую заявку.`) : null,
      h('form', { class: 'verify-box stack', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        await withLoading(btn, async () => {
          try {
            const v = values(fields);
            let documentId = numOrNull(v.documentId);
            if (fileInput.files[0]) documentId = (await api.upload('/api/me/documents', fileInput.files[0], { kind: 'verification' })).document.id;
            await api.post('/api/me/verification', { claimedKind: v.claimedKind, studentNumber: v.studentNumber, documentId, comment: textOrNull(v.comment) });
            toast('Заявка отправлена на проверку.', 'ok');
            tabs.reload();
          } catch (err) { handleFormError(err, fields); }
        });
      } }, h('div', { class: 'form-grid' }, kind.el, number.el, docSel.el, h('div', { class: 'field' }, h('label', {}, 'Или загрузите скан/фото'), fileInput, h('div', { class: 'field-hint' }, 'PDF, PNG или JPG до 5 МБ.')), h('div', { class: 'full' }, comment.el)),
      h('div', { class: 'form-actions' }, btn)));
  }
  return panel(h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, 'Статус студента или выпускника ГГКИТ'), verifBadge(s.status)),
    h('p', { class: 'muted' }, 'Подтверждённый статус отображается в вашем профиле и виден работодателям, которым вы отправили отклик. Данные из реестра колледжа работодателям не передаются.'), body, history);
}

// ------------------------------------------------------------------ резюме
async function resumeModal(resume, docs, done) {
  const r = resume || {};
  const fields = [
    field({ label: 'Название резюме', name: 'title', value: r.title || '', required: true, maxlength: 120, full: true, placeholder: 'Например: Frontend-разработчик' }),
    field({ label: 'Желаемая должность', name: 'desiredPosition', value: r.desiredPosition || '', maxlength: 120, full: true }),
    field({ label: 'О себе', name: 'about', textarea: true, value: r.about || '', maxlength: 2000, full: true }),
    field({ label: 'Опыт работы и практики', name: 'experience', textarea: true, rows: 5, value: r.experience || '', maxlength: 4000, full: true }),
    field({ label: 'Образование', name: 'education', textarea: true, rows: 3, value: r.education || '', maxlength: 2000, full: true }),
    field({ label: 'Навыки', name: 'skills', textarea: true, rows: 3, value: r.skills || '', maxlength: 1000, full: true }),
    field({ label: 'Файл резюме (необязательно)', name: 'documentId', full: true, value: r.document ? r.document.id : '', options: [{ value: '', label: 'Без файла' }, ...docs.filter((d) => d.kind !== 'verification').map((d) => ({ value: d.id, label: `${d.name} (${fmtSize(d.size)})` }))], hint: 'Файлы загружаются на вкладке «Документы».' }),
    field({ name: 'isPrimary', type: 'checkbox', value: !!r.isPrimary, label: 'x', checkboxLabel: 'Сделать основным резюме', full: true }),
  ];
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, resume ? 'Сохранить' : 'Создать резюме');
  const m = modal({ title: resume ? 'Редактирование резюме' : 'Новое резюме', wide: true, body: h('form', { class: 'form-grid', novalidate: true, id: 'resume-form', onsubmit: async (e) => {
    e.preventDefault();
    const v = values(fields);
    await withLoading(e.submitter || btn, async () => {
      try {
        const body = { title: v.title, desiredPosition: textOrNull(v.desiredPosition), about: textOrNull(v.about), experience: textOrNull(v.experience), education: textOrNull(v.education), skills: textOrNull(v.skills), documentId: numOrNull(v.documentId), isPrimary: v.isPrimary };
        if (resume) await api.put(`/api/me/resumes/${resume.id}`, body); else await api.post('/api/me/resumes', body);
        m.close(); toast('Резюме сохранено.', 'ok'); done();
      } catch (err) { handleFormError(err, fields); }
    });
  } }, fields.map((f) => f.el)), actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), h('button', { type: 'submit', class: 'btn-primary', form: 'resume-form' }, 'Сохранить')] });
  void btn;
}

async function resumesTab() {
  const [{ items }, docs] = await Promise.all([api.get('/api/me/resumes'), api.get('/api/me/documents')]);
  const reload = () => tabs.reload();
  return panel(
    h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, `Мои резюме (${items.length} из 5)`), h('button', { type: 'button', class: 'btn-primary btn-sm', disabled: items.length >= 5, onclick: () => resumeModal(null, docs.items, reload) }, 'Создать резюме')),
    items.length ? h('div', { class: 'item-list' }, items.map((r) => h('article', { class: 'item-card' },
      h('div', { class: 'grow' }, h('h3', {}, r.title, r.isPrimary ? h('span', { class: 'badge badge-ok' }, 'Основное') : null),
        h('div', { class: 'item-meta' }, r.desiredPosition ? h('span', {}, r.desiredPosition) : null, h('span', {}, `Обновлено ${fmtDate(r.updatedAt)}`), r.document ? h('span', {}, `Файл: ${r.document.name}`) : null)),
      h('div', { class: 'table-actions' },
        r.isPrimary ? null : h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: async () => { await api.put(`/api/me/resumes/${r.id}`, { isPrimary: true }).catch((e) => toast(e.message, 'error')); reload(); } }, 'Сделать основным'),
        h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: () => resumeModal(r, docs.items, reload) }, 'Редактировать'),
        h('button', { type: 'button', class: 'btn-danger btn-sm', onclick: async () => {
          if (!(await confirmDialog({ title: 'Удалить резюме?', message: `Резюме «${r.title}» будет удалено. Уже отправленные отклики сохранят копию резюме.`, confirmText: 'Удалить', danger: true }))) return;
          try { await api.del(`/api/me/resumes/${r.id}`); toast('Резюме удалено.', 'ok'); reload(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Удалить')))))
      : emptyState('Резюме пока нет', 'Создайте резюме — оно понадобится для отклика на вакансии.'));
}

// ------------------------------------------------------------------ документы
async function documentsTab() {
  const { items } = await api.get('/api/me/documents');
  const kind = field({ label: 'Тип документа', name: 'kind', options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) });
  const input = h('input', { type: 'file', class: 'input-control', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg', id: 'doc-file', required: true });
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Загрузить');
  return panel(h('h2', { class: 'section-title' }, `Мои документы (${items.length} из 20)`),
    h('form', { class: 'verify-box stack', onsubmit: async (e) => {
      e.preventDefault();
      if (!input.files[0]) { toast('Выберите файл.', 'error'); return; }
      await withLoading(btn, async () => {
        try { await api.upload('/api/me/documents', input.files[0], { kind: kind.value() }); toast('Документ загружен.', 'ok'); tabs.reload(); } catch (err) { toast(err.message, 'error'); }
      });
    } }, h('div', { class: 'form-grid' }, kind.el, h('div', { class: 'field' }, h('label', { for: 'doc-file' }, 'Файл'), input, h('div', { class: 'field-hint' }, 'PDF, DOC, DOCX, PNG, JPG — до 5 МБ. Тип файла проверяется по содержимому.'))), h('div', { class: 'form-actions' }, btn)),
    items.length ? h('div', { class: 'item-list' }, items.map((d) => h('article', { class: 'item-card' },
      h('div', { class: 'grow' }, h('h3', { class: 'break' }, d.name), h('div', { class: 'item-meta' }, h('span', {}, KIND_LABEL[d.kind]), h('span', {}, fmtSize(d.size)), h('span', {}, fmtDateTime(d.createdAt)))),
      h('div', { class: 'table-actions' }, downloadLink(d, 'Скачать'), h('button', { type: 'button', class: 'btn-danger btn-sm', onclick: async () => {
        if (!(await confirmDialog({ title: 'Удалить документ?', message: d.name, confirmText: 'Удалить', danger: true }))) return;
        try { await api.del(`/api/me/documents/${d.id}`); toast('Документ удалён.', 'ok'); tabs.reload(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Удалить')))))
      : emptyState('Документов нет', 'Загрузите резюме или подтверждающие документы.'));
}

// ------------------------------------------------------------------ отклики
async function applicationsTab() {
  let page = 1;
  let status = '';
  const box = h('div', { class: 'stack' });
  const sel = field({ label: 'Статус', name: 'status', options: [{ value: '', label: 'Все' }, ...Object.entries({ sent: 'Отправлен', reviewing: 'На рассмотрении', viewed: 'Просмотрен', interview: 'Приглашение на собеседование', accepted: 'Принят', rejected: 'Отклонён', withdrawn: 'Отозван' }).map(([value, label]) => ({ value, label }))] });
  async function render() {
    const data = await api.get(`/api/me/applications?page=${page}&pageSize=10${status ? `&status=${status}` : ''}`);
    mount(box, data.items.length ? [
      h('div', { class: 'result-count' }, `Откликов: ${data.total}`),
      h('div', { class: 'item-list' }, data.items.map((a) => h('article', { class: 'item-card' },
        h('div', { class: 'grow stack-sm' }, h('h3', {}, h('a', { href: `/vacancies/${a.vacancy.id}` }, a.vacancy.title)),
          h('div', { class: 'item-meta' }, h('span', {}, a.vacancy.organizationName), h('span', {}, a.vacancy.city), h('span', {}, `Отправлен ${fmtDateTime(a.createdAt)}`), a.resumeTitle ? h('span', {}, `Резюме: ${a.resumeTitle}`) : null),
          a.vacancy.status === 'closed' ? h('span', { class: 'status-closed-note' }, 'Вакансия закрыта') : null,
          h('details', {}, h('summary', { class: 'small fw-700' }, 'История статусов'), h('ul', { class: 'timeline mt-8' }, a.history.map((x) => h('li', {}, x.statusLabel, h('span', { class: 'when' }, fmtDateTime(x.createdAt))))))),
        h('div', { class: 'stack-sm right' }, appBadge(a.status), a.canWithdraw ? h('button', { type: 'button', class: 'btn-danger btn-sm', onclick: async () => {
          if (!(await confirmDialog({ title: 'Отозвать отклик?', message: `Отклик на «${a.vacancy.title}» будет отозван. Позже вы сможете откликнуться снова.`, confirmText: 'Отозвать', danger: true }))) return;
          try { await api.post(`/api/applications/${a.id}/withdraw`); toast('Отклик отозван.', 'ok'); render(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Отозвать') : null)))),
      pager(data, (n) => { page = n; render(); })]
      : emptyState(status ? 'Нет откликов с таким статусом' : 'Вы ещё не откликались на вакансии', 'Найдите подходящую вакансию в каталоге.', h('a', { class: 'btn-primary btn-sm', href: '/vacancies' }, 'Перейти к вакансиям')));
  }
  sel.input.addEventListener('change', () => { status = sel.value(); page = 1; render().catch((e) => toast(e.message, 'error')); });
  await render();
  return panel(h('h2', { class: 'section-title' }, 'История откликов'), h('div', { class: 'toolbar' }, sel.el), box);
}

// ------------------------------------------------------------------ избранное
async function savedTab() {
  const { items } = await api.get('/api/me/saved');
  if (!items.length) return panel(h('h2', { class: 'section-title' }, 'Избранные вакансии'), emptyState('В избранном пусто', 'Нажимайте «В избранное» в каталоге, чтобы вернуться к вакансиям позже.', h('a', { class: 'btn-primary btn-sm', href: '/vacancies' }, 'Найти вакансии')));
  return panel(h('h2', { class: 'section-title' }, `Избранные вакансии (${items.length})`), h('div', { class: 'vacancies-cards-grid' }, items.map((v) => vacancyCard(v, { user, onSaveToggle: () => setTimeout(() => tabs.reload(), 300) }))));
}

const forced = user.mustChangePassword;
const tabsDef = forced
  ? [{ id: 'settings', label: 'Настройки', render: async () => accountSettings(user, { forced: true }) }]
  : [
    { id: 'profile', label: 'Профиль', render: profileTab },
    { id: 'status', label: 'Статус студента', render: statusTab },
    { id: 'resumes', label: 'Резюме', render: resumesTab },
    { id: 'documents', label: 'Документы', render: documentsTab },
    { id: 'applications', label: 'Отклики', render: applicationsTab },
    { id: 'saved', label: 'Избранное', render: savedTab },
    { id: 'notifications', label: 'Уведомления', render: async () => panel(h('h2', { class: 'section-title' }, 'Уведомления'), await notificationsPanel((n) => tabs.setBadge('notifications', n))) },
    { id: 'settings', label: 'Настройки', render: async () => accountSettings(user) },
  ];

const tabHost = h('div');
mount(app, h('div', { class: 'dash-head' }, h('div', {}, h('h1', { class: 'title-h1' }, 'Личный кабинет соискателя'), h('p', { class: 'text-meta' }, user.fullName))), tabHost);
const tabs = createTabs(tabHost, tabsDef, { fallback: forced ? 'settings' : 'profile' });
if (!forced) api.get('/api/me/notifications?unread=1&pageSize=1').then((d) => tabs.setBadge('notifications', d.unreadCount)).catch(() => {});
void plural;
