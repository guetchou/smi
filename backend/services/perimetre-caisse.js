'use strict';
/*
 * Quels rôles échappent au périmètre des caisses affectées — et eux seuls.
 *
 * La règle vivait dans `routes/operations.js`, et tout rôle qui n'était ni global
 * ni `caissier` obtenait un accès non restreint **par retombée** : rien ne le
 * disait, c'était le `else` implicite. Créer un rôle revenait donc à lui donner
 * toutes les caisses, sans que personne l'ait décidé.
 *
 * Décision produit du 23/09/2026 : la liste des rôles globaux est FERMÉE, et tout
 * ce qui n'y figure pas est soumis aux caisses affectées. Le défaut est passé de
 * « tout ouvert » à « restreint », et un rôle futur sera restreint sans qu'on ait
 * à y penser.
 *
 * ── Ce que le périmètre ne fait pas ───────────────────────────────────────────
 *
 * Il ne donne aucun accès et n'en retire aucun au sens fonctionnel. La permission
 * reste le premier contrôle : un compte sans le module « cash » est refusé avant
 * d'arriver ici. Le périmètre ne fait que limiter QUELLES positions un compte
 * déjà autorisé peut voir et utiliser.
 *
 * C'est pourquoi la bascule a pu se faire sans rien semer : au 23/09/2026, les
 * cinq comptes détenant une permission `cash` sont tous globaux. Les deux comptes
 * que le verrou d'audit signalait n'ont aucune permission `cash` — ils ne
 * perdaient donc rien. Le verrou (scripts/audit_perimetre_caisse.js) le vérifie
 * désormais explicitement, pour que cela reste vrai quand les comptes changeront.
 */

const { hasRole } = require('./roles');

/* ── Décision produit du 23/09/2026 ───────────────────────────────────────────
 *
 * Seuls ces trois rôles échappent au périmètre. La liste est FERMÉE : tout rôle
 * qui n'y figure pas est soumis aux caisses affectées, y compris un rôle qui
 * n'existe pas encore. C'est l'inverse de la situation d'avant, où l'accès non
 * restreint s'obtenait par retombée — et donc où créer un rôle revenait à lui
 * donner tout, sans que personne l'ait décidé.
 *
 * `hasRole` accorde `admin` implicitement ; on le nomme quand même. */
const ROLES_GLOBAUX = ['admin', 'dg', 'finance'];

/* Indicatif, pour la lecture et pour le script d'audit : les rôles connus qui
   tombent du côté « soumis à affectation ». La règle ne s'appuie PAS sur cette
   liste — elle s'appuie sur l'absence de rôle global — sinon un rôle ajouté
   demain retomberait dans l'accès total sans qu'on s'en aperçoive. */
const ROLES_SOUMIS_A_AFFECTATION_CONNUS = [
  'caissier', 'rh', 'lecteur', 'assistante_direction', 'delegue',
];

function estGlobal(user) {
  return hasRole(user, ...ROLES_GLOBAUX);
}

/*
 * Le périmètre NE DONNE PAS l'accès aux opérations financières : la permission
 * fonctionnelle reste le premier contrôle, et un compte sans module « cash » est
 * déjà refusé avant d'arriver ici. Le périmètre ne fait que restreindre les
 * positions visibles et utilisables à celles qui lui sont affectées.
 */
function estSoumisAAffectation(user) {
  return !estGlobal(user);
}

/** La classe d'un compte : 'global' ou 'affecte'. Il n'y a plus de troisième. */
function classer(user) {
  return estGlobal(user) ? 'global' : 'affecte';
}

module.exports = {
  ROLES_GLOBAUX,
  ROLES_SOUMIS_A_AFFECTATION_CONNUS,
  estGlobal,
  estSoumisAAffectation,
  classer,
};
