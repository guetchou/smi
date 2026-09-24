'use strict';
/*
 * Quels rôles sont soumis au périmètre des caisses affectées — nommés, pas déduits.
 *
 * La règle vivait dans `routes/operations.js` sous la forme de deux fonctions,
 * et tout rôle qui n'était ni global ni `caissier` obtenait un accès non
 * restreint **par retombée** : rien ne le disait, c'était le `else` implicite.
 * Un `rh`, un `lecteur`, une `assistante_direction` ou un `delegue` voyaient donc
 * toutes les caisses sans qu'aucune ligne ne l'assume.
 *
 * Ce module nomme les trois groupes. Il ne change aucun défaut : la classe
 * « transition » se comporte exactement comme la retombée d'avant. La différence
 * est qu'elle est désormais visible, donc discutable, donc modifiable en un seul
 * endroit.
 *
 * ── Pourquoi on ne bascule pas « transition » vers « affecté » ici ─────────────
 *
 * Parce que `user_cashboxes` peut être vide. Une bascule vers le deny-by-default
 * sur une table d'affectations vide ne restreint pas l'accès : elle le supprime.
 * L'ordre est donc : semer les affectations, vérifier qu'aucun compte ne resterait
 * sans caisse (scripts/audit_perimetre_caisse.js), puis seulement basculer.
 *
 * Relevé de production au 23/09/2026 : 7 comptes, 0 affectation, 3 caisses
 * actives. Les 4 comptes actifs sont tous globaux — trois par `admin`, un par
 * `finance` porté dans `users.roles`. Un compte inactif porte `caissier` sans
 * rôle global : il est déjà soumis au périmètre, et ne voit donc déjà rien.
 */

const { hasRole } = require('./roles');

/* Jamais restreints. `hasRole` accorde `admin` implicitement, donc l'admin passe
   par ce chemin même si on ne le nommait pas — on le nomme quand même. */
const ROLES_GLOBAUX = ['admin', 'dg', 'finance'];

/* Ne voient que les caisses qui leur sont affectées. */
const ROLES_SOUMIS_A_AFFECTATION = ['caissier'];

/* Aujourd'hui non restreints, et en attente d'arbitrage. Les nommer ici retire
   la retombée implicite sans rien changer à leur accès. */
const ROLES_EN_TRANSITION = ['rh', 'lecteur', 'assistante_direction', 'delegue'];

function estGlobal(user) {
  return hasRole(user, ...ROLES_GLOBAUX);
}

function estSoumisAAffectation(user) {
  return hasRole(user, ...ROLES_SOUMIS_A_AFFECTATION) && !estGlobal(user);
}

/**
 * La classe d'un compte : 'global', 'affecte' ou 'transition'.
 * Un compte sans aucun rôle connu tombe en 'transition' — la classe la moins
 * restrictive, pour qu'une donnée inattendue n'enferme personne dehors.
 */
function classer(user) {
  if (estGlobal(user)) return 'global';
  if (estSoumisAAffectation(user)) return 'affecte';
  return 'transition';
}

module.exports = {
  ROLES_GLOBAUX,
  ROLES_SOUMIS_A_AFFECTATION,
  ROLES_EN_TRANSITION,
  estGlobal,
  estSoumisAAffectation,
  classer,
};
