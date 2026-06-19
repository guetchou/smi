'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  FinanceOperationError,
  deriveOperationStates,
  validateAllocations,
  buildOperationView,
} = require('../backend/services/finance-operations');

function run() {
  const draftExpense = deriveOperationStates({
    type_op: 'decaissement',
    statut: 'en_attente',
    dec_statut: 'brouillon',
  });
  assert.strictEqual(draftExpense.business_status, 'draft');
  assert.strictEqual(draftExpense.approval_status, 'draft');
  assert.strictEqual(draftExpense.payment_status, 'unpaid');

  const paidExpense = deriveOperationStates({
    type_op: 'decaissement',
    statut: 'valide',
    dec_statut: 'paye',
    accounting_status: 'synced',
    rapproche: 1,
  });
  assert.strictEqual(paidExpense.approval_status, 'approved');
  assert.strictEqual(paidExpense.payment_status, 'paid');
  assert.strictEqual(paidExpense.accounting_status, 'synced');
  assert.strictEqual(paidExpense.reconciliation_status, 'reconciled');

  const receipt = buildOperationView({
    id: 10,
    type_op: 'encaissement',
    statut: 'valide',
    source_document_id: 5,
    source_module: 'factures_clients',
    source_document_number: 'FAC-2026-0012',
    source_document_type: 'customer_invoice',
  });
  assert.strictEqual(receipt.business_status, 'validated');
  assert.strictEqual(receipt.payment_status, 'paid');
  assert.deepStrictEqual(receipt.source, {
    id: 5,
    module: 'factures_clients',
    number: 'FAC-2026-0012',
    type: 'customer_invoice',
  });

  const allocation = validateAllocations({
    paymentAmount: 1000000,
    allocations: [
      { source_document_id: 1, allocated_amount: 400000 },
      { source_document_id: 2, allocated_amount: 350000 },
      { source_document_id: 3, allocated_amount: 200000 },
    ],
  });
  assert.strictEqual(allocation.allocated_total, 950000);
  assert.strictEqual(allocation.unallocated_amount, 50000);
  assert.strictEqual(allocation.allocation_status, 'partial');

  assert.throws(
    () => validateAllocations({
      paymentAmount: 100000,
      allocations: [{ source_document_id: 1, allocated_amount: 120000 }],
    }),
    error => error instanceof FinanceOperationError && error.code === 'ALLOCATION_EXCEEDS_PAYMENT'
  );

  assert.throws(
    () => validateAllocations({
      paymentAmount: 100000,
      allocations: [{ allocated_amount: 100000 }],
    }),
    error => error instanceof FinanceOperationError && error.code === 'SOURCE_DOCUMENT_REQUIRED'
  );

  const operationsRoute = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'operations.js'), 'utf8');
  assert(
    operationsRoute.includes("const { buildOperationView } = require('../services/finance-operations');"),
    'La route operations doit importer la projection finance ERP'
  );
  assert(
    /function serializeOperation\(op\)[\s\S]*return buildOperationView\(/.test(operationsRoute),
    'Les réponses API operations doivent exposer les statuts ERP projetés'
  );

  console.log(JSON.stringify({
    financeOperationStates: true,
    legacyCompatibility: true,
    sourceDocumentProjection: true,
    partialAllocation: true,
    overAllocationGuard: true,
    apiProjectionHook: true,
  }));
}

run();
