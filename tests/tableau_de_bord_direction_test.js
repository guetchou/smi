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
  /* Les deux portaient « gradient-indigo » : un bleu sur du bleu. Ils ont
     depuis pris des traitements differents, et c'est voulu — l'avatar en
     verre, le logo sur fond blanc pour garder ses couleurs. La garde porte
     sur l'intention : aucun des deux ne reste en bleu sur bleu. */
  const avatar = (html.match(/\.sidebar #user-avatar \{[\s\S]*?\n  \}/) || [])[0] || '';
  const logo = (html.match(/\.sidebar #sidebar-logo-wrap \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(avatar, 'la regle de l avatar est introuvable');
  assert.ok(logo, 'la regle du logo est introuvable');
  assert.ok(/background: rgba\(255,255,255/.test(avatar), 'l avatar passe au verre');
  assert.ok(/background: #FFFFFF/.test(logo),
    'Le logo de la societe a besoin d un fond neutre pour garder ses couleurs');
  assert.ok(/padding:/.test(logo),
    'et d air autour de lui : « le logo est noye », 17/09/2026');
});

verifier('le nom de la societe ne double plus son logo', () => {
  assert.ok(!html.includes('sidebar-company-name'),
    'Le nom etait ecrit en toutes lettres a cote du logo qui le porte deja, '
    + 'suivi d un « · Management Integre » que le code ajoutait et qui '
    + 'n existait dans aucune donnee');
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

/* ── 3. Soldes signes ────────────────────────────────────────────────────── */

verifier('les positions gardent un axe commun et leur signe', () => {
  const charts=require('../frontend/js/modules/dashboard-charts');
  const rows=charts.positionModel([{libelle:'Caisse',solde:1000},{libelle:'Banque',solde:-500}]);
  assert.equal(rows[0].width,50); assert.equal(rows[1].width,25);assert.equal(rows[1].value,-500);
  assert(html.includes('TalaDashboardCharts.renderPositions(positions)'));
});

verifier('le total ne recouvre plus le graphique', () => {
  assert(html.includes('#page-dashboard .anneau-hote'));
  const styles=html.match(/<style id="smi-dashboard-charts-20261022">([\s\S]*?)<\/style>/)[1];
  assert(styles.includes('.anneau-hote,#page-dashboard .tb-j-w>svg{display:none}'));
  const charts=require('../frontend/js/modules/dashboard-charts');
  assert.equal((charts.positionsMarkup([{libelle:'Caisse',solde:1000}]).match(/Caisse/g)||[]).length,1);
});

verifier('les valeurs decimales signees conservent le solde net', () => {
  const charts=require('../frontend/js/modules/dashboard-charts');
  const total=rows=>charts.positionModel(rows.map(solde=>({solde}))).reduce((sum,row)=>sum+row.value,0);
  assert.equal(total([12365000,-1850000]),10515000);
  assert.equal(total(['12365000.00','-1850000.00']),10515000);
  assert.equal(total([100,-300]),-200);
});

verifier('le seuil distingue solde suffisant, insuffisant et absent', () => {
  /* Vu en production le 29/09/2026 : caisse 12 365 000 pour un seuil de
     100 000, la jauge affichait « 100 % du seuil », qui se lit « pile au
     seuil ». L arc reste plein ; le texte dit 12 365 %. */
  const bloc = (html.match(/    const RAYON = 33;[\s\S]*?_majTete\('jauge-seuil-valeur'/) || [])[0] || '';
  assert.ok(bloc, 'bloc de la jauge introuvable');
  const vm = require('vm');
  const texte = (soldeCaisse, _seuilAlerte) => {
    const el = { textContent: '', style: {} };
    const arc = { setAttribute: () => {} };
    vm.runInNewContext(bloc + '\n);', {
      soldeCaisse, _seuilAlerte, Math, Intl, String, Number,
      document: { getElementById: id => (id === 'jauge-seuil-arc' ? arc : el) },
      _majTete: () => {}, fmt: String,
    });
    return el.textContent.replace(/\s/g, ' ');
  };
  assert.strictEqual(texte(12365000, 100000), 'Seuil respecté');
  assert.strictEqual(texte(50000, 100000), 'Sous le seuil');
  assert.strictEqual(texte(50000, 0), 'Seuil non défini');
  assert.strictEqual(texte(-100, 100000), 'Sous le seuil');
});

verifier('la pastille du mois se retire quand le mois n a aucune operation', () => {
  assert.ok(/getElementById\('tb-chip'\)[\s\S]{0,80}nb_ops/.test(html),
    'La tuile « Operations 0 » le dit deja : « +0 XAF · 0 operation » a cote du solde embrouille');
});

verifier('la carte des flux : zero sans signe, pas de consigne, pas de defilement imbrique', () => {
  /* Vu en production le 29/09/2026 en faisant defiler : « −0 XAF »,
     « cliquer pour detail » sous chaque montant, et la liste des dernieres
     operations coupee dans une carte de 150 px qui defilait seule. */
  assert.ok(!/cliquer pour détail/.test(html), 'consigne de developpement');
  const regle = (html.match(/\.tb-flux \{[^}]*\}/) || [''])[0];
  assert.ok(!/max-height|overflow-y/.test(regle), 'La carte s affiche en entier, sans seconde barre de defilement');
  assert.ok(/\$\{montant \? signe : ''\}\$\{fmt\(montant\)\}/.test(html), 'Un montant nul n a pas de signe');
  assert.ok(/\$\{net \? netSign : ''\}\$\{fmt\(Math\.abs\(net\)\)\}/.test(html), 'Un solde net nul n a pas de signe');
});

verifier('les soldes sont nommes et affiches une seule fois', () => {
  const charts=require('../frontend/js/modules/dashboard-charts');
  const rendered=charts.positionsMarkup([{libelle:'Compte unique',solde:1234}]);
  assert.equal((rendered.match(/Compte unique/g)||[]).length,1);
  assert.equal((rendered.match(/XAF/g)||[]).length,1);assert(!rendered.includes('100%'));
});

/* ── 4. La carte de solde ───────────────────────────────────────────── */

verifier('le bloc dominant est traite comme la barre laterale', () => {
  /* C etait la tuile « solde net » ; depuis la refonte du 17/09/2026 c est le
     heros, qui porte le meme traitement en plus grand : aplat de couleur,
     halo, et decoupe pour que la courbe meure dans ses bords. */
  assert.ok(/class="tb-heros"/.test(html), 'Le heros doit exister');
  const regle = (html.match(/\.tb-heros \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/linear-gradient/.test(regle), 'aplat de couleur, comme la barre laterale');
  assert.ok(/overflow: hidden/.test(regle),
    'La courbe vient mourir dans les bords : sans decoupe elle deborde');
  const halo = (html.match(/\.tb-heros::after \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/radial-gradient/.test(halo), 'meme halo que la barre laterale');
});

verifier('la bande chevauche le heros', () => {
  /* La profondeur vient du recouvrement, pas de l ombre seule : c est ce que
     font les references retenues et ce qui manquait a l empilement. */
  const regle = (html.match(/\.tb-bande \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(/margin: -\d+px/.test(regle), 'la bande remonte sur le heros');
  assert.ok(/z-index/.test(regle), 'et passe devant lui');
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
