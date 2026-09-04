'use strict';

/*
 * Garde — un changement de droits doit prendre effet, dans les deux sens.
 *
 * Constaté le 04/09/2026. Le rôle « caissier » avait été activé pour une
 * utilisatrice, la base le portait bien —
 * users.roles = ["assistante_direction","finance","caissier","rh"] — et le
 * système lui refusait pourtant l'enregistrement d'un encaissement.
 *
 * Cause : requireAuth ne relit jamais l'utilisateur. Il fait
 * « req.user = decoded », le contenu du jeton, figé à la connexion. Un droit
 * accordé après reste invisible ; un droit RETIRÉ reste actif jusqu'à
 * l'expiration, soit vingt-quatre heures.
 *
 * La liste de révocation existante n'y pouvait rien : indexée par jeton
 * (jti), en mémoire, donc incapable de viser une personne et perdue à chaque
 * redémarrage — c'est-à-dire à chaque déploiement.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const lire = (...p) => fs.readFileSync(path.join(racine, ...p), 'utf8');

const auth = lire('backend', 'routes', 'auth.js');
const identite = lire('backend', 'services', 'identity_access.js');
const operations = lire('backend', 'routes', 'operations.js');
const serveur = lire('backend', 'server.js');
const migration = lire('backend', 'migrations', '057_sessions_revocation.sql');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  const ouverture = source.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < source.length; j++) {
    if (source[j] === '{') profondeur++;
    else if (source[j] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. La coupure survit aux redéploiements ──
   Une révocation gardée seulement en mémoire est perdue au redémarrage, et
   l'application redémarre à chaque livraison : le droit retiré redeviendrait
   actif tout seul. */
assert(
  /sessions_invalides_avant/.test(migration),
  'La coupure doit être portée par une colonne, pas seulement par la mémoire'
);
assert(
  /sessions_invalides_avant/.test(auth),
  'auth.js doit lire et écrire cette colonne'
);

/* ── 2. Le jeton périmé est refusé ── */
const requireAuth = corpsDe(auth, 'function requireAuth(');
assert(
  /sessionCoupee\(decoded\)/.test(requireAuth),
  'requireAuth doit refuser un jeton émis avant la coupure'
);

const coupee = corpsDe(auth, 'function sessionCoupee(');
assert(/decoded\.iat/.test(coupee), "La comparaison doit porter sur l'émission du jeton (iat)");
assert(
  /if \(!coupure/.test(coupee),
  "Sans coupure enregistrée, aucun jeton ne doit être refusé : absent n'est pas périmé"
);

/* ── 3. Changer les rôles coupe les sessions ──
   L'invariant n'est pas « la fonction existe », c'est qu'elle soit appelée
   là où les droits changent. */
assert(
  /revoquerSessionsUtilisateur\(id, tx\)/.test(identite),
  'La mise à jour des droits doit couper les sessions de la personne concernée'
);
assert(
  /rolesAvant !== rolesApres/.test(identite),
  'La coupure doit être conditionnée à un vrai changement : sinon toute modification de nom déconnecterait'
);
assert(
  /actifAvant !== actifApres/.test(identite),
  'Désactiver un compte doit aussi couper ses sessions : c est le cas qui presse le plus'
);

/* La révocation participe à la transaction : si la mise à jour échoue, la
   coupure ne doit pas subsister seule. */
assert(
  /revoquerSessionsUtilisateur\(userId, dbc = db\)/.test(auth),
  'La révocation doit accepter le contexte transactionnel de l appelant'
);

/* ── 4. Les coupures sont rechargées au démarrage, après les migrations ──
   Les charger avant créerait une lecture sur une colonne qui n'existe pas
   encore, au premier démarrage qui suit la livraison. */
const posMigrations = serveur.indexOf('runMigrations');
const posChargement = serveur.indexOf('chargerCoupuresDeSession');
assert(posChargement !== -1, 'Les coupures doivent être rechargées au démarrage');
assert(
  posMigrations < posChargement,
  'Le rechargement doit venir APRÈS les migrations : la colonne y est créée'
);

const chargement = corpsDe(auth, 'async function chargerCoupuresDeSession(');
assert(
  /catch \(error\)/.test(chargement),
  "Une lecture impossible ne doit pas empêcher le serveur de servir"
);

/* ── 5. Annuler une opération n'est plus réservé à l'administrateur ──
   Un chèque rejeté par la banque est un événement de finance. */
const suppression = corpsDe(operations, "router.delete('/:id'");
assert(
  /hasRole\(req\.user, \.\.\.DEC_CANCEL_ROLES\)/.test(suppression),
  "L'annulation doit ouvrir le même périmètre que celle des décaissements"
);
assert(
  !/hasRole\(req\.user, 'admin'\)/.test(suppression),
  "Le contrôle « admin seul » doit avoir disparu"
);
assert(
  /const DEC_CANCEL_ROLES = \['admin', 'finance', 'dg'\]/.test(operations),
  'Le périmètre reste admin, finance et DG — pas davantage'
);

/* Le motif reste exigé : élargir n'est pas relâcher. */
assert(
  /Motif d'annulation obligatoire|Motif d\\'annulation obligatoire/.test(suppression),
  'Le motif reste obligatoire après élargissement du périmètre'
);

console.log(JSON.stringify({
  cutoffOutlivesARedeploy: true,
  staleTokenIsRefused: true,
  absentCutoffRefusesNothing: true,
  changingRightsCutsTheSessions: true,
  onlyARealChangeCuts: true,
  deactivationCutsToo: true,
  revocationJoinsTheTransaction: true,
  cutoffsReloadedAfterMigrations: true,
  cancellingOpenToFinanceAndDg: true,
  reasonStillRequired: true,
}));
