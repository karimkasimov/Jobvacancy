import { initLayout } from '../layout.js';
import { h, mount, emptyState } from '../ui.js';

await initLayout();
mount(document.getElementById('app'), emptyState('Страница не найдена', 'Такой страницы нет или она была перемещена.',
  h('div', { class: 'row' }, h('a', { class: 'btn-primary btn-sm', href: '/' }, 'На главную'), h('a', { class: 'btn-outline btn-sm', href: '/vacancies' }, 'Каталог вакансий'))));
