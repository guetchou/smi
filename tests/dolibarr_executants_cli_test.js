'use strict';
/*
 * Garde — un exécutant Dolibarr de Tala SMI ne tourne qu'en ligne de commande.
 *
 * Les exécutants de integrations/dolibarr/grand-livre agissent en
 * administrateur de Dolibarr, sans authentification (NOLOGIN) : c'est leur
 * rôle, lancés par la tâche planifiée. Posés un jour sous le répertoire servi
 * par le web (custom/, htdocs/), ils ouvriraient à quiconque les droits
 * d'administration. Chacun doit donc refuser de tourner hors CLI, AVANT de
 * charger Dolibarr.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'integrations', 'dolibarr', 'grand-livre');
const fichiers = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.php')) : [];
assert.ok(fichiers.length >= 1, 'Aucun executant sous integrations/dolibarr/grand-livre : la garde ne mesurerait rien');

let echecs = 0;
for (const f of fichiers) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const garde = src.search(/if\s*\(\s*PHP_SAPI\s*!==\s*'cli'\s*\)\s*\{[^}]*exit/);
  const chargement = src.search(/require(_once)?\s*\(?\s*'[^']*master\.inc\.php'/);
  if (garde === -1) {
    console.log(`  ECHEC ${f} : aucun refus hors ligne de commande`);
    echecs++;
  } else if (chargement !== -1 && garde > chargement) {
    console.log(`  ECHEC ${f} : le refus vient apres le chargement de Dolibarr`);
    echecs++;
  } else {
    console.log(`  ok   ${f} refuse de tourner hors ligne de commande`);
  }
}
if (echecs) process.exitCode = 1;
console.log(`${fichiers.length - echecs}/${fichiers.length} executants Dolibarr limites a la ligne de commande`);
