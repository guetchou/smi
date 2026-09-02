'use strict';

/*
 * Garde — les KPI étendus de l'accueil, et l'unité affichée une seule fois.
 *
 * Constaté en production le 02/09/2026, capture confrontée au DOM :
 *
 *   « CRÉANCES — / Factures dues »   et   « IMPAYÉS >30J — / Chargement… »
 *
 * « Chargement… » est le texte de départ du gabarit. Il n'a jamais été
 * remplacé. Cause mesurée : /factures-clients/rapport/impayes rend
 * { impayes: [...], total } — clé « impayes ». Le code lisait
 * « impayes.factures », absent, retombait sur l'objet lui-même, et
 * rows.reduce(...) levait un TypeError. Le catch de la fonction est
 * silencieux : l'erreur disparaissait, et avec elle les créances, les
 * impayés, les dettes fournisseurs, les contrats actifs et l'alerte
 * salaires — tout ce qui suit dans la même fonction.
 *
 * Encore « absent ≠ zéro » : une charge utile d'une autre forme n'est pas
 * une absence de données, et une absence de données n'est pas un
 * chargement en cours.
 *
 * Et l'unité : fmt() ajoute déjà la devise. Le flux de trésorerie la
 * rajoutait — « -550 000 XAF XAF » sur chaque ligne, mesuré à l'écran.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const markup = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

/* Le fichier est un monolithe : une expression non gourmande s'arrête à la
   première accolade fermante venue, donc au milieu de la fonction. On compte
   les accolades pour découper exactement le corps visé. */
function corpsDe(nom) {
  const debut = markup.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister dans le gabarit`);
  const ouverture = markup.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < markup.length; j++) {
    if (markup[j] === '{') profondeur++;
    else if (markup[j] === '}') {
      profondeur--;
      if (profondeur === 0) return markup.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

const chargeur = corpsDe('async function loadDashboardKpisEtendus(');
const flux = corpsDe('function renderFluxRecents(');

/* ── 1. La bonne clé est lue ── */
assert(
  /impayes\.impayes/.test(chargeur) || /listeOuVide\(impayes, 'impayes'/.test(chargeur),
  "Le rapport des impayés rend la clé « impayes » : la lire, sinon reduce() reçoit un objet et lève"
);

/* ── 2. Aucune liste n'est réduite sans être un tableau ──
   La forme rendue par l'API est un contrat externe. Elle peut changer.
   Ce qui ne doit pas changer, c'est qu'un changement de forme dégrade
   l'affichage au lieu de faire tomber la fonction entière. */
for (const [nom, motif] of [
  ['impayés', /listeOuVide\(impayes, 'impayes', 'factures'\)/],
  ['dettes fournisseurs', /listeOuVide\(dettes, 'factures'\)/],
  ['contrats actifs', /listeOuVide\(contrats, 'contrats'\)/],
]) {
  assert(motif.test(chargeur), `Les ${nom} doivent passer par listeOuVide : une forme inattendue ne doit pas lever`);
}

assert(
  /function listeOuVide\(/.test(markup),
  'listeOuVide doit exister : c est le point unique qui transforme une forme inconnue en liste vide'
);

/* ── 3. Un échec ne laisse pas « Chargement… » à l'écran ──
   Le libellé de départ annonce un travail en cours. S'il subsiste, il
   ment. En cas d'échec, les tuiles retombent sur « — », le neutre déjà
   employé partout sur cette page — aucun texte nouveau n'est introduit. */
assert(
  /kpisEtendusIndisponibles\(\)/.test(chargeur),
  'Le catch doit remettre les tuiles dans un état lisible, pas laisser « Chargement… » indéfiniment'
);
assert(
  !/\/\/ silencieux/.test(chargeur),
  'Un catch entierement muet a cache ce defaut : il doit au moins tracer'
);
assert(
  /console\.error\(/.test(chargeur),
  'L echec doit etre tracable en console : c est ce qui manquait pour le voir'
);
assert(
  /function kpisEtendusIndisponibles\(\)[\s\S]{0,400}Chargement/i.test(markup),
  'La reprise doit ne toucher que les tuiles restees sur le libelle de depart'
);

/* ── 4. La devise n'est écrite qu'une fois ──
   fmt() ajoute déjà la devise lue dans la localisation. Mesuré à
   l'écran le 02/09/2026 : « -550 000 XAF XAF » sur les six lignes du
   flux, et l'unité répétée sous les trois totaux. */
assert(
  !/\$\{fmt\([^{}]*\)\}\s*XAF/.test(flux),
  'fmt() rend deja la devise : ne pas la reecrire apres, cela donne « XAF XAF »'
);
assert(
  !/>XAF\s*·/.test(flux) && !/>XAF<\/div>/.test(flux),
  'Les libelles sous les totaux ne doivent pas repeter une unite deja portee par le montant'
);

/* ── 5. Un libellé coupé garde son texte accessible ──
   Même convention que le journal d'audit : ce qui est tronqué par
   ellipse reste lisible au survol. */
assert(
  /title="\$\{esc\(label\)\}"/.test(flux),
  'Un libelle tronque par ellipse doit porter son texte complet en title, comme au journal'
);

console.log(JSON.stringify({
  rightPayloadKeyRead: true,
  everyListCoercedBeforeReduce: true,
  failureLeavesNoStaleLoadingLabel: true,
  failureIsTraceable: true,
  currencyWrittenOnce: true,
  truncatedLabelKeepsItsText: true,
}));
