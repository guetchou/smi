const INSERT_AUDIT_SQL = `
  INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
  VALUES (?,?,?,?,?)
`;

let defaultDb = null;
let defaultLogger = null;

function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database');
  return defaultDb;
}

function serializeDetails(details) {
  if (details === undefined || details === null || details === '') return null;
  if (typeof details === 'string') return details;
  return JSON.stringify(details);
}

function createAuditLogger(db) {
  const insertAudit = db.prepare(INSERT_AUDIT_SQL);

  function logAudit({ tableName, recordId = 0, action, details = null, userId = null }) {
    if (!tableName || !action) return false;
    try {
      insertAudit.run(
        tableName,
        Number(recordId) || 0,
        action,
        serializeDetails(details),
        userId || null
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function createScopedAudit(tableName) {
    return function scopedAudit(recordId, action, details, userId) {
      return logAudit({ tableName, recordId, action, details, userId });
    };
  }

  return { logAudit, createScopedAudit };
}

function logger() {
  if (!defaultLogger) defaultLogger = createAuditLogger(getDefaultDb());
  return defaultLogger;
}

function logAudit(entry) {
  return logger().logAudit(entry);
}

function createScopedAudit(tableName) {
  return logger().createScopedAudit(tableName);
}

module.exports = {
  createAuditLogger,
  createScopedAudit,
  logAudit,
  serializeDetails,
};
