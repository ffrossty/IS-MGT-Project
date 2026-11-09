'use strict';
const { db } = require('../db');

const insAudit = db.prepare(`INSERT INTO audit_logs(user_id, action, entity, entity_id, before_json, after_json, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insEvent = db.prepare(`INSERT INTO order_events(order_id, actor_user_id, actor_role, type, message, data, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

function audit(req, action, entity, entityId, before, after) {
  insAudit.run(req && req.user ? req.user.id : null, action, entity, entityId == null ? null : String(entityId),
    before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
    req ? (req.ip || null) : null, Date.now());
}

/** actor: { id, role } | null (system) */
function orderEvent(orderId, actor, type, message, data) {
  insEvent.run(orderId, actor ? actor.id : null, actor ? actor.role : 'system', type, message,
    data === undefined ? null : JSON.stringify(data), Date.now());
}

module.exports = { audit, orderEvent };
