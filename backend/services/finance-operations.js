'use strict';

class FinanceOperationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FinanceOperationError';
    this.code = code;
    this.details = details;
  }
}

const FINAL_STATES = new Set(['paid', 'cancelled', 'reversed']);

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function deriveOperationStates(operation = {}) {
  const type = operation.type_op;
  const legacyStatus = operation.statut || 'brouillon';
  const decStatus = operation.dec_statut || null;
  const accountingStatus = operation.accounting_status || 'pending';
  const allocationStatus = operation.allocation_status || 'pending';

  let businessStatus = operation.business_status || 'draft';
  let approvalStatus = operation.approval_status || 'not_required';
  let paymentStatus = operation.payment_status || 'unpaid';
  let reconciliationStatus = operation.reconciliation_status || 'unreconciled';

  if (legacyStatus === 'annule') {
    businessStatus = 'cancelled';
    approvalStatus = 'cancelled';
    paymentStatus = 'cancelled';
    reconciliationStatus = 'cancelled';
  } else if (type === 'decaissement') {
    const approvalMap = {
      brouillon: 'draft',
      soumis: 'submitted',
      en_attente: 'pending',
      en_attente_approbation: 'pending',
      approuve: 'approved',
      valide: 'approved',
      rejete: 'rejected',
      annule: 'cancelled',
      paye: 'approved',
    };
    approvalStatus = approvalMap[decStatus] || approvalStatus;
    businessStatus = approvalStatus === 'approved' ? 'approved' : approvalStatus;
    paymentStatus = legacyStatus === 'valide' || decStatus === 'paye' ? 'paid' : 'unpaid';
  } else {
    businessStatus = legacyStatus === 'valide' ? 'validated' : 'draft';
    approvalStatus = 'not_required';
    paymentStatus = legacyStatus === 'valide' ? 'paid' : 'unpaid';
  }

  if (operation.rapproche === 1 || operation.rapproche === true) {
    reconciliationStatus = 'reconciled';
  }

  return {
    business_status: businessStatus,
    approval_status: approvalStatus,
    payment_status: paymentStatus,
    accounting_status: accountingStatus,
    allocation_status: allocationStatus,
    reconciliation_status: reconciliationStatus,
    is_final: FINAL_STATES.has(paymentStatus) || FINAL_STATES.has(businessStatus),
  };
}

function validateAllocations({ paymentAmount, allocations = [] }) {
  const totalPayment = amount(paymentAmount);
  if (totalPayment <= 0) {
    throw new FinanceOperationError('PAYMENT_AMOUNT_INVALID', 'Le montant du paiement doit être supérieur à zéro');
  }
  if (!Array.isArray(allocations)) {
    throw new FinanceOperationError('ALLOCATIONS_INVALID', 'Les allocations doivent être fournies sous forme de liste');
  }

  const normalized = allocations.map((item, index) => {
    const allocated = amount(item.allocated_amount);
    const discount = amount(item.discount_amount);
    const withholding = amount(item.withholding_amount);
    const exchangeDifference = amount(item.exchange_difference);

    if (!item.source_document_id) {
      throw new FinanceOperationError('SOURCE_DOCUMENT_REQUIRED', `Document source requis à la ligne ${index + 1}`);
    }
    if (allocated <= 0) {
      throw new FinanceOperationError('ALLOCATION_AMOUNT_INVALID', `Montant alloué invalide à la ligne ${index + 1}`);
    }

    return {
      source_document_id: Number(item.source_document_id),
      allocated_amount: allocated,
      discount_amount: discount,
      withholding_amount: withholding,
      exchange_difference: exchangeDifference,
      settlement_amount: amount(allocated + discount + withholding + exchangeDifference),
    };
  });

  const allocatedTotal = amount(normalized.reduce((sum, item) => sum + item.allocated_amount, 0));
  if (allocatedTotal > totalPayment) {
    throw new FinanceOperationError(
      'ALLOCATION_EXCEEDS_PAYMENT',
      'Le total alloué dépasse le montant du paiement',
      { payment_amount: totalPayment, allocated_total: allocatedTotal }
    );
  }

  return {
    allocations: normalized,
    payment_amount: totalPayment,
    allocated_total: allocatedTotal,
    unallocated_amount: amount(totalPayment - allocatedTotal),
    allocation_status: allocatedTotal === 0 ? 'pending' : allocatedTotal === totalPayment ? 'allocated' : 'partial',
  };
}

function buildOperationView(operation = {}) {
  return {
    ...operation,
    ...deriveOperationStates(operation),
    source: operation.source_document_id ? {
      id: operation.source_document_id,
      module: operation.source_module || null,
      number: operation.source_document_number || null,
      type: operation.source_document_type || null,
    } : null,
  };
}

module.exports = {
  FinanceOperationError,
  deriveOperationStates,
  validateAllocations,
  buildOperationView,
};
