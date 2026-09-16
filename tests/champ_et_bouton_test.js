'use strict';
/*
 * Garde — un champ ne ressemble pas à un bouton.
 *
 * Plainte du 16/09/2026 : « on a du mal à lire le modèle des boutons et cases
 * de remplissage, on a du mal à faire la différence ». Mesuré dans la feuille
 * de style du produit, et pas seulement sur les écrans d'argent :
 *
 *     input, select, textarea { background: var(--c-surface);   <- #FFFFFF
 *                               border: 1.5px solid var(--c-border); }  <- #E2E8F0
 *     .btn-secondary          { background: var(--c-surface);   <- #FFFFFF
 *                               border-color: var(--c-border); }        <- #E2E8F0
 *
 * Même fond, même bordure, même épaisseur. Sur blanc, #E2E8F0 donne environ
 * 1,2:1 de contraste là où il en faut 3 pour qu'une limite d'interface se
 * perçoive. La plainte était donc exacte, et elle valait pour les trente-trois
 * modales du produit, ses barres de filtres et ses tiroirs.
 *
 * Le produit définissait déjà --c-border-h (#CBD5E1), une bordure franche, et
 * ne s'en servait qu'au survol du bouton secondaire.
 *
 * Correction : le champ se creuse — fond --c-surface-2, bordure --c-border-h,
 * ombre intérieure — et le bouton garde son fond blanc avec une ombre portée.
 * Creux contre relief : la convention la plus ancienne et la moins ambiguë.
 *
 * Cette garde tient la règle à sa place — une seule fois, globalement — parce
 * qu'une seconde déclaration ailleurs finirait par diverger. C'est déjà arrivé
 * sur ce fichier : les écrans d'argent portaient leur propre copie, retirée
 * ici au profit de la règle commune.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. le champ se creuse ─────────────────────────────────────────────── */

verifier('le champ a un fond distinct de celui du bouton', () => {
  const bloc = (html.match(/\n  input, select, textarea \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(bloc, 'le bloc global des champs est introuvable');
  assert.ok(/background: var\(--c-surface-2\)/.test(bloc),
    'Le champ doit avoir son propre fond : il partageait #FFFFFF avec le bouton secondaire');
  assert.ok(/border: 1\.5px solid var\(--c-border-h\)/.test(bloc),
    'Le champ doit porter la bordure franche : #E2E8F0 sur blanc ne donne que 1,2:1');
  assert.ok(/box-shadow: inset /.test(bloc),
    'L ombre interieure est ce qui dit « creux » : sans elle, un fond gris reste ambigu');
});

verifier('le champ actif remonte au blanc', () => {
  const bloc = (html.match(/input:focus, select:focus, textarea:focus \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(bloc, 'le bloc de focus est introuvable');
  assert.ok(/background: var\(--c-surface\)/.test(bloc),
    'Le creux se remplit quand on y ecrit : c est le signal que le champ est actif');
  assert.ok(/border-color: var\(--c-primary\)/.test(bloc),
    'Le focus doit rester visible au clavier');
});

/* ── 2. le bouton se distingue au repos ────────────────────────────────── */

verifier('le bouton secondaire porte la bordure franche des le repos', () => {
  const bloc = (html.match(/\n  \.btn-secondary \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(bloc, '.btn-secondary est introuvable');
  assert.ok(/border-color: var\(--c-border-h\)/.test(bloc),
    'Il allait deja a --c-border-h au survol : il doit y aller au repos, sinon '
    + 'rien ne le distingue du champ qu il cotoie');
  assert.ok(/background: var\(--c-surface\)/.test(bloc),
    'Le bouton garde le fond blanc : c est l oppose du champ, desormais gris');
  assert.ok(/box-shadow: var\(--shadow-xs\)/.test(bloc),
    'L ombre portee dit « relief », face a l ombre interieure du champ');
});

/* ── 3. une seule déclaration, pas deux qui divergent ──────────────────── */

verifier('le creux n est declare qu une fois', () => {
  const creux = (html.match(/box-shadow: inset 0 1px 2px rgba\(/g) || []).length;
  assert.strictEqual(creux, 1,
    `${creux} declarations du creux. Deux styles du meme composant finissent par `
    + 'diverger — les ecrans d argent portaient leur propre copie, retiree au '
    + 'profit de la regle commune.');
});

verifier('les ecrans d argent ne redefinissent plus le champ ni le bouton', () => {
  assert.ok(!/\.op-shell-duo input[^{]*\{[^}]*background: var\(--c-surface-2\)/.test(html),
    'La surcharge du champ sur les ecrans d argent doit avoir disparu');
  assert.ok(!/\.op-shell-duo \.btn-secondary \{/.test(html),
    'La surcharge du bouton secondaire sur les ecrans d argent doit avoir disparu');
  /* Ce qui reste leur est propre : la géométrie du panneau. */
  assert.ok(/\.op-shell-duo \{[\s\S]{0,200}grid-template-columns: 328px/.test(html),
    'La geometrie du panneau, elle, reste propre aux ecrans d argent');
});

/* ── 4. ce qui ne doit pas avoir bougé ─────────────────────────────────── */

verifier('la bordure franche du produit est celle qui sert', () => {
  assert.ok(/--c-border-h:\s*#CBD5E1/.test(html),
    'Le jeton --c-border-h doit rester defini : c est lui qu on emploie');
  assert.ok(/--c-surface-2:\s*#F8FAFC/.test(html),
    'Le jeton --c-surface-2 doit rester defini : c est le fond du champ');
  assert.ok(/--c-border:\s*#E2E8F0/.test(html),
    'La bordure douce garde son usage ailleurs — separateurs, cadres de cartes');
});

verifier('le survol du bouton secondaire reste distinct de son repos', () => {
  assert.ok(/\.btn-secondary:hover \{[^}]*background: var\(--c-surface-2\)/.test(html),
    'Au survol le bouton s enfonce legerement : le geste doit rester lisible '
    + 'maintenant que la bordure ne change plus');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — champ et bouton`);
process.exit(echecs ? 1 : 0);
