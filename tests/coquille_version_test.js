'use strict';

/*
 * Garde — une coquille périmée doit finir par se remplacer, sans jamais
 * interrompre une saisie ni inventer un texte.
 *
 * Constaté le 02/09/2026 : la production servait la nouvelle version depuis
 * des heures et l'écran du DG montrait encore l'ancienne. L'application
 * rafraîchit ses données toutes les 30 s ; elle ne rafraîchit jamais son
 * propre gabarit. Le repère de build, CLIENT_BUILD_ID, était par ailleurs
 * figé au 12 juin — il ne pouvait rien signaler.
 *
 * Deux contraintes tiennent ce correctif :
 *
 *   1. Aucun texte visible n'est créé. Prévenir l'utilisateur demanderait une
 *      phrase à l'écran, qui n'a pas été validée. Le rechargement se fait donc
 *      seul, et uniquement quand il ne peut rien interrompre.
 *
 *   2. Un rechargement mal placé fait perdre une saisie — c'est pire que le
 *      défaut qu'il corrige.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const serveur = fs.readFileSync(path.join(racine, 'backend', 'server.js'), 'utf8');
const markup = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  const ouverture = source.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < source.length; j++) {
    if (source[j] === '{') profondeur++;
    else if (source[j] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. Le serveur annonce la version qu'il sert ── */
assert(
  /app\.get\('\/api\/health'[\s\S]{0,300}build: EMPREINTE_COQUILLE/.test(serveur),
  '/api/health doit annoncer la version de la coquille servie : sans elle, la page ne peut rien comparer'
);

/* L'empreinte vient du fichier servi, pas de git : le conteneur n'a pas le
   dépôt — vérifié le 02/09/2026, /app/.git n'existe pas. */
assert(
  /EMPREINTE_COQUILLE[\s\S]{0,400}dashboard\.html/.test(serveur),
  "L empreinte doit dériver du gabarit réellement servi"
);
assert(
  !/EMPREINTE_COQUILLE[\s\S]{0,400}(execSync|child_process|rev-parse)/.test(serveur),
  "L empreinte ne doit pas dépendre de git : le conteneur n a pas le dépôt"
);

/* Une empreinte illisible ne doit pas faire tomber le démarrage. */
assert(
  /catch \(error\) \{[\s\S]{0,200}return null;/.test(serveur.slice(serveur.indexOf('EMPREINTE_COQUILLE'))),
  'Une empreinte illisible doit rendre null, pas lever au démarrage'
);

/* ── 2. La page compare, et ne conclut pas dans le vide ── */
const verif = corpsDe(markup, 'async function _verifierVersionCoquille()');

assert(/\/health/.test(verif), 'La page doit interroger /api/health');

/* Le premier passage enregistre, il ne recharge pas. Sans cela : boucle de
   rechargement infinie. */
assert(
  /_empreinteCoquille === null[\s\S]{0,80}return;/.test(verif),
  'Le premier relevé doit seulement enregistrer la version : sinon la page se recharge en boucle'
);

/* Absent n'est pas différent : un serveur muet ou hors ligne ne doit pas
   passer pour une nouvelle version. C est le défaut « absent ≠ zéro », ici
   sous la forme « absent ≠ changé ». */
assert(
  /if \(!build\) return;/.test(verif),
  'Un serveur qui n annonce pas de version ne doit pas être pris pour une nouvelle version'
);
assert(
  /catch[\s\S]{0,160}return;/.test(verif),
  'Hors ligne n est pas une nouvelle version : l échec réseau doit sortir sans recharger'
);

/* ── 3. Jamais pendant une saisie ── */
assert(
  /if \(_saisieEnCours\(\)\) return;/.test(verif),
  'Le rechargement doit être refusé tant qu une saisie est en cours'
);

const saisie = corpsDe(markup, 'function _saisieEnCours()');
for (const [quoi, motif] of [
  ['une modale ouverte', /modal-backdrop:not\(\.hidden\)|dialog\[open\]/],
  ['un champ actif', /activeElement/],
  ['un formulaire modifié', /defaultValue/],
]) {
  assert(motif.test(saisie), `_saisieEnCours doit reconnaître ${quoi}`);
}

/* L ordre compte : la garde doit précéder le rechargement. */
assert(
  verif.indexOf('_saisieEnCours()') < verif.indexOf('location.reload'),
  'La garde de saisie doit être évaluée AVANT le rechargement'
);

/* ── 4. Aucun texte visible n'est créé ──
   La règle du projet interdit de transformer une décision technique en texte
   d écran. Ce correctif est un comportement, il ne doit rien écrire. */
for (const [nom, corps] of [['_verifierVersionCoquille', verif], ['_saisieEnCours', saisie]]) {
  assert(
    !/\.(textContent|innerHTML|innerText)\s*=/.test(corps),
    `${nom} ne doit écrire aucun texte à l écran : prévenir demanderait une formulation validée`
  );
  assert(
    !/\b(alert|confirm|showToast|toast|notifier)\s*\(/.test(corps),
    `${nom} ne doit afficher aucun message : ce correctif est un comportement, pas une annonce`
  );
}

/* ── 5. Le contrôle tourne réellement ── */
assert(
  /_verifierVersionCoquille\(\);[\s\S]{0,400}setInterval/.test(markup),
  'La version doit être relevée au démarrage du suivi, pas seulement dans la boucle'
);
assert(
  /if \(!document\.hidden\) _verifierVersionCoquille\(\);/.test(markup),
  'Le contrôle doit se répéter dans la boucle déjà en place, onglet visible seulement'
);

console.log(JSON.stringify({
  serverAnnouncesWhatItServes: true,
  stampComesFromTheServedFileNotGit: true,
  firstReadingOnlyRecords: true,
  absentIsNotChanged: true,
  neverReloadsDuringInput: true,
  guardEvaluatedBeforeReload: true,
  noVisibleTextCreated: true,
  checkActuallyRuns: true,
}));
