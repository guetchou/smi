'use strict';
/*
 * Ce qui s'oppose à une écriture financière, établi à un seul endroit.
 *
 * Constat C12 de l'audit des flux : « la clôture journalière ne bloque pas
 * directement les opérations rétroactives ». Le relevé du 23/09/2026 est plus
 * net encore — il existait **quatre copies** du contrôle mensuel
 * (`routes/operations.js`, `services/accounting.js`,
 * `services/finance-operation-canonical.js`, `services/cash-receipt-workflow.js`)
 * et **aucun** contrôle journalier, nulle part. Une opération pouvait donc être
 * saisie dans une journée dont la caisse était clôturée et validée.
 *
 * Deux modèles de clôture journalière coexistent (constat C11) et sont tous deux
 * vivants dans le code : `cashbox_closures`, écrite par les opérations, et
 * `caisses_clotures`, écrite par le rapprochement. Une garde qui n'en lirait
 * qu'un laisserait passer les écritures sur les caisses fermées par l'autre
 * chemin. Les deux sont donc consultés.
 *
 * Un virement porte DEUX caisses. La clôture de l'une comme de l'autre s'oppose
 * à l'écriture : l'argent quitte la source et entre dans la destination.
 *
 * Ce module établit le FAIT, il ne décide pas de la réponse. Chaque appelant
 * conserve son type d'erreur, son code métier et son message — le contrat de
 * chaque API reste le sien. On supprime la duplication de la règle, pas les
 * contrats.
 */

const dbParDefaut = require('../db');

/* Les statuts qui ferment, dans chacun des deux modèles. Un `reopened` côté
   opérations et un statut non validé côté rapprochement ne ferment pas :
   une clôture déclarée n'est pas une clôture validée. */
/* Les deux modeles ne se lisent pas de la meme facon, et c'est verifie en base :
   - cashbox_closures porte un index UNIQUE (caisse_id, date_cloture), et la
     reouverture modifie la ligne sur place en « reopened ». Chercher une ligne
     « cloturee » suffit donc, et une caisse rouverte redevient ouverte ;
   - caisses_clotures n'a AUCUN index unique — plusieurs clotures du meme jour
     sont possibles (constat C11) — et aucun mecanisme de reouverture. Une
     cloture validee quelconque ferme donc la journee, et rien ne la rouvre.
   Ne pas « harmoniser » ces deux lectures sans avoir reverifie les index. */
const STATUT_FERME_OPERATIONS = 'cloturee';
const STATUT_FERME_RAPPROCHEMENT = 'valide';

function jour(date) {
  return String(date).slice(0, 10);
}

function moisDe(date) {
  const parsed = new Date(`${jour(date)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return { annee: parsed.getFullYear(), mois: parsed.getMonth() + 1 };
}

/**
 * Le verrou qui s'oppose à une écriture, ou null s'il n'y en a aucun.
 *
 * @param {object} params
 * @param {string} params.date — date de l'écriture.
 * @param {Array<number|null|undefined>} [params.positionIds] — toutes les caisses
 *   touchées. Pour un virement : destination ET source.
 * @param {object} [dbc] — connexion ou transaction. Le contrôle doit pouvoir
 *   être fait DANS la transaction qui écrit, sinon il constate un état qui peut
 *   avoir changé au moment du COMMIT.
 * @returns {Promise<null | {code: string, portee: 'mois'|'jour', date: string, positionId: number|null, message: string}>}
 */
async function verrouDeCloture({ date, positionIds = [] }, dbc = dbParDefaut) {
  if (!date) return null;
  const periode = moisDe(date);
  if (!periode) return null;

  const mensuel = await dbc.queryOne(
    'SELECT 1 AS found FROM periodes_cloturees WHERE annee = ? AND mois = ? LIMIT 1',
    [periode.annee, periode.mois],
  );
  if (mensuel) {
    return {
      code: 'PERIODE_CLOTUREE',
      portee: 'mois',
      date: jour(date),
      positionId: null,
      message: `Période ${jour(date).slice(0, 7)} clôturée — aucune écriture autorisée`,
    };
  }

  /* Dédoublonné et ordonné : le message doit être reproductible d'un appel à
     l'autre, donc on ne dépend pas de l'ordre d'arrivée des identifiants. */
  const caisses = [...new Set(positionIds.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);

  for (const positionId of caisses) {
    const parOperations = await dbc.queryOne(
      'SELECT 1 AS found FROM cashbox_closures WHERE caisse_id = ? AND date_cloture = ? AND statut = ? LIMIT 1',
      [positionId, jour(date), STATUT_FERME_OPERATIONS],
    );
    const parRapprochement = parOperations ? null : await dbc.queryOne(
      'SELECT 1 AS found FROM caisses_clotures WHERE position_id = ? AND date_cloture = ? AND statut = ? LIMIT 1',
      [positionId, jour(date), STATUT_FERME_RAPPROCHEMENT],
    );
    if (parOperations || parRapprochement) {
      return {
        code: 'CAISSE_CLOTUREE',
        portee: 'jour',
        date: jour(date),
        positionId,
        message: `Caisse clôturée le ${jour(date)} — aucune écriture autorisée`,
      };
    }
  }

  return null;
}

/**
 * Les caisses touchées par une opération : sa position, et pour un virement la
 * position source. C'est l'oubli de la seconde qui laissait un virement écrire
 * sur une caisse fermée.
 */
function caissesDeLOperation(operation) {
  if (!operation) return [];
  return [operation.position_id, operation.position_source_id];
}

/** Le verrou qui s'oppose à l'écriture d'une opération donnée. */
async function verrouPourOperation(operation, dbc = dbParDefaut) {
  return verrouDeCloture(
    { date: operation?.date, positionIds: caissesDeLOperation(operation) },
    dbc,
  );
}

module.exports = {
  verrouDeCloture,
  verrouPourOperation,
  caissesDeLOperation,
  STATUT_FERME_OPERATIONS,
  STATUT_FERME_RAPPROCHEMENT,
};
