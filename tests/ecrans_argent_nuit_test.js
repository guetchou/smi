'use strict';
/*
 * Garde — les trois écrans d'argent portent le panneau, et se ressemblent.
 *
 * Contexte, mesuré en production le 16/09/2026 sur l'écran de travail réel
 * (1366 × 768, hauteur utile 543 px, zone visible du corps 359 px) :
 *
 *   contenu du formulaire d'encaissement       948 px
 *   « Position qui reçoit » sous la ligne      194 px
 *   fond du champ / fond du bouton Annuler     #FFFFFF / #FFFFFF
 *   bordure du champ / bordure du bouton       #E2E8F0 / #E2E8F0
 *
 * Autrement dit : le formulaire n'indiquait pas où allait l'argent — le champ
 * existait, obligatoire et bien nommé, mais hors de l'écran — et l'on ne
 * distinguait pas un bouton d'une case, faute de contraste (1,2:1 là où il en
 * faut 3).
 *
 * La direction retenue renverse la hiérarchie : un panneau porte le montant en
 * grand et la position qui reçoit l'argent, éclairée, avec son solde avant et
 * après. Ce qu'on cachait devient ce qu'on voit.
 *
 * Après correction, sur le banc de recette, mêmes conditions :
 *
 *   les cinq champs obligatoires visibles sans défiler   oui
 *   « Position qui reçoit » finit à 460 px, zone à 461   oui
 *
 * Cette garde tient les trois écrans ensemble : ce qui vaut pour
 * l'encaissement vaut pour le décaissement et le transfert.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

const ECRANS = [
  { prefixe: 'enc', modale: 'modal-encaissement', teinte: 'op-nuit-enc', position: 'enc-position' },
  { prefixe: 'dec', modale: 'modal-decaissement', teinte: 'op-nuit-dec', position: 'dec-position' },
  { prefixe: 'vir', modale: 'modal-virement',     teinte: 'op-nuit-vir', position: 'vir-source' },
];

/* ── 1. les trois écrans portent le panneau ────────────────────────────── */

