const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

/* ── L'encombrement doit etre proportionnel a ce qui est reclame ──
   Mesure du Bilan Dirigeant a 1366x768 le 01/09/2026 :

     hauteur utile                535 px
     hauteur de la page         1 264 px  -> 2,4 ecrans
     panneau d'approbations       196 px  -> 37 % du premier ecran
     « Tresorerie totale »    374-480 px  -> au ras de la ligne de flottaison

   Trente-sept pour cent du premier ecran du dirigeant etaient occupes par un
   panneau annoncant qu'il n'y avait rien a decider : trois cartes vides sous
   une ligne de resume disant deja « Aucune demande en attente de validation
   DG ». Deux blocs pour la meme information, et la tresorerie repoussee. */

const loader = markup.match(/async function loadDgApprovalsPanel\(\) \{[\s\S]*?\n\}/)[0];

assert(
  /grid\.classList\.toggle\('hidden', total === 0\);/.test(loader),
  'La grille doit se retirer quand rien n est en attente'
);
assert(
  /if \(total === 0\) \{ grid\.innerHTML = ''; return; \}/.test(loader),
  'Aucune carte ne doit etre construite quand il n y a rien a decider'
);

/* La marge de l'entete suit : sans cela, l'espace rendu reste occupe par du vide. */
assert(
  /entete\.classList\.toggle\('mb-3', total > 0\)/.test(loader),
  'La marge sous l entete doit disparaitre avec la grille'
);

/* La ligne de resume porte seule l'information quand la grille se retire :
   elle doit rester renseignee dans les deux cas. */
const iResume = loader.indexOf('summary.textContent = total');
const iRetrait = loader.indexOf("if (total === 0) { grid.innerHTML = ''; return; }");
assert(
  iResume !== -1 && iRetrait !== -1 && iResume < iRetrait,
  'Le resume doit etre pose avant le retrait de la grille, sinon il resterait sur « Chargement... »'
);

/* Les boutons de navigation ne dependent pas du contenu : ils restent. */
/* Le panneau entier : une regex sur le seul entete s arreterait au premier
   couple de balises fermantes, avant les boutons. */
const entete = markup.slice(
  markup.indexOf('id="dg-approvals-panel"'),
  markup.indexOf('id="dg-approvals-grid"')
);
for (const bouton of ['Décaissements', 'Achats', 'Congés', 'Actualiser']) {
  assert(entete.includes(`>${bouton}<`), `Le bouton ${bouton} doit rester accessible quelle que soit la file`);
}

const vm = require('vm');
(async () => {
  for (const count of [0, 1, 2]) {
    const summary = {};
    const grid = { innerHTML: '', classList: { toggle() {} } };
    const panel = { classList: { add() {}, remove() {} }, querySelector: () => ({ classList: { toggle() {} } }), closest: () => ({}) };
    const elements = { 'dg-approvals-summary': summary, 'dg-approvals-grid': grid, 'dg-approvals-panel': panel };
    await vm.runInNewContext(loader + ';loadDgApprovalsPanel()', { document: { getElementById: id => elements[id] }, hasRole: () => true, api: async path => path.includes('/operations/') ? Array.from({ length: count }, () => ({ dec_statut: 'soumis', libelle: 'Demande', montant: 1 })) : [] });
    assert.strictEqual(summary.textContent, count === 0 ? 'Aucune demande à valider' : count === 1 ? '1 dossier attend une décision' : '2 dossiers attendent une décision');
  }
  console.log('Bilan : file vide, singulier, pluriel et navigation verifies');
})().catch(error => { console.error(error); process.exitCode = 1; });
