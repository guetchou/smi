'use strict';

/**
 * UserProvisioningService — Création de compte utilisateur pour un employé
 *
 * R1 - Jamais de compte sans rôle défini
 * R2 - Jamais d'attribution du rôle admin par défaut
 * R3 - Rôle par défaut : lecteur
 * R4 - Mot de passe temporaire avec must_change_password = 1
 * R5 - Mot de passe jamais envoyé en clair (seulement haché en DB)
 * R6 - Un employé sorti ne peut pas recevoir un compte
 * R7 - Un employé ne peut avoir qu'un seul compte
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { syncUserProfilesFromRoles } = require('./permissions');

const ROLES_VALIDES = ['admin','caissier','finance','rh','lecteur','dg','assistante_direction','delegue'];
const ROLE_DEFAUT   = 'lecteur';

function genTempPassword() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

async function provisionUser(employe_id, opts, ip) {
  const employe = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employe_id]);
  if (!employe) throw new Error(`Employé #${employe_id} introuvable`);
  if (employe.statut_dossier === 'sorti') throw new Error('Impossible de créer un compte pour un employé sorti');

  const existing = await db.queryOne('SELECT id, email FROM users WHERE employe_id = ?', [employe_id]);
  if (existing) throw new Error(`L'employé a déjà un compte (user #${existing.id} — ${existing.email})`);

  const role = opts.role && ROLES_VALIDES.includes(opts.role) ? opts.role : ROLE_DEFAUT;
  if (role === 'admin') throw new Error('Attribution du rôle admin interdite via provisioning — faire manuellement');

  const email = opts.email
    || employe.email_professionnel
    || employe.email
    || `${employe.matricule.toLowerCase()}@topcenter.cg`;

  const emailExist = await db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (emailExist) throw new Error(`Email déjà utilisé par un autre compte : ${email}`);

  const nom     = opts.nom_affiche || `${employe.prenom} ${employe.nom}`;
  const tempPwd = genTempPassword();
  const hash    = bcrypt.hashSync(tempPwd, 10);
  const now     = new Date().toISOString().slice(0, 19).replace('T', ' ');

  let user_id;
  await db.transaction(async (tx) => {
    const r = await tx.execute(`
      INSERT INTO users
        (nom, email, password_hash, role, actif, must_change_password,
         temp_password_hash, employe_id, provisioned_by, provisioned_at, created_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
    `, [nom, email, hash, role, hash, employe_id, opts.provisioned_by || null, now, now]);

    user_id = r.insertId;

    await tx.execute(`
      UPDATE onboarding_tasks
      SET status = 'done', completed_at = ?, completed_by = ?, notes = ?, updated_at = ?
      WHERE employe_id = ? AND task_key = 'create_user_account' AND status != 'done'
    `, [now, opts.provisioned_by || null, `Compte créé : ${email} (rôle: ${role})`, now, employe_id]);

    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_account_created', ?, ?, ?, ?)
    `, [employe_id, JSON.stringify({ user_id, email, role }), opts.provisioned_by || null, now, ip || null]);

    const { recalcStatus } = _internal();
    if (typeof recalcStatus === 'function') await recalcStatus(employe_id, now);

    await syncUserProfilesFromRoles(user_id, { role, roles: [role] }, opts.provisioned_by || null, tx);
  });

  return { user_id, email, role, temp_password: tempPwd, must_change_password: 1 };
}

async function revoquerAcces(employe_id, by, motif, ip) {
  const user = await db.queryOne('SELECT * FROM users WHERE employe_id = ?', [employe_id]);
  if (!user) return null;

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.transaction(async (tx) => {
    await tx.execute('UPDATE users SET actif = 0, updated_at = ? WHERE id = ?', [now, user.id]);
    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_access_revoked', ?, ?, ?, ?, ?)
    `, [employe_id, '{"actif":1}', JSON.stringify({ motif }), by || null, now, ip || null]);
  });

  return { user_id: user.id, email: user.email, revoked: true };
}

async function getUserForEmploye(employe_id) {
  return db.queryOne(
    'SELECT id, nom, email, role, actif, must_change_password, date_premier_login, provisioned_at FROM users WHERE employe_id = ?',
    [employe_id]
  ) || null;
}

function _internal() {
  try { return require('./onboarding'); } catch (_) { return { recalcStatus: () => {} }; }
}

module.exports = { provisionUser, revoquerAcces, getUserForEmploye, ROLES_VALIDES, ROLE_DEFAUT };
