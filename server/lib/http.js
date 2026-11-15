'use strict';
const { ApiError } = require('./errors');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(config) {
  const headers = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (config.cookieSecure) headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  return headers;
}

function getIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      // Берём адрес, добавленный ближайшим доверенным прокси (последний в цепочке).
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { out[name] = decodeURIComponent(value); } catch { /* пропускаем битое значение */ }
  }
  return out;
}

function serializeCookie(name, value, { maxAgeSeconds, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAgeSeconds !== undefined) c += `; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
  return c;
}

async function readBody(req, limitBytes) {
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > limitBytes) throw new ApiError(413, 'payload_too_large', 'Слишком большой объём данных.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new ApiError(413, 'payload_too_large', 'Слишком большой объём данных.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, { 'Content-Length': buffer.length, ...headers });
  res.end(buffer);
}

/** Кодирует имя файла для Content-Disposition (RFC 5987). */
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

module.exports = {
  securityHeaders, getIp, parseCookies, serializeCookie, readBody, sendJson, sendBuffer, contentDisposition,
};
