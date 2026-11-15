'use strict';
const V = require('../lib/validate');
const { ApiError, conflict, forbidden } = require('../lib/errors');
const S = require('../lib/security');
const H = require('../lib/http');
const { meDto } = require('../lib/queries');
const { logActivity, notify, adminIds } = require('../lib/activity');

function register(router, { config, db, mailer }) {
  const nowIso = () => new Date().toISOString();

  function startSession(ctx, userId) {
    const token = S.randomToken();
    const csrf = S.randomToken(24);
    const ttlSeconds = config.sessionTtlHours * 3600;
    db.run(
      'INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      S.sha256(token), userId, csrf, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200),
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    );
    ctx.setCookie(H.serializeCookie(config.cookieName, token, { maxAgeSeconds: ttlSeconds, secure: config.cookieSecure }));
    return csrf;
  }

  const clearCookie = (ctx) =>
    ctx.setCookie(H.serializeCookie(config.cookieName, '', { maxAgeSeconds: 0, secure: config.cookieSecure }));

  const isUniqueError = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));

  router.get('/api/auth/me', (ctx) => {
    if (!ctx.user) return { user: null };
    return { user: meDto(db, ctx.user), csrfToken: ctx.session.csrfToken };
  });

  router.post('/api/auth/register', { limit: 'register', csrf: false }, async (ctx) => {
    if (ctx.user) throw conflict('Вы уже вошли в систему.', 'already_authenticated');
    const base = V.parse(ctx.body, {
      role: V.oneOf(['candidate', 'employer']),
      email: V.email(),
      password: V.password(config.passwordMinLength),
      fullName: V.str({ min: 2, max: 120 }),
      phone: V.phone(),
      consent: V.accepted('Необходимо согласие на обработку персональных данных.'),
    });
    const extra = base.role === 'employer'
      ? V.parse(ctx.body, { organizationName: V.str({ min: 2, max: 200 }), city: V.str({ min: 2, max: 80 }), positionTitle: V.str({ max: 120, optional: true }) })
      : V.parse(ctx.body, { candidateType: V.oneOf(['applicant', 'student', 'graduate'], { optional: true }) });

    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', base.email)) {
      throw new ApiError(409, 'email_taken', 'Пользователь с таким email уже зарегистрирован.', { email: 'Этот email уже используется.' });
    }
    const hash = await S.hashPassword(base.password, config.scrypt);

    let userId;
    try {
      userId = db.tx(() => {
        const r = db.run('INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, ?, ?, ?)',
          base.email, hash, base.role, base.fullName, base.phone);
        const id = Number(r.lastInsertRowid);
        if (base.role === 'candidate') {
          db.run('INSERT INTO candidate_profiles (user_id, candidate_type) VALUES (?, ?)', id, extra.candidateType || 'applicant');
        } else {
          const org = db.run('INSERT INTO organizations (name, city, created_by) VALUES (?, ?, ?)', extra.organizationName, extra.city, id);
          db.run('INSERT INTO employer_profiles (user_id, organization_id, position_title) VALUES (?, ?, ?)', id, Number(org.lastInsertRowid), extra.positionTitle);
        }
        return id;
      });
    } catch (err) {
      if (isUniqueError(err)) throw new ApiError(409, 'email_taken', 'Пользователь с таким email уже зарегистрирован.', { email: 'Этот email уже используется.' });
      throw err;
    }

    if (base.role === 'employer') {
      for (const adminId of adminIds(db)) {
        notify(db, adminId, { type: 'employer.registered', title: 'Новый работодатель', body: `Зарегистрирована организация «${extra.organizationName}».`, link: '/admin#organizations' });
      }
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', userId);
    const csrfToken = startSession(ctx, userId);
    logActivity(db, { ...ctx, user }, 'auth.register', 'user', userId, { role: base.role });
    ctx.status = 201;
    return { user: meDto(db, user), csrfToken };
  });

  router.post('/api/auth/login', { limit: 'login', csrf: false }, async (ctx) => {
    const { email, password } = V.parse(ctx.body, { email: V.str({ min: 1, max: 254 }), password: V.str({ min: 1, max: 200 }) });
    const generic = new ApiError(401, 'invalid_credentials', 'Неверный email или пароль.');
    const user = db.get('SELECT * FROM users WHERE email = ?', email.toLowerCase());
    if (!user) {
      await S.burnPasswordCheck(password, config.scrypt);
      throw generic;
    }
    if (user.locked_until && user.locked_until > nowIso()) {
      const minutes = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000));
      throw new ApiError(429, 'account_locked', `Слишком много неудачных попыток входа. Повторите через ${minutes} мин.`);
    }
    const ok = await S.verifyPassword(password, user.password_hash);
    if (!ok) {
      const failures = user.failed_logins + 1;
      if (failures >= config.loginMaxFailures) {
        db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?',
          new Date(Date.now() + config.loginLockMinutes * 60000).toISOString(), user.id);
      } else {
        db.run('UPDATE users SET failed_logins = ? WHERE id = ?', failures, user.id);
      }
      logActivity(db, { ...ctx, user: null }, 'auth.login_failed', 'user', user.id);
      throw generic;
    }
    if (user.status !== 'active') throw forbidden('Ваш аккаунт заблокирован. Обратитесь к администратору ГГКИТ.', 'account_blocked');

    db.run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", nowIso(), user.id);
    const fresh = db.get('SELECT * FROM users WHERE id = ?', user.id);
    const csrfToken = startSession(ctx, user.id);
    logActivity(db, { ...ctx, user: fresh }, 'auth.login', 'user', user.id);
    return { user: meDto(db, fresh), csrfToken };
  });

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.session) {
      db.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
      logActivity(db, ctx, 'auth.logout', 'user', ctx.user.id);
    }
    clearCookie(ctx);
    return { ok: true };
  });

  router.post('/api/auth/change-password', async (ctx) => {
    if (!ctx.user) throw new ApiError(401, 'unauthorized', 'Требуется вход в систему.');
    const { currentPassword, newPassword } = V.parse(ctx.body, {
      currentPassword: V.str({ min: 1, max: 200 }),
      newPassword: V.password(config.passwordMinLength),
    });
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await S.verifyPassword(currentPassword, row.password_hash))) {
      throw new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', { currentPassword: 'Текущий пароль указан неверно.' });
    }
    if (currentPassword === newPassword) {
      throw new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', { newPassword: 'Новый пароль должен отличаться от текущего.' });
    }
    const hash = await S.hashPassword(newPassword, config.scrypt);
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", hash, nowIso(), ctx.user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', ctx.user.id, ctx.session.id);
    });
    logActivity(db, ctx, 'auth.password_changed', 'user', ctx.user.id);
    return { ok: true };
  });

  // Восстановление пароля: токен хранится только в виде хеша, ссылка уходит через настроенный почтовый провайдер.
  router.post('/api/auth/forgot', { limit: 'forgot', csrf: false }, async (ctx) => {
    const input = V.parse(ctx.body, { email: V.str({ min: 1, max: 254 }) });
    const mailMode = mailer.provider === 'none' ? 'not_configured' : mailer.provider === 'console' ? 'console' : 'sent';
    const user = db.get("SELECT * FROM users WHERE email = ? AND status = 'active'", input.email.toLowerCase());
    if (user && mailer.isConfigured) {
      const token = S.randomToken();
      db.tx(() => {
        db.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', nowIso(), user.id);
        db.run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
          user.id, S.sha256(token), new Date(Date.now() + config.resetTokenMinutes * 60000).toISOString());
      });
      await mailer.send({
        to: user.email,
        subject: 'Восстановление пароля — ГГКИТ Карьера ЧР',
        text: `Здравствуйте, ${user.full_name}!\n\nЧтобы задать новый пароль, перейдите по ссылке (действует ${config.resetTokenMinutes} мин.):\n${config.baseUrl}/reset-password?token=${token}\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте это письмо.`,
      });
      logActivity(db, { ...ctx, user: null }, 'auth.reset_requested', 'user', user.id);
    }
    return { ok: true, mail: mailMode };
  });

  router.post('/api/auth/reset', { limit: 'forgot', csrf: false }, async (ctx) => {
    const { token, newPassword } = V.parse(ctx.body, {
      token: V.str({ min: 10, max: 200 }),
      newPassword: V.password(config.passwordMinLength),
    });
    const row = db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', S.sha256(token), nowIso());
    if (!row) throw new ApiError(400, 'invalid_token', 'Ссылка для сброса пароля недействительна или устарела.');
    const hash = await S.hashPassword(newPassword, config.scrypt);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, nowIso(), row.user_id);
      db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), row.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    logActivity(db, { ...ctx, user: null }, 'auth.password_reset', 'user', row.user_id);
    return { ok: true };
  });
}

module.exports = { register };
