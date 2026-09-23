'use strict';
/*
 * Le solde d'une position, calculé à un seul endroit.
 *
 * La règle tient en quatre cas, et ce sont eux qui étaient recopiés :
 * un encaissement entre sur sa position ; un décaissement en sort ; un virement
 * entre sur sa destination ET sort de sa source. La quatrième ligne est celle
 * qu'on oublie : une opération de virement porte DEUX positions, et la caisse
 * quittée n'est pas dans `position_id`.
 *
 * Avant ce module, la convention existait en trois exemplaires — `getSoldePosition`
 * côté opérations, `calcSoldeSysteme` et `calcSoldeLogicielCaisse` côté
 * rapprochement — dont deux fausses. Le rapprochement additionnait
 * `CASE WHEN type_op = 'encaissement' THEN montant ELSE -montant END` sur
 * `WHERE position_id = ?` : il retirait les virements reçus et ne voyait pas les
 * virements envoyés. Constat C13 de l'audit des flux du 23/06/2026.
 *
 * Second piège, invisible à la lecture : `solde_initial` et la somme sont des
 * `decimal(15,2)`, que le pilote MySQL rend en CHAÎNE. Les additionner avec `+`
 * les concatène. « 0.00 » plus « 7000.00 » donnait « 0.007000.00 », que MySQL
 * refusait ensuite d'écrire dans une colonne décimale — en mode strict, la
 * clôture de caisse échouait. `getSoldePosition` s'en protégeait par une
 * coercition, le rapprochement ne le faisait pas. La coercition est désormais
 * dans le calcul lui-même, pas chez l'appelant.
 */

const db = require('../db');

/* Quatre paramètres, tous égaux à l'identifiant de la position : un par cas. */
const EXPRESSION_DELTA = `COALESCE(SUM(CASE
      WHEN type_op = 'encaissement' AND position_id = ?                THEN montant
      WHEN type_op = 'virement'     AND position_id = ?                THEN montant
      WHEN type_op = 'decaissement' AND position_id = ?                THEN -montant
      WHEN type_op = 'virement'     AND position_source_id = ?         THEN -montant
      ELSE 0 END), 0)`;

function paramsDelta(positionId) {
  return [positionId, positionId, positionId, positionId];
}

/* Un décimal MySQL arrive en chaîne ; une somme vide arrive nulle. */
function nombre(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return 0;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Solde d'une position : son solde initial plus le delta des opérations valides.
 *
 * @param {number} positionId
 * @param {object} [options]
 * @param {number|null} [options.avantOperationId] — ne compter que les opérations
 *   d'identifiant inférieur. Conservé pour le contrôle du solde avant paiement ;
 *   l'identifiant n'est pas un ordre chronologique fiable (constat C3).
 * @param {string|null} [options.jusquA] — ne compter que jusqu'à cette date incluse.
 */
async function soldePosition(positionId, { avantOperationId = null, jusquA = null } = {}) {
  const position = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [positionId]);
  if (!position) return 0;

  let sql = `SELECT ${EXPRESSION_DELTA} AS delta
    FROM operations WHERE statut = 'valide'`;
  const params = paramsDelta(positionId);
  if (avantOperationId) { sql += ' AND id < ?'; params.push(avantOperationId); }
  if (jusquA)           { sql += ' AND date <= ?'; params.push(jusquA); }

  const row = await db.queryOne(sql, params);
  return nombre(position.solde_initial) + nombre(row?.delta);
}

module.exports = { soldePosition, EXPRESSION_DELTA, paramsDelta, nombre };
