const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

/* ── Une seule action de pointage dans la barre du haut ──
   Deux boutons « Pointer entrée » s'affichaient cote a cote sur l'ecran
   Pointeuse. Le badge persistant avait ete ajoute pour que l'action suive
   l'utilisateur d'un ecran a l'autre, sans retirer celui que la page portait.

   Les deux ne disaient pas la meme chose : le badge lit l'etat courant et
   propose « Pointer sortie » quand l'agent est deja pointe ; celui de la page
   annoncait « Pointer entrée » en toutes circonstances. */

/* La barre du haut est tout ce qui precede le conteneur des pages. */
const barre = markup.slice(0, markup.indexOf('id="tba-pointeuse"') + 2000);

const actions = [...barre.matchAll(/onclick="ptPointerEntree\(\)"/g)];
assert.strictEqual(
  actions.length, 0,
  `La barre du haut ne doit plus porter de bouton de pointage en dur : ${actions.length} trouve(s). ` +
  'L action vient du badge, qui connait l etat.'
);

/* Le badge reste la seule source de l action, et il propose bien les deux sens. */
const badge = markup.match(/function _ptRenderLiveBadge\(ctx\) \{[\s\S]*?\n\}/)[0];
assert(/ptPointerEntree\(\)/.test(badge), 'Le badge doit proposer l entree quand aucun pointage n existe');
assert(/ptOpenSortie\(/.test(badge), 'Le badge doit proposer la sortie quand un pointage est en cours');
assert(
  /if \(p\?\.heure_sortie \|\| \['absent', 'teletravail', 'terrain'\]\.includes\(p\?\.statut\)\) return masquer\(\);/.test(badge),
  'Le badge doit se masquer quand aucune action ne peut aboutir, plutot que d en proposer une qui echouerait'
);

/* L export reste propre a la page : il n a pas d equivalent dans le badge. */
const bloc = markup.match(/<div id="tba-pointeuse"[\s\S]*?<\/div>\s*\n/)[0];
assert(/ptExportCSV\(\)/.test(bloc), 'L export CSV doit rester dans les actions de la page');
assert(
  !/Pointer entrée/.test(bloc),
  'Le bloc d actions de la page ne doit plus annoncer une entree qu il ne sait pas verifier'
);

/* Aucune reference orpheline a l identifiant retire. */
assert.strictEqual(
  (markup.match(/btn-pt-entree/g) || []).length, 0,
  'L identifiant du bouton retire ne doit plus etre reference'
);

console.log(JSON.stringify({
  singleClockActionInTopbar: true,
  badgeOffersBothDirections: true,
  badgeHidesWhenActionWouldFail: true,
  exportStaysWithThePage: true,
  noOrphanReference: true,
}));
