import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, field, values, withLoading, handleFormError } from '../ui.js';

await initLayout();
const token = new URLSearchParams(location.search).get('token');
const app = document.getElementById('app');

if (!token) {
  mount(app, h('div', { class: 'page-narrow' }, h('div', { class: 'alert alert-error' }, 'В ссылке нет токена сброса пароля. Запросите новую ссылку.'), h('p', { class: 'mt-16' }, h('a', { class: 'btn-primary', href: '/forgot-password' }, 'Запросить ссылку'))));
} else {
  const fields = [
    field({ label: 'Новый пароль', name: 'newPassword', type: 'password', required: true, autocomplete: 'new-password', maxlength: 200, hint: 'Не менее 8 символов, буквы и цифры.' }),
    field({ label: 'Повторите пароль', name: 'repeat', type: 'password', required: true, autocomplete: 'new-password', maxlength: 200 }),
  ];
  const alertBox = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'btn-primary btn-block' }, 'Сохранить пароль');
  mount(app, h('div', { class: 'page-narrow' }, h('h1', { class: 'title-h1' }, 'Новый пароль'),
    h('form', { class: 'cabinet-panel-card stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      mount(alertBox);
      const v = values(fields);
      if (v.newPassword !== v.repeat) { fields[1].setError('Пароли не совпадают.'); return; }
      await withLoading(btn, async () => {
        try {
          await api.post('/api/auth/reset', { token, newPassword: v.newPassword });
          mount(app, h('div', { class: 'page-narrow' }, h('div', { class: 'alert alert-ok' }, 'Пароль изменён. Теперь можно войти с новым паролем.'), h('p', { class: 'mt-16' }, h('a', { class: 'btn-primary', href: '/login' }, 'Войти'))));
        } catch (err) {
          if (err.fields) handleFormError(err, fields); else mount(alertBox, h('div', { class: 'alert alert-error', role: 'alert' }, err.message));
        }
      });
    } }, alertBox, fields.map((f) => f.el), btn)));
}
