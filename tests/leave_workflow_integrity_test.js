'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const transitionPath = path.join(__dirname, '..', 'backend', 'services', 'leave_transition_workflow.js');
const routerPath = path.join(__dirname, '..', 'backend', 'routes', 'agent_parapheur_required_safe.js');

const transition = fs.readFileSync(transitionPath, 'utf8');
const router = fs.readFileSync(routerPath, 'utf8');

assert.match(transition, /Transition interdite : \$\{leave\.statut\} → refuse/,
  'Le refus doit être protégé par une machine à états');
assert.match(transition, /\['demande', 'valide_sup'\]\.includes\(leave\.statut\)/,
  'Seuls demande et valide_sup peuvent être refusés');
assert.doesNotMatch(transition, /\['demande', 'valide_sup', 'refuse'\]/,
  'Un congé refusé ne doit jamais être ré-approuvé implicitement');
assert.match(transition, /workflowSup \? \['valide_sup'\] : \['demande', 'valide_sup'\]/,
  'L’approbation doit respecter conges_workflow_sup');
assert.match(transition, /recomputeLeaveCounters\(tx, employeeId\)/,
  'Toute annulation ou décision finale doit recalculer les compteurs');
assert.match(transition, /actor\?\.employe_id.*employee\.superieur_id/,
  'La validation supérieur doit vérifier la relation hiérarchique réelle');

for (const route of ['valider-sup', 'approuver', 'refuser', 'annuler', 'terminer']) {
  assert.ok(router.includes(`/conges/:cid/${route}`), `Route sécurisée manquante : ${route}`);
}

console.log('leave_workflow_integrity_test: OK');
