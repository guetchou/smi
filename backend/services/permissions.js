'use strict';

const db = require('../db');
const { hasRole } = require('../routes/auth');

const LEGACY_PERMISSION_ROLES = {
  'access.manage':              ['admin', 'dg'],
  'access.profile.manage':      ['admin'],
  'access.permission.manage':   ['admin'],
  'access.delegation.manage':   ['admin', 'dg'],
  'settings.manage':            ['admin'],
  'audit.view':                 ['admin', 'dg', 'finance'],
  'salary.view':                ['admin', 'dg', 'rh', 'finance', 'caissier'],
  'salary.generate':            ['admin', 'dg', 'rh', 'finance'],
  'salary.edit':                ['admin', 'dg', 'rh', 'finance'],
  'salary.edit_primes':         ['admin', 'dg', 'rh', 'finance'],
  'salary.validate_bulletin':   ['admin', 'dg', 'finance'],
  'salary.submit_to_dg':        ['admin', 'dg', 'rh', 'finance', 'assistante_direction'],
  'salary.approve_period_dg':   ['admin', 'dg'],
  'salary.pay':                 ['admin', 'dg', 'finance', 'caissier'],
  'salary.cancel_validation':   ['admin'],
  'salary.correct_paid':        ['admin', 'dg', 'finance', 'rh'],
  'salary.cancel_paid':         ['admin', 'dg', 'finance'],
  'salary.adjust_next_period':  ['admin', 'dg', 'finance', 'rh'],
  'salary.create_rectification':['admin', 'dg', 'finance', 'rh'],
  'cash.out.validate':          ['admin', 'dg', 'finance'],
  'cash.out.pay':               ['admin', 'finance', 'caissier'],
  'purchase.validate':          ['admin', 'dg', 'finance'],
  'purchase.pay':               ['admin', 'finance'],
  'hr.agent.create':            ['admin', 'dg', 'rh'],
  'hr.agent.update':            ['admin', 'dg', 'rh'],
  'hr.agent.archive':           ['admin', 'dg', 'rh'],
  'hr.mutation.create':         ['admin', 'dg', 'rh'],
  'hr.mutation.submit':         ['admin', 'dg', 'rh'],
  'hr.mutation.approve':        ['admin', 'dg'],
  'hr.mutation.apply':          ['admin', 'dg'],
  'hr.mutation.cancel':         ['admin', 'dg', 'rh'],
  'hr.department_function.view':            ['admin', 'dg', 'rh'],
  'hr.department_function.create':          ['admin', 'dg', 'rh'],
  'hr.department_function.submit':          ['admin', 'dg', 'rh'],
  'hr.department_function.approve':         ['admin', 'dg'],
  'hr.department_function.activate':        ['admin', 'dg'],
  'hr.department_function.close':           ['admin', 'dg', 'rh'],
  'hr.department_function.attach_document': ['admin', 'dg', 'rh'],
  'hr.department_function.report':          ['admin', 'dg', 'rh'],
  'employment_contract.view':               ['admin', 'dg', 'rh'],
  'employment_contract.create':             ['admin', 'rh'],
  'employment_contract.submit':             ['admin', 'rh'],
  'employment_contract.validate':           ['admin', 'dg'],
  'employment_contract.generate':           ['admin', 'dg', 'rh'],
  'employment_contract.template.manage':    ['admin', 'rh'],
  'employment_contract.rules.manage':       ['admin'],
};

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function amountAllowed(row, context) {
  if (!row) return false;
  if (row.amount_limit == null || context.amount == null) return true;
  return Number(context.amount) <= Number(row.amount_limit);
}

