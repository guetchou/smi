'use strict';
/*
 * Garde — l'accueil suit le role.
 *
 * Le serveur range deja les roles en quatre vues — decideur, finance, rh,
 * operationnel — dans GET /dashboard/home. Cette decision ne servait qu'a une
 * bande fine de trois pastilles : tout le reste de l'accueil etait identique
 * pour tout le monde.
 *
 * Mesure du 17/09/2026 sur le banc, viewport 1366x768 :
 *   accueil complet       1 776 px pour 532 px visibles  = 3,3 ecrans
 *   accueil operationnel  1 102 px                       = 2,1 ecrans
 *   cinq blocs retires, les deux rangees concernees se refermant a une colonne.
 *
 * Ce qui est garde : le tri existe, il est appele avec la vue du serveur, il
 * ne se substitue jamais au refus serveur, et une vue inconnue ne vide pas
 * l'ecran.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

const tri = (html.match(/function appliquerVueAccueil\(vue\) \{[\s\S]*?\n\}/) || [])[0] || '';

verifier('le tri existe et connait les quatre vues du serveur', () => {
  assert.ok(tri, 'appliquerVueAccueil introuvable');
  const liste = (html.match(/const VUES_D_ACCUEIL = \[[^\]]*\]/) || [])[0] || '';
  for (const vue of ['decideur', 'finance', 'rh', 'operationnel']) {
    assert.ok(liste.includes(`'${vue}'`),
      `« ${vue} » est renvoyee par GET /dashboard/home : le tri doit la connaitre`);
  }
});

verifier('le tri est appele avec la vue du serveur', () => {
  assert.ok(/appliquerVueAccueil\(data\.vue\)/.test(html),
    'La vue vient du serveur, elle ne se rededuit pas du role cote navigateur : '
    + 'deux classements tenus separement finissent par diverger');
});

verifier('une vue inconnue ne vide pas l ecran', () => {
  assert.ok(/const trier = VUES_D_ACCUEIL\.includes\(vue\)/.test(tri),
    'Une vue non reconnue — ajoutee plus tard cote serveur — doit tout '
    + 'montrer, jamais tout cacher');
});

verifier('un bloc sans attribut reste visible pour tous', () => {
  assert.ok(/querySelectorAll\('#page-dashboard \[data-vues\]'\)/.test(tri),
    'Seuls les blocs marques sont concernes : la reserve s ecrit la ou elle '
    + 's applique, et l accueil ne se vide pas par oubli');
});

verifier('les blocs de pilotage sont marques', () => {
  const page = (html.match(/<div id="page-dashboard"[\s\S]*?<div id="page-rh-overview"/) || [])[0] || '';
  assert.ok(page, 'page-dashboard introuvable');
  const marques = page.match(/data-vues="decideur finance"/g) || [];
  /* Ils etaient quatre apres la refonte du 17/09/2026. Le 18/09, « Evolution
     Recettes / Depenses », « CA encaisse 6 mois » et « Repartition depenses »
     ont quitte l accueil pour l onglet Rapports > Graphiques : l accueil y
     passait 2,01 ecrans pour 697 px utiles. Leur reserve aux vues « decideur »
     et « finance » n avait plus d objet — le tri ne s applique que dans
     #page-dashboard, et surtout le deplacement atteint le but plus surement,
     puisqu ils ne sont plus sur aucun accueil.

     Restent marquees les deux tuiles qui relevent du pilotage sans quitter la
     bande : Creances et Impayes >30j. */
  assert.strictEqual(marques.length, 2,
    'Deux tuiles relevent encore du pilotage : Creances et Impayes >30j. Les '
    + 'trois analyses sont parties dans Rapports le 18/09/2026, et « Synthese '
    + 'financiere » avait quitte l ecran avant elles.');
  for (const libelle of ['Créances', 'Impayés']) {
    assert.ok(page.includes(libelle),
      `La tuile « ${libelle} » doit rester sur l accueil : elle se lit d un coup d oeil, elle ne se deplie pas`);
  }
});

verifier('les positions de tresorerie restent visibles par tous', () => {
  /* Savoir ou est l'argent conditionne le transfert : c'est le besoin que
     l'utilisateur a decrit le 16/09/2026. Cette carte ne se reserve pas. */
  const carte = (html.match(/<!-- Positions de trésorerie -->[\s\S]{0,400}/) || [])[0] || '';
  assert.ok(carte, 'carte des positions introuvable');
  assert.ok(!/data-vues=/.test(carte),
    'L anneau des positions dit ou est l argent : il reste ouvert a qui tient '
    + 'la caisse, sinon le transfert se fait a l aveugle');
});

verifier('une rangee qui perd un enfant se referme', () => {
  assert.ok(/\[data-rangee\]/.test(tri),
    'Sans cela il reste une colonne vide a la place du bloc retire');
  assert.ok(/gridTemplateColumns/.test(tri), 'la rangee se recompte');
  /* Elles etaient deux : la bande des six tuiles, et la rangee « argent » qui
     portait « Repartition depenses ». Cette derniere est partie dans Rapports
     le 18/09/2026 avec les deux autres analyses ; la bande reste seule a
     pouvoir perdre un enfant, quand une vue masque Creances ou Impayes. */
  const rangees = html.match(/data-rangee="[^"]+"/g) || [];
  assert.deepStrictEqual(rangees, ['data-rangee="bande"'],
    'Seule la bande des tuiles peut encore perdre un enfant : la rangee « argent » est partie dans Rapports le 18/09/2026');
});

verifier('le tri ne se fait jamais passer pour une protection', () => {
  assert.ok(/ecrans-de-direction/.test(tri),
    'Le commentaire doit renvoyer au refus serveur : masquer un bloc est un '
    + 'confort de lecture, jamais une protection');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — accueil par role`);
process.exit(echecs ? 1 : 0);
