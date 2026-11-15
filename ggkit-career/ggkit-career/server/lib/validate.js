'use strict';
const { ApiError } = require('./errors');

class FieldError extends Error {}
const fail = (message) => { throw new FieldError(message); };

const CONTROL_MULTILINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_SINGLE = /[\u0000-\u001F\u007F]/g;

function cleanText(value, multiline) {
  let s = String(value).normalize('NFC');
  if (multiline) s = s.replace(/\r\n?/g, '\n').replace(CONTROL_MULTILINE, '');
  else s = s.replace(CONTROL_SINGLE, ' ').replace(/\s{2,}/g, ' ');
  return s.trim();
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Текст. optional → пустое значение превращается в null. */
function str({ min = 0, max = 255, optional = false, multiline = false, pattern, message } = {}) {
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Обязательное поле.');
    }
    if (typeof v !== 'string') fail('Ожидается текст.');
    const s = cleanText(v, multiline);
    if (s.length < min) fail(min <= 1 ? 'Обязательное поле.' : `Минимум символов: ${min}.`);
    if (s.length > max) fail(`Максимум символов: ${max}.`);
    if (pattern && !pattern.test(s)) fail(message || 'Недопустимый формат.');
    return s;
  };
}

function int({ min = 0, max = 2_000_000_000, optional = false } = {}) {
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Обязательное поле.');
    }
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isInteger(n)) fail('Ожидается целое число.');
    if (n < min || n > max) fail(`Допустимый диапазон: от ${min} до ${max}.`);
    return n;
  };
}

function oneOf(values, { optional = false } = {}) {
  const list = Array.isArray(values) ? values : Object.keys(values);
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Обязательное поле.');
    }
    if (!list.includes(v)) fail('Недопустимое значение.');
    return v;
  };
}

function email({ optional = false } = {}) {
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Укажите email.');
    }
    const s = String(v).trim().toLowerCase();
    if (s.length > 254 || !/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(s)) {
      fail('Введите корректный email.');
    }
    return s;
  };
}

function phone({ optional = true } = {}) {
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Укажите телефон.');
    }
    const s = cleanText(v, false);
    const digits = s.replace(/\D/g, '');
    if (!/^[0-9+()\-\s]{6,25}$/.test(s) || digits.length < 6 || digits.length > 15) fail('Введите корректный номер телефона.');
    return s;
  };
}

function url({ optional = true } = {}) {
  return (v) => {
    if (isEmpty(v)) {
      if (optional) return null;
      fail('Укажите адрес сайта.');
    }
    const s = String(v).trim();
    let parsed;
    try { parsed = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { fail('Введите корректный адрес сайта.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) fail('Введите корректный адрес сайта.');
    if (parsed.href.length > 300) fail('Адрес слишком длинный.');
    return parsed.href;
  };
}

/** Список коротких строк (обязанности, требования, условия). */
function stringList({ maxItems = 20, maxLen = 400 } = {}) {
  return (v) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail('Ожидается список.');
    if (v.length > maxItems) fail(`Максимум пунктов: ${maxItems}.`);
    const out = [];
    for (const item of v) {
      if (typeof item !== 'string') fail('Пункты списка должны быть текстом.');
      const s = cleanText(item, false);
      if (!s) continue;
      if (s.length > maxLen) fail(`Максимум символов в пункте: ${maxLen}.`);
      out.push(s);
    }
    return out;
  };
}

function bool({ optional = false } = {}) {
  return (v) => {
    if (v === undefined || v === null) {
      if (optional) return undefined;
      fail('Обязательное поле.');
    }
    if (typeof v !== 'boolean') fail('Ожидается значение да/нет.');
    return v;
  };
}

/** Обязательный флажок (согласие): допустимо только true. */
function accepted(message = 'Необходимо подтвердить согласие.') {
  return (v) => {
    if (v !== true) fail(message);
    return true;
  };
}

function password(minLength = 8) {
  return (v) => {
    if (typeof v !== 'string' || v.length === 0) fail('Введите пароль.');
    if (v.length < minLength) fail(`Пароль должен содержать не менее ${minLength} символов.`);
    if (v.length > 200) fail('Пароль слишком длинный.');
    if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) fail('Пароль должен содержать буквы и цифры.');
    return v;
  };
}

/**
 * Проверяет объект по схеме. partial: true — пропускать отсутствующие ключи (для PATCH).
 * Неизвестные поля отбрасываются.
 */
function parse(input, schema, { partial = false } = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const errors = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (partial && !(key in src)) continue;
    try {
      const value = rule(src[key]);
      if (value !== undefined) out[key] = value;
    } catch (err) {
      if (err instanceof FieldError) errors[key] = err.message;
      else throw err;
    }
  }
  if (Object.keys(errors).length) {
    throw new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', errors);
  }
  return out;
}

/** Положительный целый идентификатор из параметра пути или null. */
function parseId(value) {
  return /^[1-9]\d{0,9}$/.test(String(value)) ? Number(value) : null;
}

/** Экранирование для LIKE (используется вместе с ESCAPE '\'). */
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

module.exports = { parse, parseId, escapeLike, cleanText, str, int, oneOf, email, phone, url, stringList, bool, accepted, password };
