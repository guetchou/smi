'use strict';
/**
 * UserProvisioningService — Création de compte utilisateur pour un employé
 *
 * Règles métier :
 * R1 - Jamais de compte sans rôle défini
 * R2 - Jamais d'attribution du rôle admin par défaut
 * R3 - Rôle par défaut : lecteur
 * R4 - Mot de passe temporaire avec must_change_password = 1
 * R5 - Mot de passe jamais envoyé en clair (seulement haché en DB)
 * R6 - Un employé sorti ne peut pas recevoir un compte
 * R7 - Un employé ne peut avoir qu'un seul compte (contrainte unique employe_id)
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../database');

const ROLES_VALIDES = ['admin','caissier','finance','rh','lecteur','dg','assistante_direction','delegue'];
const ROLE_DEFAUT   = 'lecteur';

// Génère un mot de passe temporaire lisible (8 chars alphanum)
function genTempPassword() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * Crée un compte utilisateur pour un employé.
 *
 * @param {number} employe_id
 * @param {object} opts  - { role, email, nom_affiche, provisioned_by }
 * @returns {{ user_id, temp_password, must_change_password }}
 */
function provisionUser(employe_id, opts, ip) {
  const employe = db.prepare('SELECT * FROM employes WHERE id = ?').get(employe_id);
  if (!employe) throw new Error(`Employé #${employe_id} introuvable`);
  if (employe.statut_dossier === 'sorti') throw new Error('Impossible de créer un compte pour un employé sorti');

  // Vérifier qu'il n'a pas déjà un compte
  const existing = db.prepare('SELECT id, email FROM users WHERE employe_id = ?').get(employe_id);
  if (existing) throw new Error(`L'employé a déjà un compte (user #${existing.id} — ${existing.email})`);

  const role = opts.role && ROLES_VALIDES.includes(opts.role) ? opts.role : ROLE_DEFAUT;
  if (role === 'admin') throw new Error('Attribution du rôle admin interdite via provisioning — faire manuellement');

  // Email : priorité email_professionnel, puis email, puis dériver du matricule
  const email = opts.email
    || employe.email_professionnel
    || employe.email
    || `${employe.matricule.toLowerCase()}@topcenter.cg`;

  // Vérifier unicité email
  const emailExist = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (emailExist) throw new Error(`Email déjà utilisé par un autre compte : ${email}`);

  const nom = opts.nom_affiche || `${employe.prenom} ${employe.nom}`;
  const tempPwd = genTempPassword();
  const hash    = bcrypt.hashSync(tempPwd, 10);
  const now     = new Date().toISOString();

  let user_id;
  db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO users
        (nom, email, password_hash, role, actif, must_change_password,
         temp_password_hash, employe_id, provisioned_by, provisioned_at, created_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
    `).run(nom, email, hash, role, hash, employe_id, opts.provisioned_by || null, now, now);

    user_id = r.lastInsertRowid;

    // Marquer tâche onboarding create_user_account si elle existe
    db.prepare(`
      UPDATE onboarding_tasks
      SET status = 'done', completed_at = ?, completed_by = ?, notes = ?, updated_at = ?
      WHERE employe_id = ? AND task_key = 'create_user_account' AND status != 'done'
    `).run(now, opts.provisioned_by || null, `Compte créé : ${email} (rôle: ${role})`, now, employe_id);

    // Journal onboarding
    db.prepare(`
      INSERT INTO onboarding_events (employe_id, event_type, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_account_created', ?, ?, ?, ?)
    `).run(employe_id, JSON.stringify({ user_id, email, role }), opts.provisioned_by || null, now, ip || null);

    // Recalc statut onboarding
    const { recalcStatus } = _internal();
    recalcStatus(employe_id, now);
  })();

  // Retourner le mot de passe temporaire en clair UNE SEULE FOIS
  // (ne jamais le stocker en clair — c'est la seule fois qu'il est visible)
  return { user_id, email, role, temp_password: tempPwd, must_change_password: 1 };
}

/**
 * Désactiver le compte lié à un employé (sortie).
 */
function revoquerAcces(employe_id, by, motif, ip) {
  const user = db.prepare('SELECT * FROM users WHERE employe_id = ?').get(employe_id);
  if (!user) return null; // pas de compte à révoquer

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE users SET actif = 0, updated_at = ? WHERE id = ?').run(now, user.id);

    db.prepare(`
      INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_access_revoked', ?, ?, ?, ?, ?)
    `).run(employe_id, '{"actif":1}', JSON.stringify({ motif }), by || null, now, ip || null);
  })();

  return { user_id: user.id, email: user.email, revoked: true };
}

/**
 * Obtenir le compte lié à un employé.
 */
function getUserForEmploye(employe_id) {
  return db.prepare(
    'SELECT id, nom, email, role, actif, must_change_password, date_premier_login, provisioned_at FROM users WHERE employe_id = ?'
  ).get(employe_id) || null;
}

// Référence circulaire évitée : recalcStatus importé de onboarding.js si dispo
function _internal() {
  try {
    return require('./onboarding');
  } catch (_) {
    return { recalcStatus: () => {} };
  }
}

module.exports = { provisionUser, revoquerAcces, getUserForEmploye, ROLES_VALIDES, ROLE_DEFAUT };