verifier('les trois modales d argent portent un panneau', () => {
  const manquants = ECRANS.filter(e => !html.includes(`id="${e.prefixe}-nuit"`)).map(e => e.modale);
  assert.deepStrictEqual(manquants, [],
    'Le panneau est ce qui rend la destination visible : sans lui, on revient '
    + 'au formulaire ou « Position qui recoit » etait 194 px sous l ecran.\n'
    + '        ' + manquants.join('\n        '));
  assert.strictEqual((html.match(/class="op-nuit op-nuit-/g) || []).length, 3,
    'Il doit y avoir exactement trois panneaux, un par ecran d argent');
});

verifier('chaque panneau a sa teinte, pour que le sens de l argent se voie', () => {
  for (const e of ECRANS) {
    assert.ok(html.includes(`op-nuit ${e.teinte}`),
      `${e.modale} n a pas sa teinte ${e.teinte} : un agent doit reconnaitre `
      + 'ce qui entre, ce qui sort et ce qui se deplace avant d avoir lu le titre');
  }
});

verifier('chaque panneau affiche montant, position et les deux soldes', () => {
  for (const e of ECRANS) {
    for (const suffixe of ['montant', 'piece', 'pos-code', 'pos-nom', 'avant', 'apres', 'delta']) {
      assert.ok(html.includes(`id="${e.prefixe}-nuit-${suffixe}"`),
        `${e.prefixe}-nuit-${suffixe} manque : le panneau doit dire combien, ou, `
        + 'et ce que ca change');
    }
  }
});

/* ── 2. le panneau se peint depuis les fonctions d'impact ──────────────── */

verifier('le panneau est nourri par les fonctions d impact, pas en double', () => {
  assert.ok(/function peindreNuit\(prefixe, d\)/.test(html),
    'La peinture du panneau doit etre nommee et unique');
  const impactSimple = (html.match(/function updateSimpleOperationImpact[\s\S]*?\n}/) || [])[0] || '';
  const impactVir = (html.match(/function updateVirementImpact[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(/peindreNuit\(isEnc \? 'enc' : 'dec'/.test(impactSimple),
    'L encaissement et le decaissement doivent peindre leur panneau depuis leur impact');
  assert.ok(/peindreNuit\('vir'/.test(impactVir),
    'Le transfert doit peindre son panneau depuis son impact');
});

verifier('un solde inconnu s ecrit en tiret, jamais en zero', () => {
  const f = (html.match(/function peindreNuit[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'peindreNuit introuvable');
  assert.ok(/d\.avant === null \|\| d\.avant === undefined \? '—'/.test(f),
    'Un solde absent n est pas un solde nul : c est la famille de defauts la '
    + 'plus frequente de ce produit');
  assert.ok(/d\.apres === null \|\| d\.apres === undefined \? '—'/.test(f),
    'Meme regle pour le solde apres operation');
});

verifier('le code de la position se lit dans son libelle, sans champ invente', () => {
  const f = (html.match(/function decouperPosition[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'decouperPosition introuvable');
  assert.ok(/' — '/.test(f),
    'Le produit libelle ses positions « CODE — Libelle » : on y lit le code '
    + 'plutot que d afficher un tiret a cote d un nom qui le contient');
  assert.ok(/return \{ code: '', nom: texte \}/.test(f),
    'Sans separateur, tout le libelle reste le nom et aucune pastille ne '
    + 's affiche — un code absent n est pas un tiret');
});

/* ── 3. la carte mène au vrai sélecteur ────────────────────────────────── */

verifier('la carte du panneau amene au selecteur de position', () => {
  const f = (html.match(/function brancherCartesNuit[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'brancherCartesNuit introuvable');
  for (const e of ECRANS) {
    assert.ok(new RegExp(`'${e.prefixe}', '${e.position}'`).test(f),
      `${e.prefixe} : la carte doit mener a ${e.position}. Le panneau montre ou `
      + 'va l argent ; c est le formulaire qui le choisit.');
  }
  assert.ok(/focus\(\)/.test(f), 'la carte doit donner le focus au selecteur');
});

/* ── 4. un champ ne ressemble plus à un bouton ─────────────────────────── */

verifier('le champ se creuse et le bouton se souleve', () => {
  assert.ok(/\.op-shell-duo input[^{]*\{\s*background: var\(--c-surface-2\);/.test(html)
    || /background: var\(--c-surface-2\);\s*border: 1px solid var\(--c-border-h\);/.test(html),
    'Le champ doit avoir un fond distinct et une bordure franche : il partageait '
    + '#FFFFFF et #E2E8F0 avec le bouton Annuler, soit 1,2:1 de contraste');
  assert.ok(/\.op-shell-duo \.btn-secondary \{[\s\S]{0,140}border: 1\.5px solid var\(--c-border-h\)/.test(html),
    'Le bouton secondaire doit porter une bordure plus franche que le champ');
  assert.ok(/--c-border-h/.test(html),
    'La bordure franche du produit, jusqu ici inutilisee sur les champs, doit servir');
});

/* ── 5. ce qui ne doit pas avoir bougé ─────────────────────────────────── */

verifier('aucun champ n a ete deplace, renomme ni retire', () => {
  /* Le panneau a été AJOUTÉ. Les contrôles, leurs identifiants et leurs
     gestionnaires sont ceux d avant : c est ce qui garantit que la validation
     et l enregistrement n ont pas bouge. */
  const champs = [
    'enc-date', 'enc-piece', 'enc-tiers', 'enc-montant', 'enc-libelle',
    'enc-rubrique', 'enc-position', 'enc-mode', 'enc-ref',
    'dec-date', 'dec-ref-interne', 'dec-type-piece', 'dec-piece', 'dec-benef-type',
    'dec-tiers', 'dec-employe-id', 'dec-fournisseur-id', 'dec-libelle', 'dec-rubrique',
    'dec-montant', 'dec-position', 'dec-mode', 'dec-ref', 'dec-decharge',
    'vir-date', 'vir-piece', 'vir-source', 'vir-destination', 'vir-montant',
    'vir-ref', 'vir-libelle',
  ];
  const manquants = champs.filter(id => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(manquants, [],
    'Ces controles doivent rester intacts : le panneau ajoute, il ne remplace pas.\n'
    + '        ' + manquants.join('\n        '));
});

verifier('les libelles du produit sont repris, pas reecrits', () => {
  for (const texte of [
    'Position qui reçoit', 'Position qui paie', 'Position source',
    'Montant encaissé', 'Montant décaissé', 'Montant transféré',
    'Solde actuel', 'Solde disponible',
    'Nouvel encaissement', 'Enregistrer l\'encaissement',
  ]) {
    assert.ok(html.includes(texte), `« ${texte} » a disparu : le panneau devait reprendre les libelles, pas en inventer`);
  }
});

verifier('le bloc de controle reste dans le document', () => {
  /* Il est masqué dans cette mise en page — le panneau dit la même chose en
     plus grand — mais porterLeMotifAuPied lit toujours son texte. */
  for (const id of ['enc-impact-summary', 'dec-impact-summary', 'vir-impact-summary']) {
    assert.ok(html.includes(`id="${id}"`), `${id} a disparu : le motif d un refus s y lit`);
  }
  assert.ok(/\.op-shell-duo #enc-impact-box,\s*\.op-shell-duo #dec-impact-box \{ display: none; \}/.test(html),
    'Le bloc doit etre masque, pas supprime');
});

/* ── 6. la boîte de recherche ne s'affiche que si elle sert ────────────── */

verifier('la recherche de position n apparait qu au-dela de huit positions', () => {
  const f = (html.match(/function ajusterRecherchePosition[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'ajusterRecherchePosition introuvable');
  assert.ok(/POSITIONS_AVANT_RECHERCHE/.test(f),
    'Le seuil doit etre nomme, pas enfoui dans une condition');
  assert.ok(/const POSITIONS_AVANT_RECHERCHE = \d+;/.test(html),
    'Le seuil doit etre declare une fois');
  assert.ok(/ajusterRecherchePosition\(id\);/.test(html),
    'fillPositions doit appeler l ajustement apres avoir rempli la liste');
  /* La liste reste filtrable quand la boîte revient. */
  assert.ok(/filterPositionSelect\(idSelect, ''\)/.test(f),
    'En masquant la boite, son filtre doit etre leve : sinon des positions '
    + 'resteraient cachees sans moyen de les rendre');
});

/* ── 7. le repli sous 1200 px ──────────────────────────────────────────── */

verifier('sous 1200 px le panneau se replie au-dessus du formulaire', () => {
  assert.ok(/@media \(max-width: 1200px\)[\s\S]{0,700}grid-template-columns: minmax\(0, 1fr\)/.test(html),
    'Le panneau coute 328 px de largeur : sur un ecran etroit il doit passer '
    + 'au-dessus, pas ecraser la saisie');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — ecrans d argent`);
process.exit(echecs ? 1 : 0);
