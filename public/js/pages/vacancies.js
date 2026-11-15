import { api, loadMeta, qs } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, load, field, plural, fmtDate, pager, emptyState, skeletons, table } from '../ui.js';
import { vacancyCard, orgLogo, appBadge } from '../components.js';

const { user } = await initLayout({ active: 'vacancies' });
const app = document.getElementById('app');
const meta = await loadMeta().catch(() => ({ categories: [], employmentTypes: [], experienceLevels: [], cities: [] }));

const opt = (label, list) => [{ value: '', label }, ...list];
const f = {
  q: field({ label: 'Поиск', name: 'q', type: 'search', placeholder: 'Должность, организация, город', maxlength: 100, full: false }),
  position: field({ label: 'Должность', name: 'position', maxlength: 100 }),
  employer: field({ label: 'Работодатель', name: 'employer', maxlength: 100 }),
  city: field({ label: 'Город', name: 'city', maxlength: 80 }),
  category: field({ label: 'Категория', name: 'category', options: opt('Все категории', meta.categories.map((c) => ({ value: c.slug, label: c.name }))) }),
  type: field({ label: 'Тип занятости', name: 'type', options: opt('Любой', meta.employmentTypes) }),
  experience: field({ label: 'Опыт работы', name: 'experience', options: opt('Любой', meta.experienceLevels) }),
  salaryFrom: field({ label: 'Зарплата от, ₽', name: 'salaryFrom', type: 'number', min: 0, max: 10000000, inputmode: 'numeric' }),
  status: field({ label: 'Статус', name: 'status', options: [{ value: 'active', label: 'Активные' }, { value: 'closed', label: 'Закрытые' }, { value: 'all', label: 'Все' }] }),
  sort: field({ label: 'Сортировка', name: 'sort', options: [{ value: 'date', label: 'По дате публикации' }, { value: 'salary', label: 'По зарплате' }] }),
  order: field({ label: 'Порядок', name: 'order', options: [{ value: 'desc', label: 'Сначала новые / высокие' }, { value: 'asc', label: 'Сначала старые / низкие' }] }),
};
const KEYS = Object.keys(f);
const state = { source: '', view: 'cards', page: 1 };

function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of KEYS) f[k].set(p.get(k) || (k === 'status' ? 'active' : k === 'sort' ? 'date' : k === 'order' ? 'desc' : ''));
  state.source = ['college', 'partner'].includes(p.get('source')) ? p.get('source') : '';
  state.view = p.get('view') === 'table' ? 'table' : 'cards';
  state.page = Math.max(1, parseInt(p.get('page'), 10) || 1);
}
function params() {
  const o = {};
  for (const k of KEYS) o[k] = f[k].value().trim?.() ?? f[k].value();
  if (o.status === 'active') delete o.status;
  if (o.sort === 'date') delete o.sort;
  if (o.order === 'desc') delete o.order;
  if (state.source) o.source = state.source;
  return o;
}
function pushUrl(replace = false) {
  const o = { ...params(), view: state.view === 'table' ? 'table' : '', page: state.page > 1 ? state.page : '' };
  history[replace ? 'replaceState' : 'pushState'](null, '', `/vacancies${qs(o)}`);
}

const results = h('div', { 'aria-live': 'polite' });
const contourBox = h('div', { class: 'big-contour-tabs is-three' });
const viewBox = h('div', { class: 'view-mode-group', role: 'group', 'aria-label': 'Вид списка' });

function renderContour(counts) {
  const tabs = [['', 'Все вакансии'], ['college', 'Вакансии ГГКИТ'], ['partner', 'Вакансии партнёров']];
  mount(contourBox, tabs.map(([key, label]) => h('button', {
    type: 'button', class: `big-contour-tab${state.source === key ? ' is-active' : ''}`, 'aria-pressed': String(state.source === key),
    onclick: () => { state.source = key; state.page = 1; search(); },
  }, h('span', { class: 'title-h3' }, label), counts[key] !== undefined ? h('span', { class: 'big-contour-count' }, String(counts[key])) : null)));
}
function renderView() {
  mount(viewBox, [['cards', 'Карточки'], ['table', 'Таблица']].map(([k, label]) => h('button', {
    type: 'button', class: `view-mode-btn${state.view === k ? ' is-active' : ''}`, 'aria-pressed': String(state.view === k),
    onclick: () => { state.view = k; pushUrl(); renderView(); search(false); },
  }, label)));
}

