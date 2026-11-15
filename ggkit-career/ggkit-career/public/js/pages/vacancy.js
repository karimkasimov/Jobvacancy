import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, load, fmtDate, toast, modal, field, values, handleFormError, withLoading, paragraphs, emptyState } from '../ui.js';
import { orgLogo, orgBadge, appBadge, contactBlock, vacancyBadge } from '../components.js';

const { user } = await initLayout({ active: 'vacancies' });
const app = document.getElementById('app');
const id = (location.pathname.match(/^\/vacancies\/(\d+)/) || [])[1];

const list = (title, items) => (items.length ? h('section', { class: 'detail-block' }, h('h2', { class: 'title-h3' }, title), h('ul', { class: 'detail-bullet-list' }, items.map((t) => h('li', {}, t)))) : null);
const cond = (label, ...val) => h('div', { class: 'condition-cell' }, h('span', { class: 'condition-label' }, label), h('span', { class: 'condition-val' }, ...val));

function applyModal(v, onApplied) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Загрузка резюме…'));
  const m = modal({ title: `Отклик на вакансию «${v.title}»`, body });
  api.get('/api/me/resumes').then(({ items }) => {
    if (!items.length) {
      mount(body, h('div', { class: 'alert alert-warn' }, 'Чтобы откликнуться, создайте хотя бы одно резюме в личном кабинете.'),
        h('div', { class: 'mt-16' }, h('a', { class: 'btn-primary', href: '/cabinet#resumes' }, 'Создать резюме')));
      return;
    }
    const resume = field({ label: 'Резюме', name: 'resumeId', required: true, options: items.map((r) => ({ value: r.id, label: `${r.title}${r.isPrimary ? ' (основное)' : ''}` })), value: (items.find((r) => r.isPrimary) || items[0]).id });
    const letter = field({ label: 'Сопроводительное письмо', name: 'coverLetter', textarea: true, rows: 6, maxlength: 2000, hint: 'Необязательно. Расскажите, почему вам интересна эта вакансия.' });
    const fields = [resume, letter];
    const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Отправить отклик');
    mount(body, h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      await withLoading(btn, async () => {
        try {
          const vals = values(fields);
          const r = await api.post(`/api/vacancies/${v.id}/apply`, { resumeId: Number(vals.resumeId), coverLetter: vals.coverLetter });
          m.close(); toast('Отклик отправлен работодателю.', 'ok'); onApplied(r.application);
        } catch (err) { handleFormError(err, fields); }
      });
    } }, resume.el, letter.el, h('div', { class: 'form-actions' }, btn, h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'))));
  }).catch((e) => mount(body, h('div', { class: 'alert alert-error' }, e.message)));
}

