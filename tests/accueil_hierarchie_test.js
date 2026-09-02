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

/* ── 3 bis. Une grandeur promue ne doit pas rester en double ──
   La premiere version de cette garde verifiait que les cinq autres metriques
   survivent, sans verifier que les trois promues quittent la bande. Resultat
   constate a l ecran le 02/09/2026 : « Recettes » deux fois, « Depenses » deux
   fois, « Solde net » TROIS fois, a deux echelles sur le meme ecran. Le
   doublon exact que le reste de ce travail traque.

   L invariant n est pas « les cinq restent », c est « chaque grandeur ne
   parait qu une fois ». */

const bandeSecondaire = accueil.slice(accueil.indexOf('BANDE KPI'), accueil.indexOf('FIN BANDE KPI'));
assert(bandeSecondaire.length > 200, 'La bande secondaire doit rester reperable entre ses deux reperes');

for (const grandeur of ['Recettes', 'Dépenses', 'Solde net']) {
  const occurrences = (bandeSecondaire.match(new RegExp(`>${grandeur}</div>`, 'g')) || []).length;
  assert.strictEqual(
    occurrences, 0,
    `« ${grandeur} » est promu en tete : il ne doit plus figurer dans la bande secondaire ` +
    `(${occurrences} occurrence(s) trouvee(s) — la meme grandeur deux fois sur un ecran)`
  );
}

/* Et les identifiants des tuiles retirees ne doivent pas subsister : une
   ecriture JS vers un element absent est une panne silencieuse. */
for (const id of ['kpi-recettes', 'kpi-depenses', 'stat-net', 'kpi-rec-diff', 'kpi-dep-diff', 'stat-net-label']) {
  assert(
    !new RegExp(`['"\`]${id}['"\`]`).test(markup) && !new RegExp(`id="${id}"`).test(markup),
    `L identifiant ${id} appartenait a une tuile retiree : ni le gabarit ni le script ne doivent encore le nommer`
  );
}

/* ── 3 ter. Cinq tuiles doivent pouvoir tenir leur texte ──
   A huit colonnes, chaque tuile tombait a 52 px et « 183 039 XAF » s affichait
   « 183 0… ». Mesure du 02/09/2026. */
const grilleBande = accueil.match(/BANDE KPI[\s\S]*?<div class="grid ([^"]+)">/)[1];
const colonnes = Number((grilleBande.match(/xl:grid-cols-(\d+)/) || [])[1]);
assert(
  colonnes && colonnes <= 5,
  `La bande secondaire ne doit pas depasser cinq colonnes (actuel : ${colonnes}) : au-dela, ses tuiles tronquent leur montant`
);

/* ── 3 quater. Une comparaison impossible se dit « — », jamais « NaN% » ──
   L API rend les montants en DECIMAL, que le pilote restitue en chaine.
   « 0.00 » est truthy : le garde-fou !b etait franchi et 0/0 donnait NaN.
   Quatre elements affichaient « NaN% » en production. */
const fnPct = markup.match(/function pct\(a, b\) \{[\s\S]*?\n\}/)[0];
assert(
  /Number\(a\)/.test(fnPct) && /Number\(b\)/.test(fnPct),
  'pct doit convertir ses deux arguments avant de les tester : une chaine « 0.00 » est truthy'
);
assert(
  /Number\.isFinite/.test(fnPct),
  'pct doit ecarter ce qui n est pas un nombre fini, sinon il rend NaN%'
);
assert(
  !/^\s*if \(!b\) return/m.test(fnPct),
  'Le garde-fou !b ne suffit pas : il laisse passer la chaine « 0.00 »'
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
  noPromotedMetricLeftDuplicated: true,
  noOrphanIdentifierLeftBehind: true,
  secondaryBandCanHoldItsText: true,
  impossibleComparisonSaysDashNotNaN: true,
  secondaryBandStaysSmaller: true,
  singleSourceOfTruthForFigures: true,
  onlyTheTwoValidatedStringsAreNew: true,
  nameComesFromTheAccount: true,
  noDeadCommandInTheBanner: true,
}));
