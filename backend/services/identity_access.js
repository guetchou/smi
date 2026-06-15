'use strict';

/**
 * IdentityAccessService — seam industriel identite/acces.
 *
 * Ce module concentre les invariants utilisateur -> agent -> roles -> profils.
 * Les routes ne doivent plus ecrire `users` puis synchroniser les profils en
 * ordre disperse.
 */

const bcrypt = require('bcryptjs');
const db = require('../db');
const { syncUserProfilesFromRoles, auditPermission } = require('./permissions');

const VALID_ROLES = ['admin', 'caissier', 'finance', 'rh', 'lecteur', 'dg', 'assistante_direction', 'delegue'];
const EMPLOYEE_LINK_EXEMPT_ROLES = ['admin'];

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function parseRoles(user) {
  if (!user) return [];
  try {
    const parsed = user.roles ? JSON.parse(user.roles) : [user.role];
    const roles = Array.isArray(parsed) ? parsed : [user.role];
    return [...new Set([user.role, ...roles].filter(Boolean))];
  } catch {
    return user.role ? [user.role] : [];
  }
}

function normalizeRoles({ role = 'lecteur', roles = null }) {
  const base = Array.isArray(roles) ? roles : [role];
  const rolesArr = [...new Set(base.filter(Boolean))];
  const invalid = rolesArr.filter(r => !VALID_ROLES.includes(r));
  if (invalid.length) {
    const err = new Error(`Roles invalides : ${invalid.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const primaryRole = rolesArr.includes(role) ? role : rolesArr[0];
  if (!VALID_ROLES.includes(primaryRole)) {
    const err = new Error('Role invalide');
    err.status = 400;
    throw err;
  }
  return { primaryRole, rolesArr };
}

function normalizeEmployeId(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

function normalizeLoginIdentifier(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (!/^[a-z0-9._-]{3,100}$/.test(normalized)) {
    const err = new Error('Identifiant invalide : lettres, chiffres, point, tiret ou underscore requis');
    err.status = 400;
    throw err;
  }
  return normalized;
}

function defaultLoginIdentifier(email) {
  const localPart = String(email || '').split('@')[0];
  return normalizeLoginIdentifier(localPart);
}

function roleRequiresEmployeLink(role, roles = []) {
  const allRoles = [...new Set([role, ...(Array.isArray(roles) ? roles : [])].filter(Boolean))];
  return allRoles.some(r => !EMPLOYEE_LINK_EXEMPT_ROLES.includes(r));
}

async function assertEmployeAvailableForUser(employeId, userId = null) {
  if (employeId === null) return null;
  if (!Number.isInteger(employeId) || employeId <= 0) {
    const err = new Error('Fiche agent liee invalide');
    err.status = 400;
    throw err;
  }
  const emp = await db.queryOne(
    "SELECT id FROM employes WHERE id = ? AND actif = 1 AND statut_dossier != 'sorti'",
    [employeId]
  );
  if (!emp) {
    const err = new Error('Fiche agent liee introuvable ou inactive');
    err.status = 400;
    throw err;
  }
  const linked = await db.queryOne(
    'SELECT id, email FROM users WHERE employe_id = ? AND id != ?',
    [employeId, userId || 0]
  );
  if (linked) {
    const err = new Error(`Cette fiche agent est deja liee au compte ${linked.email}`);
    err.status = 400;
    throw err;
  }
  return emp;
}

function duplicateEmailError(err) {
  return err && (err.code === 'ER_DUP_ENTRY' || err.code === 'SQLITE_CONSTRAINT');
}

async function createUserAccess(input, actorUserId = null) {
  const { nom, prenom = '', email, password, sous_role = null } = input;
  if (!nom || !email || !password) {
    const err = new Error('Champs requis manquants');
    err.status = 400;
    throw err;
  }
  const { primaryRole, rolesArr } = normalizeRoles({
    role: input.role || 'lecteur',
    roles: input.roles,
  });
  const employeId = normalizeEmployeId(input.employe_id, null);
  const loginIdentifier = input.login_identifier
    ? normalizeLoginIdentifier(input.login_identifier)
    : defaultLoginIdentifier(email);
  await assertEmployeAvailableForUser(employeId);
  if (roleRequiresEmployeLink(primaryRole, rolesArr) && employeId === null) {
    const err = new Error('Un compte agent doit etre lie a une fiche agent active');
    err.status = 400;
    throw err;
  }

  const hash = bcrypt.hashSync(password, 10);
  const now = nowSql();
  try {
    return await db.transaction(async (tx) => {
      const tempPasswordHash = input.temp_password_hash ? hash : null;
      const result = await tx.execute(`
        INSERT INTO users
          (nom, prenom, email, login_identifier, password_hash, role, roles, sous_role, employe_id,
           actif, must_change_password, temp_password_hash, provisioned_by, provisioned_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        nom,
        prenom,
        email,
        loginIdentifier,
        hash,
        primaryRole,
        JSON.stringify(rolesArr),
        sous_role || null,
        employeId,
        input.actif === undefined ? 1 : (input.actif ? 1 : 0),
        input.must_change_password ? 1 : 0,
        tempPasswordHash,
        input.provisioned_by || null,
        input.provisioned_at || null,
        now,
      ]);
      const userId = result.insertId;
      await syncUserProfilesFromRoles(userId, { role: primaryRole, roles: rolesArr }, actorUserId, tx);
      await auditPermission({
        actorUserId,
        targetUserId: userId,
        tableName: 'users',
        recordId: userId,
        action: 'user_access_created',
        details: { role: primaryRole, roles: rolesArr, employe_id: employeId },
      }, tx);
      return { id: userId, nom, prenom, email, login_identifier: loginIdentifier, role: primaryRole, roles: rolesArr, employe_id: employeId };
    });
  } catch (err) {
    if (duplicateEmailError(err)) {
      const e = new Error('Email ou identifiant deja utilise');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function updateUserAccess(userId, input, actorUserId = null) {
  const id = Number(userId);
  const existing = await db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) {
    const err = new Error('Utilisateur introuvable');
    err.status = 404;
    throw err;
  }
  const currentRoles = parseRoles(existing);
  const { primaryRole, rolesArr } = normalizeRoles({
    role: input.role || existing.role,
    roles: Array.isArray(input.roles) ? input.roles : currentRoles,
  });
  const employeId = normalizeEmployeId(input.employe_id, existing.employe_id ?? null);
  const loginIdentifier = input.login_identifier
    ? normalizeLoginIdentifier(input.login_identifier)
    : normalizeLoginIdentifier(existing.login_identifier || defaultLoginIdentifier(existing.email));
  await assertEmployeAvailableForUser(employeId, id);
  if (roleRequiresEmployeLink(primaryRole, rolesArr) && employeId === null) {
    const err = new Error('Un compte agent doit etre lie a une fiche agent active');
    err.status = 400;
    throw err;
  }

  const now = nowSql();
  try {
    await db.transaction(async (tx) => {
      if (input.password) {
        await tx.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
          bcrypt.hashSync(input.password, 10),
          now,
          id,
        ]);
      }
      await tx.execute(`
        UPDATE users
        SET nom = ?, prenom = ?, email = ?, login_identifier = ?, role = ?, roles = ?, sous_role = ?, actif = ?, employe_id = ?, updated_at = ?
        WHERE id = ?
      `, [
        input.nom ?? existing.nom,
        input.prenom ?? existing.prenom ?? '',
        input.email ?? existing.email,
        loginIdentifier,
        primaryRole,
        JSON.stringify(rolesArr),
        input.sous_role ?? existing.sous_role ?? null,
        input.actif === undefined ? existing.actif : (input.actif ? 1 : 0),
        employeId,
        now,
        id,
      ]);
      await syncUserProfilesFromRoles(id, { role: primaryRole, roles: rolesArr }, actorUserId, tx);
      await auditPermission({
        actorUserId,
        targetUserId: id,
        tableName: 'users',
        recordId: id,
        action: 'user_access_updated',
        details: { role: primaryRole, roles: rolesArr, employe_id: employeId },
      }, tx);
    });
    return { id, role: primaryRole, roles: rolesArr, employe_id: employeId, login_identifier: loginIdentifier };
  } catch (err) {
    if (duplicateEmailError(err)) {
      const e = new Error('Email ou identifiant deja utilise');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function revokeEmployeeAccess(employeId, actorUserId = null, motif = '', ip = null) {
  const user = await db.queryOne('SELECT * FROM users WHERE employe_id = ?', [employeId]);
  if (!user) return null;
  const now = nowSql();
  await db.transaction(async (tx) => {
    await tx.execute('UPDATE users SET actif = 0, updated_at = ? WHERE id = ?', [now, user.id]);
    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_access_revoked', ?, ?, ?, ?, ?)
    `, [employeId, '{"actif":1}', JSON.stringify({ motif }), actorUserId || null, now, ip || null]);
    await auditPermission({
      actorUserId,
      targetUserId: user.id,
      tableName: 'users',
      recordId: user.id,
      action: 'user_access_revoked',
      details: { employe_id: employeId, motif },
    }, tx);
  });
  return { user_id: user.id, email: user.email, revoked: true };
}

module.exports = {
  VALID_ROLES,
  parseRoles,
  normalizeRoles,
  normalizeEmployeId,
  roleRequiresEmployeLink,
  assertEmployeAvailableForUser,
  createUserAccess,
  updateUserAccess,
  revokeEmployeeAccess,
};
