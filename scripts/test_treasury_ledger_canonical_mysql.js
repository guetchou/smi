'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const {
  createCanonicalOperation,
  payCanonicalDisbursement,
} = require('../backend/services/finance-operation-canonical');

function suffix() {
  return `${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
}

async function cleanup(ids) {
  if (ids.operationIds.length) {
    const marks = ids.operationIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM audit_logs WHERE table_name='operations' AND record_id IN (${marks})`, ids.operationIds);
    await db.execute(`DELETE FROM cash_ledger WHERE operation_id IN (${marks})`, ids.operationIds);
    await db.execute(`DELETE FROM operations WHERE id IN (${marks})`, ids.operationIds);
  }
  if (ids.positionIds.length) {
    const marks = ids.positionIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM cashbox_balances WHERE caisse_id IN (${marks})`, ids.positionIds);
    await db.execute(`DELETE FROM positions WHERE id IN (${marks})`, ids.positionIds);
  }
  if (ids.categoryIds.length) {
    const marks = ids.categoryIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM categories WHERE id IN (${marks})`, ids.categoryIds);
  }
  if (ids.userId) await db.execute('DELETE FROM users WHERE id = ?', [ids.userId]);
}

async function createReadyPosition({ code, label, type, opening, userId }) {
  const inserted = await db.execute(`
    INSERT INTO positions
      (code, libelle, type, solde_initial, actif, ordre, ledger_status, ledger_ready_at, ledger_ready_by)
    VALUES (?, ?, ?, ?, 1, 995, 'ready', NOW(), ?)
  `, [code, label, type, opening, userId]);
  await db.execute(`
    INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at)
    VALUES (?, ?, NULL, NOW())
  `, [inserted.insertId, opening]);
  return inserted.insertId;
}

