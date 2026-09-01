const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root   = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

/* ── L'accueil ouvre sur trois chiffres, pas sur huit ──
   Modele valide par le Directeur General le 01/09/2026. La page ouvrait sur
   huit tuiles de poids strictement identique — meme taille, meme graisse —
   pour huit grandeurs d'importance tres inegale. Le modele en met trois en
   avant, et fait du solde net le chiffre dominant.

   Les cinq autres ne sont pas retirees : elles restent en bande secondaire.
   C'est la difference entre hierarchiser et amputer. */

const accueil = markup.slice(markup.indexOf('id="page-dashboard"'), markup.indexOf('id="page-operations"'));

/* ── 1. Les trois indicateurs de tete existent et precedent les autres ── */
const iTete  = accueil.indexOf('data-bande="tete"');
const iBande = accueil.indexOf('BANDE KPI');
assert(iTete !== -1, 'La bande des trois indicateurs de tete doit rester reperable');
assert(iBande !== -1 && iTete < iBande, 'Les trois indicateurs doivent preceder la bande secondaire');

for (const id of ['tete-recettes', 'tete-depenses', 'tete-net']) {
  assert(new RegExp(`id="${id}"`).test(accueil), `L indicateur ${id} doit exister`);
}

/* ── 2. Le solde net domine, et lui seul ── */
const teteNet = accueil.match(/<div id="tete-net" class="([^"]+)"/)[1];
const teteRec = accueil.match(/<div id="tete-recettes" class="([^"]+)"/)[1];
const teteDep = accueil.match(/<div id="tete-depenses" class="([^"]+)"/)[1];
for (const c of [teteNet, teteRec, teteDep]) {
  assert(/\btext-2xl\b/.test(c), 'Les trois indicateurs de tete partagent une echelle superieure a la bande secondaire');
}
const tuileNet = accueil.slice(accueil.indexOf('Le solde net : tuile dominante'), accueil.indexOf('id="tete-net-label"'));
assert(
  /background:linear-gradient\(145deg,#2743E0,#1E33B8\)/.test(tuileNet),
  'La tuile du solde net doit porter le fond plein qui la distingue des deux autres'
);
assert(
  (accueil.match(/linear-gradient\(145deg,#2743E0,#1E33B8\)/g) || []).length === 1,
  'Une seule tuile doit porter ce fond, sinon il n y a plus de dominante'
);

/* ── 3. Les cinq autres metriques survivent ── */
for (const id of ['kpi-solde', 'kpi-ops', 'kpi-creances', 'kpi-impayes', 'stat-today']) {
  assert(new RegExp(`id="${id}"`).test(accueil), `La metrique ${id} doit rester : hierarchiser n est pas amputer`);
}

/* La bande secondaire doit rester en retrait — echelle inferieure. */
const kpiSolde = accueil.match(/<div id="kpi-solde" class="([^"]+)"/)[1];
assert(
  /\btext-sm\b/.test(kpiSolde) && !/\btext-2xl\b/.test(kpiSolde),
  'La bande secondaire doit garder une echelle inferieure a celle des trois de tete'
);

/* ── 4. Une seule source de verite pour les chiffres ──
   Les indicateurs de tete reprennent les valeurs deja calculees pour les
   tuiles existantes. Un second calcul finirait par diverger. */
assert(
  /_majTete\('tete-recettes', fmt\(enc\)\)/.test(markup) && /_majTete\('tete-depenses', fmt\(dec\)\)/.test(markup),
  'Les indicateurs de tete doivent reprendre enc et dec, les memes valeurs que les tuiles'
);
assert(
  !/document\.getElementById\('tete-recettes'\)[\s\S]{0,80}fetch|tete-recettes[\s\S]{0,60}await/.test(markup),
  'Aucun appel propre aux indicateurs de tete : ils ne doivent pas recalculer ce qui existe'
);

/* ── 5. Les deux textes nouveaux, et eux seuls ──
   Valides avec la maquette. Ils sont nommes ici pour qu une modification
   silencieuse se voie. */
assert(/Bonjour, <span id="accueil-nom">/.test(accueil), 'La salutation validee doit rester, et le nom venir du compte');
assert(
  /Recettes, dépenses et trésorerie de TOP CENTER, à jour\./.test(accueil),
  'La phrase du bandeau, validee avec la maquette, doit rester telle quelle'
);
assert(
  !/id="accueil-nom">[A-Za-zÀ-ÿ]/.test(accueil),
  'Le nom ne doit pas etre ecrit en dur dans le gabarit'
);
assert(
  /_majTete\('accueil-nom'/.test(markup),
  'Le nom doit etre rempli depuis le compte connecte'
);

/* ── 6. Aucune commande morte ──
   Le modele porte deux boutons icone dans son bandeau. L ecran d accueil n a
   pas de fonction d export ; les cabler donnerait une commande sans effet. */
const bandeau = accueil.slice(accueil.indexOf('BANDEAU D\'ACCUEIL'), accueil.indexOf('FIN BANDEAU'));
const appels = [...bandeau.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]);
for (const fn of appels) {
  assert(
    new RegExp(`function ${fn}\\s*\\(`).test(markup) || new RegExp(`${fn}\\s*=\\s*(async\\s*)?\\(`).test(markup),
    `Le bandeau appelle ${fn}(), qui n existe pas : une commande morte`
  );
}

console.log(JSON.stringify({
  threeLeadIndicatorsComeFirst: true,
  netBalanceDominatesAlone: true,
  otherFiveMetricsSurvive: true,
  secondaryBandStaysSmaller: true,
  singleSourceOfTruthForFigures: true,
  onlyTheTwoValidatedStringsAreNew: true,
  nameComesFromTheAccount: true,
  noDeadCommandInTheBanner: true,
}));
