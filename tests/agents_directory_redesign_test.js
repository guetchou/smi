'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const moduleSource = fs.readFileSync(path.join(root, 'frontend/js/modules/agents-directory.js'), 'utf8');
const transportSource = fs.readFileSync(path.join(root, 'frontend/js/core/transport.js'), 'utf8');

assert.match(transportSource, /agents-directory\.js/, 'Le module annuaire doit être chargé par le frontend existant');
assert.match(moduleSource, /PAGE_SIZE = 200/, 'La pagination serveur doit rester explicite');
assert.match(moduleSource, /offset/, 'Le chargement doit parcourir les pages au-delà des 200 premiers agents');
assert.match(moduleSource, /agent-filter-departement/, 'Le filtre département doit être disponible');
assert.match(moduleSource, /agent-filter-site/, 'Le filtre site doit être disponible');
assert.match(moduleSource, /openAgentSnapshot/, 'Un aperçu agent doit être disponible sans ouvrir le dossier complet');
assert.match(moduleSource, /Contact professionnel/, 'L’aperçu doit distinguer les coordonnées professionnelles');
assert.match(moduleSource, /loadReferences/, 'Les référentiels organisationnels doivent être décorrélés de la liste filtrée');
assert.match(moduleSource, /\/org\/postes/, 'Les postes doivent venir du référentiel organisationnel');
assert.match(moduleSource, /\/org\/departements/, 'Les départements doivent venir du référentiel organisationnel');
assert.match(moduleSource, /\/org\/sites/, 'Les sites doivent venir du référentiel organisationnel');
assert.match(moduleSource, /statut_calc/, 'Les alertes documentaires doivent consommer le statut calculé renvoyé par l’API');
assert.doesNotMatch(moduleSource, /salaire_base/, 'La rémunération ne doit pas être affichée dans l’annuaire opérationnel');
assert.match(moduleSource, /function esc\(/, 'Les valeurs injectées dans le HTML doivent être échappées');

console.log('agents_directory_redesign_test: OK');
