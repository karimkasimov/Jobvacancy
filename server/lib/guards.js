'use strict';
const { unauthorized, forbidden } = require('./errors');

const requireUser = (ctx) => {
  if (!ctx.user) throw unauthorized();
};

/** Роль всегда берётся из сессии на сервере, а не из данных клиента. */
const requireRole = (...roles) => (ctx) => {
  requireUser(ctx);
  if (!roles.includes(ctx.user.role)) throw forbidden();
};

module.exports = { requireUser, requireRole };
