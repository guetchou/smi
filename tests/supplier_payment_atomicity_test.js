'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const service = read('backend/services/supplier_payment_workflow.js');
const safeRouter = read('backend/routes/achats_parapheur_required_safe.js');
const server = read('backend/server.js');

assert(service.includes("require('../db')"), 'supplier workflow must use backend/db.js');
assert(!service.includes("require('../database')"), 'supplier workflow must not use legacy database.js');
assert(!service.includes('.prepare('), 'supplier workflow must not use synchronous prepare()');
assert(!service.includes('db.transaction(() =>'), 'supplier workflow must not use pseudo transaction');
assert(service.includes('await dbc.transaction(async (tx) =>'), 'supplier workflow must use an async transaction');
assert(service.includes('FOR UPDATE'), 'supplier invoice must be locked');
assert(service.includes('failAfterOperation'), 'supplier rollback hook missing');
assert(service.includes("'PAIEMENT'"), 'payment audit must be written in the transaction');
assert(service.includes("'RAPPROCHEMENT_AUTO'"), 'automatic reconciliation audit missing');

assert(safeRouter.includes("require('../services/supplier_payment_workflow')"), 'safe purchase router must load supplier workflow');
assert(safeRouter.includes("router.post('/factures-fournisseurs/:id/payer'"), 'safe payment route missing');
assert(safeRouter.includes('await paySupplierInvoice'), 'safe payment route must await workflow');
assert(!safeRouter.includes("require('../database')"), 'safe purchase router must not use legacy database.js');

const safeMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), validationDiagnostic('achats'), achatsParapheurRequiredRouter)");
const legacyMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), achatsRouter)");
assert(safeMount >= 0 && legacyMount > safeMount, 'safe purchases router must be mounted before legacy purchases router');

console.log('supplier_payment_atomicity_test: OK');
