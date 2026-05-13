const db = require('../database');
const { hasRole } = require('../routes/auth');

const LEGACY_PERMISSION_ROLES = {
  'access.manage': ['admin'],
  'access.profile.manage': ['admin'],
  'access.permission.manage': ['admin'],
  'access.delegation.manage': ['admin', 'dg'],
  'settings.manage': ['admin'],
  'audit.view': ['admin', 'dg', 'finance'],
  'salary.view': ['admin', 'dg', 'rh', 'finance', 'caissier'],
  'salary.generate': ['admin', 'dg', 'rh', 'finance'],
  'salary.edit': ['admin', 'dg', 'rh', 'finance'],
  'salary.edit_primes': ['admin', 'dg', 'rh', 'finance'],
  'salary.validate_bulletin': ['admin', 'dg', 'finance', 'caissier'],
  'salary.submit_to_dg': ['admin', 'dg', 'rh', 'finance'],
  'salary.approve_period_dg': ['admin', 'dg'],
  'salary.pay': ['admin', 'dg', 'finance', 'caissier'],
  'salary.cancel_validation': ['admin'],
  'cash.out.validate': ['admin', 'dg', 'finance'],
  'cash.out.pay': ['admin', 'finance', 'caissier'],
  'purchase.validate': ['admin', 'dg', 'finance'],
  'purchase.pay': ['admin', 'finance'],
};

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function amountAllowed(row, context) {
  if (!row) return false;
  if (row.amount_limit == null || context.amount == null) return true;
  return Number(context.amount) <= Number(row.amount_limit);
}

function can(user, permission, context = {}) {
  if (!user || !permission) return false;
  const adminSuperuser = context.adminSuperuser !== false;
  if (adminSuperuser && hasRole(user, 'admin')) return true;

  const direct = db.prepare(`
    SELECT up.allowed, up.amount_limit
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id=? AND p.code=? AND up.active=1
      AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    ORDER BY up.updated_at DESC, up.id DESC
    LIMIT 1
  `).get(user.id, permission);
  if (direct) return direct.allowed === 1 && amountAllowed(direct, context);

  const delegated = db.prepare(`
    SELECT d.amount_limit
    FROM delegations d
    LEFT JOIN permissions p ON p.id = d.permission_id
    LEFT JOIN profile_permissions pp ON pp.profile_id = d.profile_id AND pp.allowed=1
    LEFT JOIN permissions pp_perm ON pp_perm.id = pp.permission_id
    WHERE d.delegate_id=? AND d.active=1
      AND d.starts_at <= datetime('now') AND d.expires_at > datetime('now')
      AND (p.code=? OR pp_perm.code=? OR d.scope_module=?)
    ORDER BY d.expires_at ASC
    LIMIT 1
  `).get(user.id, permission, permission, permission.split('.')[0]);
  if (delegated && amountAllowed(delegated, context)) return true;

  const profile = db.prepare(`
    SELECT 1
    FROM user_profiles up
    JOIN profile_permissions pp ON pp.profile_id = up.profile_id AND pp.allowed=1
    JOIN permissions p ON p.id = pp.permission_id
    WHERE up.user_id=? AND up.active=1 AND p.code=?
      AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    LIMIT 1
  `).get(user.id, permission);
  if (profile) return true;

  const fallbackRoles = LEGACY_PERMISSION_ROLES[permission];
  return fallbackRoles ? hasRole(user, ...fallbackRoles) : false;
}

function requirePermission(permission, contextFactory = null) {
  return (req, res, next) => {
    const context = typeof contextFactory === 'function' ? contextFactory(req) : {};
    if (!can(req.user, permission, context)) {
      return res.status(403).json({ error: 'Permission refusée', permission });
    }
    next();
  };
}

function auditPermission({ actorUserId, targetUserId = null, tableName, recordId = null, action, details = null }) {
  db.prepare(`
    INSERT INTO permission_audit_logs
      (actor_user_id, target_user_id, table_name, record_id, action, details)
    VALUES (?,?,?,?,?,?)
  `).run(
    actorUserId || null,
    targetUserId || null,
    tableName,
    recordId,
    action,
    details ? JSON.stringify(details) : null
  );
}

function activePermissionsForUser(userId) {
  const rows = db.prepare(`
    SELECT DISTINCT p.code, p.module, p.action, p.libelle, p.sensitive
    FROM permissions p
    LEFT JOIN profile_permissions pp ON pp.permission_id = p.id AND pp.allowed=1
    LEFT JOIN user_profiles up ON up.profile_id = pp.profile_id AND up.user_id=? AND up.active=1
      AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    LEFT JOIN user_permissions udp ON udp.permission_id = p.id AND udp.user_id=? AND udp.active=1
      AND udp.allowed=1 AND (udp.expires_at IS NULL OR udp.expires_at > datetime('now'))
    LEFT JOIN delegations d ON d.delegate_id=? AND d.active=1
      AND d.starts_at <= datetime('now') AND d.expires_at > datetime('now')
      AND (d.permission_id = p.id OR d.scope_module = p.module)
    LEFT JOIN profile_permissions dpp ON dpp.profile_id = d.profile_id AND dpp.permission_id = p.id AND dpp.allowed=1
    WHERE p.actif=1 AND (up.id IS NOT NULL OR udp.id IS NOT NULL OR d.id IS NOT NULL OR dpp.id IS NOT NULL)
    ORDER BY p.module, p.code
  `).all(userId, userId, userId);
  return rows;
}

module.exports = {
  can,
  requirePermission,
  auditPermission,
  activePermissionsForUser,
  nowSql,
};
