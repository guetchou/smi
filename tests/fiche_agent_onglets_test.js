'use strict';
/*
 * Garde — la fiche agent montre tous ses onglets, sans défilement à l'aveugle.
 *
 * La modale portait max-w-3xl, soit 768 px. Mesuré sur la production le
 * 10/09/2026, à 1366×768 (543 px utiles) :
 *
 *     barre visible      766 px
 *     onglets, au total 1285 px
 *     debordement        519 px, soit 40 %
 *
 * Six onglets sur quinze étaient hors champ — Congés, Historique, Mutations,
 * Discipline, Heures sup et Compte / Onboarding — sans rien à l'écran pour
 * signaler leur existence. La barre défilait, mais rien ne disait vers quoi.
 *
 * Il a fallu chercher « Compte / Onboarding » dans le DOM après ne pas
 * l'avoir trouvé à l'écran : un onglet qu'on ne peut pas voir n'existe pas
 * pour la personne qui travaille.
 *
 * À max-w-7xl la modale occupe 1334 px et les quinze tiennent sur une ligne.
 * La barre y est même plus basse — 51 px contre 57 — la barre de défilement
 * n'ayant plus lieu d'être.
 *
 * Le compte d'onglets est gardé lui aussi : en ajouter un déplace la mesure,
 * et cette garde doit alors être rejouée dans un navigateur, pas ajustée.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ecran = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

/* La modale de la fiche agent, isolée par son identifiant : d'autres modales
   du fichier portent légitimement une largeur plus étroite. */
function modaleAgent() {
  const debut = ecran.indexOf('<div id="modal-agent"');
  assert.notStrictEqual(debut, -1, 'la modale de la fiche agent est introuvable');
  return ecran.slice(debut, debut + 700);
}

verifier('la modale agent n est plus contrainte a 768 px', () => {
  const bloc = modaleAgent();
  assert.ok(
    !/max-w-3xl/.test(bloc),
    'max-w-3xl (768 px) masque six onglets sur quinze a 1366 px de large'
  );
});

verifier('la modale agent est assez large pour ses onglets', () => {
  const bloc = modaleAgent();
  assert.ok(
    /max-w-7xl/.test(bloc),
    'mesure du 10/09/2026 : il faut max-w-7xl pour que les quinze onglets '
    + 'tiennent sur une ligne'
  );
});

verifier('le nombre d onglets n a pas change sans nouvelle mesure', () => {
  const debut = ecran.indexOf('<div id="modal-agent"');
  const fin = ecran.indexOf('<!-- Corps -->', debut);
  const barre = ecran.slice(debut, fin);
  const onglets = barre.match(/onclick="showAgentTab\('/g) || [];
  assert.strictEqual(
    onglets.length, 15,
    `La fiche agent porte ${onglets.length} onglets, mesure faite sur 15. `
    + 'Rejouer la mesure dans un navigateur a 1366 px avant de toucher a '
    + 'cette garde : la largeur retenue depend de ce compte'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n3 gardes vertes — onglets de la fiche agent`);
