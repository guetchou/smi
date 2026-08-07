'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend/routes/organigramme.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"));
assert(!source.includes("require('../database')"));
assert(!source.includes('.prepare('));
assert(source.includes("require('../services/organization_assignment')"));
assert(source.includes('async function creeraitBoucle'));
assert(source.includes('organizationSvc.createsCycleFromMap'));
assert(source.includes('await organizationSvc.assertSupervisorChange'));
assert(source.includes('await db.transaction(async tx =>'));
assert(source.includes('async function _appliquerMutation'));
assert(source.includes('async function _enregistrerMutation'));
assert(source.includes('CONCAT(e.nom'));
assert(source.includes("router.get('/mutations', async"));
assert(source.includes("router.post('/mutations', async"));
assert(source.includes("router.put('/mutations/:id/approuver', async"));
assert(source.includes("router.put('/mutations/:id/refuser', async"));

console.log('organigramme_async_test: OK');
