'use strict';

const assert = require('assert');
const fs = require('fs');

const dbPath = `/tmp/projet-smi-accounting-workflow-${process.pid}.db`;
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = dbPath;

const db = require('../backend/db');
const {
  AccountingWorkflowError,
  generateAccountingEntryForOperation,
  createAccountingReversal,
  validateAccountingEntry,
  listAccountingAnomalies,
} = require('../backend/services/accounting');

async function insertReceipt({ userId, positionId, categoryId, tiers, date = '2026-06-05' }) {
  const result = await db.execute(`
    INSERT INTO operations
      (date, num_piece, libelle, tiers, montant, type_op, position_id, categorie_id,
       mode_reglement, statut, treasury_status, accounting_status, budget_status,
       allocation_status, created_by)
    VALUES (?, ?, ?, ?, 125000, 'encaissement', ?, ?, 'especes', 'valide',
            'synced', 'pending', 'pending', 'pending', ?)
  `, [date, `TEST-${Date.now()}-${Math.random()}`, 'Prestation test', tiers, positionId, categoryId, userId]);
  return result.insertId;
}

async function run() {
  const user = await db.queryOne("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const position = await db.queryOne("SELECT id FROM positions WHERE type = 'caisse' AND actif = 1 ORDER BY id LIMIT 1");
  const category = await db.queryOne("SELECT id FROM categories WHERE type = 'encaissement' ORDER BY id LIMIT 1");
  assert(user && position && category, 'Seeds de test incomplets');

  const rule = await db.queryOne(`
    SELECT id
    FROM accounting_mapping_rules
    WHERE operation_type = 'encaissement'
      AND payment_method = 'especes'
      AND position_type = 'caisse'
      AND third_party_type = 'tiers'
    LIMIT 1
  `);
  assert(rule, 'Mapping encaissement caisse tiers absent');
  await db.execute('UPDATE accounting_mapping_rules SET is_active = 1 WHERE id = ?', [rule.id]);

  const operationId = await insertReceipt({
    userId: user.id,
    positionId: position.id,
    categoryId: category.id,
    tiers: 'Client test',
  });
  await db.execute(`
    INSERT INTO sync_errors
      (source_module, source_record_id, error_type, error_message, status)
    VALUES ('operations', ?, 'ACCOUNTING_SYNC_PENDING', 'Test pending', 'open')
  `, [operationId]);

  const generated = await generateAccountingEntryForOperation({ operationId, userId: user.id });
  assert.strictEqual(generated.created, true);
  assert.strictEqual(generated.entry.status, 'draft');
  assert.strictEqual(generated.entry.lines.length, 2);
  assert.strictEqual(
    generated.entry.lines.reduce((sum, line) => sum + Number(line.debit), 0),
    generated.entry.lines.reduce((sum, line) => sum + Number(line.credit), 0)
  );

  const duplicate = await generateAccountingEntryForOperation({ operationId, userId: user.id });
  assert.strictEqual(duplicate.created, false);
  assert.strictEqual(duplicate.entry.id, generated.entry.id);

  const validated = await validateAccountingEntry({ entryId: generated.entry.id, userId: user.id });
  assert.strictEqual(validated.validated, true);
  assert.strictEqual(validated.entry.status, 'posted');
  const syncedOperation = await db.queryOne('SELECT accounting_status FROM operations WHERE id = ?', [operationId]);
  assert.strictEqual(syncedOperation.accounting_status, 'synced');
  const remainingErrors = await db.queryOne(`
    SELECT COUNT(*) AS total FROM sync_errors
    WHERE source_module = 'operations' AND source_record_id = ? AND status = 'open'
      AND error_type LIKE 'ACCOUNTING_%'
  `, [operationId]);
  assert.strictEqual(Number(remainingErrors.total), 0);

  await assert.rejects(
    () => createAccountingReversal({
      entryId: generated.entry.id,
      userId: user.id,
      reversalDate: '2026-06-07',
      reason: 'non',
    }),
    error => error instanceof AccountingWorkflowError
      && error.code === 'ACCOUNTING_REVERSAL_REASON_REQUIRED'
  );

  const reversal = await createAccountingReversal({
    entryId: generated.entry.id,
    userId: user.id,
    reversalDate: '2026-06-07',
    reason: 'Correction de ventilation comptable',
  });
  assert.strictEqual(reversal.created, true);
  assert.strictEqual(reversal.entry.status, 'draft');
  assert.strictEqual(reversal.entry.source_module, 'accounting_reversal');
  assert.strictEqual(Number(reversal.entry.source_record_id), Number(generated.entry.id));
  assert.strictEqual(reversal.entry.lines.length, generated.entry.lines.length);
  generated.entry.lines.forEach(originalLine => {
    const reversedLine = reversal.entry.lines.find(
      line => Number(line.account_id) === Number(originalLine.account_id)
    );
    assert(reversedLine, `Ligne inversée absente pour le compte ${originalLine.account_id}`);
    assert.strictEqual(Number(reversedLine.debit), Number(originalLine.credit));
    assert.strictEqual(Number(reversedLine.credit), Number(originalLine.debit));
  });

  const duplicateReversal = await createAccountingReversal({
    entryId: generated.entry.id,
    userId: user.id,
    reversalDate: '2026-06-07',
    reason: 'Correction de ventilation comptable',
  });
  assert.strictEqual(duplicateReversal.created, false);
  assert.strictEqual(duplicateReversal.entry.id, reversal.entry.id);

  const postedReversal = await validateAccountingEntry({
    entryId: reversal.entry.id,
    userId: user.id,
  });
  assert.strictEqual(postedReversal.validated, true);
  assert.strictEqual(postedReversal.entry.status, 'posted');
  const cancelledOperation = await db.queryOne(
    'SELECT accounting_status FROM operations WHERE id = ?',
    [operationId]
  );
  assert.strictEqual(cancelledOperation.accounting_status, 'cancelled');

  const regenerationAfterReversal = await generateAccountingEntryForOperation({
    operationId,
    userId: user.id,
  });
  assert.strictEqual(regenerationAfterReversal.created, false);
  assert.strictEqual(regenerationAfterReversal.entry.id, generated.entry.id);
  const stillCancelledOperation = await db.queryOne(
    'SELECT accounting_status FROM operations WHERE id = ?',
    [operationId]
  );
  assert.strictEqual(stillCancelledOperation.accounting_status, 'cancelled');

  const missingMappingOperationId = await insertReceipt({
    userId: user.id,
    positionId: position.id,
    categoryId: category.id,
    tiers: null,
  });
  await assert.rejects(
    () => generateAccountingEntryForOperation({ operationId: missingMappingOperationId, userId: user.id }),
    error => error instanceof AccountingWorkflowError && error.code === 'ACCOUNTING_MAPPING_MISSING'
  );
  const failedOperation = await db.queryOne(
    'SELECT accounting_status FROM operations WHERE id = ?',
    [missingMappingOperationId]
  );
  assert.strictEqual(failedOperation.accounting_status, 'error');

  const closedOperationId = await insertReceipt({
    userId: user.id,
    positionId: position.id,
    categoryId: category.id,
    tiers: 'Client période clôturée',
    date: '2026-05-15',
  });
  await db.execute(
    'INSERT INTO periodes_cloturees (annee, mois, cloture_by, notes) VALUES (2026, 5, ?, ?)',
    [user.id, 'Test comptable']
  );
  await assert.rejects(
    () => generateAccountingEntryForOperation({ operationId: closedOperationId, userId: user.id }),
    error => error instanceof AccountingWorkflowError && error.code === 'ACCOUNTING_PERIOD_CLOSED'
  );

  const reversalPeriodOperationId = await insertReceipt({
    userId: user.id,
    positionId: position.id,
    categoryId: category.id,
    tiers: 'Client contre-écriture clôturée',
    date: '2026-06-20',
  });
  const reversalPeriodEntry = await generateAccountingEntryForOperation({
    operationId: reversalPeriodOperationId,
    userId: user.id,
  });
  await validateAccountingEntry({ entryId: reversalPeriodEntry.entry.id, userId: user.id });
  await db.execute(
    'INSERT INTO periodes_cloturees (annee, mois, cloture_by, notes) VALUES (2026, 7, ?, ?)',
    [user.id, 'Test contre-écriture']
  );
  await assert.rejects(
    () => createAccountingReversal({
      entryId: reversalPeriodEntry.entry.id,
      userId: user.id,
      reversalDate: '2026-07-05',
      reason: 'Correction après clôture',
    }),
    error => error instanceof AccountingWorkflowError && error.code === 'ACCOUNTING_PERIOD_CLOSED'
  );

  const anomalies = await listAccountingAnomalies({ limit: 50, offset: 0 });
  assert(anomalies.rows.some(row => Number(row.id) === Number(missingMappingOperationId)
    && row.anomaly_code === 'ACCOUNTING_MAPPING_MISSING'));
  assert(anomalies.summary.missing_mapping >= 1);
  assert.strictEqual(anomalies.pagination.total, anomalies.summary.total);

  const firstPage = await listAccountingAnomalies({ limit: 1, offset: 0 });
  assert.strictEqual(firstPage.rows.length, 1);
  assert.strictEqual(firstPage.pagination.limit, 1);
  assert.strictEqual(firstPage.pagination.offset, 0);
  assert.strictEqual(firstPage.pagination.total, firstPage.summary.total);
  assert.strictEqual(firstPage.pagination.has_previous, false);
  assert.strictEqual(firstPage.pagination.has_next, firstPage.summary.total > 1);
  if (firstPage.summary.total > 1) {
    const secondPage = await listAccountingAnomalies({ limit: 1, offset: 1 });
    assert.strictEqual(secondPage.summary.total, firstPage.summary.total);
    assert.strictEqual(secondPage.summary.missing_mapping, firstPage.summary.missing_mapping);
    assert.strictEqual(secondPage.pagination.offset, 1);
    assert.strictEqual(secondPage.pagination.has_previous, true);
    assert.notStrictEqual(Number(secondPage.rows[0].id), Number(firstPage.rows[0].id));
  }

  console.log(JSON.stringify({
    accountingWorkflow: true,
    idempotentGeneration: true,
    balancedPosting: true,
    idempotentReversal: true,
    reversalKeepsAuditTrail: true,
    missingMappingAnomaly: true,
    paginatedAnomalyQueue: true,
    closedPeriodGuard: true,
    closedReversalPeriodGuard: true,
  }));
}

run()
  .finally(() => {
    try { db._raw.close(); } catch (_) {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
    }
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
