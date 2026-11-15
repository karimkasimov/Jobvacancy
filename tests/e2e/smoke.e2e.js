'use strict';
/**
 * Сквозной тест интерфейса в реальном браузере (необязательный, запускается отдельно):
 *   npm i --no-save playwright && npx playwright install chromium
 *   node tests/e2e/smoke.e2e.js
 * Проверяет основные сценарии всех ролей, ошибки консоли, нарушения CSP, битые запросы и горизонтальную прокрутку на телефоне.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch { console.error('Playwright не установлен: npm i --no-save playwright'); process.exit(2); }

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'ggkit-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggkit-e2e-'));
const env = { ...process.env, DATABASE_PATH: path.join(dir, 'e2e.sqlite'), UPLOAD_DIR: path.join(dir, 'uploads'), SEED_PASSWORD: 'Demo12345', SCRYPT_COST: '4096' };
execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'server/seed.js')], { cwd: ROOT, env, stdio: 'ignore' });

const { createApp } = require('../../server/app');
const BIG = { limit: 1e6, windowMs: 60000 };
const app = createApp({ databasePath: env.DATABASE_PATH, uploadDir: env.UPLOAD_DIR, scrypt: { N: 4096 }, rateLimits: { api: BIG, login: BIG, register: BIG, forgot: BIG, upload: BIG, verification: BIG } });

const problems = [];
let step = 0;
const log = (m) => console.log(`  ✓ ${++step}. ${m}`);

(async () => {
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const newCtx = async (viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport, locale: 'ru-RU' });
    ctx.on('page', (p) => watch(p));
    return ctx;
  };
  const watch = (page) => {
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/status of (404|422)/.test(m.text())) problems.push(`[console.${m.type()}] ${page.url()} :: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[pageerror] ${page.url()} :: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 500) problems.push(`[http ${r.status()}] ${r.url()}`); });
  };
  const login = async (ctx, email) => {
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль').fill('Demo12345');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    return page;
  };
  const noOverflow = async (page, label) => {
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 1, `${label}: горизонтальная прокрутка ${o}px`);
  };

  // ---------------------------------------------------------------- публичные страницы
  const visitor = await newCtx();
  const page = await visitor.newPage();
  await page.goto(base);
  await page.waitForSelector('.vacancy-card');
  assert.ok((await page.locator('.stat-card .num').allInnerTexts()).every((t) => /^\d/.test(t)));
  assert.equal(await page.locator('.stat-card .num').first().innerText(), '6');
  assert.ok(await page.locator('.vacancy-card').count() >= 6);
  assert.ok(await page.locator('.partner-card').count() >= 6);
  await page.screenshot({ path: path.join(SHOTS, 'home-desktop.png'), fullPage: true });
  log('главная: статистика из БД (6 вакансий), свежие вакансии, партнёры');

  await page.goto(`${base}/vacancies`);
  await page.waitForSelector('.vacancy-card');
  assert.equal(await page.locator('.vacancy-card').count(), 6);
  await page.getByLabel('Город', { exact: true }).fill('Грозный');
  await page.getByLabel('Зарплата от, ₽').fill('65000');
  await page.getByRole('button', { name: 'Показать' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.vacancy-card').length === 2 || document.querySelector('.state-box'));
  const titles = await page.locator('.vacancy-card h3').allInnerTexts();
  assert.ok(titles.length >= 1 && titles.every((t) => t.length > 3), JSON.stringify(titles));
  assert.match(page.url(), /city=/);
  assert.match(page.url(), /salaryFrom=65000/);
  await page.getByRole('button', { name: 'Таблица' }).click();
  await page.waitForSelector('table.data-table');
  await page.screenshot({ path: path.join(SHOTS, 'catalog-table.png') });
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await page.waitForFunction(() => document.querySelectorAll('table.data-table tbody tr').length === 6);
  log('каталог: совместные фильтры (город + зарплата), синхронизация с URL, вид «Таблица», сброс');

  await page.goto(`${base}/vacancies?q=${encodeURIComponent('БУХГАЛТЕР')}`);
  await page.waitForSelector('.vacancy-card');
  assert.equal(await page.locator('.vacancy-card').count(), 1);
  await page.locator('.vacancy-card h3 a').click();
  await page.waitForURL(/\/vacancies\/\d+$/);
  await page.waitForSelector('.detail-title');
  assert.match(await page.locator('.detail-title').innerText(), /Бухгалтер/);
  assert.ok(await page.getByText('Обязанности').count());
  assert.ok(await page.getByRole('link', { name: 'Войти и откликнуться' }).count());
  const detailUrl = page.url();
  await page.goto(detailUrl); // прямой доступ по уникальному URL
  await page.waitForSelector('.detail-title');
  await page.screenshot({ path: path.join(SHOTS, 'vacancy-desktop.png'), fullPage: true });
  log('карточка вакансии: уникальный URL, прямой заход, разделы, кнопка входа для гостя');

  await page.goto(`${base}/vacancies/9999`);
  await page.waitForSelector('.state-box');
  assert.match(await page.locator('.state-box').innerText(), /не найдена/);
  log('несуществующая вакансия — аккуратное состояние «не найдена»');

  await page.goto(`${base}/partners`);
  await page.waitForSelector('.partner-card');
  assert.equal(await page.locator('.partner-card').count(), 7);
  await page.getByLabel('Название или описание').fill('телеком');
  await page.locator('.filters-card').getByRole('button', { name: 'Найти' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.partner-card').length === 1);
  await page.locator('.partner-card h3 a').click();
  await page.waitForURL(/\/partners\/\d+$/);
  await page.waitForSelector('.detail-title');
  log('партнёры: каталог 7 организаций, поиск, страница организации');

  await page.goto(`${base}/cabinet`);
  await page.waitForURL(/\/login\?next=/);
  await page.goto(`${base}/admin`);
  await page.waitForURL(/\/login/);
  log('кабинеты без входа перенаправляют на /login');

  // ---------------------------------------------------------------- регистрация и отклик
  const candCtx = await newCtx();
  const cp = await candCtx.newPage();
  await cp.goto(`${base}/register`);
  await cp.getByLabel('ФИО').fill('Тестовый Кандидат Иванович');
  await cp.getByLabel('Email').fill('e2e.candidate@test.example');
  await cp.getByLabel('Пароль').fill('Secret12345');
  await cp.getByLabel('Я даю согласие').check();
  await cp.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await cp.waitForURL(/\/cabinet/);
  await cp.waitForSelector('.cabinet-panel-card');
  log('регистрация соискателя через форму → личный кабинет');

  await cp.getByRole('tab', { name: 'Резюме' }).click();
  await cp.getByRole('button', { name: 'Создать резюме' }).click();
  await cp.getByLabel('Название резюме').fill('Программист-стажёр');
  await cp.getByLabel('Желаемая должность').fill('Младший программист');
  await cp.getByLabel('Навыки').fill('JavaScript, SQL');
  await cp.locator('button[form="resume-form"]').click();
  await cp.waitForSelector('.item-card h3:has-text("Программист-стажёр")');
  log('кабинет: создание резюме через модальное окно');

  await cp.goto(`${base}/vacancies?q=${encodeURIComponent('программист')}`);
  await cp.waitForSelector('.vacancy-card');
  await cp.locator('.vacancy-card h3 a').first().click();
  await cp.waitForSelector('.detail-title');
  await cp.getByRole('button', { name: 'Откликнуться' }).click();
  await cp.getByLabel('Сопроводительное письмо').fill('Хочу работать у вас, готов к собеседованию.');
  await cp.getByRole('button', { name: 'Отправить отклик' }).click();
  await cp.waitForSelector('.apply-status .badge:has-text("Отправлен")');
  await cp.reload();
  await cp.waitForSelector('.apply-status .badge:has-text("Отправлен")');
  await cp.goto(`${base}/cabinet#applications`);
  await cp.waitForSelector('.item-card .badge:has-text("Отправлен")');
  log('отклик на вакансию: статус «Отправлен» в карточке и в истории откликов');

  await cp.screenshot({ path: path.join(SHOTS, 'cabinet-desktop.png'), fullPage: true });

  // ---------------------------------------------------------------- работодатель
  const empCtx = await newCtx();
  // у demo.employer2 — вакансия «Младший программист 1С» (ИТ-Партнёр Грозный)
  const ep = await login(empCtx, 'demo.employer2@ggkit.example');
  await ep.waitForURL(/\/employer/);
  await ep.getByRole('tab', { name: /Отклики/ }).click();
  await ep.waitForSelector('table.data-table');
  await ep.getByRole('button', { name: 'Открыть' }).first().click();
  await ep.waitForSelector('.modal .title-h3:has-text("Тестовый Кандидат")');
  assert.ok(await ep.locator('.modal').getByText('Хочу работать у вас').count());
  await ep.getByLabel('Статус отклика').selectOption('interview');
  await ep.getByRole('button', { name: 'Сохранить статус' }).click();
  await ep.waitForSelector('.modal .badge:has-text("Приглашение на собеседование")');
  await ep.getByLabel('Новый комментарий').fill('Позвонить завтра в 10:00');
  await ep.getByRole('button', { name: 'Добавить комментарий' }).click();
  await ep.waitForSelector('.comment:has-text("Позвонить завтра")');
  await ep.keyboard.press('Escape');
  log('работодатель: просмотр отклика, смена статуса, внутренний комментарий (Esc закрывает окно)');

  await cp.reload();
  await cp.waitForSelector('.item-card .badge:has-text("Приглашение на собеседование")');
  await cp.getByRole('tab', { name: /Уведомления/ }).click();
  await cp.waitForSelector('.item-card:has-text("Приглашение на собеседование")');
  assert.equal(await cp.locator('text=Позвонить завтра').count(), 0);
  log('кандидат видит новый статус и уведомление, но не внутренний комментарий');

  // создание вакансии работодателем → модерация администратором
  await ep.goto(`${base}/employer#vacancies`);
  await ep.getByRole('button', { name: 'Создать вакансию' }).click();
  await ep.getByLabel('Название должности').fill('E2E Тестировщик');
  await ep.getByLabel('Описание вакансии').fill('Тестирование веб-приложений и автоматизация проверок качества.');
  await ep.getByLabel('Телефон для связи').fill('+7 928 111-22-33');
  await ep.getByRole('button', { name: 'Отправить на модерацию' }).click();
  await ep.waitForSelector('tr:has-text("E2E Тестировщик") .badge:has-text("На модерации")');
  await ep.getByRole('button', { name: 'Создать вакансию' }).click();
  await ep.getByRole('button', { name: 'Отправить на модерацию' }).click();
  await ep.waitForSelector('.field-error:not(:empty)');
  assert.ok(await ep.locator('.field.has-error').count() >= 2);
  await ep.keyboard.press('Escape');
  await ep.screenshot({ path: path.join(SHOTS, 'employer-desktop.png'), fullPage: true });
  log('работодатель: вакансия уходит на модерацию, пустая форма показывает ошибки у полей');

  // ---------------------------------------------------------------- администратор
  const admCtx = await newCtx();
  const ap = await login(admCtx, 'admin@ggkit.example');
  await ap.waitForURL(/\/admin/);
  await ap.waitForSelector('.metrics');
  await ap.getByRole('tab', { name: /Вакансии/ }).click();
  await ap.waitForSelector('tr:has-text("E2E Тестировщик")');
  await ap.locator('tr:has-text("E2E Тестировщик")').getByRole('button', { name: 'Одобрить' }).click();
  await ap.waitForSelector('.toast:has-text("опубликована")');
  await page.goto(`${base}/vacancies?q=${encodeURIComponent('E2E')}`);
  await page.waitForSelector('.vacancy-card');
  log('администратор одобряет вакансию — она сразу видна в публичном каталоге');

  // проверка студента
  const stCtx = await newCtx();
  const sp = await login(stCtx, 'demo.student@ggkit.example');
  await sp.goto(`${base}/cabinet#status`);
  await sp.getByLabel('Номер студенческого').fill('test-stu-001');
  await sp.getByRole('button', { name: 'Отправить на проверку' }).click();
  await sp.waitForSelector('.alert:has-text("Заявка на проверке")');
  assert.equal(await sp.locator('text=Совпадает').count(), 0);
  await ap.goto(`${base}/admin#students`);
  await ap.waitForSelector('tr:has-text("TEST-STU-001")');
  assert.ok(await ap.locator('tr:has-text("TEST-STU-001")').getByText('Совпадает с реестром').count());
  await ap.locator('tr:has-text("TEST-STU-001")').getByRole('button', { name: 'Подтвердить' }).first().click();
  await ap.locator('.modal').getByRole('button', { name: 'Подтвердить' }).click();
  await ap.locator('.modal').getByRole('button', { name: 'Подтвердить' }).click().catch(() => {});
  await ap.waitForSelector('.toast:has-text("Статус подтверждён")');
  await sp.reload();
  await sp.waitForSelector('.alert-ok:has-text("статус подтверждён")');
  log('студент: заявка → сверка в админке (результат скрыт от кандидата) → подтверждение → статус в кабинете');

  for (const tab of ['Пользователи', 'Организации', 'Отклики', 'Журнал', 'Контент']) {
    await ap.getByRole('tab', { name: tab }).click();
    await ap.waitForSelector('.dash-panel .cabinet-panel-card');
    assert.equal(await ap.locator('.state-box.is-error').count(), 0, `вкладка ${tab} вернула ошибку`);
  }
  await ap.getByRole('tab', { name: 'Журнал' }).click();
  await ap.waitForSelector('tr:has-text("Вакансия одобрена")');
  await ap.screenshot({ path: path.join(SHOTS, 'admin-logs.png'), fullPage: true });
  log('админка: все разделы открываются без ошибок, действия записаны в журнал');

  // ---------------------------------------------------------------- адаптивность
  const mobCtx = await newCtx({ width: 375, height: 800 });
  const mp = await mobCtx.newPage();
  for (const [url, wait] of [['/', '.vacancy-card'], ['/vacancies', '.vacancy-card'], ['/vacancies/1', '.detail-title'], ['/partners', '.partner-card'], ['/login', 'form'], ['/register', 'form']]) {
    await mp.goto(base + url);
    await mp.waitForSelector(wait);
    await noOverflow(mp, `мобильная ${url}`);
  }
  await mp.screenshot({ path: path.join(SHOTS, 'vacancies-mobile.png'), fullPage: true });
  const mc = await login(mobCtx, 'demo.employer1@ggkit.example');
  await mc.waitForSelector('.metrics');
  await noOverflow(mc, 'мобильный кабинет работодателя');
  const tabletCtx = await newCtx({ width: 820, height: 1000 });
  const tp = await tabletCtx.newPage();
  await tp.goto(`${base}/vacancies`);
  await tp.waitForSelector('.vacancy-card');
  await noOverflow(tp, 'планшет /vacancies');
  log('адаптивность: на 375 и 820 px нет горизонтальной прокрутки');

  // ---------------------------------------------------------------- выход
  await cp.goto(base);
  await cp.getByRole('button', { name: 'Выйти' }).click();
  await cp.waitForURL(base + '/');
  await cp.goto(`${base}/cabinet`);
  await cp.waitForURL(/\/login/);
  log('выход завершает сессию');

  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (problems.length) {
    console.error(`\nНайдены проблемы в браузере (${problems.length}):`);
    for (const p of [...new Set(problems)]) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`\nE2E: все сценарии пройдены, ошибок консоли и CSP-нарушений нет. Скриншоты: ${SHOTS}`);
})().catch(async (err) => {
  console.error('\nE2E провален:', err.message);
  if (problems.length) console.error('Проблемы браузера:\n  - ' + [...new Set(problems)].join('\n  - '));
  try { await app.close(); } catch { /* уже закрыт */ }
  process.exit(1);
});
