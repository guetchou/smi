'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const {
  approveCashReceipt,
  confirmCashReceipt,
  createCashReceiptDraft,
  disputeCashReceipt,
  rejectCashReceipt,
  returnCashReceiptToDraft,
  submitCashReceipt,
} = require('../backend/services/cash-receipt-workflow');

function suffix() {
  return `${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
}

async function createUser(tag, role) {
  const result = await db.execute(`
    INSERT INTO users (nom, email, password_hash, role, actif, created_at)
    VALUES (?, ?, 'not-used', ?, 1, NOW())
  `, [`Test ${role} ${tag}`, `${role}-${tag}@example.test`, role]);
  return result.insertId;
}

async function cleanup(ids) {
  if (ids.operationIds.length) {
    const marks = ids.operationIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM audit_logs WHERE table_name='operations' AND record_id IN (${marks})`, ids.operationIds);
    await db.execute(`DELETE FROM finance_operation_events WHERE operation_id IN (${marks})`, ids.operationIds);
    await db.execute(`DELETE FROM cash_ledger WHERE operation_id IN (${marks})`, ids.operationIds);
    await db.execute(`DELETE FROM operations WHERE id IN (${marks})`, ids.operationIds);
  }
  if (ids.positionId) {
    await db.execute('DELETE FROM cashbox_balances WHERE caisse_id=?', [ids.positionId]);
    await db.execute('DELETE FROM positions WHERE id=?', [ids.positionId]);
  }
  if (ids.categoryId) await db.execute('DELETE FROM categories WHERE id=?', [ids.categoryId]);
  for (const userId of ids.userIds.reverse()) {
    await db.execute('DELETE FROM users WHERE id=?', [userId]);
  }
}

async function balance(positionId) {
  const row = await db.queryOne('SELECT solde_courant FROM cashbox_balances WHERE caisse_id=?', [positionId]);
  return Number(row.solde_courant);
}

async function ledgerCount(operationId) {
  const row = await db.queryOne('SELECT COUNT(*) AS total FROM cash_ledger WHERE operation_id=?', [operationId]);
  return Number(row.total);
}

async function createDraft(ids, tag, number, amount = 50000) {
  const result = await createCashReceiptDraft({
    actorId: ids.creatorId,
    input: {
      date: '2026-06-23',
      num_piece: `ENC-${number}-${tag}`,
      libelle: `Encaissement contrôlé ${number}`,
      montant: amount,
      type_op: 'encaissement',
      position_id: ids.positionId,
      categorie_id: ids.categoryId,
      mode_reglement: 'especes',
    },
  });
  ids.operationIds.push(result.operationId);
  return result;
}

