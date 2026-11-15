'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

/** Хеш пароля: scrypt (память-зависимый алгоритм), формат scrypt$N$r$p$соль$хеш. */
async function hashPassword(password, params) {
  const { N, r, p } = params;
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const n = Number(N), rr = Number(r), pp = Number(p);
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: n, r: rr, p: pp, maxmem: 256 * n * rr });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummyHash = null;
/** Выполняет «пустую» проверку пароля, чтобы время ответа не выдавало существование email. */
async function burnPasswordCheck(password, params) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing', params);
  await verifyPassword(password, dummyHash);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Генератор временного пароля для сброса администратором (без похожих символов). */
function temporaryPassword(length = 14) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out}7`;
}

module.exports = { hashPassword, verifyPassword, burnPasswordCheck, randomToken, sha256, safeEqual, temporaryPassword };
