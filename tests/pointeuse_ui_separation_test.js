const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const ui = read('frontend/js/pages/pointeuse-v3.js');
const adminUi = read('frontend/js/pages/pointeuse-v3-admin-ui.js');
const markup = read('frontend/dashboard.html');

for (const source of [ui, adminUi]) new Function(source);

/* ── 1. L'interface ne raconte plus l'architecture ni la migration ── */

const EXPLICATIONS_RETIREES = [
  'contrôlés par le serveur',
  'ajustement traçable',
  'Cycle industriel',
  'snapshot paie',
  'La réouverture est contrôlée',
  'Activer uniquement après rapprochement',
  'rollback applicatif',
];
for (const phrase of EXPLICATIONS_RETIREES) {
  assert(
    !ui.includes(phrase) && !adminUi.includes(phrase),
    `Explication technique réintroduite dans l’interface : « ${phrase} »`
  );
}

/* ── 2. Ce qui porte un état réel doit rester visible ── */

assert(/Mode observation/.test(ui), 'L’état shadow doit rester annoncé à l’utilisateur');
assert(/class="p3-mode \$\{esc\(mode\)\}"/.test(ui), 'Le mode courant doit rester affiché en pastille');
assert(/\['reconcile','Rapprochement'\]/.test(ui), 'L’onglet de rapprochement doit rester accessible');
/* Les états vides ont été reformulés le 31/08/2026 : source éditoriale PR #125
   « retirer le vocabulaire technique de l'interface métier », approuvée
   explicitement. Le garde-fou reste : chaque état vide doit exister et être
   formulé sans identifiant technique ni numéro de version interne. */
for (const vide of [
  'Aucune situation à vérifier.',
  'Aucun pointage sur la période.',
]) {
  assert(ui.includes(vide), `État vide manquant : ${vide}`);
}
assert(!/Aucun événement V3/.test(ui), 'Le numéro de version interne ne doit pas apparaître dans un état vide');

/* ── 3. Le compteur de durée est borné ── */

const cutoffMatch = markup.match(/const PT_DUREE_CUTOFF_MINUTES = (\d+);/);
assert(cutoffMatch, 'Le compteur de durée doit déclarer une borne explicite');
assert.strictEqual(
  Number(cutoffMatch[1]),
  engine.DEFAULT_DAY_CUTOFF_MINUTES,
  'La borne du compteur V2 doit rester alignée sur le cutoff du moteur V3'
);

const cell = markup.match(/function _ptLiveDureeCell\(p\) \{[\s\S]*?\n\}/)[0];
assert(
  /if \(mins === null \|\| mins > PT_DUREE_CUTOFF_MINUTES\) return _esc\(_ptFmtDuree\(p\.duree_minutes\)\);/.test(cell),
  'Une journée abandonnée ne doit plus être présentée comme en cours'
);
assert(
  !/_ptFmtDuree\(mins \?\? 0\)/.test(cell),
  'Une durée inconnue ne doit pas être rendue comme une durée nulle'
);

const refresh = markup.match(/function _ptRefreshDurations\(\) \{[\s\S]*?\n\}/)[0];
assert(
  /removeAttribute\('data-pt-live-duration'\)/.test(refresh),
  'Le rafraîchissement doit cesser de suivre une journée dépassant la borne'
);
assert(
  /el\.textContent = _ptFmtDuree\(null\);/.test(refresh),
  'La durée inconnue doit réutiliser le format existant, sans nouvelle chaîne'
);

/* ── 4. Aucune chaîne visible n'a été inventée ── */

assert(
  !/'—'/.test(refresh) && !/"—"/.test(refresh),
  'Le tiret d’absence doit venir de _ptFmtDuree, pas d’un littéral ajouté'
);

console.log(JSON.stringify({
  technicalCopyRemoved: true,
  stateIndicatorsPreserved: true,
  durationCounterBounded: true,
  cutoffAlignedWithEngine: true,
  noInventedCopy: true,
}));
