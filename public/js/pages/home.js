import { api, loadMeta } from '../api.js';
import { initLayout } from '../layout.js';
import { h, mount, load, fmtNumber, plural, loadingBlock, emptyState, skeletons, paragraphs } from '../ui.js';
import { vacancyCard, orgLogo, orgBadge } from '../components.js';

const { user, site } = await initLayout({ active: 'home' });
const app = document.getElementById('app');
const c = site ? site.content : {};

function heroSection(meta) {
  const q = h('input', { class: 'input-control', type: 'search', name: 'q', placeholder: 'Должность или организация', 'aria-label': 'Должность, организация или ключевое слово', maxlength: 100 });
  const city = h('input', { class: 'input-control', type: 'text', name: 'city', placeholder: 'Город', 'aria-label': 'Город', list: 'city-list', maxlength: 80 });
  const list = h('datalist', { id: 'city-list' }, (meta ? meta.cities : []).map((x) => h('option', { value: x })));
  const form = h('form', {
    class: 'hero-hub-search', role: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      const p = new URLSearchParams();
      if (q.value.trim()) p.set('q', q.value.trim());
      if (city.value.trim()) p.set('city', city.value.trim());
      location.href = `/vacancies${p.toString() ? `?${p}` : ''}`;
    },
  }, q, h('span', { class: 'divider' }), city, list, h('button', { type: 'submit', class: 'btn-primary' }, 'Найти вакансии'));
  return h('section', { class: 'hero-hub' },
    h('span', { class: 'badge-ggkit' }, 'ОФИЦИАЛЬНЫЙ КАДРОВЫЙ ПОРТАЛ'),
    h('h1', { class: 'title-h1 mt-16' }, c.hero_title),
    h('p', { class: 'subtitle' }, c.hero_subtitle),
    form,
    h('div', { class: 'hero-quick' }, (meta ? meta.categories : []).map((cat) => h('a', { class: 'chip-link', href: `/vacancies?category=${cat.slug}` }, cat.name))));
}

async function statsSection() {
  const s = await api.get('/api/stats');
  const students = s.verifiedStudents + s.verifiedGraduates;
  const cards = [
    [s.activeVacancies, plural(s.activeVacancies, ['активная вакансия', 'активные вакансии', 'активных вакансий'])],
    [s.verifiedOrganizations, plural(s.verifiedOrganizations, ['проверенная организация', 'проверенные организации', 'проверенных организаций'])],
    [s.candidates, plural(s.candidates, ['зарегистрированный соискатель', 'зарегистрированных соискателя', 'зарегистрированных соискателей'])],
    [students, plural(students, ['подтверждённый студент или выпускник', 'подтверждённых студента или выпускника', 'подтверждённых студентов и выпускников'])],
  ];
  return h('div', { class: 'stats-grid' }, cards.map(([n, label]) => h('div', { class: 'stat-card' }, h('div', { class: 'num' }, fmtNumber(n)), h('div', { class: 'label' }, label))));
}

async function featuredSection() {
  const data = await api.get('/api/vacancies?featured=1&pageSize=4');
  if (!data.items.length) return null;
  return h('section', { class: 'section' },
    h('div', { class: 'promo-vacancies-header' }, h('h2', { class: 'title-h2' }, 'Рекомендуемые вакансии'), h('a', { class: 'btn-outline btn-sm', href: '/vacancies' }, 'Все вакансии')),
    h('div', { class: 'hero-promo-grid' }, data.items.map((v) => h('a', { class: 'promo-vacancy-slot', href: `/vacancies/${v.id}` },
      h('div', { class: 'stack-sm' }, h('span', { class: 'tag-chip' }, v.category.name), h('h3', { class: 'title-h3' }, v.title), h('div', { class: 'text-meta' }, `${v.organization.name} · ${v.city}`)),
      h('div', { class: 'salary-value' }, v.salaryText)))));
}

async function latestSection() {
  const data = await api.get('/api/vacancies?pageSize=6&sort=date');
  return data.items.length
    ? h('div', { class: 'vacancies-cards-grid' }, data.items.map((v) => vacancyCard(v, { user })))
    : emptyState('Опубликованных вакансий пока нет', 'Работодатели могут разместить первую вакансию после регистрации — она появится на портале после проверки администратором.',
      h('a', { class: 'btn-primary btn-sm', href: '/register?role=employer' }, 'Разместить вакансию'));
}

async function partnersSection() {
  const data = await api.get('/api/organizations?pageSize=6');
  if (!data.items.length) return emptyState('Каталог партнёров пока пуст');
  return h('div', { class: 'partners-grid' }, data.items.map((o) => h('article', { class: 'partner-card' },
    h('div', { class: 'partner-head' }, orgLogo(o), h('div', {}, h('h3', { class: 'title-h3' }, h('a', { href: `/partners/${o.id}` }, o.name)), h('div', { class: 'text-meta' }, [o.city, o.industry].filter(Boolean).join(' · ')))),
    h('div', { class: 'row-between' }, orgBadge(o.verificationStatus), h('a', { class: 'btn-outline btn-sm', href: `/partners/${o.id}` }, `Вакансии: ${o.vacanciesCount}`)))));
}

