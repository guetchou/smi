'use strict';
/*
 * Garde — l'image doit pouvoir compiler un module natif.
 *
 * Le 21/09/2026, la construction de l'image s'est cassee et a bloque TOUS les
 * deploiements, sans qu'aucune ligne de code ait change :
 *
 *   prebuild-install warn install No prebuilt binaries found
 *   command sh -c prebuild-install || node-gyp rebuild --release
 *   gyp ERR! stack at PythonFinder.fail
 *   gyp ERR! cwd /app/backend/node_modules/better-sqlite3
 *
 * Enchainement : « node:20-bookworm-slim » n'est epingle par aucune empreinte.
 * Son Node a derive vers 20.20.2, better-sqlite3 9.4.3 ne publie pas de binaire
 * precompile pour cette cible, npm est retombe sur node-gyp, et node-gyp exige
 * Python — absent de l'image. Le meme Dockerfile construisait trois jours plus
 * tot.
 *
 * On ne peut pas sortir better-sqlite3 des dependances de production :
 * backend/database.js le charge sans condition, meme quand DB_DRIVER vaut
 * mysql. L'application ne demarrerait pas. La construction doit donc cesser de
 * dependre de la disponibilite d'un binaire precompile.
 *
 * Verifie a l'image construite le 21/09/2026 :
 *   wkhtmltopdf 0.12.6 ................................ present
 *   better-sqlite3 .................... ecrit puis relit 42
 *   python3 / g++ / make ............... absents du resultat
 *   taille ............................ 1,16 Go (contre 1,05)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const backend = require(path.join(__dirname, '..', 'backend', 'package.json'));

let vertes = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
};

verifier('le module natif est bien une dependance de production', () => {
  /* Si un jour il n'en est plus une, cette garde n'a plus lieu d'etre — mais
     tant qu'il l'est, l'image doit savoir le construire. */
  assert.ok(backend.dependencies && backend.dependencies['better-sqlite3'],
    'better-sqlite3 doit rester une dependance de production, ou cette garde doit etre revue');
});

verifier('la chaine de compilation est posee avant l installation', () => {
  const iPose = dockerfile.search(/apt-get install[^\n]*python3/);
  const iInstall = dockerfile.indexOf('npm install --production');
  assert.ok(iPose !== -1,
    'Sans Python, node-gyp echoue des qu aucun binaire precompile ne correspond — et c est arrive');
  assert.ok(iPose < iInstall,
    'Posee apres l installation, la chaine de compilation ne sert a rien');
});

verifier('elle est retiree ensuite, dans la meme couche', () => {
  const iInstall = dockerfile.indexOf('npm install --production');
  const iRetrait = dockerfile.indexOf('apt-get purge');
  assert.ok(iRetrait !== -1, 'La chaine de compilation ne doit pas rester dans l image livree');
  assert.ok(iInstall < iRetrait, 'Retiree avant l installation, elle manquerait au moment utile');
  /* Meme couche : un RUN separe garderait le poids dans la couche precedente. */
  const couche = (dockerfile.match(/RUN apt-get update[\s\S]*?npm install --production[\s\S]*?\n(?!\s)/) || [])[0] || '';
  assert.ok(/apt-get purge/.test(couche),
    'Pose, usage et retrait doivent tenir dans un seul RUN : sinon la couche garde le poids');
});

verifier('la validation du moteur PDF reste en place', () => {
  /* C est l etape de deploiement qui a signale la panne, meme si la cause
     etait en amont. Elle ne doit pas disparaitre a l occasion d un correctif. */
  assert.ok(/wkhtmltopdf/.test(dockerfile), 'wkhtmltopdf doit rester installe dans l image');
});

console.log(vertes + '/4 gardes vertes — compilation native dans l image');
