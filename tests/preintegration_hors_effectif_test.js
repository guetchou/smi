'use strict';
/*
 * Garde — une fiche preparee ne compte pas dans l'effectif.
 *
 * Une personne dont l'arrivee est prevue existe dans le systeme sans encore
 * travailler. Sa fiche doit rester hors de l'effectif, hors de la masse
 * salariale, hors de la generation des bulletins -- sans quoi une embauche
 * preparee trois semaines a l'avance gonfle les deux pendant trois semaines.
 *
 * Mesure du 10/09/2026 : la fiche MAT-0018 a ete creee le 14/07 pour une
 * arrivee le 01/08. Dix-huit jours durant, elle comptait dans les onze actifs
 * et dans les 1 935 000 XAF de masse brute, alors que la personne n'etait pas
 * la.
 *
 * Le choix retenu porte cette regle sans toucher aux requetes : une fiche en
 * preparation porte actif = 0. Les indicateurs d'effectif exigent deja
 * actif = 1, ils l'excluent donc par construction. Aucune requete a modifier,
 * donc aucune a oublier -- c'est la raison du choix, et cette garde protege
 * l'invariant sur lequel il repose.
 *
 * Corollaire : l'onglet qui les affiche ne peut pas exiger actif = 1. Il
 * rejoint « sorti » et « archive », consultables sans cette condition.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'routes', 'agents.js'), 'utf8');
const lignes = source.split('\n');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

/* La declaration d'un indicateur, avec la requete qui la suit : elle tient
   sur une a trois lignes selon la longueur du SQL. */
function declaration(nom) {
  const i = lignes.findIndex(l => l.trimStart().startsWith('const ' + nom) && l.includes('='));
  return i === -1 ? null : lignes.slice(i, i + 3).join(' ');
}

verifier('les fiches en preparation sont consultables sans exiger actif = 1', () => {
  const i = lignes.findIndex(l => l.includes('includes(statut)'));
  assert.notStrictEqual(i, -1, 'le filtre de statut de la liste est introuvable');
  assert.ok(
    lignes[i].includes('preintegration'),
    'sans cela l onglet resterait vide : ces fiches portent actif = 0'
  );
});

verifier('les indicateurs d effectif exigent tous la condition actif', () => {
  /* Nommes un par un : compter les sorties du mois ou les documents expires
     n'a pas a filtrer sur actif, et une garde qui les attraperait ferait du
     bruit sans rien proteger. */
  const indicateurs = [
    'total', 'actifs', 'suspendus',
    'contratsExpirants', 'essaisExpirants', 'anniversaires', 'masseSalariale',
  ];
  const fautifs = [];
  for (const nom of indicateurs) {
    const d = declaration(nom);
    if (!d) { fautifs.push(nom + ' (introuvable)'); continue; }
    if (!d.includes('actif = 1') && !d.includes('actif=1')) fautifs.push(nom);
  }
  assert.strictEqual(
    fautifs.length, 0,
    'ces indicateurs compteraient les fiches preparees : ' + fautifs.join(', ')
  );
});

verifier('la masse salariale exige aussi le dossier actif', () => {
  const d = declaration('masseSalariale');
  assert.ok(d, 'la requete de masse salariale est introuvable');
  assert.ok(
    d.includes("statut_dossier = 'actif'") || d.includes("statut_dossier='actif'"),
    'un dossier suspendu ou prepare n a pas a peser dans le brut'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n3 gardes vertes — la preparation hors de l effectif`);
