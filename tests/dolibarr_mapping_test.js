'use strict';

const assert = require('assert');
const {
  DolibarrMappingError,
  assertOperationEligibleForDolibarr,
  buildOperationSyncPlan,
  mapOperationPayment,
  mapPaymentMode,
  mapThirdpartyFromOperation,
  stableExternalRef,
} = require('../backend/services/dolibarr_mapping');

const receipt = {
  id: 101,
  date: '2026-07-08',
  num_piece: 'REC-101',
  libelle: 'Reglement facture client',
  tiers: 'CLIENT ALPHA',
  montant: '250000.50',
  type_op: 'encaissement',
  statut: 'valide',
  mode_reglement: 'virement_bancaire',
  ref_externe: 'VIR-BANK-101',
};

const cashOut = {
  id: 202,
  date: '2026-07-08',
  num_piece: 'DEC-202',
  libelle: 'Paiement fournisseur',
  tiers: 'PAPETERIE CENTRALE',
  montant: 45000,
  type_op: 'decaissement',
  statut: 'valide',
  dec_statut: 'paye',
  mode_reglement: 'especes',
};

assert.strictEqual(stableExternalRef('operation', 101), 'TALA-operation-101');
assert.strictEqual(mapPaymentMode('virement_bancaire'), 'VIR');
assert.strictEqual(mapPaymentMode('mobile_money'), 'MOB');
assert.strictEqual(mapPaymentMode('inconnu'), 'OTHER');

assert.strictEqual(assertOperationEligibleForDolibarr(receipt), true);
assert.strictEqual(assertOperationEligibleForDolibarr(cashOut), true);

const customer = mapThirdpartyFromOperation(receipt);
assert.strictEqual(customer.remoteType, 'thirdparty');
assert.strictEqual(customer.payload.name, 'CLIENT ALPHA');
assert.strictEqual(customer.payload.client, 1);
assert.strictEqual(customer.payload.fournisseur, 0);
assert.strictEqual(customer.payload.ref_ext, 'TALA-operation_tiers-101');

const supplier = mapThirdpartyFromOperation(cashOut);
assert.strictEqual(supplier.payload.client, 0);
assert.strictEqual(supplier.payload.fournisseur, 1);

const customerPayment = mapOperationPayment(receipt, { thirdpartyRemoteId: 77 });
assert.strictEqual(customerPayment.remoteType, 'bank_account_line');
assert.strictEqual(customerPayment.localType, 'operation');
assert.strictEqual(customerPayment.localId, 101);
assert.strictEqual(customerPayment.idempotencyKey, 'dolibarr:bank_line:101');
assert.deepStrictEqual(customerPayment.payload, {
  ref_ext: 'TALA-operation_payment-101',
  date: 1783468800,
  type: 'VIR',
  label: 'Reglement facture client',
  amount: 250000.5,
  category: 0,
  cheque_number: 'VIR-BANK-101',
  num_releve: 'TALA-operation_payment-101',
  note_private: 'Reglement facture client',
  thirdparty_id: '77',
  direction: 'in',
});

const supplierPayment = mapOperationPayment(cashOut, { thirdpartyRemoteId: 88 });
assert.strictEqual(supplierPayment.remoteType, 'bank_account_line');
assert.strictEqual(supplierPayment.payload.type, 'LIQ');
assert.strictEqual(supplierPayment.payload.amount, -45000);
assert.strictEqual(supplierPayment.payload.direction, 'out');

const planWithoutRemoteThirdparty = buildOperationSyncPlan(receipt);
assert.strictEqual(planWithoutRemoteThirdparty.provider, 'dolibarr');
assert.strictEqual(planWithoutRemoteThirdparty.jobType, 'export_customer_payment');
assert.strictEqual(planWithoutRemoteThirdparty.steps.length, 1);
assert.strictEqual(planWithoutRemoteThirdparty.steps[0].step, 'ensure_thirdparty');

const planWithRemoteThirdparty = buildOperationSyncPlan(receipt, { thirdpartyRemoteId: 77 });
assert.strictEqual(planWithRemoteThirdparty.steps.length, 2);
assert.strictEqual(planWithRemoteThirdparty.steps[1].step, 'export_payment');
assert.strictEqual(planWithRemoteThirdparty.steps[1].remoteType, 'bank_account_line');

assert.throws(
  () => assertOperationEligibleForDolibarr({ ...receipt, statut: 'en_attente' }),
  error => error instanceof DolibarrMappingError && error.code === 'OPERATION_NOT_VALIDATED'
);

assert.throws(
  () => assertOperationEligibleForDolibarr({ ...cashOut, dec_statut: 'soumis' }),
  error => error instanceof DolibarrMappingError && error.code === 'CASH_OUT_NOT_PAID'
);

assert.throws(
  () => assertOperationEligibleForDolibarr({ ...receipt, montant: 0 }),
  error => error instanceof DolibarrMappingError && error.code === 'AMOUNT_INVALID'
);

assert.throws(
  () => mapThirdpartyFromOperation({ ...receipt, tiers: '' }),
  error => error instanceof DolibarrMappingError && error.code === 'THIRDPARTY_NAME_REQUIRED'
);

assert.throws(
  () => mapOperationPayment(receipt),
  error => error instanceof DolibarrMappingError && error.code === 'REMOTE_THIRDPARTY_REQUIRED'
);

assert.throws(
  () => assertOperationEligibleForDolibarr({ ...receipt, type_op: 'virement' }),
  error => error instanceof DolibarrMappingError && error.code === 'OPERATION_TYPE_UNSUPPORTED'
);

console.log('dolibarr_mapping_test: OK');
