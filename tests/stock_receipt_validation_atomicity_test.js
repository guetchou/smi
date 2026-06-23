'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const service = read('backend/services/stock_receipt_validation_workflow.js');
const safeRouter = read('backend/routes/achats_parapheur_required_safe.js');
const server = read('backend/server.js');

assert(service.includes("require('../db')"), 'receipt workflow must use backend/db.js');
assert(!service.includes("require('../database')"), 'receipt workflow must not use legacy database.js');
assert(!service.includes('.prepare('), 'receipt workflow must not use synchronous prepare()');
assert(!service.includes('db.transaction(() =>'), 'receipt workflow must not use pseudo transaction');
assert(service.includes('await dbc.transaction(async (tx) =>'), 'receipt workflow must use async transaction');
assert(service.includes('SELECT * FROM receptions WHERE id = ? FOR UPDATE'), 'receipt row must be locked');
assert(service.includes('SELECT id, stock_disponible FROM produits WHERE id = ? FOR UPDATE'), 'product row must be locked');
assert(service.includes('failAfterMovement'), 'stock rollback hook missing');
assert(service.includes("'VALIDER'"), 'receipt audit must be written inside transaction');

assert(safeRouter.includes("require('../services/stock_receipt_validation_workflow')"), 'safe purchases router must load receipt workflow');
assert(safeRouter.includes("router.put('/receptions/:id/valider'"), 'safe receipt validation route missing');
assert(safeRouter.includes('await validateStockReceipt'), 'safe receipt route must await workflow');

const safeMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), validationDiagnostic('achats'), achatsParapheurRequiredRouter)");
const legacyMount = server.indexOf("app.use('/api/achats', protectedRoute(requireModule('purchase')), achatsRouter)");
assert(safeMount >= 0 && legacyMount > safeMount, 'safe purchases router must be mounted before legacy purchases router');

console.log('stock_receipt_validation_atomicity_test: OK');
