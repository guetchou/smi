'use strict';
/*
 * Garde — le curseur allume, les champs ne s'étirent pas, la saisie est aidée.
 *
 * Trois remarques du 16/09/2026, toutes vérifiées dans la feuille de style et
 * le balisage avant correction :
 *
 *   1. « en déplaçant le curseur en arrivant sur champ ou bouton on mettre
 *      surbrillance » — le produit n'avait AUCUN état de survol sur les
 *      champs : zéro règle input:hover / select:hover / textarea:hover. Rien
 *      ne signalait qu'un champ était saisissable avant de cliquer dedans.
 *      Et depuis que le bouton secondaire portait --c-border-h au repos, sa
 *      bordure ne bougeait plus au survol : le geste avait disparu.
 *
 *   2. « les champs sont trop larges et trop étirés sur largeur » — mesuré
 *      dans la modale d'encaissement : 397 px pour une date, un montant ou une
 *      liste, sur une grille de deux colonnes étirées.
 *
 *   3. « ajouter des autocomplétions pour aider, à défaut l'utilisateur peut
 *      remplir manuellement » — le bénéficiaire du décaissement et le motif du
 *      transfert étaient les deux seuls champs libres sans aide, alors que
 *      l'encaissement assistait déjà son tiers et son libellé.
 *
 * Après correction, mesuré sur le banc : champs à 260 px sur trois colonnes,
 * montant plafonné à 220 px, liste du bénéficiaire ouverte à la prise de focus
 * avec trois propositions, et la frappe libre conservée.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. le curseur allume ──────────────────────────────────────────────── */

