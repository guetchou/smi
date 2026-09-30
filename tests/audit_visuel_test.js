'use strict';
/*
 * Garde — audit visuel du 30/09/2026, page par page a 1366 x 543 (hauteur
 * utile reelle de l'ecran de l'utilisateur), dans la session authentifiee.
 * Une assertion par famille de defaut vu sur les captures :
 *   montants passes a la ligne, zero signe, texte qui deborde de son
 *   contenant, axe de graphique illisible, icones vides, sous-titres de
 *   developpement, photos de 2 Mo pour une vignette de 32 px.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = lire('frontend/dashboard.html');
const cas = [];
const verifier = (nom, fn) => cas.push([nom, fn]);

verifier('la jauge du seuil reste dans son anneau quand le rapport est long', () => {
  const bloc = (html.match(/    const RAYON = 33;[\s\S]*?_majTete\('jauge-seuil-valeur'/) || [])[0] || '';
  assert.ok(bloc, 'bloc de la jauge introuvable');
  const essai = (soldeCaisse, _seuilAlerte) => {
    const el = { textContent: '', style: {} };
    vm.runInNewContext(bloc + '\n);', {
      soldeCaisse, _seuilAlerte, Math, Intl, String, Number,
      document: { getElementById: id => (id === 'jauge-seuil-arc' ? { setAttribute() {} } : el) },
      _majTete() {}, fmt: String,
    });
    return el;
  };
  assert.ok(essai(12365000, 100000).style.fontSize, '« 12 365 % » debordait de l anneau de 66 px : la police doit reduire');
  assert.ok(!essai(50000, 100000).style.fontSize, 'un rapport court garde la taille normale');
});

verifier('journal de tresorerie : montants et references sur une ligne, pas de zero signe', () => {
  const debut = html.indexOf('async function loadJournal()');
  const bloc = html.slice(debut, html.indexOf('function printJournal()', debut));
  assert.ok(!/class="text-lg font-bold(?! whitespace-nowrap)/.test(bloc), 'les totaux des cartes passaient a la ligne : « 10 515 000 / XAF »');
  assert.ok(/text-slate-500 font-mono whitespace-nowrap">\$\{r\.num_piece/.test(bloc), 'la reference etait coupee : « REC-2026- / 000001 »');
  assert.ok(!/-\$\{fmt\(totalDec\)\}/.test(bloc), '« -0 XAF » : un total nul n a pas de signe');
  assert.ok(/Number\(r\.montant\)/.test(bloc), 'un decimal MySQL arrive en chaine : + concatenerait');
  assert.ok(/#page-journal \.jnl-hero-grid \{\s*grid-template-columns: minmax\(0, \.9fr\) minmax\(0, 1\.1fr\);/.test(html),
    'les quatre cartes de totaux disposaient de 110 px chacune');
});

verifier('bilan : axe du graphique gradue en entiers a partir de zero', () => {
  const debut = html.indexOf("getElementById('bilan-chart-evolution')");
  const bloc = html.slice(debut, debut + 2500);
  assert.ok(/beginAtZero:\s*true/.test(bloc) && /precision:\s*0/.test(bloc), 'axe « 1 1 1 1 1 0 0 0 » sur des donnees nulles');
});

verifier('agents : salaire sur une ligne, actions alignees', () => {
  assert.ok(/font-mono text-sm text-slate-900 whitespace-nowrap">\$\{fmt\(a\.salaire_base/.test(html), '« 180 000 / XAF »');
  assert.ok(/<td class="px-4 py-3"><div class="flex items-center gap-1 whitespace-nowrap">\s*<button onclick="openAgentModal/.test(html),
    'crayon, « Compte » et corbeille etaient empiles');
});

verifier('pointeuse : le bouton principal a sa largeur et ses marges', () => {
  const ui = lire('frontend/js/pages/pointeuse-v3.js');
  assert.ok(/class="p3-action w-full"/.test(ui), 'la regle globale width: fit-content ramenait le bouton a son texte');
  assert.ok(/\.p3-action\{[^}]*padding:0 18px/.test(ui), '« Reprendre le travail » touchait les bords');
});

verifier('parametres : pas de sous-titre de developpement ni d icone vide', () => {
  assert.ok(!/Identité légale, coordonnées et numérotation/.test(html), 'sous-titre d onglet restant');
  assert.ok(!/rounded-lg flex items-center justify-center text-xs"><\/span>/.test(html), 'carre d icone vide');
});

verifier('contrats de travail : pas de sous-titre de developpement, accents rendus', () => {
  const ec = lire('frontend/js/modules/employment-contracts.js');
  assert.ok(!/Preparation, controle, validation/.test(ec), 'sous-titre de developpement');
  assert.ok(/Modèles et règles/.test(ec) && /Référence, agent, matricule/.test(ec), 'libelles sans accents');
});

verifier('photos : reduites avant envoi, fichiers envoyes mis en cache', () => {
  assert.ok(/async function reduirePhoto\(fichier\)/.test(html), 'une photo de 2 Mo servait une vignette de 32 px');
  assert.ok(/fd\.append\('photo', await reduirePhoto\(fichier\), 'photo\.jpg'\)/.test(html), 'photo de profil non reduite');
  assert.ok(/fd\.append\('photo', await reduirePhoto\(input\.files\[0\]\), 'photo\.jpg'\)/.test(html), 'photo d agent non reduite');
  const serveur = lire('backend/server.js');
  assert.ok(/app\.use\('\/uploads', express\.static\([^)]*\), \{ maxAge: '7d' \}\)\)/.test(serveur), 'les fichiers envoyes etaient redemandes a chaque page');
});

verifier('bilan : les montants gardent un separateur de milliers visible', () => {
  assert.ok(/const fmtM = v => new Intl\.NumberFormat[^\n]*\.replace\(\/\\u202f\/g, '\\u00a0'\)/.test(html),
    '« 930 075 » s affichait « 930075 » : l espace fine U+202F est presque invisible');
});

verifier('le tableau de bord ne calcule pas les graphiques de Rapports', () => {
  /* Mesure du 30/09/2026 : a chaque affichage de l accueil, six appels
     /operations/kpis/summary (CA 6 mois) partaient pour un graphique qui
     vit dans Rapports > Graphiques. Avec les autres appels de l accueil, ils
     occupaient les six connexions : l encaissement attendait 16 s son envoi. */
  const bloc = (html.match(/refreshDashboard = async function refreshDashboardExtended\(\) \{[\s\S]*?\n\};/) || [])[0] || '';
  assert.ok(bloc, 'enveloppe de refreshDashboard introuvable');
  assert.ok(/if \(ongletGraphiquesVisible\(\)\) loadChartsEtendus\(\);/.test(bloc), 'graphiques de Rapports calcules sur l accueil');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log('  ok   ' + nom); } catch (e) { echecs++; console.log('  ECHEC ' + nom + ' — ' + e.message); }
}
console.log(cas.length - echecs + '/' + cas.length + ' gardes vertes — audit visuel du 30/09/2026');
if (echecs) process.exitCode = 1;
