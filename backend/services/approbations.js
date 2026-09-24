'use strict';
/*
 * Les approbations d'un décaissement, lues et écrites là où elles vivent déjà.
 *
 * Le PRD décrit trois bandes (PRD_operations_workflow.md §3). Celle du milieu —
 * « Finance + DG » — demande DEUX décisions distinctes, par deux personnes
 * distinctes, à deux instants distincts. `operations` ne porte qu'un seul
 * `validated_by` : y représenter deux décisions serait faux quelle que soit
 * l'astuce employée, on perdrait le premier approbateur, le second, ou l'ordre.
 *
 * ── Pourquoi aucune table nouvelle ───────────────────────────────────────────
 *
 * `parapheur_actions` est déjà un journal de décisions : `acteur_id` (qui),
 * `acteur_role` (à quel titre), `action_type`, `is_interim` (par délégation),
 * `created_at` (quand) — et son énumération contient déjà « approuve ». En créer
 * un second serait la pire duplication : deux journaux disant la même chose sans
 * jamais être d'accord. Voir docs/adr/0001-journal-des-approbations.md.
 *
 * `operations.validated_by` / `validated_at` restent la PROJECTION de la décision
 * finale : aucun lecteur existant ne change, et les anciennes opérations se lisent
 * comme avant.
 *
 * ── La règle, telle qu'elle est appliquée ────────────────────────────────────
 *
 * Le PRD écrit « Finance + DG » sans préciser d'ordre ; la décision produit du
 * 23/09/2026 retient l'ordre LIBRE. La bande intermédiaire est donc satisfaite
 * quand le journal porte deux approbations par DEUX acteurs distincts, dont au
 * moins une portée par l'autorité du DG.
 *
 * Deux personnes distinctes est la condition qui porte le sens : un même compte
 * cumulant les rôles ne peut pas se donner le second avis à lui-même.
 */

const dbParDefaut = require('../db');
const { hasRole } = require('./roles');
const { porteLAutoriteDG, lireSeuils, niveauRequis } = require('./seuils-approbation');

const TABLE_SOURCE = 'operations';
const ACTION_APPROBATION = 'approuve';

/**
 * La capacité avec laquelle cet utilisateur approuve : la plus haute qu'il porte.
 * C'est elle qui distingue une approbation Finance d'une approbation DG, et elle
 * est écrite dans le journal plutôt que déduite après coup — un rôle peut changer,
 * une décision déjà prise ne change pas.
 */
async function capaciteDe(user, dbc = dbParDefaut) {
  return (await porteLAutoriteDG(user, dbc)) ? 'dg' : 'finance';
}

/** Le dossier de parapheur d'une opération, ou null. */
async function dossierDe(operationId, dbc = dbParDefaut) {
  return dbc.queryOne(
    `SELECT id FROM parapheur
      WHERE ref_source_table = ? AND ref_source_id = ?
      ORDER BY id DESC LIMIT 1`,
    [TABLE_SOURCE, Number(operationId)],
  );
}

/** Les approbations déjà portées au journal pour cette opération. */
async function approbationsDe(operationId, dbc = dbParDefaut) {
  const dossier = await dossierDe(operationId, dbc);
  if (!dossier) return [];
  return dbc.query(
    `SELECT acteur_id, acteur_role, created_at
       FROM parapheur_actions
      WHERE parapheur_id = ? AND action_type = ?
      ORDER BY id`,
    [dossier.id, ACTION_APPROBATION],
  );
}

/**
 * Inscrit une approbation au journal.
 *
 * Renvoie `{ ok: false, code: 'DOSSIER_ABSENT' }` si l'opération n'a pas de
 * dossier : on refuse plutôt que d'écrire ailleurs. Contourner ici reviendrait à
 * désactiver la double approbation en silence, ce qui est pire que de refuser.
 */
async function enregistrerApprobation({ operationId, user, capacite }, dbc = dbParDefaut) {
  const dossier = await dossierDe(operationId, dbc);
  if (!dossier) return { ok: false, code: 'DOSSIER_ABSENT' };

  /* Par délégation : l'acteur porte l'autorité du DG sans porter le rôle. */
  const parDelegation = capacite === 'dg' && !hasRole(user, 'dg') ? 1 : 0;

  await dbc.execute(
    `INSERT INTO parapheur_actions
       (parapheur_id, acteur_id, acteur_role, action_type, is_interim)
     VALUES (?, ?, ?, ?, ?)`,
    [dossier.id, user.id, capacite, ACTION_APPROBATION, parDelegation],
  );
  return { ok: true };
}

/**
 * Les approbations portées suffisent-elles au niveau exigé ?
 *
 * @returns {{suffisantes: boolean, acteurs: number, porteDG: boolean}}
 */
function evaluer(approbations, niveau) {
  const acteurs = new Set(approbations.map(a => Number(a.acteur_id)));
  const porteDG = approbations.some(a => String(a.acteur_role) === 'dg');
  if (niveau !== 'finance_et_dg') {
    return { suffisantes: acteurs.size >= 1, acteurs: acteurs.size, porteDG };
  }
  return { suffisantes: acteurs.size >= 2 && porteDG, acteurs: acteurs.size, porteDG };
}

/** Le niveau d'approbation qu'un montant appelle. */
async function niveauPourMontant(montant, dbc = dbParDefaut) {
  return niveauRequis(montant, await lireSeuils(dbc));
}

/** Cet acteur a-t-il déjà approuvé cette opération ? */
function aDejaApprouve(approbations, user) {
  return approbations.some(a => Number(a.acteur_id) === Number(user?.id));
}

module.exports = {
  capaciteDe,
  dossierDe,
  approbationsDe,
  enregistrerApprobation,
  evaluer,
  niveauPourMontant,
  aDejaApprouve,
  ACTION_APPROBATION,
};