verifier('un champ s allume au passage du curseur', () => {
  assert.ok(/input:hover:not\(:focus\)/.test(html),
    'Le produit n avait aucun etat de survol sur les champs : rien ne disait '
    + 'qu on pouvait y ecrire avant d avoir clique dedans');
  assert.ok(/select:hover:not\(:focus\)/.test(html), 'les listes aussi');
  assert.ok(/textarea:hover:not\(:focus\)/.test(html), 'les zones de texte aussi');
  const bloc = (html.match(/input:hover:not\(:focus\)[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/border-color: var\(--c-border-survol\)/.test(bloc),
    'Le survol doit allumer la bordure');
  assert.ok(/:not\(\[readonly\]\)/.test(bloc) && /:not\(\[disabled\]\)/.test(bloc),
    'Un champ en lecture seule ou desactive ne doit pas pretendre qu on peut y ecrire');
});

verifier('le survol ne se confond pas avec le focus', () => {
  assert.ok(/input:hover:not\(:focus\)/.test(html),
    'Le survol doit ceder la place au focus, pas le recouvrir');
  const focus = (html.match(/input:focus, select:focus, textarea:focus \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/border-color: var\(--c-primary\)/.test(focus),
    'Le focus garde sa couleur propre, plus franche que le survol');
});

verifier('le survol du bouton secondaire redevient visible', () => {
  /* Il portait --c-border-h au repos ET au survol : la bordure ne bougeait
     plus. Elle va desormais un cran plus loin. */
  const repos = (html.match(/\n  \.btn-secondary \{[\s\S]*?\n  \}/) || [])[0] || '';
  /* Ancre en debut de ligne : sans elle, l expression attrape
     « #topbar-actions .btn-secondary:hover », qui est une autre regle et ne
     porte pas le meme contenu. */
  const survol = (html.match(/^  \.btn-secondary:hover \{[^}]*\}/m) || [])[0] || '';
  assert.ok(repos && survol, 'les deux etats du bouton secondaire sont introuvables');
  assert.ok(/border-color: var\(--c-border-h\)/.test(repos), 'au repos : bordure franche');
  assert.ok(/border-color: var\(--c-border-survol\)/.test(survol),
    'au survol : un cran plus loin, sinon le geste ne se voit pas');
  assert.ok(/transform: translateY\(-1px\)/.test(survol), 'et il se souleve');
});

verifier('la bordure de survol est un jeton, declare une fois', () => {
  assert.strictEqual((html.match(/--c-border-survol:/g) || []).length, 1,
    'Une seule declaration : deux finiraient par diverger');
  assert.ok(/--c-border-survol: #94A3B8/.test(html),
    'Elle se place entre la bordure franche et l encre secondaire');
});

/* ── 2. les champs ne s'étirent plus ───────────────────────────────────── */

verifier('les grilles de formulaire cessent d etirer les champs', () => {
  assert.ok(/\.operation-modal-grid \{[\s\S]{0,160}repeat\(auto-fill, minmax\(240px, 1fr\)\)/.test(html),
    'auto-fill garde les colonnes vides : sans lui, deux champs s etirent sur '
    + 'toute la largeur, ce qui donnait 397 px pour une date');
  assert.ok(!/repeat\(2, minmax\(260px, 1fr\)\)/.test(html),
    'La grille a deux colonnes fixes doit avoir disparu');
  assert.ok(!/repeat\(auto-fit, minmax\(240px/.test(html),
    'auto-fit replie les colonnes vides et etire quand meme : ce n est pas lui qu il faut');
});

verifier('une date et un montant ne prennent que la place de leur donnee', () => {
  assert.ok(/\.modal input\[type="date"\],[\s\S]{0,140}max-width: 220px/.test(html),
    'Une date tient en dix caracteres, un montant en douze : les etirer se lit '
    + 'mal et fait perdre le repere du champ');
});

/* ── 3. la saisie est aidée, jamais contrainte ─────────────────────────── */

verifier('le beneficiaire du decaissement est assiste', () => {
  assert.ok(html.includes(`tiersSearch('dec-tiers','dec-tiers-drop')`),
    'Le decaissement laissait taper le beneficiaire a la main alors que '
    + 'l encaissement assistait deja son tiers, avec le meme cache');
  assert.ok(html.includes('id="dec-tiers-drop"'),
    'La liste a besoin de son conteneur');
  assert.ok(/<div id="dec-benef-text-wrapper" class="relative">/.test(html),
    'La liste se positionne sur un parent en relative, sinon elle flotte ailleurs');
});

verifier('le motif du transfert se nourrit de ce qui a deja ete ecrit', () => {
  /* La fonction prend desormais une rubrique en second argument. */
  assert.ok(/function motifsDejaEmployes\(typeOp, rubriqueId\)/.test(html),
    'Les motifs de transfert ne se configurent nulle part : ils se lisent dans '
    + 'les operations passees');
  assert.ok(html.includes(`brancherAutocompletion('vir-libelle'`),
    'Le motif du transfert doit etre branche a l ouverture de sa fenetre');
  const f = (html.match(/function motifsDejaEmployes[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(/l\.type_op === typeOp/.test(f) && /o\.type_op === typeOp/.test(f),
    'Chaque type d operation propose ses propres motifs, et des deux sources : '
    + 'ce que le serveur renvoie et ce que l ecran a deja sous la main');
  assert.ok(/sousLaRubrique/.test(f),
    'Ce qui a ete ecrit sous la rubrique choisie doit venir en tete : c est la '
    + 'ce qui oriente vraiment');
});

verifier('une liste vide n empeche jamais de taper', () => {
  const f = (html.match(/function brancherAutocompletion[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'brancherAutocompletion introuvable');
  assert.ok(/if \(!liste\.length\) \{ drop\.style\.display = 'none'; return; \}/.test(f),
    'Sans proposition, rien ne s affiche — la saisie manuelle reste entiere, '
    + 'c est la condition posee : « a defaut l utilisateur peut remplir manuellement »');
  assert.ok(/inp\.value = motif/.test(f),
    'Choisir une proposition remplit le champ, sans le verrouiller');
});

verifier('les propositions sont posees en texte, jamais en HTML', () => {
  const f = (html.match(/function brancherAutocompletion[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(/item\.textContent = motif/.test(f),
    'Ces motifs viennent de libelles saisis par des agents et relus depuis la '
    + 'base : les poser en innerHTML ouvrirait une injection');
  assert.ok(!/drop\.innerHTML = trouves/.test(f),
    'Aucune interpolation de donnee utilisateur dans du HTML');
  assert.ok(/addEventListener\('mousedown'/.test(f),
    'Le gestionnaire se pose par le DOM, pas par un attribut construit en chaine');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — survol, largeur, aide a la saisie`);
process.exit(echecs ? 1 : 0);
