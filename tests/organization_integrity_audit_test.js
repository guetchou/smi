const assert = require('assert');
const { analyzeOrganizationRows, findCycles } = require('../backend/services/organization_integrity_audit');

const employees = [
  { id: 1, nom: 'Alice', prenom: 'Manager', departement: 'Finance', superieur_id: null, superieur_hierarchique: '', actif: 1, statut_dossier: 'actif' },
  { id: 2, nom: 'Bob', prenom: 'Agent', departement: 'Finance', superieur_id: 3, superieur_hierarchique: 'Ancien nom', actif: 1, statut_dossier: 'actif' },
  { id: 3, nom: 'Carole', prenom: 'Agent', departement: 'Finance', superieur_id: 2, superieur_hierarchique: 'Autre ancien nom', actif: 1, statut_dossier: 'actif' },
  { id: 4, nom: 'David', prenom: 'Agent', departement: 'Ancien', superieur_id: 4, superieur_hierarchique: 'David Agent', actif: 1, statut_dossier: 'actif' },
  { id: 5, nom: 'Emma', prenom: 'Agent', departement: 'Inconnu', superieur_id: 99, superieur_hierarchique: 'Fantôme', actif: 1, statut_dossier: 'actif' },
  { id: 6, nom: 'Franck', prenom: 'Agent', departement: '', superieur_id: 6, superieur_hierarchique: 'Franck Agent', actif: 1, statut_dossier: 'actif' },
];

const departments = [
  { id: 10, libelle: 'Finance', responsable_id: 1, actif: 1 },
  { id: 11, libelle: 'RH', responsable_id: null, actif: 1 },
  { id: 12, libelle: 'Informatique', responsable_id: 99, actif: 1 },
  { id: 13, libelle: 'Ancien', responsable_id: 4, actif: 0 },
];

const report = analyzeOrganizationRows({ employees, departments });
const codes = new Set(report.anomalies.map(item => item.code));

assert(codes.has('DEPARTMENT_MANAGER_MISSING'));
assert(codes.has('DEPARTMENT_MANAGER_INACTIVE'));
assert(codes.has('AGENT_MANAGER_MISMATCH'));
assert(codes.has('AGENT_DEPARTMENT_INACTIVE'));
assert(codes.has('AGENT_DEPARTMENT_UNKNOWN'));
assert(codes.has('AGENT_SELF_SUPERVISION'));
assert(codes.has('AGENT_SUPERVISOR_INVALID'));
assert(codes.has('HIERARCHY_CYCLE'));

const bobFix = report.planned_changes.find(item => item.employee_id === 2);
const caroleFix = report.planned_changes.find(item => item.employee_id === 3);
assert.strictEqual(bobFix.new_supervisor_id, 1, 'department manager must override stale current supervisor data');
assert.strictEqual(caroleFix.new_supervisor_id, 1, 'cycle members must be reassigned to the department manager');
assert.strictEqual(report.projected_cycles.length, 0, 'safe repair plan must remove repairable cycles');
assert(report.summary.planned_employee_changes >= 4);

const cycles = findCycles(new Map([[1, 2], [2, 3], [3, 1], [4, null]]));
assert.deepStrictEqual(cycles, [[1, 2, 3]]);

console.log('OK - organization integrity diagnostic and repair planning');
