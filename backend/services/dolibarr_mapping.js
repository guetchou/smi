'use strict';

class DolibarrMappingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DolibarrMappingError';
    this.code = code;
    this.details = details;
  }
}

const PAYMENT_MODE_TO_DOLIBARR_CODE = {
  especes: 'LIQ',
  cheque: 'CHQ',
  virement_bancaire: 'VIR',
  mobile_money: 'MOB',
  compensation: 'COMP',
  autres: 'OTHER',
};

function clean(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function requiredText(value, code, message) {
  const text = clean(value);
  if (!text) throw new DolibarrMappingError(code, message);
  return text;
}

function stableExternalRef(localType, localId) {
  const type = requiredText(localType, 'LOCAL_TYPE_REQUIRED', 'Type local requis');
  const id = requiredText(localId, 'LOCAL_ID_REQUIRED', 'Identifiant local requis');
  return `TALA-${type}-${id}`;
}

function unixDate(value) {
  const text = requiredText(value, 'PAYMENT_DATE_REQUIRED', 'Date de paiement requise');
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    throw new DolibarrMappingError('PAYMENT_DATE_INVALID', 'Date de paiement invalide', { date: text });
  }
  return Math.floor(parsed / 1000);
}

function thirdpartyKindFromOperation(operation = {}) {
  if (operation.type_op === 'encaissement') return 'customer';
  if (operation.type_op === 'decaissement') return 'supplier';
  return null;
}

function mapThirdpartyFromOperation(operation = {}) {
  const kind = thirdpartyKindFromOperation(operation);
  if (!kind) {
    throw new DolibarrMappingError(
      'THIRDPARTY_KIND_UNSUPPORTED',
      'Seuls les encaissements et decaissements peuvent produire un tiers Dolibarr',
      { type_op: operation.type_op || null }
    );
  }

  const name = requiredText(operation.tiers, 'THIRDPARTY_NAME_REQUIRED', 'Nom du tiers requis');
  const externalRef = stableExternalRef('operation_tiers', operation.id || operation.num_piece || name);

  return {
    remoteType: 'thirdparty',
    lookup: {
      ref_ext: externalRef,
      name,
    },
    payload: {
      name,
      ref_ext: externalRef,
      client: kind === 'customer' ? 1 : 0,
      fournisseur: kind === 'supplier' ? 1 : 0,
      note_private: `Created from Tala SMI operation ${operation.id || operation.num_piece || 'unknown'}`,
    },
  };
}

function assertOperationEligibleForDolibarr(operation = {}) {
  if (!operation || typeof operation !== 'object') {
    throw new DolibarrMappingError('OPERATION_REQUIRED', 'Operation Tala SMI requise');
  }
  if (!['encaissement', 'decaissement'].includes(operation.type_op)) {
    throw new DolibarrMappingError(
      'OPERATION_TYPE_UNSUPPORTED',
      'Seuls les encaissements et decaissements sont exportables vers Dolibarr en V1',
      { type_op: operation.type_op || null }
    );
  }
  if (operation.statut !== 'valide') {
    throw new DolibarrMappingError(
      'OPERATION_NOT_VALIDATED',
      'Operation non validee : export Dolibarr interdit',
      { statut: operation.statut || null }
    );
  }
  if (operation.type_op === 'decaissement' && operation.dec_statut && !['paye', 'valide'].includes(operation.dec_statut)) {
    throw new DolibarrMappingError(
      'CASH_OUT_NOT_PAID',
      'Decaissement non paye : export Dolibarr interdit',
      { dec_statut: operation.dec_statut }
    );
  }
  const amount = money(operation.montant);
  if (amount <= 0) {
    throw new DolibarrMappingError('AMOUNT_INVALID', 'Montant strictement positif requis');
  }
  requiredText(operation.tiers, 'THIRDPARTY_NAME_REQUIRED', 'Nom du tiers requis');
  return true;
}

function mapPaymentMode(mode) {
  const normalized = clean(mode) || 'autres';
  return PAYMENT_MODE_TO_DOLIBARR_CODE[normalized] || PAYMENT_MODE_TO_DOLIBARR_CODE.autres;
}

function mapOperationPayment(operation = {}, links = {}) {
  assertOperationEligibleForDolibarr(operation);

  const thirdpartyRemoteId = clean(links.thirdpartyRemoteId);
  if (!thirdpartyRemoteId) {
    throw new DolibarrMappingError(
      'REMOTE_THIRDPARTY_REQUIRED',
      'Lien tiers Dolibarr requis avant export du paiement'
    );
  }

  const amount = money(operation.montant);
  const externalRef = stableExternalRef('operation_payment', operation.id || operation.num_piece);
  const signedAmount = operation.type_op === 'decaissement' ? -amount : amount;
  const commonPayload = {
    ref_ext: externalRef,
    date: unixDate(operation.date),
    type: mapPaymentMode(operation.mode_reglement || operation.mode_paiement),
    label: requiredText(operation.libelle, 'PAYMENT_LABEL_REQUIRED', 'Libelle du paiement requis'),
    amount: signedAmount,
    category: 0,
    cheque_number: clean(operation.ref_externe || operation.num_piece) || '',
    num_releve: externalRef,
    note_private: clean(operation.libelle),
  };

  if (operation.type_op === 'encaissement') {
    return {
      remoteType: 'bank_account_line',
      localType: 'operation',
      localId: operation.id,
      idempotencyKey: `dolibarr:bank_line:${operation.id || operation.num_piece}`,
      payload: {
        ...commonPayload,
        thirdparty_id: thirdpartyRemoteId,
        direction: 'in',
      },
    };
  }

  return {
    remoteType: 'bank_account_line',
    localType: 'operation',
    localId: operation.id,
    idempotencyKey: `dolibarr:bank_line:${operation.id || operation.num_piece}`,
    payload: {
      ...commonPayload,
      thirdparty_id: thirdpartyRemoteId,
      direction: 'out',
    },
  };
}

function buildOperationSyncPlan(operation = {}, links = {}) {
  assertOperationEligibleForDolibarr(operation);
  const thirdparty = mapThirdpartyFromOperation(operation);
  const steps = [
    {
      step: 'ensure_thirdparty',
      remoteType: thirdparty.remoteType,
      lookup: thirdparty.lookup,
      payload: thirdparty.payload,
    },
  ];

  if (links.thirdpartyRemoteId) {
    steps.push({
      step: 'export_payment',
      ...mapOperationPayment(operation, links),
    });
  }

  return {
    provider: 'dolibarr',
    localType: 'operation',
    localId: operation.id || null,
    jobType: operation.type_op === 'encaissement' ? 'export_customer_payment' : 'export_supplier_payment',
    idempotencyKey: `dolibarr:operation:${operation.type_op}:${operation.id || operation.num_piece}`,
    steps,
  };
}

module.exports = {
  DolibarrMappingError,
  PAYMENT_MODE_TO_DOLIBARR_CODE,
  assertOperationEligibleForDolibarr,
  buildOperationSyncPlan,
  mapOperationPayment,
  mapPaymentMode,
  mapThirdpartyFromOperation,
  stableExternalRef,
};
