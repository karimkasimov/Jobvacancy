import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, field, values, withLoading, handleFormError } from '../ui.js';

await initLayout();
const email = field({ label: 'Email, указанный при регистрации', name: 'email', type: 'email', required: true, autocomplete: 'email', maxlength: 254 });
const result = h('div', { 'aria-live': 'polite' });
const btn = h('button', { type: 'submit', class: 'btn-primary btn-block' }, 'Отправить ссылку для сброса');

const MESSAGES = {
  sent: ['alert-ok', 'Если аккаунт с таким email существует, на него отправлено письмо со ссылкой для создания нового пароля. Ссылка действует 1 час.'],
  console: ['alert-info', 'Включён режим разработки: письмо не отправляется, а выводится в консоль сервера. Ссылку для сброса можно взять оттуда.'],
  not_configured: ['alert-warn', 'Автоматическая отправка писем на портале пока не настроена, поэтому ссылка для сброса не отправлена. Обратитесь к администратору ГГКИТ — он выдаст временный пароль.'],
};

mount(document.getElementById('app'), h('div', { class: 'page-narrow' },
  h('h1', { class: 'title-h1' }, 'Восстановление пароля'),
  h('p', { class: 'subtitle mb-24' }, 'Укажите email — мы отправим ссылку для создания нового пароля.'),
  h('form', { class: 'cabinet-panel-card stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    mount(result);
    await withLoading(btn, async () => {
      try {
        const r = await api.post('/api/auth/forgot', values([email]));
        const [cls, text] = MESSAGES[r.mail] || MESSAGES.not_configured;
        mount(result, h('div', { class: `alert ${cls}`, role: 'status' }, text));
      } catch (err) { handleFormError(err, [email]); }
    });
  } }, result, email.el, btn, h('p', { class: 'small center' }, h('a', { href: '/login' }, '← Вернуться ко входу')))));
