'use strict';

const db = require('../db');
const {
  getPositionLedgerReadiness,
  postOperationToLedgerInContext,
} = require('./treasury-ledger');
const {
  normalizeOperationInput,
  loadOperation,
} = require('./finance-operation-canonical');

class CashReceiptWorkflowError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.name = 'CashReceiptWorkflowError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requiredReason(value, label = 'Motif') {
  const reason = String(value || '').trim();
  if (reason.length < 5) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_REASON_REQUIRED',
      `${label} obligatoire (5 caractères minimum)`,
      422,
    );
  }
  return reason;
}

async function assertPeriodOpen(date, tx) {
  const parsed = new Date(`${String(date).slice(0, 10)}T00:00:00`);
  const closed = await tx.queryOne(`
    SELECT id FROM periodes_cloturees
    WHERE annee = ? AND mois = ?
    LIMIT 1
  `, [parsed.getFullYear(), parsed.getMonth() + 1]);
  if (closed) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_PERIOD_CLOSED',
      `Période ${String(date).slice(0, 7)} clôturée — encaissement interdit`,
      409,
    );
  }
}

async function attachmentThreshold(tx) {
  const row = await tx.queryOne(`
    SELECT setting_value
    FROM finance_workflow_settings
    WHERE setting_key = 'cash_receipt_attachment_threshold'
  `);
  const value = Number(row?.setting_value || 500000);
  return Number.isFinite(value) && value >= 0 ? value : 500000;
}

function modeRequiresReference(mode) {
  return ['cheque', 'virement_bancaire', 'mobile_money'].includes(mode);
}

async function assertExternalReferenceAvailable(input, tx, excludeId = null) {
  if (!modeRequiresReference(input.mode_reglement)) return;
  if (!input.ref_externe) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_REFERENCE_REQUIRED',
      'Référence externe obligatoire pour chèque, virement bancaire ou mobile money',
      422,
    );
  }
  const params = [input.mode_reglement, input.ref_externe];
  let exclude = '';
  if (excludeId) {
    exclude = 'AND id <> ?';
    params.push(excludeId);
  }
  const duplicate = await tx.queryOne(`
    SELECT id, num_piece
    FROM operations
    WHERE statut <> 'annule'
      AND type_op = 'encaissement'
      AND mode_reglement = ?
      AND LOWER(TRIM(ref_externe)) = LOWER(TRIM(?))
      ${exclude}
    LIMIT 1
    FOR UPDATE
  `, params);
  if (duplicate) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_REFERENCE_DUPLICATE',
      `Référence externe déjà utilisée sur ${duplicate.num_piece || `#${duplicate.id}`}`,
      409,
      { duplicate_operation_id: Number(duplicate.id) },
    );
  }
}

async function assertReadyPosition(positionId, tx) {
  const readiness = await getPositionLedgerReadiness([positionId], tx);
  if (!readiness.ready) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_LEDGER_NOT_READY',
      'La position de trésorerie n’est pas prête pour le workflow canonique',
      409,
      readiness,
    );
  }
}

async function assertNoLedger(operationId, tx) {
  const row = await tx.queryOne(`
    SELECT id FROM cash_ledger
    WHERE operation_id = ?
    LIMIT 1
    FOR UPDATE
  `, [operationId]);
  if (row) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_ALREADY_EFFECTIVE',
      'Cet encaissement a déjà pris effet en trésorerie',
      409,
      { ledger_id: Number(row.id) },
    );
  }
}

async function lockedReceipt(operationId, tx) {
  const operation = await tx.queryOne(`
    SELECT * FROM operations
    WHERE id = ? AND type_op = 'encaissement'
    FOR UPDATE
  `, [operationId]);
  if (!operation) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_NOT_FOUND',
      'Encaissement introuvable',
      404,
    );
  }
  return operation;
}

