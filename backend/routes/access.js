const express = require('express');
const db = require('../database');
const { can, auditPermission, activePermissionsForUser } = require('../services/permissions');

const router = express.Router();

function requireAccessManage(req, res, next) {
  if (!can(req.user, 'access.manage')) {
    return res.status(403).json({ error: 'Permission access.manage requise' });
  }
  next();
}

router.get('/overview', (req, res) => {
  if (!can(req.user, 'access.manage') && !can(req.user, 'audit.view')) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const profiles = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM profile_permissions pp WHERE pp.profile_id=p.id AND pp.allowed=1) AS nb_permissions,
      (SELECT COUNT(*) FROM user_profiles up WHERE up.profile_id=p.id AND up.active=1) AS nb_users
    FROM profiles p ORDER BY p.code
  `).all();
  const permissions = db.prepare('SELECT * FROM permissions WHERE actif=1 ORDER BY module, code').all();
  const departments = db.prepare('SELECT * FROM departments WHERE actif=1 ORDER BY libelle').all();
  const users = db.prepare('SELECT id, nom, email, role, roles, actif FROM users ORDER BY nom').all().map(u => {
    let roles = [u.role];
    try { roles = u.roles ? JSON.parse(u.roles) : [u.role]; } catch {}
    return { ...u, roles };
  });
  res.json({ profiles, permissions, departments, users });
});

router.get('/users/:id/effective', (req, res) => {
  if (!can(req.user, 'access.manage') && Number(req.params.id) !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const userId = Number(req.params.id);
  const profiles = db.prepare(`
    SELECT p.*, up.source, up.expires_at, up.active
    FROM user_profiles up
    JOIN profiles p ON p.id = up.profile_id
    WHERE up.user_id=? AND up.active=1
    ORDER BY p.code
  `).all(userId);
  const directPermissions = db.prepare(`
    SELECT p.*, up.allowed, up.amount_limit, up.expires_at, up.reason
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id=? AND up.active=1
    ORDER BY p.module, p.code
  `).all(userId);
  const delegations = db.prepare(`
    SELECT d.*, p.code AS permission_code, pr.code AS profile_code,
           u.nom AS delegator_nom
    FROM delegations d
    LEFT JOIN permissions p ON p.id=d.permission_id
    LEFT JOIN profiles pr ON pr.id=d.profile_id
    LEFT JOIN users u ON u.id=d.delegator_id
    WHERE d.delegate_id=? AND d.active=1
    ORDER BY d.expires_at
  `).all(userId);
  res.json({
    profiles,
    directPermissions,
    delegations,
    effectivePermissions: activePermissionsForUser(userId),
  });
});

router.put('/users/:id/profiles/:profileId', requireAccessManage, (req, res) => {
  const userId = Number(req.params.id);
  const profileId = Number(req.params.profileId);
  const active = req.body.active !== false;
  db.prepare(`
    INSERT INTO user_profiles (user_id, profile_id, active, source, expires_at, created_by, updated_at)
    VALUES (?, ?, ?, 'manual', ?, ?, datetime('now'))
    ON CONFLICT(user_id, profile_id) DO UPDATE SET
      active=excluded.active, expires_at=excluded.expires_at, updated_at=datetime('now')
  `).run(userId, profileId, active ? 1 : 0, req.body.expires_at || null, req.user.id);
  auditPermission({
    actorUserId: req.user.id,
    targetUserId: userId,
    tableName: 'user_profiles',
    recordId: profileId,
    action: active ? 'profile_enabled' : 'profile_disabled',
    details: { profileId, expires_at: req.body.expires_at || null },
  });
  res.json({ ok: true });
});

router.put('/users/:id/permissions/:permissionId', requireAccessManage, (req, res) => {
  const userId = Number(req.params.id);
  const permissionId = Number(req.params.permissionId);
  const allowed = req.body.allowed !== false;
  db.prepare(`
    INSERT INTO user_permissions
      (user_id, permission_id, allowed, active, reason, amount_limit, expires_at, created_by, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, permission_id) DO UPDATE SET
      allowed=excluded.allowed, active=1, reason=excluded.reason,
      amount_limit=excluded.amount_limit, expires_at=excluded.expires_at,
      updated_at=datetime('now')
  `).run(
    userId,
    permissionId,
    allowed ? 1 : 0,
    req.body.reason || null,
    req.body.amount_limit ?? null,
    req.body.expires_at || null,
    req.user.id
  );
  auditPermission({
    actorUserId: req.user.id,
    targetUserId: userId,
    tableName: 'user_permissions',
    recordId: permissionId,
    action: allowed ? 'permission_allowed' : 'permission_denied',
    details: req.body,
  });
  res.json({ ok: true });
});

router.post('/delegations', requireAccessManage, (req, res) => {
  const { delegate_id, permission_id = null, profile_id = null, scope_module = null,
          starts_at = null, expires_at, amount_limit = null, reason = '' } = req.body;
  if (!delegate_id || !expires_at || (!permission_id && !profile_id && !scope_module)) {
    return res.status(400).json({ error: 'delegate_id, expires_at et permission/profile/module requis' });
  }
  const r = db.prepare(`
    INSERT INTO delegations
      (delegator_id, delegate_id, permission_id, profile_id, scope_module, starts_at, expires_at,
       amount_limit, reason, created_by)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)
  `).run(req.user.id, delegate_id, permission_id, profile_id, scope_module, starts_at, expires_at, amount_limit, reason, req.user.id);
  auditPermission({
    actorUserId: req.user.id,
    targetUserId: delegate_id,
    tableName: 'delegations',
    recordId: r.lastInsertRowid,
    action: 'delegation_created',
    details: req.body,
  });
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/delegations/:id/disable', requireAccessManage, (req, res) => {
  db.prepare("UPDATE delegations SET active=0, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  auditPermission({
    actorUserId: req.user.id,
    tableName: 'delegations',
    recordId: Number(req.params.id),
    action: 'delegation_disabled',
  });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  if (!can(req.user, 'access.manage') && !can(req.user, 'audit.view')) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const rows = db.prepare(`
    SELECT l.*, actor.nom AS actor_nom, target.nom AS target_nom
    FROM permission_audit_logs l
    LEFT JOIN users actor ON actor.id=l.actor_user_id
    LEFT JOIN users target ON target.id=l.target_user_id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

module.exports = router;