async function main() {
  const tag = suffix();
  const ids = {
    creatorId: null,
    approverId: null,
    confirmerId: null,
    adminId: null,
    userIds: [],
    positionId: null,
    categoryId: null,
    operationIds: [],
  };

  try {
    ids.creatorId = await createUser(tag, 'caissier');
    ids.approverId = await createUser(tag, 'finance');
    ids.confirmerId = await createUser(tag, 'finance-confirm');
    ids.adminId = await createUser(tag, 'admin');
    ids.userIds.push(ids.creatorId, ids.approverId, ids.confirmerId, ids.adminId);

    const category = await db.execute(`
      INSERT INTO categories (nom, type, couleur, icone, actif)
      VALUES (?, 'encaissement', '#000000', 'circle', 1)
    `, [`Encaissement contrôlé ${tag}`]);
    ids.categoryId = category.insertId;

    const position = await db.execute(`
      INSERT INTO positions
        (code, libelle, type, solde_initial, actif, ordre,
         ledger_status, ledger_ready_at, ledger_ready_by)
      VALUES (?, ?, 'caisse', 100000, 1, 997, 'ready', NOW(), ?)
    `, [`ENC-${tag}`, `Caisse encaissement ${tag}`, ids.adminId]);
    ids.positionId = position.insertId;
    await db.execute(`
      INSERT INTO cashbox_balances
        (caisse_id, solde_courant, derniere_operation_id, updated_at)
      VALUES (?, 100000, NULL, NOW())
    `, [ids.positionId]);

    const draft = await createDraft(ids, tag, 'A');
    assert.strictEqual(draft.operation.statut, 'en_attente');
    assert.strictEqual(draft.operation.business_status, 'draft');
    assert.strictEqual(draft.operation.approval_status, 'draft');
    assert.strictEqual(draft.operation.payment_status, 'unpaid');
    assert.strictEqual(await ledgerCount(draft.operationId), 0);
    assert.strictEqual(await balance(ids.positionId), 100000);

    const submitted = await submitCashReceipt({
      operationId: draft.operationId,
      actorId: ids.creatorId,
    });
    assert.strictEqual(submitted.operation.business_status, 'submitted');
    assert.strictEqual(submitted.operation.approval_status, 'pending');
    assert.strictEqual(await ledgerCount(draft.operationId), 0);
    assert.strictEqual(await balance(ids.positionId), 100000);

    await assert.rejects(
      () => approveCashReceipt({ operationId: draft.operationId, actorId: ids.creatorId }),
      error => error.code === 'CASH_RECEIPT_SELF_CONTROL_FORBIDDEN',
    );

    const approved = await approveCashReceipt({
      operationId: draft.operationId,
      actorId: ids.approverId,
    });
    assert.strictEqual(approved.operation.business_status, 'validated');
    assert.strictEqual(approved.operation.approval_status, 'approved');
    assert.strictEqual(approved.operation.payment_status, 'unpaid');
    assert.strictEqual(await ledgerCount(draft.operationId), 0);
    assert.strictEqual(await balance(ids.positionId), 100000);

    await assert.rejects(
      () => confirmCashReceipt({ operationId: draft.operationId, actorId: ids.creatorId }),
      error => error.code === 'CASH_RECEIPT_SELF_CONTROL_FORBIDDEN',
    );

    await assert.rejects(
      () => confirmCashReceipt({
        operationId: draft.operationId,
        actorId: ids.confirmerId,
        failBeforeLedger: true,
      }),
      error => error.message === 'CASH_RECEIPT_TEST_FAILURE_BEFORE_LEDGER',
    );
    const afterRollback = await db.queryOne(`
      SELECT statut, business_status, approval_status, payment_status, treasury_status
      FROM operations WHERE id=?
    `, [draft.operationId]);
    assert.strictEqual(afterRollback.statut, 'en_attente');
    assert.strictEqual(afterRollback.business_status, 'validated');
    assert.strictEqual(afterRollback.payment_status, 'unpaid');
    assert.strictEqual(afterRollback.treasury_status, 'pending');
    assert.strictEqual(await ledgerCount(draft.operationId), 0);
    assert.strictEqual(await balance(ids.positionId), 100000);

    const concurrent = await Promise.all([
      confirmCashReceipt({ operationId: draft.operationId, actorId: ids.confirmerId }),
      confirmCashReceipt({ operationId: draft.operationId, actorId: ids.confirmerId }),
    ]);
    assert.strictEqual(concurrent.filter(row => row.confirmed).length, 1);
    assert.strictEqual(concurrent.filter(row => row.idempotent).length, 1);
    assert.strictEqual(await ledgerCount(draft.operationId), 1);
    assert.strictEqual(await balance(ids.positionId), 150000);

    const receiptLeg = await db.queryOne(`
      SELECT leg_code, type_mouvement, montant, solde_avant, solde_apres
      FROM cash_ledger WHERE operation_id=?
    `, [draft.operationId]);
    assert.strictEqual(receiptLeg.leg_code, 'receipt');
    assert.strictEqual(receiptLeg.type_mouvement, 'credit');
    assert.strictEqual(Number(receiptLeg.montant), 50000);
    assert.strictEqual(Number(receiptLeg.solde_avant), 100000);
    assert.strictEqual(Number(receiptLeg.solde_apres), 150000);

    const events = await db.query(`
      SELECT event_type FROM finance_operation_events
      WHERE operation_id=? ORDER BY id
    `, [draft.operationId]);
    assert.deepStrictEqual(events.map(row => row.event_type), [
      'cash_receipt_created',
      'cash_receipt_submitted',
      'cash_receipt_approved',
      'cash_receipt_confirmed',
    ]);

    const disputedDraft = await createDraft(ids, tag, 'B', 20000);
    await submitCashReceipt({ operationId: disputedDraft.operationId, actorId: ids.creatorId });
    const disputed = await disputeCashReceipt({
      operationId: disputedDraft.operationId,
      actorId: ids.approverId,
      reason: 'Référence bancaire à vérifier',
    });
    assert.strictEqual(disputed.operation.business_status, 'disputed');
    assert.strictEqual(await ledgerCount(disputedDraft.operationId), 0);
    assert.strictEqual(await balance(ids.positionId), 150000);

    const returned = await returnCashReceiptToDraft({
      operationId: disputedDraft.operationId,
      actorId: ids.approverId,
      reason: 'Correction des informations bancaires',
    });
    assert.strictEqual(returned.operation.business_status, 'draft');
    assert.strictEqual(returned.operation.approval_status, 'draft');

    const rejectedDraft = await createDraft(ids, tag, 'C', 10000);
    await submitCashReceipt({ operationId: rejectedDraft.operationId, actorId: ids.creatorId });
    const rejected = await rejectCashReceipt({
      operationId: rejectedDraft.operationId,
      actorId: ids.approverId,
      reason: 'Justificatif non recevable',
    });
    assert.strictEqual(rejected.operation.business_status, 'rejected');
    assert.strictEqual(rejected.operation.approval_status, 'rejected');
    assert.strictEqual(await ledgerCount(rejectedDraft.operationId), 0);

    const overrideDraft = await createDraft(ids, tag, 'D', 5000);
    await submitCashReceipt({ operationId: overrideDraft.operationId, actorId: ids.creatorId });
    const selfApproved = await approveCashReceipt({
      operationId: overrideDraft.operationId,
      actorId: ids.creatorId,
      allowSelfOverride: true,
      overrideReason: 'Dérogation administrateur pour test contrôlé',
    });
    assert.strictEqual(selfApproved.operation.business_status, 'validated');
    const selfConfirmed = await confirmCashReceipt({
      operationId: overrideDraft.operationId,
      actorId: ids.creatorId,
      allowSelfOverride: true,
      overrideReason: 'Dérogation administrateur pour test contrôlé',
    });
    assert.strictEqual(selfConfirmed.confirmed, true);
    assert.strictEqual(await balance(ids.positionId), 155000);

    const overrideAudit = await db.queryOne(`
      SELECT details FROM audit_logs
      WHERE table_name='operations' AND record_id=?
        AND action='cash_receipt_confirmed'
      ORDER BY id DESC LIMIT 1
    `, [overrideDraft.operationId]);
    assert(overrideAudit && String(overrideAudit.details).includes('self_control_override'));

    console.log('test_cash_receipt_workflow_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
