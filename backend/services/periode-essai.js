'use strict';
/*
 * La période d'essai que la loi congolaise plafonne.
 *
 * Document « Les obligations sociales des entreprises », Ministère de la
 * Fonction publique de la République du Congo :
 *
 *   Contrat à durée indéterminée — la période d'essai ne peut excéder
 *     quinze jours pour les employés, ouvriers et manœuvres payés à l'heure ;
 *     un mois pour ceux payés au mois ;
 *     trois mois pour les agents de maîtrise, cadres et assimilés.
 *     Renouvelable une fois, par écrit.
 *
 *   Contrat à durée déterminée — à défaut d'usage ou de disposition
 *     conventionnelle prévoyant moins :
 *     quinze jours au plus pour une durée de six mois ou moins ;
 *     un mois dans les autres cas.
 *
 * Ce que cette fonction rend est un PLAFOND, jamais une décision : une durée
 * négociée plus courte reste licite, et c'est le cas courant. L'appelant
 * propose, la personne qui saisit dispose.
 *
 * Mesuré le 10/09/2026 : les colonnes periode_essai_mois et date_fin_essai
 * existent depuis l'origine et sont vides sur les onze fiches actives. Rien
 * n'était calculé parce que rien ne portait la règle.
 */

const JOUR = 'jours';
const MOIS = 'mois';

/* Une catégorie relève de la maîtrise ou de l'encadrement. Le libellé est lu
   plutôt que l'identifiant : la grille est administrable en production, ses
   identifiants ne sont pas des constantes. */
function estEncadrement(libelleCategorie) {
  return /cadre|ma[iî]trise|assimil/i.test(String(libelleCategorie || ''));
}

/**
 * Le plafond légal, et ce qui le fonde.
 *
 * @param {object} p
 * @param {string} p.typeContrat        'cdi' | 'cdd' (autre valeur → non statué)
 * @param {number} [p.dureeContratMois] durée du CDD, en mois
 * @param {string} [p.categorieLibelle] libellé de la catégorie de grille
 * @param {boolean} [p.payeALHeure]     rémunération horaire (rare ici)
 * @returns {{valeur:number, unite:string, mois:number, motif:string}|null}
 */
function plafondPeriodeEssai({ typeContrat, dureeContratMois, categorieLibelle, payeALHeure } = {}) {
  const type = String(typeContrat || '').toLowerCase();

  if (type === 'cdd') {
    // Le seuil porte sur la durée du contrat, pas sur la catégorie.
    const duree = Number(dureeContratMois);
    if (!Number.isFinite(duree) || duree <= 0) return null;
    return duree <= 6
      ? { valeur: 15, unite: JOUR, mois: 0.5, motif: 'cdd_six_mois_ou_moins' }
      : { valeur: 1, unite: MOIS, mois: 1, motif: 'cdd_plus_de_six_mois' };
  }

  if (type === 'cdi') {
    if (estEncadrement(categorieLibelle)) {
      return { valeur: 3, unite: MOIS, mois: 3, motif: 'cdi_encadrement' };
    }
    if (payeALHeure) {
      return { valeur: 15, unite: JOUR, mois: 0.5, motif: 'cdi_paye_a_l_heure' };
    }
    return { valeur: 1, unite: MOIS, mois: 1, motif: 'cdi_paye_au_mois' };
  }

  // Apprentissage, stage, type absent : la règle ci-dessus ne les couvre pas.
  return null;
}

/**
 * La fin d'essai qui découle d'une date d'embauche et d'un plafond.
 * Rend null plutôt qu'une date fausse quand l'un des deux manque.
 */
function finPeriodeEssai(dateEmbauche, plafond) {
  if (!dateEmbauche || !plafond) return null;
  const debut = new Date(dateEmbauche);
  if (!Number.isFinite(debut.getTime())) return null;
  const fin = new Date(debut.getTime());
  if (plafond.unite === JOUR) fin.setDate(fin.getDate() + plafond.valeur);
  else fin.setMonth(fin.getMonth() + plafond.valeur);
  return fin.toISOString().slice(0, 10);
}

module.exports = { plafondPeriodeEssai, finPeriodeEssai, estEncadrement, JOUR, MOIS };
