'use strict';
/*
 * Porte-t-il ce rôle ?
 *
 * Fonction pure sur `user.role` et `user.roles`. Elle vivait dans
 * `routes/auth.js`, qui jette au chargement si `JWT_SECRET` est absent : tout
 * module voulant classer un utilisateur se retrouvait donc à exiger un secret
 * d'authentification dont il n'avait aucun besoin — un script d'audit en lecture
 * seule, par exemple.
 *
 * Le code est déplacé tel quel, sans une virgule de changement, et `routes/auth.js`
 * le ré-exporte : aucun des appelants ne bouge.
 *
 * `admin` est un raccourci : il satisfait n'importe quelle demande de rôle.
 */

function hasRole(user, ...roles) {
  if (!user) return false;
  const userRoles = Array.isArray(user.roles) ? user.roles : [user.role];
  if (user.role === 'admin' || userRoles.includes('admin')) return true;
  return roles.some(r => userRoles.includes(r));
}

module.exports = { hasRole };
