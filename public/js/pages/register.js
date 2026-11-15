import { api, setCurrentUser } from '../api.js';
import { initLayout, redirectIfSignedIn, afterLoginTarget } from '../layout.js';
import { h, mount, field, values, withLoading, handleFormError, textOrNull } from '../ui.js';

const { user } = await initLayout();
if (!redirectIfSignedIn(user)) {
  const params = new URLSearchParams(location.search);
  let role = params.get('role') === 'employer' ? 'employer' : 'candidate';

  const common = [
    field({ label: 'ФИО', name: 'fullName', required: true, autocomplete: 'name', maxlength: 120, hint: 'Фамилия Имя Отчество' }),
    field({ label: 'Email', name: 'email', type: 'email', required: true, autocomplete: 'email', maxlength: 254 }),
    field({ label: 'Телефон', name: 'phone', type: 'tel', autocomplete: 'tel', placeholder: '+7 (900) 000-00-00', maxlength: 25 }),
    field({ label: 'Пароль', name: 'password', type: 'password', required: true, autocomplete: 'new-password', maxlength: 200, hint: 'Не менее 8 символов, буквы и цифры.' }),
  ];
  const candidateOnly = [field({ label: 'Ваш статус', name: 'candidateType', value: 'applicant', full: true,
    options: [{ value: 'applicant', label: 'Соискатель' }, { value: 'student', label: 'Студент ГГКИТ' }, { value: 'graduate', label: 'Выпускник ГГКИТ' }],
    hint: 'Статус студента или выпускника станет подтверждённым только после проверки администратором — подайте заявку в личном кабинете.' })];
  const employerOnly = [
    field({ label: 'Название организации', name: 'organizationName', required: true, maxlength: 200, full: true }),
    field({ label: 'Город', name: 'city', required: true, maxlength: 80, value: 'Грозный' }),
    field({ label: 'Ваша должность', name: 'positionTitle', maxlength: 120 }),
  ];
  const consent = field({ name: 'consent', type: 'checkbox', label: 'consent', checkboxLabel: 'Я даю согласие на обработку моих персональных данных для работы кадрового портала ГГКИТ.' });

  const cardsBox = h('div', { class: 'radio-cards' });
  const extraBox = h('div', { class: 'form-grid' });
  const btn = h('button', { type: 'submit', class: 'btn-primary btn-block' }, 'Зарегистрироваться');
  const alertBox = h('div');

  const roleCard = (value, title, text) => {
    const input = h('input', { type: 'radio', name: 'role', value, checked: role === value, onchange: () => { role = value; renderExtra(); } });
    return h('label', { class: 'radio-card' }, input, h('div', {}, h('strong', {}, title), h('span', {}, text)));
  };
  mount(cardsBox, roleCard('candidate', 'Я ищу работу', 'Студент, выпускник или другой соискатель'), roleCard('employer', 'Я работодатель', 'Размещение вакансий от организации'));

  function renderExtra() { mount(extraBox, (role === 'employer' ? employerOnly : candidateOnly).map((f) => f.el)); }
  renderExtra();

  mount(document.getElementById('app'), h('div', { class: 'page-medium' },
    h('h1', { class: 'title-h1' }, 'Регистрация'),
    h('p', { class: 'subtitle mb-24' }, 'Создайте аккаунт, чтобы откликаться на вакансии или размещать их от имени организации.'),
    h('form', { class: 'cabinet-panel-card stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      mount(alertBox);
      const all = [...common, ...(role === 'employer' ? employerOnly : candidateOnly), consent];
      const v = values(all);
      await withLoading(btn, async () => {
        try {
          const body = { role, ...v, phone: textOrNull(v.phone), positionTitle: textOrNull(v.positionTitle) };
          const data = await api.post('/api/auth/register', body);
          setCurrentUser(data);
          location.href = afterLoginTarget(data.user);
        } catch (err) {
          handleFormError(err, all);
          if (!err.fields) mount(alertBox, h('div', { class: 'alert alert-error', role: 'alert' }, err.message));
        }
      });
    } }, alertBox, cardsBox, h('div', { class: 'form-grid' }, common.map((f) => f.el)), extraBox, consent.el, btn,
    h('p', { class: 'small muted center' }, 'Уже есть аккаунт? ', h('a', { href: '/login' }, 'Войти')))));
}
