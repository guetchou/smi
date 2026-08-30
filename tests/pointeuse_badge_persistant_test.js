const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');
const navigation = fs.readFileSync(path.join(root, 'frontend/js/core/navigation.js'), 'utf8');

/* ── 1. La zone survit au changement d'écran ── */

assert(/id="tb-pointeuse-live"/.test(markup), 'La zone de pointage persistante doit exister dans le bandeau');
assert(
  /<div id="topbar-actions"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<div id="tb-pointeuse-live"/.test(markup),
  'La zone doit être placée dans le bandeau d’actions'
);

const zoneIds = navigation.match(/const TOPBAR_ACTION_ZONE_IDS = \[([\s\S]*?)\];/)[1];
assert(
  !zoneIds.includes('tb-pointeuse-live'),
  'La zone ne doit pas figurer parmi les zones que updateTopbarActions masque à chaque navigation'
);
assert(/'tba-pointeuse'/.test(zoneIds), 'Les zones existantes doivent rester inchangées');

/* ── 2. Les modales doivent être joignables depuis tout écran ── */

const detach = markup.match(/function _ptDetachModals\(\) \{[\s\S]*?\n\}/)[0];
for (const id of ['pt-modal-entree', 'pt-modal-sortie', 'pt-modal-correction', 'pt-modal-pin']) {
  assert(detach.includes(id), `La modale ${id} doit être rattachée au body`);
}
assert(
  /modal\.parentElement !== document\.body\) document\.body\.appendChild\(modal\)/.test(detach),
  'Les modales vivent sous #page-pointeuse, que showPage masque entièrement : elles doivent être re-parentées'
);
assert(
  /document\.querySelectorAll\('\.fade-in\[id\^="page-"\]'\)\.forEach\(el => \{\s*el\.classList\.toggle\('hidden'/.test(markup),
  'Le mécanisme de masquage de page qui justifie le re-parentage doit rester celui-ci'
);

/* ── 3. La pastille ne propose jamais une action qui échouerait ── */

const badge = markup.match(/function _ptRenderLiveBadge\(ctx\) \{[\s\S]*?\n\}/)[0];
assert(
  /if \(p\?\.heure_sortie \|\| \['absent', 'teletravail', 'terrain'\]\.includes\(p\?\.statut\)\) return masquer\(\);/.test(badge),
  'Journée close ou statut hors présence : aucune action ne doit être proposée'
);
assert(/if \(!ctx\?\.employe\) return masquer\(\);/.test(badge), 'Sans fiche agent, la pastille doit disparaître');
assert(/secs <= PT_DUREE_CUTOFF_MINUTES \* 60/.test(badge), 'La pastille doit respecter la borne de journée');
assert(/ptOpenSortie\(' \+ Number\(p\.id\)/.test(badge), 'L’identifiant doit être contraint en nombre avant interpolation');
assert(/_esc\(p\.date \|\| ''\)/.test(badge) && /_esc\(p\.heure_entree \|\| ''\)/.test(badge), 'Les valeurs interpolées doivent être échappées');

assert(/Pointer sortie/.test(badge) && /Pointer entrée/.test(badge), 'La pastille doit réutiliser les libellés existants');
assert(
  !/Compteur|En cours|Pointé|Vous êtes/.test(badge),
  'Aucun texte d’interface nouveau ne doit être introduit dans la pastille'
);

/* ── 4. Une seule minuterie, pilotée par le document et non par un rendu ── */

const sync = markup.match(/function _ptSyncChrono\(\) \{[\s\S]*?\n\}/)[0];
assert(
  /document\.querySelector\('\[data-pt-chrono\]'\)\) _ptStartChrono\(\);/.test(sync),
  'Le chronomètre doit démarrer dès qu’un élément chronométré existe dans le document'
);
assert(
  !/if \(chronoActif\) _ptStartChrono\(\); else _ptStopChrono\(\);/.test(markup),
  'Un rendu particulier ne doit plus décider seul d’éteindre la minuterie partagée'
);
const occurrencesSync = (markup.match(/_ptSyncChrono\(\);/g) || []).length;
assert(
  occurrencesSync >= 2,
  'Le panneau personnel et la pastille doivent tous deux passer par la synchronisation'
);

/* ── 5. Amorçage sur tous les écrans ── */

assert(
  /document\.addEventListener\('DOMContentLoaded', \(\) => \{ _ptBootLiveBadge\(\); \}, \{ once: true \}\);/.test(markup),
  'La pastille doit être amorcée quel que soit l’écran d’arrivée'
);
const boot = markup.match(/async function _ptBootLiveBadge\(\) \{[\s\S]*?\n\}/)[0];
assert(/if \(!token\) return;/.test(boot), 'Aucun appel réseau sans session');
assert(/_ptDetachModals\(\);/.test(boot), 'Les modales doivent être re-parentées à l’amorçage');
assert(
  /if \(!_ptLinkedEmployeId\(\)\) return;/.test(boot),
  'Un compte sans fiche agent reçoit 409 : ne pas déclencher une requête vouée à échouer sur chaque écran'
);
const lien = markup.match(/function _ptLinkedEmployeId\(\) \{[\s\S]*?\n\}/)[0];
assert(
  /currentUser\?\.employe_id/.test(lien) && /tc_user/.test(lien),
  'Le rattachement doit être lu de façon robuste, même avant initialisation de currentUser'
);

/* ── 6. Un seul point de rafraîchissement pour tous les chemins de pointage ── */

const loader = markup.match(/async function _ptLoadSelfContext\(date\) \{[\s\S]*?\n\}/)[0];
assert(
  /_ptRenderLiveBadge\(ctx\);/.test(loader),
  'La pastille doit se rafraîchir par le chargeur commun, que tous les chemins de pointage traversent'
);

console.log(JSON.stringify({
  badgeSurvivesNavigation: true,
  modalsReachableEverywhere: true,
  noActionThatWouldFail: true,
  singleChronoOwnedByDom: true,
  bootedOnEveryScreen: true,
  refreshedByCommonLoader: true,
  noInventedCopy: true,
}));