let counts = {};
async function refreshCounts() {
  const base = { ...params() }; delete base.source;
  const [all, college, partner] = await Promise.all(['', 'college', 'partner'].map((s) => api.get(`/api/vacancies${qs({ ...base, source: s, pageSize: 1 })}`).then((d) => d.total).catch(() => undefined)));
  counts = { '': all, college, partner };
  renderContour(counts);
}

function tableView(items) {
  return table(['Должность', 'Организация', 'Город', 'Зарплата', 'Опыт', 'Опубликована', ''],
    items.map((v) => h('tr', {},
      h('td', {}, h('a', { class: 'cell-title', href: `/vacancies/${v.id}` }, v.title), h('span', { class: 'sub' }, v.category.name), v.status === 'closed' ? h('span', { class: 'badge badge-muted' }, 'Закрыта') : null),
      h('td', {}, h('div', { class: 'row' }, orgLogo(v.organization), v.organization.name)),
      h('td', {}, v.city), h('td', { class: 'nowrap fw-700' }, v.salaryText), h('td', {}, v.experienceLabel), h('td', { class: 'nowrap' }, fmtDate(v.publishedAt)),
      h('td', { class: 'actions' }, v.applicationStatus ? appBadge(v.applicationStatus) : h('a', { class: 'btn-outline btn-sm', href: `/vacancies/${v.id}` }, 'Подробнее')))));
}

async function search(updateUrl = true, count = true) {
  if (updateUrl) pushUrl();
  renderContour(counts);
  if (count) refreshCounts();
  const p = { ...params(), page: state.page, pageSize: 10 };
  await load(results, async () => {
    const data = await api.get(`/api/vacancies${qs(p)}`);
    if (state.page > data.pages && data.pages >= 1 && data.total) { state.page = data.pages; return search(true, false); }
    if (!data.items.length) {
      return emptyState('Ничего не найдено', 'Измените условия поиска или сбросьте фильтры — возможно, подходящие вакансии появятся позже.', h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: reset }, 'Сбросить фильтры'));
    }
    return h('div', { class: 'stack' },
      h('div', { class: 'result-count' }, `Найдено: ${data.total} ${plural(data.total, ['вакансия', 'вакансии', 'вакансий'])}`),
      state.view === 'table' ? tableView(data.items) : h('div', { class: 'vacancies-cards-grid' }, data.items.map((v) => vacancyCard(v, { user }))),
      pager(data, (n) => { state.page = n; search(true, false); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }, { skeleton: h('div', { class: 'vacancies-cards-grid' }, skeletons(4)) });
}

function reset() {
  for (const k of KEYS) f[k].set(k === 'status' ? 'active' : k === 'sort' ? 'date' : k === 'order' ? 'desc' : '');
  state.source = ''; state.page = 1; search();
}

const form = h('form', { class: 'filters-card', role: 'search', onsubmit: (e) => { e.preventDefault(); state.page = 1; search(); } },
  h('div', { class: 'filters-grid' },
    h('div', { class: 'span-2' }, f.q.el), f.position.el, f.employer.el, f.city.el, f.category.el, f.type.el, f.experience.el, f.salaryFrom.el, f.status.el, f.sort.el, f.order.el,
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn-primary' }, 'Показать'), h('button', { type: 'button', class: 'btn-outline', onclick: reset }, 'Сбросить'))));
for (const k of ['category', 'type', 'experience', 'status', 'sort', 'order']) f[k].input.addEventListener('change', () => { state.page = 1; search(); });

mount(app,
  h('div', { class: 'breadcrumbs' }, h('a', { href: '/' }, 'Главная'), '›', h('span', {}, 'Вакансии')),
  h('h1', { class: 'title-h1' }, 'Каталог вакансий'),
  h('p', { class: 'subtitle mb-24' }, 'Вакансии подразделений ГГКИТ и организаций-партнёров в Чеченской Республике. Фильтры работают вместе.'),
  contourBox, form,
  h('div', { class: 'catalog-toolbar' }, h('span', { class: 'text-meta' }, 'Вид:'), viewBox),
  results);

readUrl(); renderView(); renderContour({}); search(false);
window.addEventListener('popstate', () => { readUrl(); renderView(); search(false); });
