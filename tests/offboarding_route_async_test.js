'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend/routes/offboarding.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"));
assert(!source.includes("require('../database')"));
assert(!source.includes('.prepare('));
assert(source.includes("require('../services/offboarding_workflow')"));
assert(source.includes('await initiateOffboarding({'));
assert(source.includes('await validateOffboarding({'));
assert(source.includes("router.get('/sorties', async"));
assert(source.includes("router.get('/:id/sortie', async"));
assert(source.includes("router.get('/:id/sortie/solde-tout-compte-pdf', async"));
assert(source.includes("router.get('/:id/sortie/certificat-travail-pdf', async"));
assert(source.includes('CONCAT(e.nom'));

console.log('offboarding_route_async_test: OK');
