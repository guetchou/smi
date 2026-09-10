'use strict';
/*
 * Garde — une fiche préparée en avance ne naît pas en retard.
 *
 * L'échéance des tâches d'onboarding était calculée à J+7 depuis la création
 * de la fiche :
 *
 *     const due = new Date(Date.now() + 7 * 24 * 3600 * 1000)…
 *
 * Or préparer une arrivée à l'avance est la bonne pratique : on crée la fiche,
 * on prépare le contrat et les accès, puis la personne arrive.
 *
 * Mesuré en production le 10/09/2026 sur la fiche MAT-0018 :
 *     fiche créée le      14/07/2026
 *     échéance des tâches 21/07/2026
 *     arrivée réelle      01/08/2026
 *
 * Les huit tâches — vérifier l'identité, créer le contrat, ouvrir le compte,
 * affecter au poste et au département — étaient échues onze jours avant que
 * la personne ne franchisse la porte. L'indicateur de retard ne dit alors
 * plus rien, et c'est structurel : toute fiche préparée en avance naît ainsi.
 *
 * L'échéance part donc de l'arrivée quand elle est encore devant nous.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'services', 'onboarding.js'), 'utf8');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

/* Le corps de l'initialisation, isolé : d'autres fonctions du fichier
   manipulent des dates sans être concernées. */
function corpsInitialisation() {
  const debut = source.indexOf('async function initOnboarding');
  assert.notStrictEqual(debut, -1, 'initOnboarding est introuvable');
  const fin = source.indexOf('\n// ─', debut);
  return source.slice(debut, fin === -1 ? debut + 2500 : fin);
}

verifier('l echeance ne part plus du seul instant de creation', () => {
  const corps = corpsInitialisation();
  assert.ok(
    !/const\s+due\s*=\s*new Date\(Date\.now\(\)\s*\+\s*7\s*\*/.test(corps),
    'J+7 depuis la creation : une fiche preparee en avance naitrait en retard'
  );
});

verifier('l echeance s ancre sur la date d embauche', () => {
  const corps = corpsInitialisation();
  assert.ok(
    /date_embauche/.test(corps),
    'initOnboarding doit lire la date d embauche pour poser ses echeances'
  );
});

verifier('une embauche deja passee garde une echeance a partir d aujourd hui', () => {
  const corps = corpsInitialisation();
  assert.ok(
    /Date\.now\(\)/.test(corps),
    "sans repli sur aujourd'hui, une embauche ancienne poserait une echeance "
    + 'deja largement depassee des la creation'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n3 gardes vertes — echeances d onboarding`);
