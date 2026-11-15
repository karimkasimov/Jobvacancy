'use strict';
const V = require('../lib/validate');
const { ApiError, notFound, forbidden } = require('../lib/errors');
const S = require('../lib/security');
const { requireUser } = require('../lib/guards');
const { meDto, pageParams, pageResult } = require('../lib/queries');
const { logActivity } = require('../lib/activity');
const { removeFile } = require('../lib/uploads');

/** Функции аккаунта, доступные любой роли: данные профиля, email, уведомления, удаление. */
function register(router, { config, db }) {
  const nowIso = () => new Date().toISOString();
  const invalid = (fields) => new ApiError(422, 'validation_error', 'Проверьте правильность заполнения полей.', fields);

  router.patch('/api/me/account', requireUser, (ctx) => {
    const data = V.parse(ctx.body, { fullName: V.str({ min: 2, max: 120 }), phone: V.phone() }, { partial: true });
    const sets = [];
    const vals = [];
    if ('fullName' in data) { sets.push('full_name = ?'); vals.push(data.fullName); }
    if ('phone' in data) { sets.push('phone = ?'); vals.push(data.phone); }
    if (sets.length) {
      db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), ctx.user.id);
      logActivity(db, ctx, 'account.updated', 'user', ctx.user.id);
    }
    return { user: meDto(db, db.get('SELECT * FROM users WHERE id = ?', ctx.user.id)) };
  });

  // Email не подтверждается письмом (почта не настроена), поэтому смена защищена текущим паролем.
  router.post('/api/me/email', requireUser, async (ctx) => {
    const { email, password } = V.parse(ctx.body, { email: V.email(), password: V.str({ min: 1, max: 200 }) });
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await S.verifyPassword(password, row.password_hash))) throw invalid({ password: 'Пароль указан неверно.' });
    const taken = db.get('SELECT id FROM users WHERE email = ? AND id <> ?', email, ctx.user.id);
    if (taken) throw invalid({ email: 'Этот email уже используется.' });
    db.run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', email, nowIso(), ctx.user.id);
    logActivity(db, ctx, 'account.email_changed', 'user', ctx.user.id);
    return { user: meDto(db, db.get('SELECT * FROM users WHERE id = ?', ctx.user.id)) };
  });

  router.delete('/api/me/account', requireUser, async (ctx) => {
    if (ctx.user.role === 'admin') throw forbidden('Аккаунт администратора нельзя удалить самостоятельно.');
    const { password } = V.parse(ctx.body, { password: V.str({ min: 1, max: 200 }) });
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await S.verifyPassword(password, row.password_hash))) throw invalid({ password: 'Пароль указан неверно.' });

    const docs = db.all('SELECT stored_name FROM documents WHERE user_id = ?', ctx.user.id);
    db.tx(() => {
      if (ctx.user.role === 'employer') {
        const ep = db.get('SELECT organization_id FROM employer_profiles WHERE user_id = ?', ctx.user.id);
        if (ep) {
          const others = db.get('SELECT COUNT(*) AS n FROM employer_profiles WHERE organization_id = ? AND user_id <> ?', ep.organization_id, ctx.user.id).n;
          if (others === 0) {
            // Организация остаётся без представителя: её вакансии закрываются, из каталога партнёров она скрывается.
            db.run("UPDATE vacancies SET status = 'closed', closed_at = ?, updated_at = ? WHERE organization_id = ? AND status IN ('published', 'pending')", nowIso(), nowIso(), ep.organization_id);
            db.run('UPDATE organizations SET is_partner_listed = 0, updated_at = ? WHERE id = ?', nowIso(), ep.organization_id);
          }
        }
      }
      logActivity(db, ctx, 'account.deleted', 'user', ctx.user.id, { role: ctx.user.role });
      db.run('DELETE FROM users WHERE id = ?', ctx.user.id);
    });
    for (const d of docs) removeFile(config.uploadDir, 'documents', d.stored_name);
    ctx.setCookie(require('../lib/http').serializeCookie(config.cookieName, '', { maxAgeSeconds: 0, secure: config.cookieSecure }));
    return { ok: true };
  });

  // ---- Уведомления ----
  router.get('/api/me/notifications', requireUser, (ctx) => {
    const pg = pageParams(ctx.query, { defaultSize: 20, maxSize: 50 });
    const unreadOnly = ctx.query.unread === '1';
    const where = `user_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}`;
    const total = db.get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, ctx.user.id).n;
    const rows = db.all(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ctx.user.id, pg.pageSize, pg.offset);
    const items = rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at }));
    const unreadCount = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', ctx.user.id).n;
    return { ...pageResult(items, total, pg), unreadCount };
  });

  router.post('/api/me/notifications/read-all', requireUser, (ctx) => {
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), ctx.user.id);
    return { ok: true };
  });

  router.post('/api/me/notifications/:id/read', requireUser, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const r = id && db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?', nowIso(), id, ctx.user.id);
    if (!r || !r.changes) throw notFound('Уведомление не найдено.');
    return { ok: true };
  });

  router.delete('/api/me/notifications/:id', requireUser, (ctx) => {
    const id = V.parseId(ctx.params.id);
    const r = id && db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', id, ctx.user.id);
    if (!r || !r.changes) throw notFound('Уведомление не найдено.');
    return { ok: true };
  });
}

module.exports = { register };
