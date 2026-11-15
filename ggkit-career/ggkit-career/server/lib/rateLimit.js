'use strict';

/** Ограничитель частоты запросов в памяти процесса (скользящее окно, ключ — группа + IP). */
class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** @returns {{allowed:boolean, retryAfterSeconds:number}} */
  hit(key, { limit, windowMs }) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  sweep() {
    const now = Date.now();
    for (const [key, arr] of this.hits) {
      if (!arr.length || now - arr[arr.length - 1] > 60 * 60_000) this.hits.delete(key);
    }
  }

  close() { clearInterval(this.timer); }
}

module.exports = { RateLimiter };