async function render() {
  const { vacancy: v, viewer } = await api.get(`/api/vacancies/${id}`);
  document.title = `${v.title} — ${v.organization.name} — ГГКИТ Карьера ЧР`;
  const isManager = user && ['employer', 'admin'].includes(user.role);
  const side = h('div', { class: 'apply-status' });

  function renderApply() {
    let node;
    if (v.status !== 'published') node = h('div', { class: 'alert alert-warn' }, v.status === 'closed' ? 'Вакансия закрыта — отклики не принимаются.' : 'Эта вакансия ещё не опубликована.');
    else if (!user) node = [h('p', { class: 'text-meta' }, 'Войдите в личный кабинет соискателя, чтобы откликнуться.'), h('a', { class: 'btn-primary btn-block', href: `/login?next=${encodeURIComponent(location.pathname)}` }, 'Войти и откликнуться'), h('a', { class: 'btn-outline btn-block', href: `/register?role=candidate&next=${encodeURIComponent(location.pathname)}` }, 'Создать профиль соискателя')];
    else if (user.role !== 'candidate') node = h('div', { class: 'alert alert-info' }, 'Откликаться на вакансии могут только соискатели.');
    else if (viewer.application) node = [h('div', { class: 'row' }, h('span', { class: 'text-meta' }, 'Ваш отклик:'), appBadge(viewer.application.status)), h('a', { class: 'btn-outline btn-block', href: '/cabinet#applications' }, 'Открыть историю откликов')];
    else node = h('button', { type: 'button', class: 'btn-primary btn-block', onclick: () => applyModal(v, (a) => { viewer.application = { id: a.id, status: a.status }; renderApply(); }) }, 'Откликнуться');
    mount(side, node);
    if (user && user.role === 'candidate' && v.status !== 'draft') {
      const saveBtn = h('button', { type: 'button', class: 'btn-outline btn-block', 'aria-pressed': String(viewer.saved), onclick: async (e) => {
        await withLoading(e.currentTarget, async () => {
          try {
            if (viewer.saved) await api.del(`/api/me/saved/${v.id}`); else await api.put(`/api/me/saved/${v.id}`);
            viewer.saved = !viewer.saved; renderApply();
            toast(viewer.saved ? 'Вакансия добавлена в избранное.' : 'Вакансия убрана из избранного.', 'ok');
          } catch (err) { toast(err.message, 'error'); }
        });
      } }, viewer.saved ? 'Убрать из избранного' : 'В избранное');
      side.append(saveBtn);
    }
  }
  renderApply();

  const mapLink = v.address ? h('a', { class: 'map-open-link', href: v.mapUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть на карте') : null;
  const preview = v.status !== 'published' && isManager
    ? h('div', { class: `alert ${v.status === 'rejected' ? 'alert-error' : 'alert-warn'} mb-24` }, h('strong', {}, 'Предпросмотр. '), 'Статус вакансии: ', vacancyBadge(v.status), v.moderationNote ? ` Причина: ${v.moderationNote}` : '') : null;

  return h('div', {},
    h('div', { class: 'breadcrumbs' }, h('a', { href: '/' }, 'Главная'), '›', h('a', { href: '/vacancies' }, 'Вакансии'), '›', h('span', {}, v.title)),
    preview,
    v.status === 'closed' ? h('div', { class: 'alert alert-warn mb-24' }, `Вакансия закрыта${v.closedAt ? ` ${fmtDate(v.closedAt)}` : ''}. Отклики больше не принимаются.`) : null,
    h('div', { class: 'detail-layout' },
      h('article', { class: 'detail-doc-card' },
        h('div', { class: 'detail-header' },
          h('div', { class: 'grow' }, h('div', { class: 'tag-row mb-8' }, h('span', { class: 'tag-chip' }, v.category.name), h('span', { class: 'tag-chip' }, v.employmentTypeLabel), v.organization.isCollegeUnit ? h('span', { class: 'badge-ggkit' }, 'ВАКАНСИЯ ГГКИТ') : null),
            h('h1', { class: 'detail-title' }, v.title), h('div', { class: 'detail-salary' }, v.salaryText))),
        h('div', { class: 'vacancy-conditions-grid mt-24' },
          cond('Город', v.city), cond('Опыт работы', v.experienceLabel), cond('Тип занятости', v.employmentTypeLabel), cond('Формат работы', v.workFormat || '—'),
          cond('Подразделение', v.department || '—'), cond('Опубликована', fmtDate(v.publishedAt))),
        h('section', { class: 'detail-block' }, h('h2', { class: 'title-h3' }, 'Описание'), h('div', { class: 'paragraphs text-body' }, paragraphs(v.description))),
        list('Обязанности', v.responsibilities), list('Требования', v.requirements), list('Условия работы', v.conditions),
        h('div', { class: 'detail-address-contact-bar' },
          h('div', { class: 'detail-address-box' }, h('div', { class: 'condition-label' }, 'Адрес места работы'), h('p', { class: 'condition-val' }, v.address || v.city), mapLink),
          h('div', { class: 'detail-contact-box' }, h('div', { class: 'condition-label mb-8' }, 'Рабочие контакты'), contactBlock(v)))),
      h('aside', { class: 'detail-side' },
        h('div', { class: 'card' }, side),
        h('div', { class: 'card' },
          h('div', { class: 'row-start' }, orgLogo(v.organization), h('div', {}, h('div', { class: 'title-h3' }, v.organization.name), h('div', { class: 'text-meta' }, v.organization.city))),
          h('div', { class: 'mt-16 row' }, orgBadge(v.organization.verificationStatus)),
          v.organization.description ? h('p', { class: 'text-meta mt-16' }, v.organization.description.length > 220 ? `${v.organization.description.slice(0, 219)}…` : v.organization.description) : null,
          h('div', { class: 'mt-16' }, h('a', { class: 'btn-outline btn-sm', href: `/partners/${v.organization.id}` }, 'Об организации и другие вакансии'))),
        h('button', { type: 'button', class: 'btn-outline', onclick: async () => {
          try { await navigator.clipboard.writeText(location.href); toast('Ссылка на вакансию скопирована.', 'ok'); } catch { toast('Не удалось скопировать ссылку. Скопируйте адрес из строки браузера.', 'error'); }
        } }, 'Скопировать ссылку'))));
}

if (!id) {
  mount(app, emptyState('Вакансия не найдена', 'Проверьте адрес страницы.', h('a', { class: 'btn-primary btn-sm', href: '/vacancies' }, 'К каталогу вакансий')));
} else {
  await load(app, async () => {
    try { return await render(); } catch (err) {
      if (err.status === 404) {
        document.title = 'Вакансия не найдена — ГГКИТ Карьера ЧР';
        return emptyState('Вакансия не найдена', 'Возможно, она была удалена, не прошла модерацию или адрес указан неверно.', h('a', { class: 'btn-primary btn-sm', href: '/vacancies' }, 'К каталогу вакансий'));
      }
      throw err;
    }
  });
}
