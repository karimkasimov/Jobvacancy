// Небольшой набор UI-хелперов. Весь динамический текст вставляется через textContent (без innerHTML) — защита от XSS.
const SAFE_URL = /^(\/|#|mailto:|tel:|https?:\/\/)/i;
let uidCounter = 0;
export const uid = (p = 'id') => `${p}-${(uidCounter += 1)}`;

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' || k === 'innerHTML' || k === 'outerHTML') throw new Error(`Атрибут ${k} запрещён`);
    else if (['value', 'checked', 'selected', 'disabled', 'hidden'].includes(k)) el[k] = v;
    else if (k === 'href' || k === 'src' || k === 'action') {
      if (!SAFE_URL.test(String(v))) throw new Error('Небезопасная ссылка');
      el.setAttribute(k, v);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- форматирование ----------
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
export const fmtNumber = (n) => new Intl.NumberFormat('ru-RU').format(n ?? 0);
export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const initials = (name) => String(name || '?').replace(/[«»"()]/g, ' ').split(/\s+/).filter(Boolean).filter((w) => !/^(ооо|ао|зао|пао|гбпоу|гбу|ип)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '•';

// ---------- уведомления (тосты) ----------
function toastBox() {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', role: 'status' });
    document.body.append(box);
  }
  return box;
}
export function toast(message, type = 'info', ms = 4200) {
  const t = h('div', { class: `toast ${type === 'error' ? 'is-error' : type === 'ok' ? 'is-ok' : ''}` }, message);
  toastBox().append(t);
  setTimeout(() => t.remove(), type === 'error' ? ms + 2500 : ms);
}

// ---------- состояния ----------
export const loadingBlock = (text = 'Загрузка…') => h('div', { class: 'loading-box', role: 'status' }, h('div', { class: 'spinner' }), text);
export function emptyState(title, text, action) {
  return h('div', { class: 'state-box' }, h('h3', {}, title), text ? h('p', {}, text) : null, action || null);
}
export function errorState(message, retry) {
  return h('div', { class: 'state-box is-error', role: 'alert' },
    h('h3', {}, 'Не удалось загрузить данные'), h('p', {}, message),
    retry ? h('button', { type: 'button', class: 'btn-outline btn-sm', onclick: retry }, 'Повторить') : null);
}
export const skeletons = (n = 4) => Array.from({ length: n }, () => h('div', { class: 'skeleton' }));

/** Загружает данные в контейнер с индикатором, обработкой ошибки и кнопкой «Повторить». */
export async function load(container, fn, { skeleton } = {}) {
  mount(container, skeleton || loadingBlock());
  try {
    const node = await fn();
    mount(container, node);
  } catch (err) {
    mount(container, errorState(err.message, () => load(container, fn, { skeleton })));
  }
}

/** Текст с пустыми строками → абзацы <p>. */
export const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).map((t) => h('p', {}, t));

// ---------- кнопки ----------
export async function withLoading(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); } }
}

// ---------- формы ----------
/**
 * Поле формы. Возвращает { el, input, name, value(), set(v), setError(msg) }.
 */
export function field({ label, name, type = 'text', value = '', required = false, placeholder, hint, options, textarea, rows = 4, autocomplete, maxlength, min, max, accept, disabled, full, inputmode, checkboxLabel }) {
  const id = uid('f');
  const errId = `${id}-err`;
  let input;
  if (type === 'checkbox') {
    input = h('input', { type: 'checkbox', id, name, checked: !!value, disabled, 'aria-describedby': errId });
  } else if (options) {
    input = h('select', { id, name, class: 'select-control', disabled, 'aria-describedby': errId },
      options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  } else if (textarea) {
    input = h('textarea', { id, name, class: 'textarea-control', rows, maxlength, placeholder, disabled, 'aria-describedby': errId });
    input.value = value ?? '';
  } else {
    input = h('input', { id, name, type, class: 'input-control', value: value ?? '', placeholder, autocomplete, maxlength, min, max, accept, disabled, inputmode, 'aria-describedby': errId });
  }
  if (required) input.setAttribute('aria-required', 'true');
  const err = h('div', { class: 'field-error', id: errId, role: 'alert' });
  const el = type === 'checkbox'
    ? h('div', { class: `field${full ? ' full' : ''}` }, h('label', { class: 'checkbox-row', for: id }, input, h('span', {}, checkboxLabel || label)), err)
    : h('div', { class: `field${full ? ' full' : ''}` },
      label ? h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null) : null,
      input, hint ? h('div', { class: 'field-hint' }, hint) : null, err);
  const api = {
    el, input, name,
    value: () => (type === 'checkbox' ? input.checked : type === 'number' ? input.value.trim() : input.value),
    set(v) { if (type === 'checkbox') input.checked = !!v; else input.value = v ?? ''; },
    setError(msg) {
      err.textContent = msg || '';
      el.classList.toggle('has-error', !!msg);
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    },
  };
  input.addEventListener('input', () => api.setError(''));
  return api;
}

export const values = (fields) => Object.fromEntries(fields.map((f) => [f.name, f.value()]));

