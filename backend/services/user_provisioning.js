'use strict';

/**
 * UserProvisioningService — Création de compte utilisateur pour un employé
 *
 * R1 - Jamais de compte sans rôle défini
 * R1b- Jamais de compte sans profil actif : le rôle ne suffit pas, car les
 *      permissions viennent des profils et la dérivation rôle → profil ne
 *      couvre que les huit profils homonymes d'un rôle
 * R2 - Jamais d'attribution du rôle admin par défaut, ni du profil admin
 * R3 - Rôle par défaut : lecteur
 * R4 - Mot de passe temporaire avec must_change_password = 1
 * R5 - Mot de passe jamais envoyé en clair (seulement haché en DB)
 * R6 - Un employé sorti ne peut pas recevoir un compte
 * R7 - Un employé ne peut avoir qu'un seul compte
 */

const crypto = require('crypto');
const db     = require('../db');
const identityAccess = require('./identity_access');

const ROLES_VALIDES = identityAccess.VALID_ROLES;
const ROLE_DEFAUT   = 'lecteur';

/* Le profil est attaché avec source='manual' : syncUserProfilesFromRoles, qui
   tourne à la création, ne touche que les lignes source='legacy_role' et
   préserve explicitement les lignes manuelles. C'est le point d'extension
   prévu par le modèle, pas un contournement. */
async function profilValide(code) {
  if (!code) return null;
  return db.queryOne('SELECT id, code, libelle FROM profiles WHERE code = ? AND actif = 1', [code]);
}

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

  // R1b — sans profil, le compte n'a aucun droit : la dérivation rôle → profil
  // écarte 'lecteur' et ne connaît pas les onze profils métier.
  if (!opts.profile_code) throw new Error('Le profil est requis : un compte sans profil n\'a aucun droit');
  if (opts.profile_code === 'admin') throw new Error('Attribution du profil admin interdite via provisioning — faire manuellement');
  const profil = await profilValide(opts.profile_code);
  if (!profil) throw new Error(`Profil inconnu ou inactif : ${opts.profile_code}`);

  const email = opts.email
    || employe.email_professionnel
    || employe.email
    || `${employe.matricule.toLowerCase()}@topcenter.cg`;

  const emailExist = await db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (emailExist) throw new Error(`Email déjà utilisé par un autre compte : ${email}`);

  const nom     = opts.nom_affiche || `${employe.prenom} ${employe.nom}`;
  const tempPwd = genTempPassword();
  const now     = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const created = await identityAccess.createUserAccess({
    nom,
    email,
    password: tempPwd,
    role,
    roles: [role],
    employe_id,
    must_change_password: true,
    temp_password_hash: true,
    provisioned_by: opts.provisioned_by || null,
    provisioned_at: now,
  }, opts.provisioned_by || null);
  const user_id = created.id;

  await db.transaction(async (tx) => {
    // source='manual' : la synchronisation par rôle ne l'écrasera pas.
    await tx.execute(`
      INSERT INTO user_profiles (user_id, profile_id, active, source, created_by, updated_at)
      VALUES (?, ?, 1, 'manual', ?, NOW())
      ON DUPLICATE KEY UPDATE active=1, source='manual', updated_at=NOW()
    `, [user_id, profil.id, opts.provisioned_by || null]);

    await tx.execute(`
      UPDATE onboarding_tasks
      SET status = 'done', completed_at = ?, completed_by = ?, notes = ?, updated_at = ?
      WHERE employe_id = ? AND task_key = 'create_user_account' AND status != 'done'
    `, [now, opts.provisioned_by || null, `Compte créé : ${email} (rôle: ${role})`, now, employe_id]);

    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, new_value, created_by, created_at, ip_address)
      VALUES (?, 'user_account_created', ?, ?, ?, ?)
    `, [employe_id, JSON.stringify({ user_id, email, role, profil: profil.code }), opts.provisioned_by || null, now, ip || null]);

    const { recalcStatus } = _internal();
    if (typeof recalcStatus === 'function') await recalcStatus(employe_id, now);
  });

  return { user_id, email, role, profil: profil.code, temp_password: tempPwd, must_change_password: 1 };
}

async function revoquerAcces(employe_id, by, motif, ip) {
  return identityAccess.revokeEmployeeAccess(employe_id, by, motif, ip);
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

async function profilsDisponibles() {
  return db.query(`
    SELECT pr.code, pr.libelle, COUNT(pp.permission_id) AS nb_permissions
    FROM profiles pr
    LEFT JOIN profile_permissions pp ON pp.profile_id = pr.id AND pp.allowed = 1
    WHERE pr.actif = 1 AND pr.code <> 'admin'
    GROUP BY pr.id
    ORDER BY pr.libelle
  `);
}

module.exports = { provisionUser, revoquerAcces, getUserForEmploye, profilsDisponibles, ROLES_VALIDES, ROLE_DEFAUT };
