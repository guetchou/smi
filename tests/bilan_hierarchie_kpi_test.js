const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const markup = read('frontend/dashboard.html');
const css = read('frontend/tailwind.css');

/* ── Huit tuiles de meme poids pour huit grandeurs inegales ──
   Audit du Bilan Dirigeant, 01/09/2026. Les huit tuiles de tete portaient
   exactement la meme echelle — text-2xl font-bold — pour la tresorerie de
   l'entreprise comme pour un « Achats engages : 0 XAF ». Les couleurs
   differaient, mais la couleur seule ne fait pas une hierarchie.

   Elles forment deux familles que le code nomme dans ses commentaires, mais
   que rien ne separait a l'ecran : l'ecart entre les deux lignes egalait
   l'ecart entre deux tuiles. */

const bilan = markup.slice(markup.indexOf('id="page-bilan"'), markup.indexOf('Évolution journalière du mois'));

/* ── 1. Le chiffre principal domine ── */

const treso = bilan.match(/<p id="bilan-treso" class="([^"]+)"/)[1];
assert(/\btext-3xl\b/.test(treso), 'La tresorerie totale doit porter une echelle superieure aux autres tuiles');

const autres = [...bilan.matchAll(/<p id="bilan-(enc|dec|net|masse|cout|achats|alertes)" class="([^"]+)"/g)].map(m => m[2]);
assert(autres.length >= 4, `Trop peu de tuiles comparees (${autres.length})`);
for (const c of autres) {
  assert(!/\btext-3xl\b/.test(c), 'Une seule tuile doit porter l echelle superieure, sinon il n y a plus de hierarchie');
  assert(/\btext-2xl\b/.test(c), 'Les autres tuiles doivent garder une echelle commune');
}

/* La primaute de la tresorerie vient du produit, pas d'un choix arbitraire :
   le sous-titre de la page l'annonce en premier. */
assert(
  /Synthèse consolidée trésorerie · RH · achats · alertes/.test(markup),
  'Le sous-titre qui fonde la primaute de la tresorerie doit rester present'
);

/* ── 2. Les deux familles se separent par l'espace ── */

const ligne1 = bilan.match(/<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-(\d+)" data-famille="1">/);
assert(ligne1, 'La premiere famille de tuiles doit rester reperable');
const margeFamille = Number(ligne1[1]);
const ecartTuiles = 4;   // gap-4 entre deux tuiles de la meme famille
assert(
  margeFamille > ecartTuiles,
  `L ecart entre les deux familles (mb-${margeFamille}) doit depasser l ecart entre tuiles (gap-${ecartTuiles}), ` +
  'sinon les huit se lisent comme un seul bloc'
);


/* La marge a aussi une borne haute. Mesure en production le 01/09/2026, a
   1366x768, conteneur de page utile 472 px : avec mb-8 la seconde rangee
   finissait a 475 px, soit trois pixels sous le pli, et les huit indicateurs
   n'etaient jamais vus ensemble. mb-6 la ramene a 467 px. */
assert(
  margeFamille <= 6,
  `L ecart entre les deux familles (mb-${margeFamille}) repousse la seconde rangee sous la ligne de ` +
  'flottaison a 1366x768 : les huit indicateurs ne tiennent plus sur le premier ecran'
);

/* Les deux grilles doivent rester designees par data-famille, sinon cette
   garde et la suivante se rattachent a une valeur de marge ajustable. */
assert(
  /data-famille="2"/.test(bilan),
  'La seconde famille de tuiles doit rester designee par data-famille'
);

/* ── 3. Les classes doivent exister dans le CSS compile ──
   Une classe Tailwind absente du build ne rend rien : le changement serait
   invisible tout en paraissant fait. */
for (const classe of ['text-3xl', 'text-2xl', `mb-${margeFamille}`]) {
  assert(
    new RegExp(`\\.${classe}\\{`).test(css),
    `La classe ${classe} est absente du CSS compile : le changement n aurait aucun effet a l ecran`
  );
}

/* L echelle superieure doit vraiment etre superieure, en valeur. */
const taille = c => Number(css.match(new RegExp(`\\.${c}\\{font-size:([\\d.]+)rem`))[1]);
assert(
  taille('text-3xl') > taille('text-2xl'),
  `text-3xl (${taille('text-3xl')}rem) doit etre plus grand que text-2xl (${taille('text-2xl')}rem)`
);

console.log(JSON.stringify({
  primaryFigureDominates: true,
  singleDominantTile: true,
  primacyGroundedInProductCopy: true,
  familiesSeparatedBySpace: true,
  classesPresentInBuiltCss: true,
  scaleActuallyLarger: true,
}));
