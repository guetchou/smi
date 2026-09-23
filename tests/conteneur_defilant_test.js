'use strict';
/*
 * Garde — le conteneur qui défile doit envelopper toutes les pages.
 *
 * Constaté en production le 21/09/2026, écran « Accès et utilisateurs »,
 * fenêtre de 603 px :
 *
 *   <main … overflow-hidden>   hauteur 532   contenu 2859   rien ne défile
 *   #app-page-container        hauteur  48   ne contenait que page-dashboard
 *
 * Toutes les pages sauf l'accueil étaient posées À CÔTÉ du conteneur défilant,
 * dans un <main> en overflow-hidden. 2 327 px inatteignables sur chaque écran :
 * « impossible de naviguer ».
 *
 * Une seule balise </div> en trop, laissée par la refonte du poste de
 * trésorerie (#215, 18/09/2026). Mesuré en comptant l'équilibre des balises
 * version par version : solde 1 jusqu'à be7cd94, solde 0 à partir de ea7535f.
 * Le défaut a vécu trois jours en production sans qu'aucune garde le voie.
 *
 * POURQUOI CETTE GARDE EXISTE, ET PAS UNE DE PLUS SUR UNE CHAÎNE DE CARACTÈRES.
 * Toutes mes gardes de ce fichier vérifiaient des PRÉSENCES : tel identifiant,
 * tel libellé, tel attribut. Aucune ne lisait la STRUCTURE. Or les correctifs
 * qui découpent et redéplacent du balisage cassent la structure sans toucher
 * au vocabulaire — et passent donc au vert. Celle-ci marche balise par balise,
 * comme le ferait le navigateur.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

let vertes = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
};

/* Où le navigateur fermera-t-il le conteneur ? On avance balise par balise
   depuis son ouverture ; la première fois que la profondeur retombe à zéro,
   c'est sa fermeture réelle — pas celle que l'indentation laisse croire. */
function fermetureDuConteneur() {
  const i = html.indexOf('id="app-page-container"');
  if (i === -1) return null;
  const debut = html.indexOf('>', i) + 1;
  let profondeur = 1;
  const motif = /<div\b|<\/div>/gi;
  motif.lastIndex = debut;
  let m;
  while ((m = motif.exec(html)) !== null) {
    profondeur += m[0][1] === '/' ? -1 : 1;
    if (profondeur === 0) return m.index;
  }
  return null;
}

const fermeture = fermetureDuConteneur();
const iMain = html.indexOf('</main>');

verifier('le conteneur défilant existe et se referme', () => {
  assert.ok(html.includes('id="app-page-container"'), 'Le conteneur défilant doit exister');
  assert.ok(/id="app-page-container"[^>]*overflow-y-auto/.test(html),
    'C est lui qui porte le défilement : sans overflow-y-auto, rien ne défile nulle part');
  assert.ok(fermeture !== null, 'Le conteneur doit se refermer : non fermé, la page entière part en vrille');
});

verifier('il enveloppe toutes les pages, pas seulement l accueil', () => {
  let derniere = -1;
  let nom = null;
  for (const m of html.matchAll(/id="(page-[a-z0-9-]+)"/g)) { derniere = m.index; nom = m[1]; }
  assert.ok(derniere !== -1, 'Au moins une page doit exister');
  assert.ok(fermeture > derniere,
    `Le conteneur se referme avant « ${nom} » : toutes les pages qui suivent sortent du défilement `
    + 'et deviennent inatteignables sous le pli, dans un <main> en overflow-hidden');
});

verifier('et il se referme avant la fin du bloc principal', () => {
  assert.ok(iMain !== -1, '</main> doit exister');
  assert.ok(fermeture < iMain,
    'Fermé après </main>, le conteneur déborderait du châssis : le navigateur recollerait les morceaux à sa façon');
});

verifier('le chassis garde son defilement a un seul endroit', () => {
  /* <body> et <main> sont volontairement en overflow-hidden : c est le
     conteneur qui défile, et lui seul. Si l un des deux cessait de l être, la
     page entière défilerait derrière la barre du haut. */
  assert.ok(/<body class="[^"]*overflow-hidden/.test(html),
    'Le corps doit rester en overflow-hidden : c est ce qui fixe la barre du haut');
  assert.ok(/<main class="[^"]*overflow-hidden/.test(html),
    'Le bloc principal aussi — le défilement appartient au conteneur');
});

console.log(vertes + '/4 gardes vertes — conteneur défilant');