async function can(user, permission, context = {}) {
  if (!user || !permission) return false;
  const adminSuperuser = context.adminSuperuser !== false;
  if (adminSuperuser && hasRole(user, 'admin')) return true;

  const direct = await db.queryOne(`
    SELECT up.allowed, up.amount_limit
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id=? AND p.code=? AND up.active=1
      AND (up.expires_at IS NULL OR up.expires_at > NOW())
    ORDER BY up.updated_at DESC, up.id DESC
    LIMIT 1
  `, [user.id, permission]);
  if (direct) return direct.allowed === 1 && amountAllowed(direct, context);

  const delegated = await db.queryOne(`
    SELECT d.amount_limit
    FROM delegations d
    LEFT JOIN permissions p ON p.id = d.permission_id
    LEFT JOIN profile_permissions pp ON pp.profile_id = d.profile_id AND pp.allowed=1
    LEFT JOIN permissions pp_perm ON pp_perm.id = pp.permission_id
    WHERE d.delegate_id=? AND d.active=1
      AND d.starts_at <= NOW() AND d.expires_at > NOW()
      AND (p.code=? OR pp_perm.code=? OR d.scope_module=?)
    ORDER BY d.expires_at ASC
    LIMIT 1
  `, [user.id, permission, permission, permission.split('.')[0]]);
  if (delegated && amountAllowed(delegated, context)) return true;

  const profile = await db.queryOne(`
    SELECT 1 AS ok
    FROM user_profiles up
    JOIN profile_permissions pp ON pp.profile_id = up.profile_id AND pp.allowed=1
    JOIN permissions p ON p.id = pp.permission_id
    WHERE up.user_id=? AND up.active=1 AND p.code=?
      AND (up.expires_at IS NULL OR up.expires_at > NOW())
    LIMIT 1
  `, [user.id, permission]);
  if (profile) return true;

  const fallbackRoles = LEGACY_PERMISSION_ROLES[permission];
  return fallbackRoles ? hasRole(user, ...fallbackRoles) : false;
}

async function canValidateBulletin(user, context = {}) {
  return can(user, 'salary.validate_bulletin', context);
}

async function canPaySalary(user, context = {}) {
  return can(user, 'salary.pay', context);
}

async function canSubmitPayrollPeriod(user, context = {}) {
  return can(user, 'salary.submit_to_dg', context);
}

async function canApprovePayrollPeriod(user, context = {}) {
  return can(user, 'salary.approve_period_dg', context);
}

