import { api, setCurrentUser } from '../api.js';
import { initLayout, redirectIfSignedIn, afterLoginTarget } from '../layout.js';
import { h, mount, field, values, withLoading, handleFormError } from '../ui.js';

const { user } = await initLayout();
if (!redirectIfSignedIn(user)) {
  const fields = [
    field({ label: 'Email', name: 'email', type: 'email', required: true, autocomplete: 'username', maxlength: 254 }),
    field({ label: 'Пароль', name: 'password', type: 'password', required: true, autocomplete: 'current-password', maxlength: 200 }),
  ];
  const alertBox = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'btn-primary btn-block' }, 'Войти');
  const next = new URLSearchParams(location.search).get('next');
  mount(document.getElementById('app'), h('div', { class: 'page-narrow' },
    h('h1', { class: 'title-h1' }, 'Вход в личный кабинет'),
    h('p', { class: 'subtitle mb-24' }, 'Для соискателей, работодателей и администраторов портала.'),
    h('form', { class: 'cabinet-panel-card stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      mount(alertBox);
      await withLoading(btn, async () => {
        try {
          const data = await api.post('/api/auth/login', values(fields));
          setCurrentUser(data);
          location.href = afterLoginTarget(data.user);
        } catch (err) {
          if (err.fields) handleFormError(err, fields);
          else mount(alertBox, h('div', { class: 'alert alert-error', role: 'alert' }, err.message));
        }
      });
    } }, alertBox, fields.map((f) => f.el), btn,
    h('div', { class: 'row-between small' }, h('a', { href: '/forgot-password' }, 'Забыли пароль?'), h('a', { href: `/register${next ? `?next=${encodeURIComponent(next)}` : ''}` }, 'Создать аккаунт')))));
}