async function recordTransition(tx, {
  operation,
  eventType,
  previousStatus,
  nextStatus,
  reason = null,
  metadata = {},
  actorId,
}) {
  await tx.execute(`
    INSERT INTO finance_operation_events
      (operation_id, event_type, previous_status, next_status, reason,
       metadata_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `, [
    operation.id,
    eventType,
    previousStatus,
    nextStatus,
    reason,
    JSON.stringify(metadata || {}),
    actorId,
  ]);
  await tx.execute(`
    INSERT INTO audit_logs
      (table_name, record_id, action, details, user_id)
    VALUES ('operations', ?, ?, ?, ?)
  `, [
    operation.id,
    eventType,
    JSON.stringify({
      previous_status: previousStatus,
      next_status: nextStatus,
      reason,
      ...metadata,
    }),
    actorId,
  ]);
}

function assertSelfControl(operation, actorId, allowOverride, overrideReason, actionLabel) {
  if (Number(operation.created_by) !== Number(actorId)) return null;
  if (!allowOverride) {
    throw new CashReceiptWorkflowError(
      'CASH_RECEIPT_SELF_CONTROL_FORBIDDEN',
      `Le créateur ne peut pas ${actionLabel} son propre encaissement`,
      403,
      { created_by: Number(operation.created_by), actor_id: Number(actorId) },
    );
  }
  return requiredReason(overrideReason, 'Motif de dérogation');
}

