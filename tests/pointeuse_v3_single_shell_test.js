const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const ui = read('frontend/js/pages/pointeuse-v3.js');
const adminUi = read('frontend/js/pages/pointeuse-v3-admin-ui.js');
const markup = read('frontend/dashboard.html');

/* Les deux bundles doivent rester syntaxiquement valides. */
for (const source of [ui, adminUi]) new Function(source);

/* ── 1. Coquille unique ── */

assert(
  /\.pointeuse-v3-merged>:not\(#pointeuse-v3-root\):not\(#pointeuse-v3-legacy-store\):not\(\[id\^="pt-modal-"\]\)\{display:none!important\}/.test(ui),
  'La coquille doit masquer les blocs restés hors des onglets, sans toucher aux modales'
);
assert(/t\.classList\.add\('pointeuse-v3-merged'\)/.test(ui), 'La classe de coquille unique doit être posée au rendu');
assert(/#pointeuse-v3-legacy-store\{display:none!important\}/.test(ui), 'Le réceptacle doit être invisible');

/* ── 2. Les blocs V2 sont relogés, jamais recréés ── */

const LEGACY_KEYS = ['agentPanel', 'controls', 'kpis', 'journee', 'histo', 'adminConsole'];
for (const key of LEGACY_KEYS) {
  assert(new RegExp(`${key}:\\s*\\(\\)\\s*=>`).test(ui), `Le registre doit résoudre le bloc ${key}`);
  assert(ui.includes(`data-legacy="${key}"`), `Un emplacement doit accueillir le bloc ${key}`);
}

/* Aucun identifiant V2 ne doit être réémis par la coquille : les blocs sont
   déplacés, pas dupliqués. Sinon deux noeuds porteraient le même id. */
assert(!/id="pt-[a-z-]+"/.test(ui), 'La coquille ne doit jamais recréer un élément V2 porteur d’un id');

/* Les identifiants adressés par le registre doivent exister dans le markup. */
for (const id of ['pt-agent-panel', 'pt-kpis', 'pt-journee-tbody', 'pt-histo-tbody']) {
  assert(markup.includes(`id="${id}"`), `Le markup doit fournir ${id}`);
}
assert(/class="pt-control-bar/.test(markup), 'Le markup doit fournir la barre de contrôle V2');

/* ── 3. Survie aux réécritures de innerHTML ── */

const renderBody = ui.match(/async function renderBody\(\)\{[\s\S]*?\n  \}/)?.[0] || '';
assert(renderBody, 'renderBody doit être analysable');
assert(
  renderBody.indexOf('stashLegacy()') < renderBody.indexOf("body.innerHTML='<div class=\"p3-empty\">Chargement…</div>'"),
  'Les blocs doivent être mis à l’abri avant toute réécriture du corps'
);
assert(
  renderBody.indexOf('mountLegacy(body)') > renderBody.indexOf('else body.innerHTML=todayView()'),
  'Les blocs doivent être remontés après le rendu de la vue'
);

const render = ui.match(/\n  function render\(\)\{[\s\S]*?\n  \}/)?.[0] || '';
assert(render, 'render doit être analysable');
assert(
  render.indexOf('stashLegacy()') < render.indexOf('root.innerHTML='),
  'Les blocs doivent être mis à l’abri avant la réécriture de la coquille'
);

/* ── 4. La console d’administration ne pend plus sous la coquille ── */

assert(
  /\(document\.getElementById\('pointeuse-v3-legacy-store'\)\|\|root\)\.appendChild\(box\)/.test(adminUi),
  'La console doit être créée dans le réceptacle, pas empilée sous la coquille'
);
assert(!/;root\.appendChild\(box\);/.test(adminUi), 'L’ancien empilement de la console ne doit plus subsister');

/* ── 5. Ce que la fusion ne doit pas casser ── */

assert(/Mode observation/.test(ui), 'La distinction shadow / actif doit rester visible');
assert(/aria-live/.test(ui) && /role="tablist/.test(ui), 'Le socle d’accessibilité doit être conservé');
assert(
  /\.p3-today\{display:grid;grid-template-columns:minmax\(0,1\.4fr\) minmax\(280px,\.6fr\);gap:14px;align-items:start\}/.test(ui),
  'Les colonnes ne doivent pas s’étirer : un panneau court laisserait un vide'
);
assert(
  /btn\.style\.display=\(mode==='active'\|\|agentPanelUsable\(\)\)\?'none':''/.test(ui),
  'Le bouton du bandeau ne doit être retiré que si un contrôle équivalent est réellement disponible'
);

console.log(JSON.stringify({
  singleShell: true,
  legacyRelocatedNotDuplicated: true,
  survivesInnerHtmlRewrites: true,
  adminConsoleInsideTab: true,
  shadowDistinctionPreserved: true,
  noStretchedPanel: true,
  topbarFallbackPreserved: true,
}));
