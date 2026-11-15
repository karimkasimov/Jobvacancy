import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, load, emptyState, paragraphs, plural } from '../ui.js';
import { orgLogo, orgBadge, vacancyCard } from '../components.js';

const { user } = await initLayout({ active: 'partners' });
const app = document.getElementById('app');
const id = (location.pathname.match(/^\/partners\/(\d+)/) || [])[1];

async function render() {
  const { organization: o, vacancies } = await api.get(`/api/organizations/${id}`);
  document.title = `${o.name} — ГГКИТ Карьера ЧР`;
  const row = (label, node) => (node ? [h('dt', {}, label), h('dd', {}, node)] : []);
  return h('div', {},
    h('div', { class: 'breadcrumbs' }, h('a', { href: '/' }, 'Главная'), '›', h('a', { href: '/partners' }, 'Партнёры'), '›', h('span', {}, o.name)),
    h('div', { class: 'detail-layout' },
      h('div', { class: 'stack-lg' },
        h('section', { class: 'detail-doc-card' },
          h('div', { class: 'row-start' }, orgLogo(o, true), h('div', {}, h('h1', { class: 'detail-title' }, o.name),
            h('div', { class: 'tag-row mt-8' }, orgBadge(o.verificationStatus), o.isCollegeUnit ? h('span', { class: 'badge-ggkit' }, 'ПОДРАЗДЕЛЕНИЕ ГГКИТ') : null, o.industry ? h('span', { class: 'tag-chip' }, o.industry) : null))),
          o.description ? h('div', { class: 'paragraphs text-body mt-24' }, paragraphs(o.description)) : null,
          o.specialties ? h('p', { class: 'text-meta mt-16' }, `Специальности колледжа: ${o.specialties}`) : null),
        h('section', {}, h('h2', { class: 'title-h2' }, `Открытые вакансии (${vacancies.length})`),
          vacancies.length ? h('div', { class: 'vacancies-cards-grid mt-16' }, vacancies.map((v) => vacancyCard({ ...v, saved: false }, { user: null })))
            : emptyState('Сейчас открытых вакансий нет', 'Загляните позже или посмотрите вакансии других организаций.', h('a', { class: 'btn-outline btn-sm', href: '/vacancies' }, 'Каталог вакансий')))),
      h('aside', { class: 'detail-side' }, h('div', { class: 'card' }, h('h2', { class: 'section-title' }, 'Контакты'),
        h('dl', { class: 'kv' },
          row('Город', o.city), row('Адрес', o.address), row('Контактное лицо', o.contactPerson),
          row('Телефон', o.contactPhone ? h('a', { href: `tel:${o.contactPhone.replace(/[^\d+]/g, '')}` }, o.contactPhone) : null),
          row('Почта', o.contactEmail ? h('a', { href: `mailto:${o.contactEmail}` }, o.contactEmail) : null),
          row('Сайт', o.website ? h('a', { href: o.website, target: '_blank', rel: 'noopener noreferrer' }, o.website.replace(/^https?:\/\//, '')) : null)),
        !(o.contactPhone || o.contactEmail || o.address || o.website) ? h('p', { class: 'muted small' }, 'Организация пока не добавила контактные данные.') : null))));
}

if (!id) mount(app, emptyState('Организация не найдена', null, h('a', { class: 'btn-primary btn-sm', href: '/partners' }, 'К списку партнёров')));
else await load(app, async () => {
  try { return await render(); } catch (err) {
    if (err.status === 404) return emptyState('Организация не найдена', 'Она не опубликована в каталоге или адрес указан неверно.', h('a', { class: 'btn-primary btn-sm', href: '/partners' }, 'К списку партнёров'));
    throw err;
  }
});
