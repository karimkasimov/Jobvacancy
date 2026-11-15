import { api, loadMeta, qs } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, load, field, plural, pager, emptyState, skeletons } from '../ui.js';
import { orgLogo, orgBadge } from '../components.js';

await initLayout({ active: 'partners' });
const app = document.getElementById('app');
const meta = await loadMeta().catch(() => ({ industries: [] }));

const f = {
  q: field({ label: 'Название или описание', name: 'q', type: 'search', maxlength: 100 }),
  city: field({ label: 'Город', name: 'city', maxlength: 80 }),
  industry: field({ label: 'Сфера деятельности', name: 'industry', options: [{ value: '', label: 'Все сферы' }, ...meta.industries.map((x) => ({ value: x, label: x }))] }),
  verified: field({ name: 'verified', type: 'checkbox', label: 'Только проверенные', checkboxLabel: 'Только проверенные организации' }),
};
let page = 1;
const results = h('div', { 'aria-live': 'polite' });

function card(o) {
  const phone = o.contactPhone ? h('p', {}, h('span', {}, 'Телефон: '), h('a', { href: `tel:${o.contactPhone.replace(/[^\d+]/g, '')}` }, o.contactPhone)) : null;
  const mail = o.contactEmail ? h('p', {}, h('span', {}, 'Почта: '), h('a', { href: `mailto:${o.contactEmail}` }, o.contactEmail)) : null;
  const site = o.website ? h('p', {}, h('span', {}, 'Сайт: '), h('a', { href: o.website, target: '_blank', rel: 'noopener noreferrer' }, o.website.replace(/^https?:\/\//, ''))) : null;
  return h('article', { class: 'partner-card' },
    h('div', { class: 'stack' },
      h('div', { class: 'partner-head' }, orgLogo(o, true), h('div', {}, h('h3', { class: 'title-h3' }, h('a', { href: `/partners/${o.id}` }, o.name)), orgBadge(o.verificationStatus))),
      h('div', { class: 'tag-row' }, o.isCollegeUnit ? h('span', { class: 'badge-ggkit' }, 'ПОДРАЗДЕЛЕНИЕ ГГКИТ') : null, o.industry ? h('span', { class: 'tag-chip' }, o.industry) : null, h('span', { class: 'tag-chip' }, o.city)),
      o.description ? h('p', { class: 'vacancy-desc' }, o.description.length > 200 ? `${o.description.slice(0, 199)}…` : o.description) : null,
      o.specialties ? h('p', { class: 'text-meta' }, `Специальности: ${o.specialties}`) : null,
      h('div', { class: 'partner-meta partner-contacts' }, o.address ? h('p', {}, h('span', {}, 'Адрес: '), o.address) : null, phone, mail, site)),
    h('div', { class: 'row-between' }, h('span', { class: 'text-meta' }, `${o.vacanciesCount} ${plural(o.vacanciesCount, ['открытая вакансия', 'открытые вакансии', 'открытых вакансий'])}`),
      h('a', { class: 'btn-primary btn-sm', href: `/partners/${o.id}` }, 'Подробнее')));
}

async function search() {
  await load(results, async () => {
    const data = await api.get(`/api/organizations${qs({ q: f.q.value().trim(), city: f.city.value().trim(), industry: f.industry.value(), verified: f.verified.value() ? 1 : '', page, pageSize: 9 })}`);
    if (!data.items.length) return emptyState('Организации не найдены', 'Измените условия поиска.');
    return h('div', { class: 'stack' }, h('div', { class: 'result-count' }, `Найдено: ${data.total} ${plural(data.total, ['организация', 'организации', 'организаций'])}`),
      h('div', { class: 'partners-grid' }, data.items.map(card)), pager(data, (n) => { page = n; search(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }, { skeleton: h('div', { class: 'partners-grid' }, skeletons(3)) });
}

mount(app,
  h('div', { class: 'breadcrumbs' }, h('a', { href: '/' }, 'Главная'), '›', h('span', {}, 'Наши партнёры')),
  h('h1', { class: 'title-h1' }, 'Организации-партнёры'),
  h('p', { class: 'subtitle mb-24' }, 'Справочник организаций, с которыми сотрудничает колледж. Статус «Проверена» присваивает администратор портала после проверки данных организации.'),
  h('form', { class: 'filters-card', role: 'search', onsubmit: (e) => { e.preventDefault(); page = 1; search(); } },
    h('div', { class: 'filters-grid' }, f.q.el, f.city.el, f.industry.el, h('div', { class: 'stack-sm' }, f.verified.el, h('button', { type: 'submit', class: 'btn-primary' }, 'Найти')))),
  results);
f.industry.input.addEventListener('change', () => { page = 1; search(); });
f.verified.input.addEventListener('change', () => { page = 1; search(); });
search();
