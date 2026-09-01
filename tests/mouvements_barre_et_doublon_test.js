const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

/* ── 1. La barre de titre ne doit pas se poser sur le titre ──
   Audit du 01/09/2026, viewport 1366x768, ecran Mouvements caisse/banque.
   La rangee de boutons de la barre etait en nowrap au-dessus de 1024 px. A
   1366 px, sidebar ouverte, elle mesure environ 620 px pour 517 px
   disponibles : alignee a droite, elle debordait vers la GAUCHE et venait se
   poser par-dessus le sous-titre. Mesure : sous-titre a 825 px, bouton
   « Encaisser » a 795 px, 31 px de recouvrement. Et comme le sous-titre est en
   overflow visible, le texte n'etait pas coupe par une ellipse mais peint sous
   le bouton — donc simplement invisible.

   Le retour a la ligne ne s'active que lorsque la place manque : sur un ecran
   large, le rendu est identique. */

const regleLarge = markup.match(/@media \(min-width: 1025px\) \{ #topbar-actions > div \{ flex-wrap: (\w+); \} \}/);
assert(regleLarge, 'La regle de disposition des actions de la barre doit rester reperable');
assert.strictEqual(
  regleLarge[1], 'wrap',
  'En nowrap, une rangee de boutons plus large que la place disponible deborde vers la gauche ' +
  'et se pose par-dessus le titre de la page — 31 px de recouvrement mesures a 1366 px'
);

/* Le sous-titre est en overflow visible : il n'a pas d'ellipse pour signaler
   qu'il est masque. C'est ce qui rend le recouvrement silencieux, et c'est
   pourquoi la garde porte sur la cause et non sur un symptome. */
assert(
  /<p id="page-subtitle"/.test(markup),
  'Le sous-titre de la barre doit rester : c est lui que le recouvrement effacait'
);

/* La barre ne doit pas non plus decouper ce qu elle laisse passer a la ligne.
   Autoriser le retour a la ligne a revele un second plafond : #app-topbar
   portait un max-height de 96 px, alors que sa zone d actions mesure 124 px
   sur cet ecran. Les 28 px de trop sortaient de la boite — « Pointer entree »
   coupe par le haut, « Transfert » flottant sur le contenu de la page. Un
   plafond de hauteur sur une barre au contenu variable ne peut produire que
   cela : la decoupe est silencieuse, rien ne la signale. */

const regleBarre = markup.match(/#app-topbar \{([\s\S]*?)\n  \}/)[1]
  .replace(/\/\*[\s\S]*?\*\//g, '');   // les commentaires parlent de max-height, ils n en declarent pas
assert(
  !/max-height\s*:/.test(regleBarre),
  'La barre de titre ne doit pas etre plafonnee en hauteur : son contenu varie d un ecran a ' +
  'l autre, et un plafond decoupe silencieusement ce qui passe a la ligne'
);
assert(
  /min-height:\s*var\(--topbar-h\)/.test(regleBarre),
  'La barre doit garder sa hauteur de repos : elle ne grandit que lorsque son contenu le demande'
);

/* ── 2. Le titre de l'ecran ne doit pas etre ecrit deux fois ──
   Il figurait dans la barre — mecanisme commun a tous les ecrans — et etait
   repete dans la premiere carte de Mouvements. Aucun autre ecran ne le fait :
   le doublon etait aussi une incoherence. La copie retiree est celle de la
   page ; la barre garde la sienne. Aucun texte n'a ete cree ni reformule. */

const carte = markup.match(/<div class="card ops-command-card[^"]*"[^>]*>([\s\S]*?)<div class="ops-workspace-switcher/);
assert(carte, 'La carte de commande de Mouvements doit rester reperable');
assert(
  !/<h2[^>]*>Mouvements caisse\/banque<\/h2>/.test(carte[1] + markup.slice(markup.indexOf('id="page-operations"'), markup.indexOf('ops-workspace-switcher'))),
  'Le titre de l ecran ne doit pas etre repete dans la page : la barre de titre le porte deja'
);
assert(
  !/Journal opérationnel des encaissements/.test(markup),
  'Le sous-titre repete dans la page doit rester retire : la barre porte deja le sien'
);

/* Ce qui devait survivre a survecu : la barre garde ses deux textes, et la
   carte garde le selecteur d espace de travail, qui etait son autre contenu. */
assert(
  /Journal des mouvements validés/.test(markup),
  'Le sous-titre de la barre de titre doit rester : c est la copie conservee'
);
for (const onglet of ['Journal validé', 'Décaissements', 'Rapprochement', 'Comptabilité', 'Import caisse']) {
  assert(
    new RegExp(`<span class="ops-workspace-title">${onglet}</span>`).test(markup),
    `L onglet « ${onglet} » doit rester : retirer le doublon de titre ne doit rien emporter d autre`
  );
}


/* ── 3. Les actions de l'ecran vivent dans l'ecran ──
   Decision du Directeur General, 01/09/2026. A 1366x768 la barre de titre de
   Mouvements portait quatre boutons plus la cloche, le theme et le profil :
   environ 620 px pour 517 px disponibles. Elle passait sur trois rangees et
   mesurait 149 px, ne laissant que 394 px de page utile. « Encaisser »,
   « Decaisser » et « Transfert » n'appartiennent pas au chassis de
   l'application : ce sont les actions de cet ecran. Elles sont descendues dans
   la carte qui porte deja ses onglets, telles quelles. */

const navigation = fs.readFileSync(path.join(root, 'frontend/js/core/navigation.js'), 'utf8');
assert(
  !/tba-operations/.test(navigation) && !/tba-operations/.test(markup),
  'La barre de titre ne doit plus porter de groupe d actions pour Mouvements : ses actions sont dans la page'
);

const actionsPage = markup.match(/<div class="ops-page-actions[\s\S]*?\n          <\/div>/);
assert(actionsPage, 'Les actions de l ecran doivent figurer dans la page');
for (const action of ['Encaisser', 'Décaisser', 'Transfert']) {
  assert(
    new RegExp(`<span class="action-label">${action}</span>`).test(actionsPage[0]),
    `L action « ${action} » doit avoir suivi le deplacement, libelle compris`
  );
}
for (const appel of ['openEncaissementModal()', 'openDecaissementModal()', 'openVirementModal()']) {
  assert(
    actionsPage[0].includes(appel),
    `Le deplacement ne doit rien changer au comportement : ${appel} doit rester attache a son bouton`
  );
}

/* ── 4. Le cycle de validation ne doit plus dicter la hauteur de ligne ──
   Decision du Directeur General : garder l'ordre, retirer les libelles.
   Une ligne faisait 127 px, dictee par cette seule colonne (98 px) qui
   empilait trois pastilles dont les libelles — TRESORERIE, COMPTABILITE,
   BUDGET — sont identiques sur les 719 lignes. Le reste de la ligne tient en
   62 px. Mesure apres : ligne 91 px, table -31 %, 3,1 -> 4,3 lignes par ecran.
   Le plancher n'est plus impose par cette colonne mais par le montant. */

const etape = markup.match(/const syncStep = \(label, value\) => \{[\s\S]*?\n  \};/)[0];
assert(
  !/ops-flow-label/.test(markup),
  'Le libelle d etape ne doit plus etre peint dans chaque pastille — ni sa regle CSS rester en place'
);
assert(
  /title="\$\{label\} : \$\{etat\}"/.test(etape) && /aria-label="\$\{label\} : \$\{etat\}"/.test(etape),
  'Le nom de l etape doit survivre en infobulle ET en aria-label : il n est pas supprime, il est deplace'
);
assert(
  /<span class="ops-flow-status">\$\{etat\}<\/span>/.test(etape),
  'La pastille doit continuer de porter son etat'
);

/* L'ordre est ce qui remplace les libelles : il ne doit pas bouger. */
const flux = markup.match(/const operationFlow = \(o\) => `[\s\S]*?`;/)[0];
const ordre = [...flux.matchAll(/syncStep\('([^']+)'/g)].map(m => m[1]);
assert.deepStrictEqual(
  ordre, ['Trésorerie', 'Comptabilité', 'Budget'],
  'L ordre des trois etapes remplace desormais leurs libelles : il ne peut plus changer sans rendre les pastilles illisibles'
);

/* L'en-tete de colonne continue de nommer ce dont il s'agit. */
assert(
  /Cycle de validation/.test(markup),
  'L en-tete « Cycle de validation » doit rester : c est lui qui nomme la colonne maintenant que les pastilles ne le font plus'
);

const regleListe = markup.match(/\.ops-flow-list \{([\s\S]*?)\}/)[1];
assert(
  /display:\s*flex/.test(regleListe) && /flex-wrap:\s*nowrap/.test(regleListe),
  'Les pastilles doivent rester cote a cote : empilees, elles imposaient 98 px a la ligne'
);
assert(
  /#page-operations table td:nth-child\(2\) \{ max-width: 300px; \}/.test(markup),
  'La colonne « Opération » doit rester bornee : sans cela le debordement horizontal du tableau passe de 119 a 188 px'
);


console.log(JSON.stringify({
  topbarActionsWrapInsteadOfOverlapping: true,
  subtitleStillPresent: true,
  inPageTitleDuplicateRemoved: true,
  inPageSubtitleDuplicateRemoved: true,
  topbarCopyKept: true,
  workspaceSwitcherIntact: true,
  screenActionsMovedIntoThePage: true,
  movedActionsKeptTheirLabelsAndBehaviour: true,
  stageNameMovedToTooltipNotDeleted: true,
  stageOrderLocked: true,
  columnHeaderStillNamesIt: true,
  pillsSideBySide: true,
}));
