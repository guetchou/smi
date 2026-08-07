'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'achats.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"));
assert(!source.includes("require('../database')"));
assert(!source.includes('.prepare('));
assert(!source.includes('db.transaction(() =>'));
assert(source.includes('await db.transaction(async tx =>'));
assert(source.includes("require('../services/supplier_payment_workflow')"));
assert(source.includes('calculateReconciliation'));
assert(source.includes('FOR UPDATE'));
assert(source.includes("router.post('/bons-commandes', async"));
assert(source.includes("router.post('/receptions', async"));
assert(source.includes("router.post('/factures-fournisseurs', async"));
assert(source.includes("router.put('/:id/approuver', async"));
assert(source.includes("router.put('/:id/rejeter', async"));
assert(source.includes("router.post('/factures-fournisseurs/:id/rapprocher', async"));
assert(source.includes('affectedRows'));
assert(!source.includes("router.post('/factures-fournisseurs/:id/payer'"), 'payment must stay owned by safe transactional workflow');
assert(!source.includes("router.put('/receptions/:id/valider'"), 'stock validation must stay owned by safe transactional workflow');
assert(!source.includes("router.put('/:id/soumettre'"), 'submission/parapheur must stay owned by safe transactional workflow');

console.log('achats_backend_async_test: OK');
