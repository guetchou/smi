'use strict';
/*
 * Qui perdrait l'accès aux caisses, et est-ce que ça compte ?
 *
 * Ce script est le verrou d'une bascule, et il pose deux questions distinctes :
 *
 *   1. ce compte est-il soumis au périmètre ? (rôle non global) ;
 *   2. est-il fonctionnellement autorisé sur les opérations financières,
 *      c'est-à-dire détient-il une permission du module « cash » ?
 *
 * Seule la conjonction des deux compte. Le périmètre ne donne ni ne retire
 * l'accès fonctionnel : un compte sans permission « cash » est déjà refusé avant
 * que le périmètre ne s'applique, donc lui compter une perte serait faux — et un
 * verrou qui signale des pertes imaginaires finit par être contourné.
 *
 * STRICTEMENT EN LECTURE. Il n'émet que des SELECT ; il peut être exécuté contre
 * la production sans précaution.
 *
 * Code de sortie : 0 si aucun compte ACTIF et fonctionnellement autorisé ne
 * serait privé de toute caisse, 1 sinon.
 */

const path = require('path');

const racine = path.resolve(__dirname, '..');
const db = require(path.join(racine, 'backend', 'db'));
const {
  ROLES_GLOBAUX,
  ROLES_SOUMIS_A_AFFECTATION_CONNUS,
  classer,
} = require(path.join(racine, 'backend', 'services', 'perimetre-caisse'));

const MODULE_FINANCIER = 'cash';

function rolesDe(ligne) {
  let liste = null;
  try { liste = JSON.parse(ligne.roles); } catch (_) { liste = null; }
  return Array.isArray(liste) ? liste : [ligne.role].filter(Boolean);
}

async function main() {
  const comptes = await db.query(
    'SELECT id, role, roles, actif FROM users ORDER BY actif DESC, id',
    [],
  );

  const affectations = await db.query(
    'SELECT user_id, COUNT(*) AS n FROM user_cashboxes WHERE can_read = 1 GROUP BY user_id',
    [],
  );

  /* L'autorisation fonctionnelle : au moins une permission du module financier,
     par un profil actif. C'est le contrôle qui précède le périmètre. */
  const autorises = await db.query(`
    SELECT DISTINCT up.user_id
      FROM user_profiles up
      JOIN profile_permissions pp ON pp.profile_id = up.profile_id
      JOIN permissions p ON p.id = pp.permission_id
     WHERE up.active = 1 AND p.module = ?
  `, [MODULE_FINANCIER]);

  const caisses = await db.queryOne('SELECT COUNT(*) AS n FROM positions WHERE actif = 1', []);

  const nbAffectations = new Map(affectations.map(a => [Number(a.user_id), Number(a.n)]));
  const estAutorise = new Set(autorises.map(a => Number(a.user_id)));

  console.log(`Caisses actives : ${caisses ? caisses.n : 0}`);
  console.log(`Comptes servis par une affectation en lecture : ${affectations.length}`);
  console.log(`Comptes détenant une permission « ${MODULE_FINANCIER} » : ${estAutorise.size}`);
  console.log(`Rôles globaux (liste fermée) : ${ROLES_GLOBAUX.join(', ')}`);
  console.log(`Rôles connus soumis au périmètre : ${ROLES_SOUMIS_A_AFFECTATION_CONNUS.join(', ')}`);
  console.log('  — et tout rôle futur qui ne figure pas parmi les globaux.');
  console.log('');

  const bloquants = [];
  const sansEnjeu = [];
  let globaux = 0;
  let soumis = 0;

  for (const ligne of comptes) {
    const utilisateur = { role: ligne.role, roles: rolesDe(ligne) };
    if (classer(utilisateur) === 'global') { globaux += 1; continue; }
    soumis += 1;

    if ((nbAffectations.get(Number(ligne.id)) || 0) > 0) continue;

    const fiche = {
      id: ligne.id,
      role: ligne.role,
      roles: utilisateur.roles.join('+'),
      actif: Number(ligne.actif) === 1,
      autorise: estAutorise.has(Number(ligne.id)),
    };
    if (fiche.actif && fiche.autorise) bloquants.push(fiche);
    else sansEnjeu.push(fiche);
  }

  console.log(`Répartition : ${globaux} global(aux), ${soumis} soumis au périmètre`);
  console.log('');

  const decrire = f => `  - id ${f.id} · role ${f.role} · rôles ${f.roles}`
    + ` · ${f.actif ? 'actif' : 'inactif'}`
    + ` · ${f.autorise ? 'permission cash' : 'aucune permission cash'}`;

  if (sansEnjeu.length) {
    console.log(`${sansEnjeu.length} compte(s) soumis au périmètre et sans affectation, sans enjeu :`);
    for (const f of sansEnjeu) console.log(decrire(f));
    console.log('  → inactifs, ou déjà refusés par la permission fonctionnelle.');
    console.log('  → à affecter avant de les réactiver ou de leur donner le module.');
    console.log('');
  }

  if (!bloquants.length) {
    console.log('Aucun compte actif ET fonctionnellement autorisé ne serait privé de caisse.');
    console.log('La bascule est sans effet de bord.');
    return 0;
  }

  console.log(`${bloquants.length} compte(s) ACTIFS et AUTORISÉS seraient privés de toute caisse :`);
  for (const f of bloquants) console.log(decrire(f));
  console.log('');
  console.log('Semer leurs affectations dans user_cashboxes avant de basculer.');
  return 1;
}

main()
  .then(code => { process.exitCode = code; })
  .catch(error => {
    console.error(`ECHEC : ${error.message}`);
    process.exitCode = 2;
  })
  .finally(() => {
    if (db._pool && typeof db._pool.end === 'function') db._pool.end().catch(() => {});
  });