/** Показывает ошибки валидации сервера у полей; возвращает true, если было что показать. */
export function showFieldErrors(fields, errors) {
  let first = true;
  for (const f of fields) {
    const msg = errors && errors[f.name];
    f.setError(msg || '');
    if (msg && first) { f.input.focus(); first = false; }
  }
  return !first;
}

export function handleFormError(err, fields) {
  if (err.fields && showFieldErrors(fields, err.fields)) toast('Проверьте выделенные поля.', 'error');
  else toast(err.message, 'error');
}

/** Пустую строку превращает в null, число — в Number (для необязательных числовых полей). */
export const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
export const textOrNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);

// ---------- модальное окно ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const previous = document.activeElement;
  const titleId = uid('m');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = $$('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)', dialog).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const dialog = h('div', { class: `modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title), h('button', { type: 'button', class: 'modal-close', 'aria-label': 'Закрыть', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  const firstInput = $('input:not([type=hidden]), select, textarea', dialog);
  (firstInput || $('.modal-close', dialog)).focus();
  return { close, el: dialog };
}

export function confirmDialog({ title, message, confirmText = 'Подтвердить', danger = false, cancelText = 'Отмена' }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = modal({
      title,
      body: h('p', { class: 'pre-line' }, message),
      onClose: () => done(false),
      actions: [
        h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, cancelText),
        h('button', { type: 'button', class: danger ? 'btn-danger' : 'btn-primary', onclick: () => { done(true); m.close(); } }, confirmText),
      ],
    });
  });
}

/** Диалог с вводом причины/комментария. Возвращает строку или null при отмене. */
export function promptDialog({ title, label, required = true, confirmText = 'Отправить', danger = false, hint }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const f = field({ label, name: 'note', textarea: true, rows: 4, required, hint, maxlength: 500 });
    const m = modal({
      title, body: f.el, onClose: () => done(null),
      actions: [
        h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'),
        h('button', { type: 'button', class: danger ? 'btn-danger' : 'btn-primary', onclick: () => {
          const v = f.value().trim();
          if (required && v.length < 3) { f.setError('Укажите не менее 3 символов.'); return; }
          done(v || null); m.close();
        } }, confirmText),
      ],
    });
  });
}

// ---------- пагинация ----------
export function pager({ page, pages }, onPage) {
  if (pages <= 1) return h('div');
  const nums = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return h('nav', { class: 'pager', 'aria-label': 'Страницы' },
    h('button', { type: 'button', disabled: page <= 1, onclick: () => onPage(page - 1) }, '← Назад'),
    nums.map((n) => (n === '…' ? h('span', { class: 'gap' }, '…')
      : h('button', { type: 'button', class: n === page ? 'is-current' : '', 'aria-current': n === page ? 'page' : null, onclick: () => onPage(n) }, String(n)))),
    h('button', { type: 'button', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Вперёд →'));
}

// ---------- вкладки (кабинеты) ----------
export function createTabs(container, tabs, { fallback } = {}) {
  const bar = h('div', { class: 'cabinet-top-tabs', role: 'tablist' });
  const panel = h('div', { class: 'dash-panel', role: 'tabpanel' });
  const buttons = new Map();
  const badges = new Map();
  let current = null;

  async function show(id, { updateHash = true } = {}) {
    const tab = tabs.find((t) => t.id === id) || tabs.find((t) => t.id === fallback) || tabs[0];
    current = tab.id;
    for (const [tid, b] of buttons) {
      b.classList.toggle('is-active', tid === tab.id);
      b.setAttribute('aria-selected', String(tid === tab.id));
    }
    if (updateHash && location.hash !== `#${tab.id}`) history.replaceState(null, '', `#${tab.id}`);
    panel.setAttribute('aria-labelledby', `tab-${tab.id}`);
    await load(panel, () => tab.render());
  }
  for (const t of tabs) {
    const badge = h('span', { class: 'count-pill hidden' });
    badges.set(t.id, badge);
    const b = h('button', { type: 'button', role: 'tab', id: `tab-${t.id}`, class: 'cabinet-top-tab-btn', onclick: () => show(t.id) }, t.label, badge);
    buttons.set(t.id, b);
    bar.append(b);
  }
  mount(container, bar, panel);
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== current) show(id, { updateHash: false }); });
  show(location.hash.slice(1), { updateHash: false });
  return {
    show,
    reload: () => show(current, { updateHash: false }),
    setBadge(id, n) {
      const b = badges.get(id);
      if (!b) return;
      b.textContent = String(n);
      b.classList.toggle('hidden', !n);
    },
  };
}

// ---------- прочее ----------
export function debounce(fn, ms = 350) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function table(headers, rows, { empty = 'Нет данных' } = {}) {
  if (!rows.length) return emptyState(empty);
  return h('div', { class: 'table-responsive' }, h('table', { class: 'data-table' },
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.endsWith('!') ? 'actions' : '' }, x.replace(/!$/, ''))))),
    h('tbody', {}, rows)));
}

export function downloadLink(doc, label) {
  return h('a', { href: `/api/documents/${doc.id}/download`, class: 'btn-outline btn-sm', download: doc.name }, label || `Скачать: ${doc.name} (${fmtSize(doc.size)})`);
}
