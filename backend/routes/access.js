'use strict';

const express = require('express');
const db      = require('../db');
const { can, auditPermission, activePermissionsForUser } = require('../services/permissions');

const router = express.Router();

async function canAccessOverview(user) {
  const [a, b, c] = await Promise.all([
    can(user, 'access.manage'),
    can(user, 'access.profile.manage'),
    can(user, 'access.permission.manage'),
  ]);
  return a || b || c;
}

function requireAccess(permission, label) {
  return async (req, res, next) => {
    try {
      const [manage, specific] = await Promise.all([
        can(req.user, 'access.manage'),
        can(req.user, permission),
      ]);
      if (!manage && !specific)
        return res.status(403).json({ error: `Permission ${label} requise` });
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

const requireAccessProfileManage    = requireAccess('access.profile.manage',    'access.profile.manage');
const requireAccessPermissionManage = requireAccess('access.permission.manage', 'access.permission.manage');
const requireAccessDelegationManage = requireAccess('access.delegation.manage', 'access.delegation.manage');

router.get('/overview', async (req, res) => {
  try {
    // Toutes les permissions chargées en parallèle — une seule vague de requêtes
    const [canAudit, mManage, mProfiles, mPerms, mDel,
           profiles, permissions, departments, usersRaw] = await Promise.all([
      can(req.user, 'audit.view'),
      can(req.user, 'access.manage'),
      can(req.user, 'access.profile.manage'),
      can(req.user, 'access.permission.manage'),
      can(req.user, 'access.delegation.manage'),
      db.query(`
        SELECT p.*,
          (SELECT COUNT(*) FROM profile_permissions pp WHERE pp.profile_id=p.id AND pp.allowed=1) AS nb_permissions,
          (SELECT COUNT(*) FROM user_profiles up WHERE up.profile_id=p.id AND up.active=1) AS nb_users
        FROM profiles p ORDER BY p.code
      `),
      db.query('SELECT * FROM permissions WHERE actif=1 ORDER BY module, code'),
      db.query('SELECT * FROM departments WHERE actif=1 ORDER BY libelle'),
      db.query('SELECT id, nom, prenom, email, role, roles, actif FROM users ORDER BY nom'),
    ]);

    const canOv = mManage || mProfiles || mPerms;
    if (!canOv && !canAudit)
      return res.status(403).json({ error: 'Accès refusé' });

    const users = usersRaw.map(u => {
      let roles = [u.role];
      try { roles = u.roles ? JSON.parse(u.roles) : [u.role]; } catch {}
      return { ...u, roles };
    });

    res.json({
      profiles,
      permissions,
      departments,
      users,
      accessRights: {
        manage:      mManage,
        profiles:    mManage || mProfiles,
        permissions: mManage || mPerms,
        delegations: mManage || mDel,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/users/:id/effective', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const canOv  = await canAccessOverview(req.user);
    if (!canOv && userId !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });

    const [profiles, directPermissions, delegations, effectivePermissions] = await Promise.all([
      db.query(`
        SELECT p.*, up.source, up.expires_at, up.active
        FROM user_profiles up
        JOIN profiles p ON p.id = up.profile_id
        WHERE up.user_id=? ORDER BY p.code
      `, [userId]),
      db.query(`
        SELECT p.*, up.allowed, up.amount_limit, up.expires_at, up.reason
        FROM user_permissions up
        JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id=? AND up.active=1 ORDER BY p.module, p.code
      `, [userId]),
      db.query(`
        SELECT d.*, p.code AS permission_code, pr.code AS profile_code, u.nom AS delegator_nom
        FROM delegations d
        LEFT JOIN permissions p ON p.id=d.permission_id
        LEFT JOIN profiles pr ON pr.id=d.profile_id
        LEFT JOIN users u ON u.id=d.delegator_id
        WHERE d.delegate_id=? AND d.active=1 ORDER BY d.expires_at
      `, [userId]),
      activePermissionsForUser(userId),
    ]);

    res.json({ profiles, directPermissions, delegations, effectivePermissions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/profiles/:profileId', requireAccessProfileManage, async (req, res) => {
  try {
    const userId    = Number(req.params.id);
    const profileId = Number(req.params.profileId);
    const active    = req.body.active !== false;

    await db.execute(`
      INSERT INTO user_profiles (user_id, profile_id, active, source, expires_at, created_by, updated_at)
      VALUES (?, ?, ?, 'manual', ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        active=VALUES(active), expires_at=VALUES(expires_at), updated_at=NOW()
    `, [userId, profileId, active ? 1 : 0, req.body.expires_at || null, req.user.id]);

    await auditPermission({
      actorUserId:  req.user.id,
      targetUserId: userId,
      tableName:    'user_profiles',
      recordId:     profileId,
      action:       active ? 'profile_enabled' : 'profile_disabled',
      details:      { profileId, expires_at: req.body.expires_at || null },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/permissions/:permissionId', requireAccessPermissionManage, async (req, res) => {
  try {
    const userId       = Number(req.params.id);
    const permissionId = Number(req.params.permissionId);
    const allowed      = req.body.allowed !== false;

    await db.execute(`
      INSERT INTO user_permissions
        (user_id, permission_id, allowed, active, reason, amount_limit, expires_at, created_by, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        allowed=VALUES(allowed), active=1, reason=VALUES(reason),
        amount_limit=VALUES(amount_limit), expires_at=VALUES(expires_at), updated_at=NOW()
    `, [
      userId, permissionId, allowed ? 1 : 0,
      req.body.reason || null, req.body.amount_limit ?? null, req.body.expires_at || null, req.user.id,
    ]);

    await auditPermission({
      actorUserId:  req.user.id,
      targetUserId: userId,
      tableName:    'user_permissions',
      recordId:     permissionId,
      action:       allowed ? 'permission_allowed' : 'permission_denied',
      details:      req.body,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/delegations', requireAccessDelegationManage, async (req, res) => {
  try {
    const {
      delegate_id, permission_id = null, profile_id = null, scope_module = null,
      starts_at = null, expires_at, amount_limit = null, reason = '',
    } = req.body;

    if (!delegate_id || !expires_at || (!permission_id && !profile_id && !scope_module)) {
      return res.status(400).json({ error: 'delegate_id, expires_at et permission/profile/module requis' });
    }

    const result = await db.execute(`
      INSERT INTO delegations
        (delegator_id, delegate_id, permission_id, profile_id, scope_module, starts_at, expires_at,
         amount_limit, reason, created_by)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?, ?, ?)
    `, [req.user.id, delegate_id, permission_id, profile_id, scope_module, starts_at, expires_at, amount_limit, reason, req.user.id]);

    await auditPermission({
      actorUserId:  req.user.id,
      targetUserId: delegate_id,
      tableName:    'delegations',
      recordId:     result.insertId,
      action:       'delegation_created',
      details:      req.body,
    });
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/delegations/:id/disable', requireAccessDelegationManage, async (req, res) => {
  try {
    await db.execute("UPDATE delegations SET active=0, updated_at=NOW() WHERE id=?", [req.params.id]);
    await auditPermission({
      actorUserId: req.user.id,
      tableName:   'delegations',
      recordId:    Number(req.params.id),
      action:      'delegation_disabled',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/audit', async (req, res) => {
  try {
    const [canAudit, canManage] = await Promise.all([
      can(req.user, 'audit.view'),
      can(req.user, 'access.manage'),
    ]);
    if (!canManage && !canAudit)
      return res.status(403).json({ error: 'Accès refusé' });

    const rows = await db.query(`
      SELECT l.*, actor.nom AS actor_nom, target.nom AS target_nom
      FROM permission_audit_logs l
      LEFT JOIN users actor ON actor.id=l.actor_user_id
      LEFT JOIN users target ON target.id=l.target_user_id
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
