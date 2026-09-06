'use strict';

/*
 * Garde — une créance, c'est ce qui reste dû.
 *
 * Constaté le 04/09/2026, en cliquant sur la tuile plutôt qu'en lisant le
 * code. L'accueil annonçait « Créances 118 000 XAF » ; l'écran des factures,
 * atteint par ce clic, montrait :
 *
 *     FAC-2026-0001 — 118 000 TTC · PAYÉ 100 000 · RESTE 18 000
 *
 * Cause : l'API rend « reste_a_payer ». Cinq endroits lisaient « reste_du »,
 * un champ qui n'existe pas — la lecture retombait sur montant_ttc,
 * c'est-à-dire le montant AVANT paiement. Une facture soldée aurait continué
 * de compter pour son montant d'origine.
 *
 * C'est la troisième clé mal lue de la même famille dans cette session :
 * « factures » là où l'API rend « impayes », puis « reste_du » ici. Ce n'est
 * donc pas l'étourderie qui est en cause, c'est l'absence de garde. Celle-ci
 * vérifie ce que l'écran lit CONTRE ce que le serveur rend.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const routeFactures = fs.readFileSync(
  path.join(racine, 'backend', 'routes', 'factures_clients.js'), 'utf8');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  const ouverture = source.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < source.length; j++) {
    if (source[j] === '{') profondeur++;
    else if (source[j] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. Le champ lu est celui que le serveur rend ──
   C'est l'invariant qui manquait. Le serveur nomme « reste_a_payer » ;
   l'écran doit lire ce nom-là, et aucun autre. */
assert(
  /reste_a_payer/.test(routeFactures),
  "Le serveur doit rendre « reste_a_payer » : si ce nom change, cette garde doit être revue avec l'écran"
);

const lecturesFautives = markup
  .split('\n')
  .map((ligne, i) => ({ n: i + 1, ligne }))
  .filter(({ ligne }) => /\breste_du\b/.test(ligne) && !/^\s*\/\//.test(ligne));

assert.strictEqual(
  lecturesFautives.length, 0,
  '« reste_du » n existe pas dans la réponse du serveur — ' +
  `${lecturesFautives.length} ligne(s) le lisent encore : ` +
  lecturesFautives.slice(0, 3).map(l => `L${l.n}`).join(', ')
);

/* ── 2. Un seul endroit décide de ce qui reste dû ──
   Le défaut était réparti sur cinq lectures indépendantes. Une seule
   corrigée, les quatre autres auraient continué de mentir. */
assert(
  /function resteDuFacture\(f\)/.test(markup),
  'Le calcul doit vivre en un seul endroit, pas répété à chaque lecture'
);

const utilisations = (markup.match(/resteDuFacture\(/g) || []).length;
assert(
  utilisations >= 6,
  `resteDuFacture doit servir partout où une créance est totalisée (${utilisations} usages, 6 attendus au moins)`
);

/* ── 3. Le repli ne prend jamais le TTC seul ──
   C'est précisément ce repli qui produisait l'erreur : sans déduire le
   paiement, une facture réglée compte encore pour son montant d'origine. */
const calcul = corpsDe(markup, 'function resteDuFacture(f)');

assert(/reste_a_payer/.test(calcul), 'Le champ du serveur doit être lu en premier');
assert(
  /ttc\s*-\s*paye/.test(calcul),
  'Le repli doit déduire le paiement, jamais retenir le TTC seul'
);
assert(
  /Math\.max\(0,/.test(calcul),
  'Une facture surpayée ne doit pas produire une créance négative'
);
assert(
  /Number\.isFinite\(reste\)/.test(calcul),
  'Un champ absent ou illisible ne doit pas passer pour un zéro : c est « absent ≠ zéro »'
);

console.log(JSON.stringify({
  screenReadsAFieldTheServerActuallyReturns: true,
  noLineStillReadsTheWrongKey: true,
  oneSinglePlaceDecidesWhatIsOwed: true,
  usedEverywhereAReceivableIsTotalled: true,
  fallbackDeductsThePayment: true,
  neverANegativeReceivable: true,
  missingFieldIsNotZero: true,
}));
