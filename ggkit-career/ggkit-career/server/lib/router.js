'use strict';

/** Небольшой роутер: шаблоны вида /api/vacancies/:id, цепочка middleware → обработчик. */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, ...handlers) {
    let options = {};
    if (handlers.length && typeof handlers[0] !== 'function') options = handlers.shift();
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}/?$`), names, options, handlers });
  }

  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }

  /** @returns {{route, params}|{methodNotAllowed:true}|null} */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((n, i) => {
        try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; }
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router };
