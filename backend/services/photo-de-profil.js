'use strict';
/*
 * Sa propre photo n'est pas un réglage de l'application.
 *
 * La porte de /api/config exemptait « GET /me » — lire sa propre fiche — mais
 * pas « POST /me/photo ». Changer sa photo retombait donc sur le garde de
 * droit commun de cette porte : requireModule(['settings','access']).
 *
 * Mesuré en production le 16/09/2026, jeton de LOUVOUEZO (compte 2,
 * assistante_direction, onze modules dont aucun n'est settings ni access) :
 *
 *   GET  /api/config/me         -> 200
 *   POST /api/config/me/photo   -> 403 {"error":"Module non assigné à votre
 *                                       compte","module":"settings,access"}
 *
 * L'avatar de la barre latérale s'ouvrait, le sélecteur de fichier s'ouvrait,
 * et l'envoi était refusé. Sur les trois comptes actifs, les deux qui
 * pouvaient changer leur photo étaient administrateurs ; le seul agent
 * ordinaire ne le pouvait pas — et ce sera le cas de tout compte créé sans
 * droit d'administration.
 *
 * Le module « settings » gouverne les réglages de la société. La photo d'un
 * agent n'en est pas un : elle ne regarde que lui, la route ne lit que
 * req.user.id et n'accepte aucun identifiant en paramètre.
 */

/** Vrai lorsque la requête ne touche qu'à la photo de l'agent connecté. */
function estSaProprePhoto(methode, chemin) {
  return methode === 'POST' && chemin === '/me/photo';
}

module.exports = { estSaProprePhoto };