async function main() {
  const tag = suffix();
  const ids = { userId: null, positionIds: [], categoryIds: [], operationIds: [] };

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, 'not-used', 'finance', 1, NOW())
    `, [`Test ledger ${tag}`, `treasury-ledger-${tag}@example.test`]);
    ids.userId = user.insertId;

    const receiptCategory = await db.execute(`
      INSERT INTO categories (nom, type, couleur, icone, actif)
      VALUES (?, 'encaissement', '#000000', 'circle', 1)
    `, [`Encaissement ledger ${tag}`]);
    const disbursementCategory = await db.execute(`
      INSERT INTO categories (nom, type, couleur, icone, actif)
      VALUES (?, 'decaissement', '#000000', 'circle', 1)
    `, [`Décaissement ledger ${tag}`]);
    ids.categoryIds.push(receiptCategory.insertId, disbursementCategory.insertId);

    const sourceId = await createReadyPosition({
      code: `TLS-${tag}`,
      label: `Caisse source ${tag}`,
      type: 'caisse',
      opening: 100000,
      userId: ids.userId,
    });
    const destinationId = await createReadyPosition({
      code: `TLD-${tag}`,
      label: `Banque destination ${tag}`,
      type: 'banque',
      opening: 40000,
      userId: ids.userId,
    });
    ids.positionIds.push(sourceId, destinationId);

    const receipt = await createCanonicalOperation({
      userId: ids.userId,
      input: {
        date: '2026-06-23',
        num_piece: `ENC-${tag}`,
        libelle: 'Encaissement canonique',
        montant: 50000,
        type_op: 'encaissement',
        position_id: sourceId,
        categorie_id: receiptCategory.insertId,
        mode_reglement: 'especes',
      },
    });
    ids.operationIds.push(receipt.operationId);
    assert.strictEqual(receipt.ledger.posted, true);
    assert.strictEqual(receipt.ledger.rows.length, 1);
    assert.strictEqual(receipt.ledger.rows[0].leg_code, 'receipt');
    assert.strictEqual(Number(receipt.ledger.rows[0].solde_apres), 150000);

    const failedTransferRef = `VIR-FAIL-${tag}`;
    await assert.rejects(
      () => createCanonicalOperation({
        userId: ids.userId,
        failAfterLeg: 1,
        input: {
          date: '2026-06-23',
          num_piece: failedTransferRef,
          libelle: 'Virement rollback',
          montant: 10000,
          type_op: 'virement',
          position_source_id: sourceId,
          position_id: destinationId,
          mode_reglement: 'virement_bancaire',
          ref_externe: `REF-FAIL-${tag}`,
        },
      }),
      error => /TREASURY_LEDGER_TEST_FAILURE_AFTER_LEG_1/.test(error.message),
    );
    const failedTransfer = await db.queryOne('SELECT id FROM operations WHERE num_piece = ?', [failedTransferRef]);
    assert.strictEqual(failedTransfer, null, 'operation must roll back with first transfer leg');
    const afterRollback = await db.query(`
      SELECT caisse_id, solde_courant FROM cashbox_balances
      WHERE caisse_id IN (?, ?) ORDER BY caisse_id
    `, [sourceId, destinationId]);
    const rollbackBalances = new Map(afterRollback.map(row => [Number(row.caisse_id), Number(row.solde_courant)]));
    assert.strictEqual(rollbackBalances.get(sourceId), 150000);
    assert.strictEqual(rollbackBalances.get(destinationId), 40000);

    const transfer = await createCanonicalOperation({
      userId: ids.userId,
      input: {
        date: '2026-06-23',
        num_piece: `VIR-${tag}`,
        libelle: 'Virement canonique',
        montant: 10000,
        type_op: 'virement',
        position_source_id: sourceId,
        position_id: destinationId,
        mode_reglement: 'virement_bancaire',
        ref_externe: `REF-VIR-${tag}`,
      },
    });
    ids.operationIds.push(transfer.operationId);
    assert.deepStrictEqual(transfer.ledger.rows.map(row => row.leg_code), [
      'transfer_source',
      'transfer_destination',
    ]);

    const transferBalances = await db.query(`
      SELECT caisse_id, solde_courant FROM cashbox_balances
      WHERE caisse_id IN (?, ?) ORDER BY caisse_id
    `, [sourceId, destinationId]);
    const byPosition = new Map(transferBalances.map(row => [Number(row.caisse_id), Number(row.solde_courant)]));
    assert.strictEqual(byPosition.get(sourceId), 140000);
    assert.strictEqual(byPosition.get(destinationId), 50000);

    const disbursement = await createCanonicalOperation({
      userId: ids.userId,
      input: {
        date: '2026-06-23',
        num_piece: `DEC-${tag}`,
        libelle: 'Décaissement canonique',
        montant: 30000,
        type_op: 'decaissement',
        position_id: sourceId,
        categorie_id: disbursementCategory.insertId,
        mode_reglement: 'especes',
      },
    });
    ids.operationIds.push(disbursement.operationId);
    assert.strictEqual(disbursement.operation.dec_statut, 'brouillon');
    await db.execute(`
      UPDATE operations
      SET dec_statut='valide', validated_by=?, validated_at=NOW(), approval_status='approved'
      WHERE id=?
    `, [ids.userId, disbursement.operationId]);

    const concurrent = await Promise.all([
      payCanonicalDisbursement({ operationId: disbursement.operationId, userId: ids.userId }),
      payCanonicalDisbursement({ operationId: disbursement.operationId, userId: ids.userId }),
    ]);
    assert.strictEqual(concurrent.filter(result => result.paid).length, 1);
    assert.strictEqual(concurrent.filter(result => result.idempotent).length, 1);
    const paymentLegs = await db.query(`
      SELECT id, leg_code FROM cash_ledger
      WHERE operation_id = ?
    `, [disbursement.operationId]);
    assert.strictEqual(paymentLegs.length, 1);
    assert.strictEqual(paymentLegs[0].leg_code, 'disbursement');

    const paidBalance = await db.queryOne(`
      SELECT solde_courant FROM cashbox_balances WHERE caisse_id = ?
    `, [sourceId]);
    assert.strictEqual(Number(paidBalance.solde_courant), 110000);

    const tooLarge = await createCanonicalOperation({
      userId: ids.userId,
      input: {
        date: '2026-06-23',
        num_piece: `DEC-BLOCK-${tag}`,
        libelle: 'Décaissement insuffisant',
        montant: 200000,
        type_op: 'decaissement',
        position_id: sourceId,
        categorie_id: disbursementCategory.insertId,
        mode_reglement: 'especes',
      },
    });
    ids.operationIds.push(tooLarge.operationId);
    await db.execute(`
      UPDATE operations
      SET dec_statut='valide', validated_by=?, validated_at=NOW(), approval_status='approved'
      WHERE id=?
    `, [ids.userId, tooLarge.operationId]);

    await assert.rejects(
      () => payCanonicalDisbursement({ operationId: tooLarge.operationId, userId: ids.userId }),
      error => error.code === 'TREASURY_INSUFFICIENT_BALANCE',
    );
    const blocked = await db.queryOne('SELECT dec_statut, statut FROM operations WHERE id = ?', [tooLarge.operationId]);
    assert.strictEqual(blocked.dec_statut, 'valide');
    assert.notStrictEqual(blocked.statut, 'valide');
    const blockedLeg = await db.queryOne('SELECT id FROM cash_ledger WHERE operation_id = ?', [tooLarge.operationId]);
    assert.strictEqual(blockedLeg, null);

    const auditCount = await db.queryOne(`
      SELECT COUNT(*) AS total FROM audit_logs
      WHERE table_name='operations' AND record_id IN (?, ?, ?)
        AND action='treasury_ledger_posted'
    `, [receipt.operationId, transfer.operationId, disbursement.operationId]);
    assert.strictEqual(Number(auditCount.total), 3);

    console.log('test_treasury_ledger_canonical_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
