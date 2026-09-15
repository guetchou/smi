'use strict';
/*
 * La référence externe : quand elle est obligatoire, et quand elle ne l'est pas.
 *
 * Défaut du 15/09/2026, mesuré en production avec les droits réels de
 * l'assistante de direction : le transfert interne de trésorerie est
 * impossible à enregistrer.
 *
 *   POST /api/operations  {type_op:"virement", mode_reglement:"virement_bancaire"}
 *   → 400 « Référence externe obligatoire pour chèque, virement bancaire
 *           ou mobile money »
 *
 * Le tableau de bord propose le bouton « Transfert » à côté d'« Encaisser » et
 * de « Décaisser ». La fenêtre annonce « Déplacement entre positions, sans
 * charge ni produit » et présente « Référence externe » SANS astérisque —
 * donc facultative. Le serveur, lui, l'exige. L'agent remplit tout, clique, et
 * reçoit un message qui parle de chèque et de mobile money alors qu'il déplace
 * simplement de l'argent de la caisse vers la banque.
 *
 * Mesure : sur les 727 opérations de l'historique complet sauvegardé avant la
 * remise à zéro du 02/09/2026 — 672 décaissements, 55 encaissements — il y a
 * ZÉRO virement. La fonction est offerte depuis toujours et n'a jamais produit
 * une seule ligne.
 *
 * La règle elle-même est juste, et on ne l'affaiblit pas : un chèque, un
 * virement bancaire ou un mobile money est un règlement AVEC UN TIERS, et sa
 * référence est la seule chose qui rattache l'écriture à l'instrument
 * bancaire. Sans elle, le rapprochement est impossible.
 *
 * Mais un transfert interne n'a pas de tiers. Il déplace de l'argent entre
 * deux positions de l'entreprise. Sa traçabilité est portée par le couple
 * position source / position destination et par son numéro de pièce VIR-….
 * Exiger de lui la référence d'un instrument qui n'existe pas rend la
 * fonction inutilisable, ce qu'elle a été jusqu'ici.
 *
 * Second défaut corrigé au passage : cette règle était écrite TROIS fois —
 * backend/routes/operations.js, backend/services/finance-operation-canonical.js
 * et backend/services/cash-receipt-workflow.js. Trois copies d'une même règle
 * finissent par diverger, exactement comme deux tables tenues séparément.
 * Elles lisent désormais toutes les trois ce module.
 */

/* « virement » est l'ancien libellé de « virement_bancaire » ; « carte » a été
   versée dans « autres ». Sans valeur, le mode est l'espèce. */
function normaliserMode(valeur) {
  if (valeur === 'virement') return 'virement_bancaire';
  if (valeur === 'carte') return 'autres';
  return valeur || 'especes';
}

/* Les trois instruments de règlement qui portent une référence opposable. */
const MODES_A_REFERENCE = ['cheque', 'virement_bancaire', 'mobile_money'];

function modeExigeReferenceExterne(mode) {
  return MODES_A_REFERENCE.includes(normaliserMode(mode));
}

/* Un transfert interne déplace de l'argent entre deux positions de
   l'entreprise. Il n'a pas de tiers, donc pas d'instrument de règlement dont
   porter la référence. */
function estTransfertInterne(typeOp) {
  return String(typeOp || '').trim().toLowerCase() === 'virement';
}

/* La référence est obligatoire quand le mode est un instrument à référence ET
   que l'opération a bien un tiers en face. */
function referenceExterneObligatoire({ type_op, mode_reglement } = {}) {
  if (estTransfertInterne(type_op)) return false;
  return modeExigeReferenceExterne(mode_reglement);
}

const MESSAGE_REFERENCE_REQUISE =
  'Référence externe obligatoire pour chèque, virement bancaire ou mobile money';

module.exports = {
  MODES_A_REFERENCE,
  MESSAGE_REFERENCE_REQUISE,
  normaliserMode,
  modeExigeReferenceExterne,
  estTransfertInterne,
  referenceExterneObligatoire,
};
