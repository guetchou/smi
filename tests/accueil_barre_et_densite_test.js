'use strict';

/*
 * Garde — la barre situe, la page agit ; et rien n'est dit deux fois.
 *
 * Constaté en production le 02/09/2026, capture confrontée au DOM, à
 * 1366 × 768 (zone page 1110 × 603) :
 *
 *   barre .......... 149 px, en TROIS bandes empilées
 *   page restante ..  454 px
 *   accueil ........ 16 cartes, 1 823 px, soit 3,0 écrans
 *
 * Les trois bandes venaient d'un correctif antérieur de cette même session :
 * la barre débordait, j'ai autorisé le retour à la ligne. Le débordement a
 * disparu, l'empilement l'a remplacé — « Pointer entrée » seul en haut,
 * « Clôture » seul en bas, sans qu'aucun de ces placements ne signifie rien.
 *
 * Deux partis retenus après maquette :
 *   A — les quatre actions de caisse descendent dans la page ;
 *   1 — les cartes qui redisent une grandeur déjà affichée sont retirées.
 *
 * Le badge de pointage, lui, RESTE dans la barre : il lit l'état courant,
 * propose « Pointer sortie » le cas échéant et se masque quand aucune action
 * ne peut aboutir. C'est un invariant déjà tenu par
 * topbar_pointage_unique_test.js — le déplacer le romprait.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const markup = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

/* La barre est tout ce qui précède le conteneur des pages. */
const barre = markup.slice(markup.indexOf('id="app-topbar"'), markup.indexOf('id="app-page-container"'));
const accueil = markup.slice(markup.indexOf('id="page-dashboard"'), markup.indexOf('id="page-operations"'));

/* ── 1. La barre ne porte plus les actions de caisse ──
   Onze commandes pour 1 110 px de largeur : elles ne tenaient pas sur une
   ligne, d'où l'empilement. */
for (const action of ['openEncaissementModal()', 'openDecaissementModal()', 'openVirementModal()']) {
  assert(
    !barre.includes(action),
    `La barre ne doit plus porter ${action} : c'est une action de caisse, pas le châssis de l'application`
  );
}
assert(
  !/id="btn-tba-cloture"/.test(barre),
  'La clôture appartient à la page, pas à la barre : seule elle occupait une bande entière'
);

/* La barre garde ce qui situe : le titre, la période, le compte. */
assert(/id="page-title"/.test(barre), 'La barre doit garder le titre de la page');
assert(/id="sel-mois"/.test(barre) && /id="sel-annee"/.test(barre),
  'Le sélecteur de période situe la lecture : il reste dans la barre');

/* ── 2. Le badge de pointage reste dans la barre ──
   Il suit l'utilisateur d'un écran à l'autre et connaît l'état courant.
   Aucune ligne d'actions de page ne doit le reprendre. */
assert(
  /id="tb-pointeuse-live"/.test(barre),
  'Le badge de pointage doit rester dans la barre : il doit suivre l utilisateur d un écran à l autre'
);
assert(
  !/ptPointerEntree\(\)/.test(accueil),
  'L accueil ne doit pas porter de bouton de pointage : le badge connaît l état, un bouton en dur ne le connaît pas'
);

/* ── 3. Les actions sont dans la page, aux mêmes libellés ──
   Déplacer une action ne l autorise pas à changer de nom. */
const lignePage = accueil.match(/<div class="dash-page-actions[\s\S]*?<\/div>\s*\n\s*<!-- ═══ FIN ACTIONS/);
assert(lignePage, 'L accueil doit porter la ligne d actions descendue de la barre');
for (const libelle of ['Encaisser', 'Décaisser', 'Transfert', 'Clôture']) {
  assert(
    lignePage[0].includes(`<span class="action-label">${libelle}</span>`),
    `« ${libelle} » doit garder son libellé exact : un déplacement n est pas une réécriture`
  );
}

/* ── 4. Aucune grandeur n'est tracée deux fois ──
   « Solde net cumulé du mois » et « Mois courant vs précédent » redisaient le
   net et sa variation, déjà portés par l indicateur de tête et son « vs préc. ».
   « Enc/Déc par semaine » redisait le flux de « Évolution Recettes / Dépenses ». */
for (const titre of ['Solde net cumulé du mois', 'Mois courant vs précédent', 'Enc/Déc par semaine']) {
  assert(
    !accueil.includes(`>${titre}</h3>`),
    `« ${titre} » redit une grandeur déjà affichée : la carte doit avoir été retirée`
  );
}

/* ── 5. Aucun identifiant orphelin, aucun appel vers un canvas absent ──
   C est le défaut qui avait laissé « Solde net » trois fois à l écran : la
   carte partie, le script continuait de la nommer. */
for (const id of ['chart-solde', 'chart-comparison', 'chart-semaines']) {
  assert(
    !new RegExp(`id="${id}"`).test(markup),
    `Le canvas ${id} appartenait à une carte retirée : il ne doit plus figurer dans le gabarit`
  );
}
for (const appel of ["renderChart('chart-solde'", "renderChart('chart-comparison'"]) {
  assert(
    !markup.includes(appel),
    `${appel} vise un canvas retiré : l appel doit avoir disparu avec la carte`
  );
}
assert(
  !/\bchartSolde\b/.test(markup) && !/\bchartComparison\b/.test(markup),
  'Les variables des graphiques retirés ne doivent plus être déclarées'
);

/* ── 6. renderChart ne tombe pas sur un canvas absent ──
   Sans cela, retirer une carte fait lever tout refreshDashboard(). */
const rc = markup.match(/function renderChart\(canvasId[\s\S]*?\n\}/)[0];
assert(
  /const canvas = document\.getElementById\(canvasId\);\s*\n\s*if \(!canvas\) return null;/.test(rc),
  'renderChart doit rendre null sur un canvas absent, pas lever'
);

/* ── 7. On ne va pas chercher mille opérations pour un graphique absent ──
   La requête hebdomadaire précédait sa propre garde de présence. */
const etendus = markup.match(/async function loadChartsEtendus[\s\S]*?catch\(e\) \{ console\.error\('loadChartsEtendus:'/)[0];
const posGarde = etendus.indexOf("document.getElementById('chart-semaines')");
const posRequete = etendus.indexOf('/operations?debut=');
assert(
  posGarde !== -1 && posRequete !== -1 && posGarde < posRequete,
  'La présence du canvas doit être vérifiée AVANT la requête : sinon on paie mille lignes pour rien'
);

/* ── 8. La salutation et la bande d'état partagent une ligne ──
   Empilées, elles repoussaient le premier chiffre à 171 px sur 394 utiles. */
assert(
  /lg:flex-row[\s\S]{0,900}id="role-home-view"/.test(accueil),
  'La salutation et la bande d état doivent tenir sur la même ligne dès 1024 px'
);

console.log(JSON.stringify({
  topbarCarriesOnlyItsChassis: true,
  clockBadgeStaysWhereItKnowsTheState: true,
  movedActionsKeptTheirLabels: true,
  noQuantityChartedTwice: true,
  noOrphanCanvasOrCall: true,
  renderChartSurvivesAMissingCanvas: true,
  noFetchForAnAbsentChart: true,
  greetingAndStatusShareOneLine: true,
}));
