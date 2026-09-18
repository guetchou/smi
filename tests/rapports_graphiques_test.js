'use strict';
/*
 * Garde — les trois analyses vivent dans Rapports, et l'onglet les dessine.
 *
 * Mesure a 1366 x 768 le 18/09/2026, zone utile 697 px :
 *
 *   avant   accueil 1404 px — 2,01 ecrans
 *              24 +232  heros
 *             230 +107  bande des six tuiles
 *             348 +250  satellites + « Positions de tresorerie »
 *           ----------------------------------------- pli a 697
 *             598 +306  « Evolution Rec/Dep » + « CA encaisse 6 mois »
 *             920 +276  « Repartition depenses »
 *            1212 +216  « Flux de tresorerie » (une liste, pas un graphique)
 *
 *   apres   accueil 808 px — 1,16 ecran ; onglet Rapports > Graphiques 598 px
 *
 * « Positions de tresorerie » n'a pas bouge : savoir ou est l'argent
 * conditionne le transfert, et c'est garde dans accueil_hierarchie_test.js.
 *
 * Le piege du deplacement est le dessin : Chart.js pose dans un conteneur
 * cache rend un canvas 0x0 qui reste blanc une fois revele. showRapportTab
 * montre d'abord la section, puis redessine. Verifie a l'ecran, onglet ouvert,
 * avec quatre ventes semees : evolution 513x240 peint, six mois 513x240 peint,
 * repartition en etat vide legitime — « Aucune depense categorisee sur cette
 * periode » — faute de decaissement.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');
const accueil = html.slice(html.indexOf('id="page-dashboard"'), html.indexOf('id="page-rh-overview"'));
const rapports = html.slice(html.indexOf('id="page-rapports"'), html.indexOf('id="rpt-section-hebdo"'));
const section = html.slice(html.indexOf('id="rpt-section-graphiques"'), html.indexOf('id="rpt-section-hebdo"'));

const ANALYSES = ['chart-evolution', 'chart-ca-6mois', 'chart-categories'];
let vertes = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
};

verifier('les trois analyses ont quitte l accueil', () => {
  for (const id of ANALYSES) {
    assert.ok(!accueil.includes('id="' + id + '"'),
      `« ${id} » est reste sur l accueil : il le ramene au-dela d un ecran`);
  }
});

verifier('les positions de tresorerie sont restees', () => {
  assert.ok(accueil.includes('id="chart-positions"'),
    'Savoir ou est l argent conditionne le transfert : cette carte ne descend pas dans un onglet');
  assert.ok(accueil.includes('id="recent-ops"'),
    'Le flux de tresorerie est une liste nominative, pas un graphique : il reste sur l accueil');
});

verifier('les trois sont arrivees dans Rapports', () => {
  for (const id of ANALYSES) {
    assert.ok(section.includes('id="' + id + '"'), `« ${id} » manque dans l onglet Graphiques`);
  }
});

verifier('l ordre metier est conserve', () => {
  /* Une evolution, puis son cumul sur six mois, puis la repartition : on lit
     le mouvement avant de le decomposer. */
  const rangs = ANALYSES.map(id => section.indexOf(id));
  assert.ok(rangs[0] < rangs[1] && rangs[1] < rangs[2],
    'Evolution, puis six mois, puis repartition — pas un autre ordre : ' + rangs.join(' '));
});

verifier('les titres ont suivi leurs graphiques', () => {
  for (const titre of ['Évolution Recettes / Dépenses', 'CA encaissé — 6 derniers mois', 'Répartition dépenses']) {
    assert.ok(section.includes(titre), `Le titre « ${titre} » doit accompagner son graphique`);
    assert.ok(!accueil.includes(titre), `Le titre « ${titre} » ne doit pas rester en double sur l accueil`);
  }
});

verifier('l onglet existe et porte son libelle', () => {
  assert.ok(/id="rtab-graphiques"[^>]*>Graphiques</.test(rapports),
    'Le sixieme sous-onglet doit s appeler « Graphiques » — libelle valide le 18/09/2026');
  assert.ok(/showRapportTab\('graphiques'\)/.test(rapports),
    'Le bouton doit appeler le commutateur d onglets');
});

verifier('le commutateur connait le nouvel onglet', () => {
  const commut = (html.match(/function showRapportTab\(t\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(commut, 'showRapportTab introuvable');
  assert.ok(/'graphiques'/.test(commut.split('forEach')[0]),
    'Sans « graphiques » dans la liste, la section ne se montre ni ne se cache');
});

verifier('l onglet redessine apres s etre montre', () => {
  /* Un canvas Chart.js pose dans un conteneur cache se rend en 0x0 et reste
     blanc une fois revele. Le redessin doit donc venir APRES le basculement
     des classes, pas avant. */
  const commut = (html.match(/function showRapportTab\(t\)[\s\S]*?\n\}/) || [])[0] || '';
  const iBascule = commut.indexOf('classList.toggle');
  const iDessin = commut.indexOf("t === 'graphiques'");
  assert.ok(iDessin !== -1, 'L ouverture de l onglet doit declencher un redessin');
  assert.ok(iBascule !== -1 && iBascule < iDessin,
    'Le redessin doit suivre l affichage de la section, sinon le canvas se rend en 0x0');
  assert.ok(/t === 'graphiques'\) refreshDashboard\(\)/.test(commut),
    'On redessine par le chemin qui les dessinait deja, pas par une copie de leur configuration');
});

verifier('le tri par vue d accueil ne les suit pas', () => {
  /* appliquerVueAccueil ne regarde que #page-dashboard : un data-vues laisse
     ici serait un attribut mort, qui ferait croire a une reserve inexistante. */
  assert.ok(!/data-vues|data-rangee/.test(section),
    'Les attributs de tri d accueil n ont plus d objet dans Rapports');
});

console.log(vertes + '/9 gardes vertes — les analyses dans Rapports');