const steps = [
  ['Регистрация', 'Создайте аккаунт соискателя или работодателя. Студентам и выпускникам ГГКИТ доступно подтверждение статуса.'],
  ['Профиль и резюме', 'Соискатель заполняет профиль и резюме, работодатель — карточку организации и запрашивает её проверку.'],
  ['Вакансии и отклики', 'Работодатель публикует вакансию после модерации, кандидат откликается одним нажатием с резюме и письмом.'],
  ['Ответ работодателя', 'Статусы откликов приходят в личный кабинет: просмотр, приглашение на собеседование, решение.'],
];
const studentAdv = ['Вакансии, стажировки и работа от партнёров колледжа в Чеченской Республике', 'Подтверждённый статус студента или выпускника ГГКИТ в профиле', 'История откликов и понятные статусы по каждой вакансии', 'Избранные вакансии и уведомления в личном кабинете'];
const employerAdv = ['Доступ к студентам и выпускникам профильных специальностей колледжа', 'Статус «проверенная организация» после подтверждения администратором', 'Управление вакансиями и откликами, комментарии к кандидатам', 'Статистика просмотров и откликов по каждой вакансии'];

const advCard = (title, items, cta) => h('div', { class: 'interest-column-card' }, h('h3', { class: 'title-h3' }, title),
  h('ul', { class: 'interest-list' }, items.map((t, i) => h('li', {}, h('span', { class: 'interest-bullet' }, String(i + 1)), h('span', { class: 'text-body' }, t)))), h('div', { class: 'mt-16' }, cta));

const meta = await loadMeta().catch(() => null);
const statsBox = h('div'); const featBox = h('div'); const latestBox = h('div'); const partnersBox = h('div');

mount(app,
  heroSection(meta),
  h('section', { class: 'section', 'aria-label': 'Статистика портала' }, statsBox),
  featBox,
  h('section', { class: 'section-tinted' }, h('div', { class: 'section' },
    h('div', { class: 'promo-vacancies-header' }, h('h2', { class: 'title-h2' }, 'Свежие вакансии'), h('a', { class: 'btn-outline btn-sm', href: '/vacancies' }, 'Перейти в каталог')), latestBox)),
  h('section', { class: 'section' },
    h('div', { class: 'promo-vacancies-header' }, h('h2', { class: 'title-h2' }, 'Организации-партнёры'), h('a', { class: 'btn-outline btn-sm', href: '/partners' }, 'Все партнёры')), partnersBox),
  h('section', { class: 'section' }, h('h2', { class: 'title-h2 mb-24' }, 'Как работает платформа'),
    h('div', { class: 'steps-grid' }, steps.map(([t, p]) => h('div', { class: 'step-card' }, h('h3', {}, t), h('p', {}, p))))),
  h('section', { class: 'section' }, h('div', { class: 'interests-grid' },
    advCard('Для студентов и выпускников', studentAdv, h('a', { class: 'btn-primary', href: '/register?role=candidate' }, 'Создать профиль соискателя')),
    advCard('Для работодателей', employerAdv, h('a', { class: 'btn-primary', href: '/register?role=employer' }, 'Зарегистрировать организацию')))),
  h('section', { class: 'section', id: 'about' }, h('div', { class: 'about-grid' },
    h('div', { class: 'about-text-card' }, h('h2', { class: 'title-h2' }, c.about_title), h('div', { class: 'paragraphs text-body' }, paragraphs(c.about_text))),
    h('div', { class: 'about-emblem-card' }, h('img', { src: '/assets/logo.png', alt: 'Эмблема ГГКИТ', class: 'about-emblem-img', width: 136, height: 136 }),
      h('div', { class: 'title-h3' }, 'ГГКИТ'), c.about_founded ? h('p', { class: 'text-meta' }, `Колледж основан в ${c.about_founded} году`) : null))),
  h('section', { class: 'section' }, h('div', { class: 'cta-band' },
    h('div', {}, h('h2', {}, 'Начните карьеру вместе с ГГКИТ'), h('p', {}, 'Зарегистрируйтесь, заполните резюме и откликайтесь на вакансии партнёров колледжа.')),
    h('div', { class: 'row' }, user ? h('a', { class: 'btn-outline', href: '/vacancies' }, 'Смотреть вакансии') : [h('a', { class: 'btn-outline', href: '/register' }, 'Зарегистрироваться'), h('a', { class: 'btn-outline', href: '/vacancies' }, 'Смотреть вакансии')]))));

load(statsBox, statsSection, { skeleton: h('div', { class: 'stats-grid' }, skeletons(4)) });
load(featBox, featuredSection, { skeleton: h('div') });
load(latestBox, latestSection, { skeleton: h('div', { class: 'vacancies-cards-grid' }, skeletons(2)) });
load(partnersBox, partnersSection, { skeleton: h('div', { class: 'partners-grid' }, skeletons(3)) });
if (location.hash === '#about') document.getElementById('about')?.scrollIntoView();
