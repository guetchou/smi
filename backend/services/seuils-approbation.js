'use strict';
/*
 * Qui peut valider un décaissement, selon son montant.
 *
 * Constat C7b de l'audit des flux : « les seuils d'approbation décrits dans le
 * PRD ne sont pas appliqués ». Le relevé du 23/09/2026 précise la situation —
 * les deux clés **existent déjà en production** dans la table `parametres`,
 * `seuil_approbation_finance` = 50 000 et `seuil_approbation_dg` = 500 000, et
 * aucune ligne de code ne les lisait. Le paramétrage était là, le comportement
 * manquait.
 *
 * Le PRD (PRD_operations_workflow.md, §3) décrit trois bandes :
 *   — en deçà du seuil finance : un approbateur suffit ;
 *   — entre les deux seuils : finance ET DG ;
 *   — au-delà du seuil DG : le DG est obligatoire.
 *
 * Ce module applique la première et la troisième. La bande intermédiaire est une
 * DOUBLE approbation : `operations` ne porte qu'un seul `validated_by`, donc
 * l'exprimer demande une décision de modèle de données. Elle est nommée par
 * `niveauRequis` mais n'est pas imposée ici, et la note de la PR le dit.
 *
 * Les montants ne sont pas écrits dans le code : ils viennent de `parametres`,
 * et un seuil absent ou illisible n'impose rien — on ne durcit pas un contrôle
 * d'argent sur une valeur qu'on n'a pas su lire.
 */

const dbParDefaut = require('../db');
const { hasRole } = require('../routes/auth');

const CLE_SEUIL_FINANCE = 'seuil_approbation_finance';
const CLE_SEUIL_DG = 'seuil_approbation_dg';

function nombreOuNull(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : null;
}

/** Les deux seuils configurés, ou null pour ceux qu'on n'a pas su lire. */
async function lireSeuils(dbc = dbParDefaut) {
  const rows = await dbc.query(
    'SELECT cle, valeur FROM parametres WHERE cle IN (?, ?)',
    [CLE_SEUIL_FINANCE, CLE_SEUIL_DG],
  );
  const par = new Map((rows || []).map(r => [r.cle, r.valeur]));
  return {
    finance: nombreOuNull(par.get(CLE_SEUIL_FINANCE)),
    dg: nombreOuNull(par.get(CLE_SEUIL_DG)),
  };
}

/** Le niveau d'approbation qu'un montant appelle, selon les seuils lus. */
function niveauRequis(montant, seuils) {
  const m = Number(montant);
  if (!Number.isFinite(m)) return 'finance';
  if (seuils.dg !== null && m > seuils.dg) return 'dg';
  if (seuils.finance !== null && m >= seuils.finance) return 'finance_et_dg';
  return 'finance';
}

/*
 * Porte la direction : le DG, l'admin par son raccourci habituel, ou un délégué
 * dont la délégation émane d'un porteur du rôle `dg`.
 *
 * Une délégation quelconque ne suffit pas au-delà du seuil DG : déléguer une
 * approbation de finance ne confère pas l'autorité du DG. La table porte
 * `delegant_id`, donc la question se tranche sur des données existantes plutôt
 * que sur une convention inventée.
 */
async function porteLAutoriteDG(user, dbc = dbParDefaut) {
  if (hasRole(user, 'dg')) return true;
  if (!hasRole(user, 'delegue')) return false;
  const row = await dbc.queryOne(`
    SELECT d.id
      FROM delegations_approbation d
      JOIN users u ON u.id = d.delegant_id
     WHERE d.delegue_id = ?
       AND d.actif = 1
       AND d.date_debut <= CURDATE()
       AND (d.date_fin IS NULL OR d.date_fin >= CURDATE())
       AND (u.role = 'dg' OR u.roles LIKE '%"dg"%')
     LIMIT 1
  `, [user.id]);
  return !!row;
}

/**
 * Ce qui s'oppose à la validation d'un montant par cet utilisateur, ou null.
 *
 * Comme la garde de clôture, ce module établit le fait et laisse l'appelant
 * choisir son code HTTP et son message.
 */
async function verifierSeuilApprobation({ user, montant }, dbc = dbParDefaut) {
  const seuils = await lireSeuils(dbc);
  const niveau = niveauRequis(montant, seuils);
  if (niveau !== 'dg') return null;
  if (await porteLAutoriteDG(user, dbc)) return null;
  return {
    code: 'APPROBATION_DG_REQUISE',
    seuil: seuils.dg,
    montant: Number(montant),
    message: `Validation réservée au DG ou à un délégué actif au-delà de ${seuils.dg}`,
  };
}

module.exports = {
  lireSeuils,
  niveauRequis,
  porteLAutoriteDG,
  verifierSeuilApprobation,
  CLE_SEUIL_FINANCE,
  CLE_SEUIL_DG,
};