function requirePermission(permission, contextFactory = null) {
  return async (req, res, next) => {
    try {
      const context = typeof contextFactory === 'function' ? contextFactory(req) : {};
      const allowed = await can(req.user, permission, context);
      if (!allowed) return res.status(403).json({ error: 'Permission refusée', permission });
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

async function auditPermission(
  { actorUserId, targetUserId = null, tableName, recordId = null, action, details = null },
  executor = db
) {
  try {
    await executor.execute(`
      INSERT INTO permission_audit_logs
        (actor_user_id, target_user_id, table_name, record_id, action, details)
      VALUES (?,?,?,?,?,?)
    `, [
      actorUserId  || null,
      targetUserId || null,
      tableName,
      recordId,
      action,
      details ? JSON.stringify(details) : null,
    ]);
  } catch (_) {}
}

async function tableHasColumns(tableName, columns) {
  try {
    let rows;
    if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') {
      rows = await db.query(`
        SELECT COLUMN_NAME AS name
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      `, [tableName]);
    } else {
      rows = await db.query(`PRAGMA table_info(${tableName})`);
    }
    const names = new Set(rows.map(r => r.name || r.COLUMN_NAME));
    return columns.every(c => names.has(c));
  } catch (_) {
    return false;
  }
}

async function activePermissionsForUser(userId) {
  const hasErpDelegations = await tableHasColumns('delegations', [
    'delegate_id', 'active', 'starts_at', 'expires_at', 'permission_id', 'profile_id', 'scope_module',
  ]);

  if (!hasErpDelegations) {
    return db.query(`
      SELECT DISTINCT p.code, p.module, p.action, p.libelle, p.sensitive
      FROM permissions p
      LEFT JOIN profile_permissions pp ON pp.permission_id = p.id AND pp.allowed=1
      LEFT JOIN user_profiles up ON up.profile_id = pp.profile_id AND up.user_id=? AND up.active=1
        AND (up.expires_at IS NULL OR up.expires_at > NOW())
      LEFT JOIN user_permissions udp ON udp.permission_id = p.id AND udp.user_id=? AND udp.active=1
        AND udp.allowed=1 AND (udp.expires_at IS NULL OR udp.expires_at > NOW())
      WHERE p.actif=1 AND (up.id IS NOT NULL OR udp.id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM user_permissions denied
          WHERE denied.user_id=?
            AND denied.permission_id=p.id
            AND denied.active=1
            AND denied.allowed=0
            AND (denied.expires_at IS NULL OR denied.expires_at > NOW())
        )
      ORDER BY p.module, p.code
    `, [userId, userId, userId]);
  }

  return db.query(`
    SELECT DISTINCT p.code, p.module, p.action, p.libelle, p.sensitive
    FROM permissions p
    LEFT JOIN profile_permissions pp ON pp.permission_id = p.id AND pp.allowed=1
    LEFT JOIN user_profiles up ON up.profile_id = pp.profile_id AND up.user_id=? AND up.active=1
      AND (up.expires_at IS NULL OR up.expires_at > NOW())
    LEFT JOIN user_permissions udp ON udp.permission_id = p.id AND udp.user_id=? AND udp.active=1
      AND udp.allowed=1 AND (udp.expires_at IS NULL OR udp.expires_at > NOW())
    LEFT JOIN delegations d ON d.delegate_id=? AND d.active=1
      AND d.starts_at <= NOW() AND d.expires_at > NOW()
      AND (d.permission_id = p.id OR d.scope_module = p.module)
    LEFT JOIN profile_permissions dpp ON dpp.profile_id = d.profile_id AND dpp.permission_id = p.id AND dpp.allowed=1
    WHERE p.actif=1 AND (up.id IS NOT NULL OR udp.id IS NOT NULL OR d.id IS NOT NULL OR dpp.id IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1
        FROM user_permissions denied
        WHERE denied.user_id=?
          AND denied.permission_id=p.id
          AND denied.active=1
          AND denied.allowed=0
          AND (denied.expires_at IS NULL OR denied.expires_at > NOW())
      )
    ORDER BY p.module, p.code
  `, [userId, userId, userId, userId]);
}

function normalizeRolesForProfiles({ role, roles }) {
  let parsed = [];
  if (Array.isArray(roles)) {
    parsed = roles;
  } else if (typeof roles === 'string' && roles.trim()) {
    try { parsed = JSON.parse(roles); } catch { parsed = []; }
  }
  return [...new Set([role, ...parsed].filter(Boolean))];
}

async function syncUserProfilesFromRoles(userId, rolesInput, actorUserId = null, tx = null) {
  const roles             = normalizeRolesForProfiles(rolesInput).filter(role => role !== 'lecteur');
  const existingProfiles  = await db.query('SELECT id, code FROM profiles WHERE actif=1');
  const byCode            = new Map(existingProfiles.map(p => [p.code, p.id]));
  const roleProfileIds    = roles.map(role => byCode.get(role)).filter(Boolean);

  const applySync = async (conn) => {
    if (roleProfileIds.length) {
      await conn.execute(`
        UPDATE user_profiles
        SET active=0, updated_at=NOW()
        WHERE user_id=? AND source='legacy_role'
          AND profile_id NOT IN (${roleProfileIds.map(() => '?').join(',')})
      `, [userId, ...roleProfileIds]);
    } else {
      await conn.execute(`
        UPDATE user_profiles SET active=0, updated_at=NOW()
        WHERE user_id=? AND source='legacy_role'
      `, [userId]);
    }

    if (roleProfileIds.length) {
      const placeholders = roleProfileIds.map(() => "(?, ?, 1, 'legacy_role', ?, NOW())").join(', ');
      const values       = roleProfileIds.flatMap(pid => [userId, pid, actorUserId]);
      await conn.execute(`
        INSERT INTO user_profiles (user_id, profile_id, active, source, created_by, updated_at)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          active=CASE WHEN source='manual' THEN active ELSE 1 END,
          source=CASE WHEN source='manual' THEN source ELSE 'legacy_role' END,
          updated_at=NOW()
      `, values);
    }
  };

  if (tx) await applySync(tx);
  else await db.transaction(applySync);

  return roleProfileIds.length;
}

module.exports = {
  can,
  canValidateBulletin,
  canPaySalary,
  canSubmitPayrollPeriod,
  canApprovePayrollPeriod,
  requirePermission,
  auditPermission,
  activePermissionsForUser,
  syncUserProfilesFromRoles,
  nowSql,
};
