const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/notifs.js');
const markup = read('frontend/dashboard.html');

/* ── Un second chemin d'affichage portait encore les codes ──
   L'onglet Rappels affichait « RAP IS ACOMPTE », « RAP DECLARATION STAT » et
   « calendrier_fiscal #17 ». Constate a l'ecran le 01/09/2026, une fois
   l'acces du DG retabli.

   #156 avait corrige les MESSAGES de rappel. Cet onglet liste les RAPPELS
   eux-memes : la route ne joignait pas notif_regles, et l'ecran rendait le
   type brut avec ses underscores remplaces par des espaces. */

const liste = route.match(/router\.get\('\/rappels', async \(req, res\) => \{[\s\S]*?\n\}\);/)[0];

assert(
  /LEFT JOIN notif_regles rg ON rg\.type = r\.type/.test(liste),
  'La liste des rappels doit joindre les regles pour en rapporter le libelle'
);
assert(/SELECT r\.\*, rg\.libelle/.test(liste), 'Le libelle doit etre rapporte');

/* LEFT et non INNER : un rappel dont la regle a ete desactivee doit rester
   visible, avec son code a defaut de libelle. */
assert(
  !/\bINNER JOIN notif_regles/.test(liste),
  'Une jointure stricte ferait disparaitre les rappels dont la regle a ete retiree'
);

/* Les colonnes du WHERE doivent etre qualifiees : statut et type existent dans
   les deux tables, une reference nue serait ambigue et la requete echouerait. */
assert(
  /where\.replace\(\/\\bstatut=\\\?\/, 'r\.statut=\?'\)\.replace\(\/\\btype=\\\?\/, 'r\.type=\?'\)/.test(liste),
  'Les colonnes filtrees doivent etre qualifiees : statut et type sont ambigus apres la jointure'
);

/* ── L'ecran affiche le libelle, sans perdre le repli ── */

const rendu = markup.match(/const dt = new Date\(r\.declenche_a\)[\s\S]*?\}\)\.join\(''\);/)[0];
assert(
  /\$\{r\.libelle \|\| r\.type\.replace\(\/_\/g,' '\)\}/.test(rendu),
  'Le titre doit venir du libelle, avec repli sur le code si la regle a disparu'
);
assert(
  !/>\$\{r\.type\.replace\(\/_\/g,' '\)\}</.test(rendu),
  'Le code brut ne doit plus etre le premier choix'
);

/* La source porte le nom que la navigation lui donne deja : rien n'est invente. */
assert(
  /const NOTIF_SOURCE_LABELS = \{ calendrier_fiscal: 'Calendrier Fiscal' \};/.test(markup),
  'La source doit reprendre un libelle existant du produit'
);
assert(
  markup.includes('>Calendrier Fiscal<'),
  'Ce libelle doit bien preexister dans la navigation : sinon il est invente'
);
assert(
  /\$\{NOTIF_SOURCE_LABELS\[r\.src_table\] \|\| r\.src_table\}/.test(rendu),
  'Une source inconnue doit rester affichee telle quelle plutot que disparaitre'
);

/* Le statut etait deja traduit : ce correctif ne doit pas le defaire. */
assert(
  /const STATUT_LABEL = \{ planifie:'Planifié'/.test(markup),
  'La traduction des statuts doit rester en place'
);

console.log(JSON.stringify({
  routeCarriesTheRuleLabel: true,
  leftJoinKeepsOrphanedReminders: true,
  filterColumnsQualified: true,
  screenShowsLabelWithFallback: true,
  sourceLabelReusedFromNavigation: true,
  statusLabelsUntouched: true,
}));
