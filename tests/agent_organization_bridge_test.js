const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const departmentCore = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments-core.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'frontend/js/modules/agent-organization.js'), 'utf8');
const agents = fs.readFileSync(path.join(root, 'frontend/js/modules/agents.js'), 'utf8');
const safeWrite = fs.readFileSync(path.join(root, 'backend/routes/agents_safe_write.js'), 'utf8');
const org = fs.readFileSync(path.join(root, 'backend/routes/organigramme.js'), 'utf8');

assert(loader.includes('/js/modules/org-departments-core.js'));
assert(loader.includes('/js/modules/agent-organization.js'));
assert(departmentCore.includes('orgNewDepartement'));
assert(bridge.includes("request('/org/departements')"));
assert(bridge.includes("request('/org/postes')"));
assert(bridge.includes("request('/org/sites')"));
assert(bridge.includes("request('/org/arbre')"));
assert(bridge.includes('ag-departement-select'));
assert(bridge.includes('ag-superieur-select'));
assert(bridge.includes('applyDepartmentManager'));
assert(bridge.includes('setSupervisorLocked(applied)'));
assert(bridge.includes('Responsable hiérarchique appliqué automatiquement'));
assert(bridge.includes('Le responsable du département est obligatoire.'));
assert(bridge.includes("state.departements.filter(row => row.responsable_id)"));
assert(bridge.includes("motif: 'Responsable du département appliqué automatiquement'"));
assert(agents.includes("departement: rawValue('ag-departement')"));
assert(agents.includes("superieur_hierarchique: rawValue('ag-superieur')"));
assert(safeWrite.includes("'departement', 'superieur_hierarchique', 'site', 'superieur_id'"));
assert(org.includes("router.put('/:id/superieur'"));

console.log('OK - automatic department manager assignment');
