// Клиент API. CSRF-токен и состояние сессии хранятся только в памяти страницы, в браузерном хранилище ничего не сохраняется.
let csrfToken = null;
let mePromise = null;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', fields } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request(method, url, { body, form, retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте подключение и повторите попытку.', { code: 'network' });
  }
  let data = null;
  if (res.status !== 204) {
    const type = res.headers.get('content-type') || '';
    data = type.includes('json') ? await res.json().catch(() => null) : null;
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (e.code === 'csrf' && !retried) {
      await loadMe(true);
      return request(method, url, { body, form, retried: true });
    }
    throw new ApiError(e.message || 'Не удалось выполнить действие. Попробуйте позже.', { status: res.status, code: e.code || 'error', fields: e.fields });
  }
  if (data && data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, { body }),
  put: (url, body = {}) => request('PUT', url, { body }),
  patch: (url, body = {}) => request('PATCH', url, { body }),
  del: (url, body) => request('DELETE', url, { body }),
  upload(url, file, fields = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file);
    return request('POST', url, { form });
  },
};

/** Текущий пользователь (null, если не вошёл). Кешируется на время жизни страницы. */
export function loadMe(force = false) {
  if (!mePromise || force) {
    mePromise = request('GET', '/api/auth/me').then((d) => d.user).catch(() => null);
  }
  return mePromise;
}

export function setCurrentUser(data) {
  if (data && data.csrfToken) csrfToken = data.csrfToken;
  mePromise = Promise.resolve(data ? data.user : null);
}

export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* сессия уже недействительна */ }
  csrfToken = null;
  mePromise = Promise.resolve(null);
}

let metaPromise = null;
export const loadMeta = () => (metaPromise ||= api.get('/api/meta'));
