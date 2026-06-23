'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const migration = read('backend/migrations/038_cash_receipt_workflow.sql');
const service = read('backend/services/cash-receipt-workflow.js');
const router = read('backend/routes/cash_receipt_workflow_router.js');
const server = read('backend/server.js');

const permissions = [
  'cash.receipt.create',
  'cash.receipt.submit',
  'cash.receipt.approve',
  'cash.receipt.confirm',
  'cash.receipt.dispute',
  'cash.receipt.override_self_control',
  'cash.receipt.configure',
];
permissions.forEach(code => {
  assert(migration.includes(code), `migration permission missing: ${code}`);
  assert(router.includes(code), `router permission missing: ${code}`);
});

assert(migration.includes('cash_receipt_attachment_threshold'));
assert(service.includes("'draft', 'draft', 'unpaid'"));
assert(service.includes('postOperationToLedgerInContext'));
assert(service.includes('failBeforeLedger'));
assert(service.includes('failAfterLeg'));
assert(service.includes('CASH_RECEIPT_SELF_CONTROL_FORBIDDEN'));
assert(service.includes('finance_operation_events'));
assert(service.includes('audit_logs'));

[
  'cash_receipt_created',
  'cash_receipt_submitted',
  'cash_receipt_approved',
  'cash_receipt_confirmed',
  'cash_receipt_rejected',
  'cash_receipt_disputed',
  'cash_receipt_returned_to_draft',
].forEach(event => assert(service.includes(event), `event missing: ${event}`));

[
  '/encaissements/:id/soumettre',
  '/encaissements/:id/valider',
  '/encaissements/:id/confirmer',
  '/encaissements/:id/rejeter',
  '/encaissements/:id/litige',
  '/encaissements/:id/retour-brouillon',
].forEach(route => assert(router.includes(route), `route missing: ${route}`));

assert(router.includes('CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION'));
assert(router.includes('accounting_warning'));

const controlledMount = server.indexOf('cashReceiptWorkflowRouter);');
const canonicalMount = server.indexOf('operationsParapheurRequiredRouter);');
const legacyMount = server.indexOf('operationsRouter);');
assert(controlledMount >= 0);
assert(canonicalMount > controlledMount);
assert(legacyMount > canonicalMount);

console.log('cash_receipt_workflow_contract_test: OK');
