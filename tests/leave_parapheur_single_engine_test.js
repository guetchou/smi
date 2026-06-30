'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const entry = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'routes', 'parapheur_source_sync_safe.js'),
  'utf8',
);
const leave = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'routes', 'parapheur_leave_source_sync_safe.js'),
  'utf8',
);

assert.match(entry, /parapheur_leave_source_sync_safe/, 'Le routeur principal doit monter l’intercepteur congés en premier');
assert.match(entry, /router\.use\(leaveRouter\)/, 'Le routeur congés doit être enregistré avant les autres sources');

assert.doesNotMatch(
  leave,
  /\['demande', 'valide_sup', 'refuse'\]/,
  'Le parapheur ne doit pas pouvoir ré-approuver implicitement un congé refusé',
);
assert.doesNotMatch(
  leave,
  /async function recomputeLeaveCounters\(/,
  'Le parapheur ne doit pas maintenir un second moteur de calcul des soldes congés',
);
assert.match(
  leave,
  /leave_transition_workflow/,
  'Le parapheur doit déléguer les transitions au service métier unique',
);
assert.match(leave, /approveLeave/, 'L’approbation doit passer par le service métier');
assert.match(leave, /rejectLeave/, 'Le refus doit passer par le service métier');

console.log('leave_parapheur_single_engine_test: OK');
