// Просмотр отклика: профиль кандидата, резюме, статусы, комментарии (работодатель — с правами изменения, администратор — только просмотр).
import { api } from './api.js';
import { h, mount, field, withLoading, toast, fmtDateTime, paragraphs, downloadLink } from './ui.js';
import { appBadge } from './components.js';

const STATUS_OPTIONS = [['reviewing', 'На рассмотрении'], ['viewed', 'Просмотрен'], ['interview', 'Приглашение на собеседование'], ['accepted', 'Принят'], ['rejected', 'Отклонён']];
const block = (title, node) => (node ? h('section', { class: 'stack-sm' }, h('h3', { class: 'section-title' }, title), node) : null);
const text = (t) => (t ? h('div', { class: 'paragraphs text-body' }, paragraphs(t)) : null);

/** a — отклик из API. editable — работодатель. onChange(newApplication) вызывается после изменения. */
export function applicationDetailView(a, { editable = false, onChange = () => {} } = {}) {
  const root = h('div', { class: 'stack-lg' });
  const c = a.candidate;
  const r = a.resume;

  const statusSel = field({ label: 'Статус отклика', name: 'status', value: ['sent', 'withdrawn'].includes(a.status) ? 'reviewing' : a.status, options: STATUS_OPTIONS.map(([value, label]) => ({ value, label })) });
  const saveBtn = h('button', { type: 'button', class: 'btn-primary', onclick: async (e) => {
    await withLoading(e.currentTarget, async () => {
      try { const res = await api.patch(`/api/employer/applications/${a.id}/status`, { status: statusSel.value() }); toast('Статус обновлён, кандидат получит уведомление.', 'ok'); onChange(res.application); } catch (err) { toast(err.message, 'error'); }
    });
  } }, 'Сохранить статус');

  const commentField = field({ label: 'Новый комментарий', name: 'body', textarea: true, rows: 3, maxlength: 1000, hint: 'Комментарии видны только сотрудникам вашей организации.' });
  const commentBtn = h('button', { type: 'button', class: 'btn-outline', onclick: async (e) => {
    const body = commentField.value().trim();
    if (!body) { commentField.setError('Введите текст комментария.'); return; }
    await withLoading(e.currentTarget, async () => {
      try { const res = await api.post(`/api/employer/applications/${a.id}/comments`, { body }); toast('Комментарий добавлен.', 'ok'); onChange(res.application); } catch (err) { toast(err.message, 'error'); }
    });
  } }, 'Добавить комментарий');

  mount(root,
    h('div', { class: 'row-between' },
      h('div', {}, h('div', { class: 'title-h3' }, c.fullName), h('div', { class: 'text-meta' }, `${a.vacancy.title}${a.organization ? ` · ${a.organization.name}` : ''}`)),
      h('div', { class: 'row' }, c.collegeStatus ? h('span', { class: 'badge badge-ok' }, `${c.collegeStatus} · подтверждён`) : null, appBadge(a.status))),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Email'), h('dd', {}, h('a', { href: `mailto:${c.email}` }, c.email)),
      c.phone ? [h('dt', {}, 'Телефон'), h('dd', {}, h('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }, c.phone))] : null,
      c.city ? [h('dt', {}, 'Город'), h('dd', {}, c.city)] : null,
      c.desiredPosition ? [h('dt', {}, 'Желаемая должность'), h('dd', {}, c.desiredPosition)] : null,
      h('dt', {}, 'Отправлен'), h('dd', {}, fmtDateTime(a.createdAt))),
    block('О кандидате', text(c.about)), block('Навыки (профиль)', text(c.skills)),
    r ? h('section', { class: 'card-flat stack' }, h('h3', { class: 'section-title' }, `Резюме: ${r.title}`),
      r.desiredPosition ? h('p', {}, h('strong', {}, 'Желаемая должность: '), r.desiredPosition) : null,
      block('О себе', text(r.about)), block('Опыт', text(r.experience)), block('Образование', text(r.education)), block('Навыки', text(r.skills)),
      a.resumeFile ? h('div', {}, downloadLink(a.resumeFile)) : null) : null,
    block('Сопроводительное письмо', text(a.coverLetter)),
    editable && a.status !== 'withdrawn' ? h('section', { class: 'card-flat stack' }, statusSel.el, h('div', {}, saveBtn)) : null,
    editable && a.status === 'withdrawn' ? h('div', { class: 'alert alert-info' }, 'Кандидат отозвал отклик — статус изменить нельзя.') : null,
    block('История статусов', h('ul', { class: 'timeline' }, a.history.map((x) => h('li', {}, x.statusLabel, h('span', { class: 'when' }, fmtDateTime(x.createdAt)))))),
    block('Внутренние комментарии', h('div', { class: 'stack' },
      a.comments.length ? h('div', { class: 'comment-list' }, a.comments.map((k) => h('div', { class: 'comment' }, h('div', { class: 'who' }, `${k.author || 'Сотрудник'} · ${fmtDateTime(k.createdAt)}`), k.body))) : h('p', { class: 'muted small' }, 'Комментариев пока нет.'),
      editable ? [commentField.el, h('div', {}, commentBtn)] : null)));
  return root;
}
