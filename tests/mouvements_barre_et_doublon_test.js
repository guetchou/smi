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

console.log(JSON.stringify({
  topbarActionsWrapInsteadOfOverlapping: true,
  subtitleStillPresent: true,
  inPageTitleDuplicateRemoved: true,
  inPageSubtitleDuplicateRemoved: true,
  topbarCopyKept: true,
  workspaceSwitcherIntact: true,
}));
