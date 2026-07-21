// utils/auditLog.js
const { run } = require('../db/database');

async function logAction(userId, action, entityType, entityId, details) {
  try {
    await run(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
      [userId, action, entityType, entityId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('فشل تسجيل سجل التدقيق:', err.message);
  }
}

module.exports = { logAction };