async function createCashReceiptDraft({ input: rawInput, actorId }, dbc = db) {
  const input = normalizeOperationInput(rawInput);
  if (input.type_op !== 'encaissement') {
    throw new CashReceiptWorkflowError('CASH_RECEIPT_TYPE_REQUIRED', 'Type encaissement requis', 422);
  }
  if (!actorId) throw new CashReceiptWorkflowError('CASH_RECEIPT_ACTOR_REQUIRED', 'Auteur obligatoire', 422);
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new CashReceiptWorkflowError('CASH_RECEIPT_DATE_REQUIRED', 'Date valide requise', 422);
  }
  if (!input.libelle) throw new CashReceiptWorkflowError('CASH_RECEIPT_LABEL_REQUIRED', 'Libellé requis', 422);
  if (!Number.isFinite(input.montant) || input.montant <= 0) {
    throw new CashReceiptWorkflowError('CASH_RECEIPT_AMOUNT_INVALID', 'Montant doit être > 0', 422);
  }
  if (!input.position_id) throw new CashReceiptWorkflowError('CASH_RECEIPT_POSITION_REQUIRED', 'Position requise', 422);
  if (!input.categorie_id) throw new CashReceiptWorkflowError('CASH_RECEIPT_CATEGORY_REQUIRED', 'Rubrique comptable requise', 422);

  const result = await dbc.transaction(async tx => {
    await assertPeriodOpen(input.date, tx);
    await assertReadyPosition(input.position_id, tx);
    await assertExternalReferenceAvailable(input, tx);
    const threshold = await attachmentThreshold(tx);
    if (input.montant >= threshold && !input.piece_justificative) {
      throw new CashReceiptWorkflowError(
        'CASH_RECEIPT_ATTACHMENT_REQUIRED',
        `Pièce justificative obligatoire à partir de ${threshold} XAF`,
        422,
        { threshold },
      );
    }

    const inserted = await tx.execute(`
      INSERT INTO operations
        (date, num_piece, libelle, tiers, montant, type_op, position_id,
         categorie_id, mode_reglement, ref_externe, piece_justificative,
         decharge_signee, employe_id, created_by, statut, dec_statut,
         treasury_status, accounting_status, budget_status, allocation_status,
         business_status, approval_status, payment_status,
         reconciliation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'encaissement', ?, ?, ?, ?, ?, ?, ?, ?,
              'en_attente', NULL, 'pending', 'pending', 'pending', 'pending',
              'draft', 'draft', 'unpaid', 'pending', NOW(), NOW())
    `, [
      input.date,
      input.num_piece,
      input.libelle,
      input.tiers,
      input.montant,
      input.position_id,
      input.categorie_id,
      input.mode_reglement,
      input.ref_externe,
      input.piece_justificative,
      input.decharge_signee,
      input.employe_id,
      actorId,
    ]);
    if (!inserted.insertId) throw new Error('Création de l’encaissement sans identifiant');
    const operation = await lockedReceipt(inserted.insertId, tx);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_created',
      previousStatus: null,
      nextStatus: 'draft',
      metadata: {
        montant: Number(operation.montant),
        position_id: Number(operation.position_id),
        attachment_threshold: threshold,
      },
      actorId,
    });
    return { operationId: Number(operation.id) };
  });

  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function submitCashReceipt({ operationId, actorId, allowOtherSubmitter = false }, dbc = db) {
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    await assertNoLedger(operation.id, tx);
    if (operation.business_status !== 'draft' || operation.approval_status !== 'draft') {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_NOT_DRAFT', 'Seul un encaissement brouillon peut être soumis');
    }
    if (Number(operation.created_by) !== Number(actorId) && !allowOtherSubmitter) {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_SUBMIT_FORBIDDEN', 'Seul le créateur peut soumettre cet encaissement', 403);
    }
    await assertPeriodOpen(operation.date, tx);
    await tx.execute(`
      UPDATE operations
      SET business_status='submitted', approval_status='pending',
          submitted_by=?, submitted_at=NOW(), updated_at=NOW()
      WHERE id=?
    `, [actorId, operation.id]);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_submitted',
      previousStatus: 'draft',
      nextStatus: 'submitted',
      actorId,
    });
    return { operationId: Number(operation.id) };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function approveCashReceipt({
  operationId,
  actorId,
  allowSelfOverride = false,
  overrideReason = null,
}, dbc = db) {
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    await assertNoLedger(operation.id, tx);
    if (operation.business_status !== 'submitted' || operation.approval_status !== 'pending') {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_NOT_SUBMITTED', 'Seul un encaissement soumis peut être validé');
    }
    const derogation = assertSelfControl(operation, actorId, allowSelfOverride, overrideReason, 'valider');
    await assertPeriodOpen(operation.date, tx);
    await tx.execute(`
      UPDATE operations
      SET business_status='validated', approval_status='approved',
          validated_by=?, validated_at=NOW(), updated_at=NOW()
      WHERE id=?
    `, [actorId, operation.id]);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_approved',
      previousStatus: 'submitted',
      nextStatus: 'validated',
      reason: derogation,
      metadata: { self_control_override: Boolean(derogation) },
      actorId,
    });
    return { operationId: Number(operation.id) };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function confirmCashReceipt({
  operationId,
  actorId,
  allowSelfOverride = false,
  overrideReason = null,
  failBeforeLedger = false,
  failAfterLeg = null,
}, dbc = db) {
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    const derogation = assertSelfControl(operation, actorId, allowSelfOverride, overrideReason, 'confirmer');

    if (operation.business_status === 'confirmed'
      && operation.payment_status === 'paid'
      && operation.statut === 'valide') {
      const ledger = await postOperationToLedgerInContext({
        operation,
        userId: actorId,
        failAfterLeg,
      }, tx);
      return { operationId: Number(operation.id), confirmed: false, idempotent: true, ledger };
    }

    if (operation.business_status !== 'validated'
      || operation.approval_status !== 'approved'
      || operation.payment_status !== 'unpaid') {
      throw new CashReceiptWorkflowError(
        'CASH_RECEIPT_NOT_APPROVED',
        'Seul un encaissement validé peut être confirmé',
      );
    }

    await assertNoLedger(operation.id, tx);
    await assertPeriodOpen(operation.date, tx);
    await assertReadyPosition(operation.position_id, tx);
    await tx.execute(`
      UPDATE operations
      SET statut='valide', business_status='confirmed',
          approval_status='approved', payment_status='paid',
          treasury_status='pending', accounting_status='pending',
          paid_by=?, paid_at=NOW(), updated_at=NOW()
      WHERE id=?
    `, [actorId, operation.id]);

    if (failBeforeLedger) throw new Error('CASH_RECEIPT_TEST_FAILURE_BEFORE_LEDGER');

    const confirmed = await lockedReceipt(operation.id, tx);
    const ledger = await postOperationToLedgerInContext({
      operation: confirmed,
      userId: actorId,
      failAfterLeg,
    }, tx);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_confirmed',
      previousStatus: 'validated',
      nextStatus: 'confirmed',
      reason: derogation,
      metadata: {
        self_control_override: Boolean(derogation),
        ledger_ids: ledger.rows.map(row => Number(row.id)),
      },
      actorId,
    });
    return { operationId: Number(operation.id), confirmed: true, idempotent: false, ledger };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function rejectCashReceipt({ operationId, actorId, reason }, dbc = db) {
  const rejectionReason = requiredReason(reason, 'Motif de rejet');
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    await assertNoLedger(operation.id, tx);
    if (operation.business_status !== 'submitted' || operation.approval_status !== 'pending') {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_NOT_REJECTABLE', 'Seul un encaissement soumis peut être rejeté');
    }
    await tx.execute(`
      UPDATE operations
      SET business_status='rejected', approval_status='rejected',
          payment_status='unpaid', updated_at=NOW()
      WHERE id=?
    `, [operation.id]);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_rejected',
      previousStatus: 'submitted',
      nextStatus: 'rejected',
      reason: rejectionReason,
      actorId,
    });
    return { operationId: Number(operation.id) };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function disputeCashReceipt({ operationId, actorId, reason }, dbc = db) {
  const disputeReason = requiredReason(reason, 'Motif du litige');
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    await assertNoLedger(operation.id, tx);
    if (!['submitted', 'validated'].includes(operation.business_status)
      || operation.payment_status !== 'unpaid') {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_NOT_DISPUTABLE', 'Cet encaissement ne peut pas être placé en litige');
    }
    const previous = operation.business_status;
    await tx.execute(`
      UPDATE operations
      SET business_status='disputed', approval_status='disputed',
          payment_status='unpaid', updated_at=NOW()
      WHERE id=?
    `, [operation.id]);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_disputed',
      previousStatus: previous,
      nextStatus: 'disputed',
      reason: disputeReason,
      actorId,
    });
    return { operationId: Number(operation.id) };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

