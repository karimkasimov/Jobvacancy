'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { badRequest } = require('./errors');

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Допустимые типы: расширение → MIME и проверка сигнатуры (содержимого), а не только имени. */
const TYPES = {
  pdf: { mime: 'application/pdf', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  doc: { mime: 'application/msword', check: (b) => b.subarray(0, 8).equals(OLE) },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    check: (b) => b.subarray(0, 4).equals(ZIP) && b.includes('word/'),
  },
  png: { mime: 'image/png', check: (b) => b.subarray(0, 8).equals(PNG) },
  jpg: { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'];
const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const STORED_NAME = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

function parseMultipart(buffer, contentType, { maxParts = 12 } = {}) {
  const m = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType || '');
  if (!m) throw badRequest('Некорректный формат отправки файла.');
  const boundary = m[1] || m[2];
  const delim = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`\r\n--${boundary}`);
  const fields = {};
  const files = [];

  let pos = buffer.indexOf(delim);
  if (pos < 0) throw badRequest('Некорректный формат отправки файла.');
  let parts = 0;
  for (;;) {
    pos += delim.length;
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // завершающий разделитель
    if (buffer[pos] !== 0x0d || buffer[pos + 1] !== 0x0a) throw badRequest('Некорректный формат отправки файла.');
    pos += 2;
    if (++parts > maxParts) throw badRequest('Слишком много частей в запросе.');
    const headEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw badRequest('Некорректный формат отправки файла.');
    const head = buffer.subarray(pos, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = buffer.indexOf(closing, bodyStart);
    if (next < 0) throw badRequest('Некорректный формат отправки файла.');
    const body = buffer.subarray(bodyStart, next);

    const disposition = head.split('\r\n').find((l) => /^content-disposition:/i.test(l)) || '';
    const name = /(?:^|;\s*)name="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (name !== undefined) {
      if (filename !== undefined) files.push({ field: name, filename, data: body });
      else if (body.length <= 20_000) fields[name] = body.toString('utf8');
    }
    pos = next + 2;
  }
  return { fields, files };
}

function sanitizeFilename(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F"<>|:*?]/g, '').trim();
  const cleaned = base.replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

/** Проверяет файл: расширение из списка, размер, сигнатура. Возвращает { ext, mime, originalName }. */
function validateFile(file, { allowed, maxBytes }) {
  if (!file || !file.data || file.data.length === 0) throw badRequest('Файл не выбран или пуст.');
  if (file.data.length > maxBytes) {
    throw new (require('./errors').ApiError)(413, 'file_too_large', `Файл слишком большой. Максимальный размер: ${Math.floor(maxBytes / 1024 / 1024) || 1} МБ.`);
  }
  const originalName = sanitizeFilename(file.filename);
  const ext = path.extname(originalName).slice(1).toLowerCase();
  if (!allowed.includes(ext)) throw badRequest(`Недопустимый тип файла. Разрешены: ${allowed.join(', ')}.`, 'invalid_file_type');
  const type = TYPES[ext];
  if (!type.check(file.data)) throw badRequest('Содержимое файла не соответствует его расширению.', 'invalid_file_content');
  return { ext, mime: type.mime, originalName };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dir;
}

function storeFile(baseDir, subdir, ext, data) {
  const dir = ensureDir(path.join(baseDir, subdir));
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, storedName), data, { flag: 'wx', mode: 0o640 });
  return storedName;
}

/** Безопасно получает путь к сохранённому файлу (защита от выхода из каталога). */
function storedPath(baseDir, subdir, storedName) {
  if (!STORED_NAME.test(String(storedName))) return null;
  const full = path.join(baseDir, subdir, storedName);
  return fs.existsSync(full) ? full : null;
}

function removeFile(baseDir, subdir, storedName) {
  const p = storedPath(baseDir, subdir, storedName);
  if (p) { try { fs.unlinkSync(p); } catch { /* файл уже удалён */ } }
}

module.exports = {
  TYPES, DOCUMENT_EXTENSIONS, LOGO_EXTENSIONS, parseMultipart, validateFile, storeFile, storedPath, removeFile, sanitizeFilename,
};
