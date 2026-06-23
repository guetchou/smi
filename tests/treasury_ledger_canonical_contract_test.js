'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  expectedLedgerLegs,
  TreasuryLedgerError,
} = require('../backend/services/treasury-ledger');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const migration = read('backend/migrations/037_treasury_ledger_canonical.sql');
const ledger = read('backend/services/treasury-ledger.js');
const workflow = read('backend/services/finance-operation-canonical.js');
const safeRouter = read('backend/routes/operations_parapheur_required_safe.js');
const server = read('backend/server.js');

assert(migration.includes("ledger_status ENUM('legacy','ready')"), 'positions must support explicit ledger cutover');
assert(migration.includes('uq_cash_ledger_operation_leg'), 'ledger leg uniqueness constraint missing');
assert(migration.includes('leg_code VARCHAR(40)'), 'ledger leg code missing');
assert(!/INSERT\s+INTO\s+cash_ledger/i.test(migration), 'migration must not backfill ledger automatically');
assert(!/UPDATE\s+positions\s+SET\s+ledger_status/i.test(migration), 'migration must not activate positions automatically');

assert(ledger.includes('FOR UPDATE'), 'canonical ledger must lock positions and balances');
assert(ledger.includes('TREASURY_BALANCE_DIVERGED'), 'balance divergence guard missing');
assert(ledger.includes('TREASURY_LEDGER_PARTIAL_OPERATION'), 'partial transfer guard missing');
assert(ledger.includes('TREASURY_INSUFFICIENT_BALANCE'), 'insufficient balance guard missing');
assert(ledger.includes("'treasury_ledger_posted'"), 'ledger audit must be transactional');
assert(!/catch\s*\([^)]*\)\s*\{\s*\/\*\s*ledger non bloquant/i.test(ledger), 'ledger errors must never be ignored');

assert(workflow.includes('await dbc.transaction(async tx =>'), 'operation creation must be transactional');
assert(workflow.includes('postOperationToLedgerInContext'), 'operation and ledger must share the transaction');
assert(workflow.includes("dec_statut = 'paye'"), 'payment transition missing');
assert(workflow.includes('failAfterLeg'), 'rollback test hook missing');

assert(safeRouter.includes("router.get('/positions'"), 'canonical balance endpoint missing');
assert(safeRouter.includes("balance_source: position.ledger_status === 'ready' ? 'cashbox_balances' : 'operations'"), 'ready positions must read cashbox_balances');
assert(safeRouter.includes("router.post('/'"), 'canonical operation creation route missing');
assert(safeRouter.includes("router.post('/:id/payer'"), 'canonical payment route missing');
assert(safeRouter.includes("router.put('/:id'"), 'canonical modification guard missing');
assert(safeRouter.includes("router.delete('/:id'"), 'canonical deletion guard missing');
assert(safeRouter.includes('TREASURY_OPERATION_IMMUTABLE'), 'posted operation immutability error missing');
assert(safeRouter.includes('if (!readiness.ready) return next()'), 'legacy fallback must remain explicit');
assert(safeRouter.includes('attemptAutomaticAccountingForOperation'), 'accounting integration missing');

const safeMount = server.indexOf("app.use('/api/operations', protectedRoute(requireModule('cash')), operationsParapheurRequiredRouter)");
const legacyMount = server.indexOf("app.use('/api/operations', protectedRoute(requireModule('cash')), operationsRouter)");
assert(safeMount >= 0 && legacyMount > safeMount, 'canonical router must run before legacy operations');

assert.deepStrictEqual(expectedLedgerLegs({
  type_op: 'virement',
  montant: 10000,
  position_source_id: 7,
  position_id: 8,
}), [
  { leg_code: 'transfer_source', caisse_id: 7, type_mouvement: 'debit', montant: 10000 },
  { leg_code: 'transfer_destination', caisse_id: 8, type_mouvement: 'credit', montant: 10000 },
]);
assert.throws(
  () => expectedLedgerLegs({ type_op: 'virement', montant: 10000, position_source_id: 7, position_id: 7 }),
  error => error instanceof TreasuryLedgerError && error.code === 'TREASURY_TRANSFER_SAME_POSITION',
);

console.log('treasury_ledger_canonical_contract_test: OK');
