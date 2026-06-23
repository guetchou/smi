'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const service = read('backend/services/stock_receipt_creation_workflow.js');
const safeRouter = read('backend/routes/achats_parapheur_required_safe.js');
const server = read('backend/server.js');

assert(service.includes("require('../db')"), 'receipt creation must use backend/db.js');
assert(!service.includes("require('../database')"), 'receipt creation must not use legacy database.js');
assert(!service.includes('.prepare('), 'receipt creation must not use synchronous prepare()');
assert(!service.includes('db.transaction(() =>'), 'receipt creation must not use pseudo transaction');
assert(service.includes('await dbc.transaction(async (tx) =>'), 'receipt creation must use async transaction');
assert(service.includes('bons_commandes_fournisseurs WHERE id = ? FOR UPDATE'), 'purchase order must be locked');
assert(service.includes('bons_commandes_lignes'), 'purchase order lines must be handled');
assert(service.includes('FOR UPDATE'), 'receipt sequence and rows must be locked');
assert(service.includes('failAfterLine'), 'receipt creation rollback hook missing');
assert(service.includes("'CREATE'"), 'receipt creation audit must be inside transaction');
assert(service.includes('quantite_conforme ne peut pas dépasser quantite_recue'), 'quantity integrity rule missing');

assert(safeRouter.includes("require('../services/stock_receipt_creation_workflow')"), 'safe purchases router must load receipt creation workflow');
assert(safeRouter.includes("router.post('/receptions'"), 'safe receipt creation route missing');
assert(safeRouter.includes('await createStockReceipt'), 'safe receipt creation route must await workflow');

const safeMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), validationDiagnostic('achats'), achatsParapheurRequiredRouter)");
const legacyMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), achatsRouter)");
assert(safeMount >= 0 && legacyMount > safeMount, 'safe purchases router must be mounted before legacy purchases router');

console.log('stock_receipt_creation_atomicity_test: OK');
