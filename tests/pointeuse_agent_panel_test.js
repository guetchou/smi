const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

const panelFn = markup.match(/function _ptRenderAgentPanel\(\) \{[\s\S]*?\n\}/)[0];

/* ── Un responsable est aussi un salarié qui pointe ── */

assert(
  !/if \(_ptIsManager\) \{[\s\S]*?panel\.innerHTML = '';[\s\S]*?return;/.test(panelFn),
  'Le panneau de pointage personnel ne doit plus être supprimé pour un responsable'
);
assert(
  /panel\.classList\.remove\('hidden'\)/.test(panelFn),
  'Le panneau doit être rendu visible quel que soit le rôle'
);
assert(
  !/panel\.classList\.add\('hidden'\)/.test(panelFn),
  'Aucun chemin ne doit re-masquer le panneau personnel'
);

/* ── Ce que le panneau doit continuer de porter ── */

assert(/ptOpenSortie\(\$\{p\.id\}\)/.test(panelFn), 'Le bouton de sortie contextuel doit rester dans le panneau');
assert(/Pointer sortie/.test(panelFn) && /Pointer entrée/.test(panelFn), 'Les deux libellés d’action doivent rester disponibles');
assert(/_ptLiveDureeCell\(p\)/.test(panelFn), 'Le compteur de durée doit rester rattaché au panneau');
assert(/pinLabel/.test(panelFn), 'L’état du PIN doit rester visible');
assert(/Compte non lié à une fiche agent/.test(panelFn), 'Le cas du compte non rattaché doit rester traité');

/* ── Le bandeau ne doit pas afficher une action qui ment ── */

const ui = fs.readFileSync(path.join(root, 'frontend/js/pages/pointeuse-v3.js'), 'utf8');
assert(
  /btn\.style\.display=\(mode==='active'\|\|agentPanelUsable\(\)\)\?'none':''/.test(ui),
  'Le bouton figé du bandeau doit s’effacer dès qu’un contrôle contextuel est disponible'
);
assert(
  /function agentPanelUsable\(\)\{[^}]*!n\.classList\.contains\('hidden'\)[^}]*n\.childElementCount>0/.test(ui),
  'Le bandeau ne doit s’effacer que si le panneau est réellement exploitable'
);

console.log(JSON.stringify({
  managerKeepsPersonalClock: true,
  exitButtonReachable: true,
  liveCounterReachable: true,
  topbarNoLongerLies: true,
}));
