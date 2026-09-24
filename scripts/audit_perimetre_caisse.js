'use strict';
/*
 * Qui perdrait l'accès si le périmètre des caisses se fermait ?
 *
 * Ce script est le verrou d'une bascule. Fermer le périmètre sur une table
 * `user_cashboxes` vide ne restreint pas l'accès : il le supprime. On ne bascule
 * donc qu'après avoir semé les affectations, et ce script dit si c'est fait.
 *
 * STRICTEMENT EN LECTURE. Il n'émet que des SELECT ; il peut être exécuté contre
 * la production sans précaution.
 *
 * Usage :
 *   node scripts/audit_perimetre_caisse.js              état actuel
 *   node scripts/audit_perimetre_caisse.js --bascule    état APRÈS bascule des
 *                                                       rôles « en transition »
 *
 * Code de sortie : 0 si aucun compte ACTIF ne serait privé d'accès, 1 sinon.
 * C'est ce qui permet de s'en servir comme garde avant migration.
 */

const path = require('path');

const racine = path.resolve(__dirname, '..');
const db = require(path.join(racine, 'backend', 'db'));
const {
  ROLES_GLOBAUX,
  ROLES_SOUMIS_A_AFFECTATION,
  ROLES_EN_TRANSITION,
  classer,
} = require(path.join(racine, 'backend', 'services', 'perimetre-caisse'));

const bascule = process.argv.includes('--bascule');

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
  const caisses = await db.queryOne('SELECT COUNT(*) AS n FROM positions WHERE actif = 1', []);

  const parUtilisateur = new Map(affectations.map(a => [Number(a.user_id), Number(a.n)]));

  console.log(`Caisses actives : ${caisses ? caisses.n : 0}`);
  console.log(`Affectations en lecture : ${affectations.length} compte(s) servi(s)`);
  console.log(`Mode : ${bascule ? 'APRÈS bascule des rôles en transition' : 'état actuel'}`);
  console.log(`Rôles globaux : ${ROLES_GLOBAUX.join(', ')}`);
  console.log(`Rôles soumis à affectation : ${ROLES_SOUMIS_A_AFFECTATION.join(', ')}`);
  console.log(`Rôles en transition : ${ROLES_EN_TRANSITION.join(', ')}`);
  console.log('');

  const bloques = [];
  const compte = { global: 0, affecte: 0, transition: 0 };

  for (const ligne of comptes) {
    const utilisateur = { role: ligne.role, roles: rolesDe(ligne) };
    let classe = classer(utilisateur);
    /* La bascule envisagée : « transition » rejoint « soumis à affectation ». */
    if (bascule && classe === 'transition') classe = 'affecte';
    compte[classe] += 1;

    if (classe !== 'affecte') continue;
    const nb = parUtilisateur.get(Number(ligne.id)) || 0;
    if (nb === 0) {
      bloques.push({
        id: ligne.id,
        role: ligne.role,
        roles: utilisateur.roles.join('+'),
        actif: ligne.actif,
      });
    }
  }

  console.log(`Répartition : ${compte.global} global(aux), ${compte.affecte} soumis à affectation, `
    + `${compte.transition} en transition`);
  console.log('');

  /* Le verrou porte sur les comptes ACTIFS : eux seuls peuvent se connecter et
     donc perdre un accès. Un compte inactif est signalé sans bloquer — sinon le
     verrou refuserait indéfiniment pour des comptes que personne n'utilise, et un
     verrou qui refuse toujours finit par être contourné. */
  const actifs = bloques.filter(b => Number(b.actif) === 1);
  const inactifs = bloques.filter(b => Number(b.actif) !== 1);
  const decrire = b => `  - id ${b.id} · role ${b.role} · rôles ${b.roles}`;

  if (inactifs.length) {
    console.log(`${inactifs.length} compte(s) INACTIFS n'auraient aucune caisse :`);
    for (const b of inactifs) console.log(decrire(b));
    console.log('  → sans effet tant qu\'ils ne sont pas réactivés, mais à semer avant de les rouvrir.');
    console.log('');
  }

  if (!actifs.length) {
    console.log('Aucun compte ACTIF ne serait privé d\'accès : la bascule est sans effet de bord.');
    return 0;
  }

  console.log(`${actifs.length} compte(s) ACTIFS seraient privés de toute caisse :`);
  for (const b of actifs) console.log(decrire(b));
  console.log('');
  console.log('Semer leurs affectations dans user_cashboxes avant toute bascule.');
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