async function returnCashReceiptToDraft({ operationId, actorId, reason }, dbc = db) {
  const returnReason = requiredReason(reason, 'Motif du retour en brouillon');
  const result = await dbc.transaction(async tx => {
    const operation = await lockedReceipt(operationId, tx);
    await assertNoLedger(operation.id, tx);
    if (!['rejected', 'disputed'].includes(operation.business_status)) {
      throw new CashReceiptWorkflowError('CASH_RECEIPT_RETURN_FORBIDDEN', 'Seul un encaissement rejeté ou en litige peut revenir en brouillon');
    }
    const previous = operation.business_status;
    await tx.execute(`
      UPDATE operations
      SET business_status='draft', approval_status='draft',
          payment_status='unpaid', submitted_by=NULL, submitted_at=NULL,
          validated_by=NULL, validated_at=NULL, updated_at=NOW()
      WHERE id=?
    `, [operation.id]);
    await recordTransition(tx, {
      operation,
      eventType: 'cash_receipt_returned_to_draft',
      previousStatus: previous,
      nextStatus: 'draft',
      reason: returnReason,
      actorId,
    });
    return { operationId: Number(operation.id) };
  });
  return { ...result, operation: await loadOperation(result.operationId, dbc) };
}

module.exports = {
  CashReceiptWorkflowError,
  approveCashReceipt,
  confirmCashReceipt,
  createCashReceiptDraft,
  disputeCashReceipt,
  rejectCashReceipt,
  returnCashReceiptToDraft,
  submitCashReceipt,
};
