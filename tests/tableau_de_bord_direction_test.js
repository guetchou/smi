'use strict';
/*
 * Garde — le tableau de bord parle la langue des references retenues.
 *
 * Les deux pages ouvertes par l'utilisateur le 16/09/2026 — un tableau de bord
 * financier sur Pinterest, la grille « dashboard finance » d'Envato — disent
 * toutes deux la meme chose : fond clair teinte, barre laterale en aplat de
 * couleur vive, anneau dont le total occupe le centre, courbes jusque dans les
 * plus petites tuiles. Le produit faisait l'inverse : barre blanche, positions
 * en barres horizontales, aucune courbe hors des grands graphes.
 *
 * Ce qui est garde ici, ce sont ces procedes — pas des codes couleur, qui
 * doivent pouvoir bouger sans casser la garde.
 *
 * Verifie a l'ecran sur le banc isole, theme clair et theme sombre, barre
 * pleine, repliee et masquee.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. La barre laterale donne le ton ──────────────────────────────── */

verifier('la barre laterale est un aplat de couleur', () => {
  const bloc = (html.match(/\n  \.sidebar \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(bloc, 'regle .sidebar introuvable');
  assert.ok(/background: linear-gradient\(/.test(bloc),
    'La barre etait « background: #FFFFFF » : blanche sur fond clair, elle ne '
    + 'donnait aucun ton a l ecran');
  assert.ok(!/background: #FFFFFF/.test(bloc), 'le fond blanc doit avoir disparu');
});

verifier('un halo remplace la barre d accent', () => {
  const bloc = (html.match(/\n  \.sidebar::before \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/radial-gradient/.test(bloc),
    'La barre d accent de 3 px etait faite pour un fond blanc ; sur un aplat '
    + 'de couleur elle ne se lit plus. Le halo prend sa place');
  assert.ok(/border-radius: 50%/.test(bloc), 'le halo est un disque');
});

verifier('les liens passent devant l utilitaire du balisage', () => {
  /* Les liens portent « text-slate-700 » dans le balisage. A specificite
     egale, c est la derniere regle ecrite qui gagne, et Tailwind est injecte
     apres la feuille : sans le prefixe « .sidebar », les liens resteraient
     ardoise sur un fond bleu. */
  for (const regle of ['.sidebar .nav-link {', '.sidebar .nav-link:hover {', '.sidebar .nav-link.active {']) {
    assert.ok(html.includes(regle), `« ${regle} » doit etre portee par la barre`);
  }
  const repos = (html.match(/\.sidebar \.nav-link \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/color: rgba\(255,255,255/.test(repos),
    'Un lien au repos s ecrit en clair sur l aplat');
});

verifier('le logo et l avatar ne se fondent pas dans le bleu', () => {
  assert.ok(/\.sidebar #sidebar-logo-wrap, \.sidebar #user-avatar \{/.test(html),
    'Les deux portaient « gradient-indigo » : un bleu sur du bleu, invisible');
});

/* ── 2. Les courbes ─────────────────────────────────────────────────── */

verifier('les trois tuiles de tete portent leur courbe', () => {
  for (const id of ['tete-rec-spark', 'tete-dep-spark', 'tete-net-courbe']) {
    assert.ok(html.includes(`id="${id}"`), `le conteneur ${id} doit exister`);
    assert.ok(html.includes(`dessinerCourbe('${id}'`), `${id} doit etre alimente`);
  }
});

verifier('le traceur pose son SVG par le DOM, jamais en HTML', () => {
  const f = (html.match(/function dessinerCourbe[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(f, 'dessinerCourbe introuvable');
  assert.ok(/createElementNS/.test(f), 'les noeuds sont crees, pas interpolees');
  assert.ok(!/innerHTML/.test(f),
    'Ces series viennent de la base : aucune interpolation dans du HTML');
});

verifier('un zero se pose au sol, une serie plate flotte', () => {
  const f = (html.match(/function dessinerCourbe[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(/serie\.every\(v => v === 0\) \? H - marge : H \/ 2/.test(f),
    'Une serie plate mais non nulle tracee au ras du bas disait « rien » sous '
    + 'une tuile qui affichait 25 000 XAF. Le bas appartient au vrai zero');
  assert.ok(/stroke-dasharray/.test(f),
    'L absence se dit en pointilles, pas en ligne pleine qui ferait croire a '
    + 'une mesure');
});

verifier('le traceur epouse la largeur reelle du conteneur', () => {
  const f = (html.match(/function dessinerCourbe[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(/hote\.clientWidth/.test(f),
    'Un repere fixe etire par preserveAspectRatio rendait le point de fin en '
    + 'ellipse : le viewBox suit la largeur reelle');
  assert.ok(!/preserveAspectRatio/.test(f), 'plus besoin d etirer');
});

/* ── 3. L'anneau ────────────────────────────────────────────────────── */

verifier('les positions passent de la barre a l anneau', () => {
  const bloc = (html.match(/chartPositions = renderChart[\s\S]*?\}, 'Aucune position de trésorerie active\.'\);/) || [])[0] || '';
  assert.ok(bloc, 'graphe des positions introuvable');
  assert.ok(/type: 'doughnut'/.test(bloc),
    'La barre horizontale ne dit pas une repartition ; l anneau, si');
  assert.ok(!/type: 'bar'/.test(bloc), 'les barres doivent avoir disparu');
  assert.ok(/cutout:/.test(bloc), 'un anneau, pas un disque plein');
});

verifier('le total occupe le centre de l anneau', () => {
  assert.ok(html.includes('id="positions-total-valeur"'), 'le centre doit exister');
  assert.ok(html.includes('class="anneau-centre'), 'et se poser sur l anneau');
  assert.ok(/valeur\.textContent = fmt\(total\)/.test(html),
    'Le total est pose en texte, et il est celui des positions affichees');
  const centre = (html.match(/\.anneau-centre \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/position: absolute/.test(centre) && /pointer-events: none/.test(centre),
    'Le centre se superpose sans voler le clic a l anneau');
});

verifier('la repartition n est dite qu une fois', () => {
  const bloc = (html.match(/chartPositions = renderChart[\s\S]*?\}, 'Aucune position de trésorerie active\.'\);/) || [])[0] || '';
  assert.ok(/donutPlugins\(false\)/.test(bloc),
    'La liste nommee sous l anneau porte deja les libelles : deux legendes '
    + 'pour une donnee finissent par diverger');
  assert.ok(/datalabels: \{ display: false \}/.test(bloc),
    'Le pourcentage est deja dans la liste et le total au centre : une part '
    + 'unique affichait « 100% » colle au bord, en troisieme exemplaire');
});

/* ── 4. La carte de solde ───────────────────────────────────────────── */

verifier('la carte de solde est traitee comme la barre laterale', () => {
  assert.ok(/class="p-4 rounded-2xl cursor-pointer text-white solde-carte"/.test(html),
    'La tuile dominante doit porter le traitement d aplat');
  const bloc = (html.match(/\.solde-carte::after \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/radial-gradient/.test(bloc), 'meme halo que la barre laterale');
  assert.ok(/\.solde-carte \{[^}]*overflow: hidden/.test(html),
    'La courbe vient mourir dans les bords : sans decoupe elle deborde');
});

/* ── 5. Rien de mort ────────────────────────────────────────────────── */

verifier('le calcul mort du solde a repris du service ou disparu', () => {
  assert.ok(/dessinerCourbe\('tete-net-courbe', soldeSeries/.test(html),
    '« soldeSeries » etait calcule et inutilise depuis le retrait du graphe '
    + '« Solde net cumule » : il alimente desormais la courbe de la carte');
  assert.ok(!/const lineColor = /.test(html),
    '« lineColor », calcule au meme endroit et sans emploi, doit disparaitre');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — direction du tableau de bord`);
process.exit(echecs ? 1 : 0);
