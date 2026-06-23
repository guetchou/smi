'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { buildFinanceIntegrityReport } = require('../backend/services/finance-integrity');

function token() {
  return `${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
}

async function createOperation(data) {
  const result = await db.execute(`
    INSERT INTO operations
      (date, num_piece, libelle, montant, type_op, position_id, position_source_id,
       mode_reglement, statut, dec_statut, treasury_status, accounting_status,
       budget_status, allocation_status, created_by, paid_by, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valide', ?, 'synced', 'synced',
            'pending', 'pending', ?, ?, ?)
  `, [
    data.date,
    data.num_piece,
    data.libelle,
    data.montant,
    data.type_op,
    data.position_id,
    data.position_source_id || null,
    data.mode_reglement || 'especes',
    data.type_op === 'decaissement' ? 'paye' : null,
    data.user_id,
    data.type_op === 'decaissement' ? data.user_id : null,
    data.type_op === 'decaissement' ? `${data.date} 12:00:00` : null,
  ]);
  return result.insertId;
}

async function createPostedEntry({ entryNo, sourceModule, operationId, amount, userId, debitAccountId, creditAccountId, positionId }) {
  const entry = await db.execute(`
    INSERT INTO accounting_entries
      (entry_no, entry_date, journal_code, source_module, source_record_id,
       label, status, created_by, validated_by)
    VALUES (?, '2026-06-23', 'TST', ?, ?, ?, 'posted', ?, ?)
  `, [entryNo, sourceModule, operationId, entryNo, userId, userId]);
  await db.execute(`
    INSERT INTO accounting_entry_lines
      (entry_id, account_id, debit, credit, label, position_id)
    VALUES (?, ?, ?, 0, ?, ?)
  `, [entry.insertId, debitAccountId, amount, entryNo, positionId]);
  await db.execute(`
    INSERT INTO accounting_entry_lines
      (entry_id, account_id, debit, credit, label, position_id)
    VALUES (?, ?, 0, ?, ?, ?)
  `, [entry.insertId, creditAccountId, amount, entryNo, positionId]);
  return entry.insertId;
}

async function cleanup(ids) {
  if (ids.entryIds.length) {
    await db.execute(`DELETE FROM accounting_entry_lines WHERE entry_id IN (${ids.entryIds.map(() => '?').join(',')})`, ids.entryIds);
    await db.execute(`DELETE FROM accounting_entries WHERE id IN (${ids.entryIds.map(() => '?').join(',')})`, ids.entryIds);
  }
  if (ids.operationIds.length) {
    await db.execute(`DELETE FROM cash_ledger WHERE operation_id IN (${ids.operationIds.map(() => '?').join(',')})`, ids.operationIds);
    await db.execute(`DELETE FROM operations WHERE id IN (${ids.operationIds.map(() => '?').join(',')})`, ids.operationIds);
  }
  if (ids.positionIds.length) {
    await db.execute(`DELETE FROM cashbox_balances WHERE caisse_id IN (${ids.positionIds.map(() => '?').join(',')})`, ids.positionIds);
    await db.execute(`DELETE FROM positions WHERE id IN (${ids.positionIds.map(() => '?').join(',')})`, ids.positionIds);
  }
  if (ids.userId) await db.execute('DELETE FROM users WHERE id = ?', [ids.userId]);
}

async function main() {
  const suffix = token();
  const ids = { userId: null, positionIds: [], operationIds: [], entryIds: [] };

  try {
    const accounts = await db.query(`
      SELECT id FROM accounting_accounts
      WHERE is_active = 1
      ORDER BY id
      LIMIT 2
    `);
    assert.strictEqual(accounts.length, 2, 'Deux comptes comptables actifs sont requis');

    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, 'not-used-in-test', 'finance', 1, NOW())
    `, [`Test intégrité finance ${suffix}`, `finance-integrity-${suffix}@example.test`]);
    ids.userId = user.insertId;

    const positionA = await db.execute(`
      INSERT INTO positions (code, libelle, type, solde_initial, actif, ordre)
      VALUES (?, ?, 'caisse', 100000, 1, 990)
    `, [`FIA-${suffix}`, `Caisse intégrité A ${suffix}`]);
    const positionB = await db.execute(`
      INSERT INTO positions (code, libelle, type, solde_initial, actif, ordre)
      VALUES (?, ?, 'banque', 40000, 1, 991)
    `, [`FIB-${suffix}`, `Banque intégrité B ${suffix}`]);
    ids.positionIds.push(positionA.insertId, positionB.insertId);

    const receiptId = await createOperation({
      date: '2026-06-23',
      num_piece: `ENC-${suffix}`,
      libelle: 'Encaissement test intégrité',
      montant: 50000,
      type_op: 'encaissement',
      position_id: positionA.insertId,
      user_id: ids.userId,
    });
    const disbursementId = await createOperation({
      date: '2026-06-23',
      num_piece: `DEC-${suffix}`,
      libelle: 'Décaissement test intégrité',
      montant: 20000,
      type_op: 'decaissement',
      position_id: positionA.insertId,
      user_id: ids.userId,
    });
    const transferId = await createOperation({
      date: '2026-06-23',
      num_piece: `VIR-${suffix}`,
      libelle: 'Virement test intégrité',
      montant: 10000,
      type_op: 'virement',
      position_id: positionB.insertId,
      position_source_id: positionA.insertId,
      mode_reglement: 'virement_bancaire',
      user_id: ids.userId,
    });
    ids.operationIds.push(receiptId, disbursementId, transferId);

    const ledgerRows = [
      [positionA.insertId, receiptId, 'credit', 50000, 100000, 150000, `ENC-${suffix}`, '2026-06-23 09:00:00'],
      [positionA.insertId, disbursementId, 'debit', 20000, 150000, 130000, `DEC-${suffix}`, '2026-06-23 10:00:00'],
      [positionA.insertId, transferId, 'debit', 10000, 130000, 120000, `VIR-S-${suffix}`, '2026-06-23 11:00:00'],
      [positionB.insertId, transferId, 'credit', 10000, 40000, 50000, `VIR-D-${suffix}`, '2026-06-23 11:00:01'],
    ];
    for (const row of ledgerRows) {
      await db.execute(`
        INSERT INTO cash_ledger
          (caisse_id, operation_id, type_mouvement, montant, solde_avant,
           solde_apres, reference, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [...row.slice(0, 7), ids.userId, row[7]]);
    }

    await db.execute(`
      INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at)
      VALUES (?, 120000, ?, NOW()), (?, 50000, ?, NOW())
    `, [positionA.insertId, transferId, positionB.insertId, transferId]);

    ids.entryIds.push(await createPostedEntry({
      entryNo: `TST-ENC-${suffix}`,
      sourceModule: 'cash_receipt',
      operationId: receiptId,
      amount: 50000,
      userId: ids.userId,
      debitAccountId: accounts[0].id,
      creditAccountId: accounts[1].id,
      positionId: positionA.insertId,
    }));
    ids.entryIds.push(await createPostedEntry({
      entryNo: `TST-DEC-${suffix}`,
      sourceModule: 'cash_disbursement',
      operationId: disbursementId,
      amount: 20000,
      userId: ids.userId,
      debitAccountId: accounts[1].id,
      creditAccountId: accounts[0].id,
      positionId: positionA.insertId,
    }));
    ids.entryIds.push(await createPostedEntry({
      entryNo: `TST-VIR-${suffix}`,
      sourceModule: 'internal_transfer',
      operationId: transferId,
      amount: 10000,
      userId: ids.userId,
      debitAccountId: accounts[0].id,
      creditAccountId: accounts[1].id,
      positionId: positionB.insertId,
    }));

    const coherent = await buildFinanceIntegrityReport({
      positionIds: ids.positionIds,
      operationIds: ids.operationIds,
    });
    assert.strictEqual(coherent.ok, true, JSON.stringify(coherent, null, 2));
    assert.strictEqual(coherent.summary.balance_mismatches, 0);
    assert.strictEqual(coherent.summary.operations_missing_ledger, 0);
    assert.strictEqual(coherent.summary.operations_missing_accounting, 0);
    assert.strictEqual(coherent.summary.unbalanced_entries, 0);

    await db.execute(`
      DELETE FROM cash_ledger
      WHERE operation_id = ? AND caisse_id = ? AND type_mouvement = 'credit'
    `, [transferId, positionB.insertId]);

    const divergent = await buildFinanceIntegrityReport({
      positionIds: ids.positionIds,
      operationIds: ids.operationIds,
    });
    assert.strictEqual(divergent.ok, false);
    assert.strictEqual(divergent.summary.operations_missing_ledger, 1);
    assert.strictEqual(divergent.summary.balance_mismatches, 1);
    assert(divergent.issues.operations_missing_ledger.some(issue =>
      issue.operation_id === transferId
      && issue.caisse_id === positionB.insertId
      && issue.type_mouvement === 'credit'));

    console.log('test_finance_integrity_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
