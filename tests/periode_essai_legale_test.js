'use strict';
/*
 * Garde — la période d'essai respecte les plafonds légaux congolais.
 *
 * Source : « Les obligations sociales des entreprises », Ministère de la
 * Fonction publique de la République du Congo.
 *
 *   CDI — quinze jours (payés à l'heure), un mois (payés au mois),
 *         trois mois (agents de maîtrise, cadres et assimilés).
 *   CDD — quinze jours jusqu'à six mois de contrat, un mois au-delà.
 *
 * Le risque que cette garde couvre n'est pas une erreur de calcul : c'est
 * qu'un plafond dépassé rende une rupture d'essai irrégulière. Un mois de
 * trop sur un employé payé au mois, et l'entreprise se retrouve hors des
 * clous sans que rien à l'écran ne l'annonce.
 *
 * Mesuré le 10/09/2026 : periode_essai_mois et date_fin_essai sont vides sur
 * les onze fiches actives. Rien n'était calculé parce que rien ne portait la
 * règle — et rien ne la gardait.
 */
const assert = require('assert');
const { plafondPeriodeEssai, finPeriodeEssai } = require('../backend/services/periode-essai');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

verifier('CDI, cadre — trois mois', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'A — Cadre' });
  assert.strictEqual(p.mois, 3, 'la maitrise et l encadrement plafonnent a trois mois');
});

verifier('CDI, agent de maitrise — trois mois aussi', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'Agents de maîtrise' });
  assert.strictEqual(p.mois, 3, 'la loi cite les agents de maitrise avec les cadres');
});

verifier('CDI, paye au mois — un mois', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'Employé' });
  assert.strictEqual(p.mois, 1);
  assert.strictEqual(p.valeur, 1);
});

verifier('CDI, paye a l heure — quinze jours', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'Ouvrier', payeALHeure: true });
  assert.strictEqual(p.valeur, 15);
  assert.strictEqual(p.unite, 'jours');
});

verifier('CDD de six mois — quinze jours', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdd', dureeContratMois: 6 });
  assert.strictEqual(p.valeur, 15, 'le seuil de six mois est inclusif');
});

verifier('CDD de sept mois — un mois', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdd', dureeContratMois: 7 });
  assert.strictEqual(p.mois, 1);
});

verifier('le CDD ne regarde pas la categorie', () => {
  const cadre = plafondPeriodeEssai({ typeContrat: 'cdd', dureeContratMois: 3, categorieLibelle: 'Cadre' });
  assert.strictEqual(
    cadre.valeur, 15,
    'en CDD la loi fixe le plafond sur la duree du contrat, pas sur la categorie : '
    + 'appliquer les trois mois des cadres ici depasserait le plafond legal'
  );
});

verifier('un contrat non couvert ne rend pas de plafond invente', () => {
  assert.strictEqual(plafondPeriodeEssai({ typeContrat: 'apprentissage' }), null,
    'l apprentissage a son propre regime : deux mois d essai, regle distincte');
  assert.strictEqual(plafondPeriodeEssai({}), null, 'sans type de contrat, rien a proposer');
  assert.strictEqual(plafondPeriodeEssai({ typeContrat: 'cdd' }), null,
    'un CDD sans duree ne permet pas de choisir entre quinze jours et un mois');
});

verifier('la fin d essai se calcule depuis l embauche', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'Cadre' });
  assert.strictEqual(finPeriodeEssai('2026-08-01', p), '2026-11-01');
  const q = plafondPeriodeEssai({ typeContrat: 'cdd', dureeContratMois: 4 });
  assert.strictEqual(finPeriodeEssai('2026-08-01', q), '2026-08-16');
});

verifier('une date absente ou illisible ne produit pas de date fausse', () => {
  const p = plafondPeriodeEssai({ typeContrat: 'cdi', categorieLibelle: 'Cadre' });
  assert.strictEqual(finPeriodeEssai(null, p), null);
  assert.strictEqual(finPeriodeEssai('pas une date', p), null,
    'une date illisible doit rendre null, pas « Invalid Date »');
  assert.strictEqual(finPeriodeEssai('2026-08-01', null), null);
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n10 gardes vertes — periode d essai legale`);
