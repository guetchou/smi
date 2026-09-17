const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root   = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

/* ── L'accueil ouvre sur UN chiffre, pas sur huit ──
 *
 * Premier modele, valide par le Directeur General le 01/09/2026 : la page
 * ouvrait sur huit tuiles de poids strictement identique — meme taille, meme
 * graisse — pour huit grandeurs d'importance tres inegale. Trois indicateurs
 * ont ete mis en avant, le solde net devenant le chiffre dominant.
 *
 * Second modele, valide le 17/09/2026 — « Poste de tresorerie ». Trois tuiles
 * de meme corps se disputaient encore le regard, et « combien ai-je, et ou »
 * se deduisait au lieu de se voir. Un seul chiffre domine desormais : le solde
 * de tresorerie, somme des positions. Recettes et Depenses redescendent dans
 * la bande, qui passe de cinq a six tuiles.
 *
 * Ce qui ne change pas d'un modele a l'autre, et que cette garde protege :
 * hierarchiser n'est pas amputer. Aucune metrique ne disparait.
 *
 * Mesure au 17/09/2026, 1366x768 : vue complete 1 413 px (2,66 ecrans) contre
 * 1 776 avant ; vue operationnelle 811 px (1,52 ecran).
 */

const accueil = markup.slice(markup.indexOf('id="page-dashboard"'), markup.indexOf('id="page-operations"'));

/* ── 1. Le heros ouvre la page, avant toute autre mesure ── */
const iHeros = accueil.indexOf('data-bande="tete"');
const iBande = accueil.indexOf('class="tb-bande"');
assert(iHeros !== -1, 'Le heros doit rester reperable');
assert(iBande !== -1 && iHeros < iBande, 'Le chiffre qui domine doit preceder la bande');

assert(/id="tb-tresorerie"/.test(accueil),
  'Le grand chiffre est le solde de tresorerie — la somme des positions, pas le seul tiroir');
assert(/id="tete-net"/.test(accueil), 'Le solde net reste, en pastille');

/* ── 2. Un seul chiffre domine, et lui seul ── */
{
  const heros = accueil.slice(iHeros, iBande);
  assert(/class="tb-h-n text-2xl" id="tb-tresorerie"/.test(heros),
    'Le solde de tresorerie porte l echelle dominante');
  /* Un seul fond plein sur la page d accueil : le heros. Deux blocs pleins et
     il n y a plus de dominante — c est ce que disait deja la garde du premier
     modele, et cela reste vrai. */
  const pleins = (accueil.match(/class="tb-heros"/g) || []).length;
  assert(pleins === 1, 'Un seul bloc porte le fond plein, sinon plus de dominante');
}

/* ── 3. Les sept autres metriques survivent ── */
for (const id of ['tete-recettes', 'tete-depenses', 'kpi-solde', 'kpi-ops',
                  'kpi-creances', 'kpi-impayes', 'stat-today']) {
  assert(new RegExp(`id="${id}"`).test(accueil),
    `La metrique ${id} doit rester : hierarchiser n est pas amputer`);
}

/* La bande reste en retrait : six tuiles d une echelle inferieure au heros. */
{
  const bande = accueil.slice(iBande, accueil.indexOf('class="tb-sat"'));
  const tuiles = (bande.match(/class="tb-kp"/g) || []).length;
  assert(tuiles === 6, `La bande porte six tuiles, ${tuiles} trouvee(s)`);
  assert(!/tb-h-n/.test(bande), 'Aucune tuile de la bande ne porte l echelle du heros');
}

/* ── 4. La bande chevauche le heros : deux plans, pas un empilement ── */
{
  const regle = (markup.match(/\.tb-bande \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert(regle, 'la regle .tb-bande est introuvable');
  assert(/margin: -\d+px/.test(regle),
    'Le chevauchement fait la profondeur : c est ce que font les references '
    + 'retenues, et ce qui manquait');
  assert(/z-index/.test(regle), 'et la bande doit passer devant');
}

/* ── 5. Les trois satellites ── */
{
  assert(/class="tb-sat"/.test(accueil), 'La rangee des satellites doit exister');
  assert(/id="jauge-seuil-arc"/.test(accueil),
    'L alerte de seuil se dit en jauge : l ancienne bande de texte orange ne se '
    + 'voyait pas');
  assert(/id="role-home-view"/.test(accueil), 'Ce qui attend reste affiche');
  assert(/id="chart-positions"/.test(accueil),
    'Ou est l argent conditionne le transfert : les positions restent au-dessus '
    + 'du pli');
}

/* ── 6. Les indicateurs retires de l ecran restent alimentes ── */
{
  /* « Synthese financiere » a quitte l ecran ; le code continue de la remplir.
     Sans l element, refreshDashboard tomberait en entier. */
  for (const id of ['finance-insights', 'summary-period', 'stat-average', 'stat-max-dep']) {
    assert(new RegExp(`id="${id}"`).test(accueil),
      `${id} doit rester dans le document : le code l ecrit toujours`);
  }
}

console.log(JSON.stringify({
  leaderFigureComesFirst: true,
  singleDominantBlock: true,
  everyMetricSurvives: true,
  bandOverlapsHero: true,
  satellitesPresent: true,
  removedIndicatorsStillFed: true,
}));
