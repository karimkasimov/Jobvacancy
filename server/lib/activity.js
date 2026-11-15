'use strict';

/** Запись в журнал действий (аудит). details — небольшой объект без персональных данных и секретов. */
function logActivity(db, ctx, action, entityType = null, entityId = null, details = null) {
  db.run(
    'INSERT INTO activity_logs (actor_id, actor_role, action, entity_type, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ctx.user ? ctx.user.id : null,
    ctx.user ? ctx.user.role : null,
    action,
    entityType,
    entityId,
    details ? JSON.stringify(details) : null,
    ctx.ip || null,
  );
}

function notify(db, userId, { type, title, body = null, link = null }) {
  if (!userId) return;
  db.run('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', userId, type, title, body, link);
}

function notifyMany(db, userIds, payload) {
  for (const id of new Set(userIds)) notify(db, id, payload);
}

const adminIds = (db) => db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").map((r) => r.id);
const orgEmployerIds = (db, orgId) =>
  db.all("SELECT u.id FROM employer_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.organization_id = ? AND u.status = 'active'", orgId).map((r) => r.id);

module.exports = { logActivity, notify, notifyMany, adminIds, orgEmployerIds };
