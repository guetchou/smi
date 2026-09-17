'use strict';
/*
 * Les ecrans qui n'appartiennent qu'a la direction.
 *
 * Le menu portait un groupe « Direction » etiquete data-roles="admin,dg".
 * Cet attribut n'etait lu par personne : une intention ecrite, jamais
 * executee. En mesurant les sept entrees du groupe avec le jeton d'une
 * assistante de direction (compte 2, le 17/09/2026), six lui sont accordees
 * volontairement par le serveur — le parapheur par une regle qui nomme son
 * role a la main. L'etiquette du groupe etait donc perimee : « Direction »
 * y designe un voisinage de travail, pas un perimetre d'acces.
 *
 * Deux ecrans seulement relevent vraiment de la direction, et le produit se
 * contredisait sur les deux :
 *
 *   - « bilan » porte le compte de resultat mensuel de la societe et n'etait
 *     garde que par requireModule('cash'), que tout caissier detient ;
 *   - « audit » etait affiche au menu puis refuse par le serveur en 403.
 *
 * Ces ecrans-la ne se gouvernent pas par module : un module dit un domaine
 * de travail, pas un niveau de responsabilite. Ils se gouvernent par role.
 *
 * Cette liste est la seule. Le menu la relit cote navigateur — voir
 * PAGE_ROLES dans frontend/js/core/navigation.js — et une garde verifie que
 * les deux cotes ne divergent pas.
 */

const ECRANS_DE_DIRECTION = Object.freeze({
  bilan: Object.freeze(['admin', 'dg']),
  audit: Object.freeze(['admin', 'dg']),
});

/** Les roles admis sur cet ecran, ou null s'il n'est pas reserve. */
function rolesAdmisSurLEcran(ecran) {
  return ECRANS_DE_DIRECTION[ecran] || null;
}

module.exports = { ECRANS_DE_DIRECTION, rolesAdmisSurLEcran };
