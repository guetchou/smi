'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'routes', 'parapheur_source_sync_safe.js'),
  'utf8',
);

assert.doesNotMatch(
  file,
  /\['demande', 'valide_sup', 'refuse'\]/,
  'Le parapheur ne doit pas pouvoir ré-approuver implicitement un congé refusé',
);

assert.doesNotMatch(
  file,
  /async function recomputeLeaveCounters\(/,
  'Le parapheur ne doit pas maintenir un second moteur de calcul des soldes congés',
);

assert.match(
  file,
  /leave_transition_workflow/,
  'Le parapheur doit déléguer les transitions au service métier unique',
);

console.log('leave_parapheur_single_engine_test: OK');
