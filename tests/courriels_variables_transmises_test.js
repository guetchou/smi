'use strict';
/*
 * Garde — chaque réglage que lit l'expéditeur de courriels atteint le conteneur.
 *
 * Constaté le 28/09/2026 : 420 envois en échec, aucun réussi, depuis mai.
 * backend/services/email.js lit SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS et
 * SMTP_FROM, mais docker-compose.yml ne les transmettait pas au service. Le
 * bloc `environment` est une liste explicite et il n'y a pas d'`env_file` :
 * une valeur posée dans .env ne sert qu'à l'interpolation, elle n'entre pas
 * dans le conteneur. Renseigner .env n'aurait donc rien changé.
 *
 * La liste n'est pas recopiée ici : elle est lue dans email.js. Qu'un réglage
 * y soit ajouté sans être transmis, et cette garde échoue.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const email = fs.readFileSync(path.join(racine, 'backend', 'services', 'email.js'), 'utf8');
const compose = fs.readFileSync(path.join(racine, 'docker-compose.yml'), 'utf8');

// Les variables que l'expéditeur déclare requises.
const bloc = email.slice(email.indexOf('const REGLAGES_REQUIS'), email.indexOf('];', email.indexOf('const REGLAGES_REQUIS')));
const requises = [...bloc.matchAll(/env:\s*'([A-Z_]+)'/g)].map(m => m[1]);
assert.ok(requises.length >= 5, 'REGLAGES_REQUIS introuvable dans email.js : ' + requises.length + ' variable(s) lue(s)');

// Le bloc environment du service applicatif (celui qui écoute sur 3337).
const lignes = compose.split('\n');
const debutService = lignes.findIndex(l => /^\s*-\s*PORT=3337\b/.test(l));
assert.ok(debutService !== -1, 'Service applicatif (PORT=3337) introuvable dans docker-compose.yml');
let debut = debutService;
while (debut > 0 && !/^\s+environment:\s*$/.test(lignes[debut])) debut--;
let fin = debut + 1;
while (fin < lignes.length && (/^\s+-\s/.test(lignes[fin]) || /^\s*#/.test(lignes[fin]) || !lignes[fin].trim())) fin++;
const transmises = new Set(lignes.slice(debut + 1, fin)
  .map(l => (l.match(/^\s+-\s*([A-Z_][A-Z0-9_]*)=/) || [])[1]).filter(Boolean));

let echecs = 0;
for (const v of requises) {
  if (transmises.has(v)) { console.log('  ok   ' + v + ' atteint le conteneur'); continue; }
  console.log('  ECHEC ' + v + ' est lu par email.js mais n est pas transmis au conteneur');
  echecs++;
}

// Une valeur absente ne doit pas empêcher le démarrage : l'application tourne
// sans courriels, comme avec OIDC. On exige donc une valeur par défaut vide.
for (const v of requises) {
  const ligne = lignes.slice(debut + 1, fin).find(l => new RegExp('^\\s+-\\s*' + v + '=').test(l));
  if (!ligne) continue;
  if (/\$\{[A-Z_]+:-[^}]*\}/.test(ligne)) continue;
  console.log('  ECHEC ' + v + ' sans valeur par défaut : un .env incomplet bloquerait le démarrage');
  echecs++;
}

if (echecs) { process.exitCode = 1; console.log(echecs + ' défaut(s) — variables de courriel'); }
else console.log(requises.length + '/' + requises.length + ' variables de courriel transmises au conteneur');
