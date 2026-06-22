const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const navigation = fs.readFileSync(path.join(root, 'frontend/js/core/navigation.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'backend/routes/organigramme.js'), 'utf8');

assert(navigation.includes('/js/modules/org-departments.js'));
assert(moduleSource.includes('orgNewDepartement'));
assert(moduleSource.includes("api('/departements')"));
assert(moduleSource.includes("method: id ? 'PUT' : 'POST'"));
assert(moduleSource.includes('Renommage bloqué'));
assert(moduleSource.includes('orgDeactivateDepartement'));
assert(backend.includes("router.post('/departements'"));
assert(backend.includes("router.put('/departements/:id'"));
assert(backend.includes("hasRole(user, 'admin', 'rh', 'dg')"));

console.log('OK - department CRUD frontend wiring');
