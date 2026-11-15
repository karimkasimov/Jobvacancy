// Общая шапка, подвал и проверка доступа к страницам.
import { api, loadMe, logout } from './api.js';
import { h, $, mount } from './ui.js';

export const DASHBOARD = { candidate: '/cabinet', employer: '/employer', admin: '/admin' };
const NAV = [
  { key: 'home', href: '/', label: 'Главная' },
  { key: 'vacancies', href: '/vacancies', label: 'Вакансии' },
  { key: 'partners', href: '/partners', label: 'Наши партнёры' },
  { key: 'about', href: '/#about', label: 'О нас' },
];

function searchBox() {
  const input = h('input', { type: 'search', class: 'expand-search-input', placeholder: 'Поиск', 'aria-label': 'Поиск вакансий', name: 'q', maxlength: 100 });
  const form = h('form', {
    class: 'expand-search', role: 'search',
    onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); location.href = q ? `/vacancies?q=${encodeURIComponent(q)}` : '/vacancies'; },
  }, h('button', { type: 'submit', class: 'expand-search-btn', 'aria-label': 'Найти' },
    svg('0 0 24 24', [['circle', { cx: 11, cy: 11, r: 7 }], ['line', { x1: 20, y1: 20, x2: 16.5, y2: 16.5 }]])), input);
  return form;
}

function svg(viewBox, shapes) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: 15, height: 15, viewBox, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) el.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const s = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    el.append(s);
  }
  return el;
}

function renderHeader(user, active) {
  const actions = [searchBox()];
  if (user) {
    const dash = DASHBOARD[user.role];
    actions.push(h('div', { class: 'header-user' },
      user.unreadNotifications ? h('a', { class: 'bell-link', href: `${dash}#notifications`, title: 'Непрочитанные уведомления' }, 'Уведомления', h('span', { class: 'count-pill' }, String(user.unreadNotifications))) : null,
      h('a', { class: 'btn-primary btn-sm', href: dash }, 'Личный кабинет'),
      h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: async () => { await logout(); location.href = '/'; } }, 'Выйти')));
  } else {
    actions.push(h('a', { class: 'btn-primary btn-sm', href: '/login' }, 'Личный кабинет'));
  }
  return h('header', { class: `site-header${user ? ' is-signed-in' : ''}` },
    h('div', { class: 'container header-inner' },
      h('a', { href: '/', class: 'header-brand', 'aria-label': 'ГГКИТ Карьера ЧР — на главную' },
        h('img', { src: '/assets/logo.png', alt: 'Герб ГГКИТ', class: 'header-logo', width: 48, height: 48 }),
        h('div', {}, h('div', { class: 'header-brand-title' }, 'ГГКИТ'), h('div', { class: 'header-brand-sub' }, 'Кадровый портал колледжа и партнёров ЧР'))),
      h('nav', { class: 'header-nav', 'aria-label': 'Основная навигация' },
        NAV.map((n) => h('a', { class: `header-nav-link${n.key === active ? ' is-active' : ''}`, href: n.href, 'aria-current': n.key === active ? 'page' : null }, n.label))),
      h('div', { class: 'header-actions' }, actions)));
}

function renderFooter(site) {
  const c = (site && site.content) || {};
  const contacts = [
    c.contact_address ? h('li', {}, c.contact_address) : null,
    c.contact_phone ? h('li', {}, h('a', { href: `tel:${c.contact_phone.replace(/[^\d+]/g, '')}` }, c.contact_phone)) : null,
    c.contact_email ? h('li', {}, h('a', { href: `mailto:${c.contact_email}` }, c.contact_email)) : null,
  ].filter(Boolean);
  return h('footer', { class: 'site-footer' },
    h('div', { class: 'container footer-inner' },
      h('div', { class: 'footer-grid' },
        h('div', {},
          h('div', { class: 'footer-brand' }, h('img', { src: '/assets/logo.png', alt: '', width: 46, height: 46 }), h('strong', {}, 'ГГКИТ Карьера ЧР')),
          h('p', {}, 'ГБПОУ «Грозненский государственный колледж информационных технологий»'),
          h('p', { class: 'mt-8' }, c.footer_note || '')),
        h('div', {}, h('h4', {}, 'Навигация'),
          h('ul', {},
            h('li', {}, h('a', { href: '/vacancies' }, 'Все вакансии')),
            h('li', {}, h('a', { href: '/partners' }, 'Партнёры колледжа')),
            h('li', {}, h('a', { href: '/register' }, 'Регистрация')),
            h('li', {}, h('a', { href: '/login' }, 'Вход в личный кабинет')))),
        h('div', {}, h('h4', {}, 'Контакты'),
          contacts.length ? h('ul', {}, contacts) : h('p', {}, 'Контактные данные будут добавлены администратором портала.'))),
      h('div', { class: 'footer-bottom' }, h('span', {}, `© ГБПОУ «ГГКИТ», 1933–${new Date().getFullYear()}`), h('span', {}, 'Официальный кадровый портал'))));
}

/**
 * Инициализация страницы.
 * require: 'candidate' | 'employer' | 'admin' | 'user' — ограничение доступа (проверяется и на сервере).
 * Возвращает { user, site }.
 */
export async function initLayout({ active = '', require = null } = {}) {
  const [user, site] = await Promise.all([loadMe(), api.get('/api/site').catch(() => null)]);

  if (require) {
    if (!user) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`); return new Promise(() => {}); }
    if (require !== 'user' && user.role !== require) { location.replace(DASHBOARD[user.role]); return new Promise(() => {}); }
  }

  document.body.prepend(h('a', { class: 'skip-link', href: '#main' }, 'Перейти к содержимому'));
  const headerSlot = $('#site-header');
  const footerSlot = $('#site-footer');
  if (headerSlot) headerSlot.replaceWith(renderHeader(user, active));
  if (footerSlot) footerSlot.replaceWith(renderFooter(site));
  return { user, site };
}

/** Пользователь вошёл → перенаправить в его кабинет (для страниц входа/регистрации). */
export function redirectIfSignedIn(user) {
  if (!user) return false;
  const next = new URLSearchParams(location.search).get('next');
  location.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : DASHBOARD[user.role]);
  return true;
}

export function afterLoginTarget(user) {
  const next = new URLSearchParams(location.search).get('next');
  if (user.mustChangePassword) return `${DASHBOARD[user.role]}#settings`;
  return next && next.startsWith('/') && !next.startsWith('//') ? next : DASHBOARD[user.role];
}

export { mount };
