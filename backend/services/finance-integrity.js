'use strict';

const db = require('../db');

const EPSILON = 0.01;
const SOURCE_BY_TYPE = {
  encaissement: 'cash_receipt',
  decaissement: 'cash_disbursement',
  virement: 'internal_transfer',
};

function amount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizeIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function differs(left, right) {
  return Math.abs(amount(left) - amount(right)) >= EPSILON;
}

function isEffectiveOperation(operation) {
  if (!operation || operation.statut !== 'valide') return false;
  if (operation.type_op === 'decaissement') return operation.dec_statut === 'paye';
  return operation.type_op === 'encaissement' || operation.type_op === 'virement';
}

function expectedLedgerLegs(operation) {
  const value = amount(operation.montant);
  if (operation.type_op === 'encaissement') {
    return [{ caisse_id: Number(operation.position_id), type_mouvement: 'credit', montant: value }];
  }
  if (operation.type_op === 'decaissement') {
    return [{ caisse_id: Number(operation.position_id), type_mouvement: 'debit', montant: value }];
  }
  if (operation.type_op === 'virement') {
    return [
      { caisse_id: Number(operation.position_source_id), type_mouvement: 'debit', montant: value },
      { caisse_id: Number(operation.position_id), type_mouvement: 'credit', montant: value },
    ];
  }
  return [];
}

function operationDeltaForPosition(operation, positionId) {
  const value = amount(operation.montant);
  if (operation.type_op === 'encaissement' && Number(operation.position_id) === positionId) return value;
  if (operation.type_op === 'decaissement' && Number(operation.position_id) === positionId) return -value;
  if (operation.type_op === 'virement') {
    let delta = 0;
    if (Number(operation.position_source_id) === positionId) delta -= value;
    if (Number(operation.position_id) === positionId) delta += value;
    return delta;
  }
  return 0;
}

async function loadPositions(positionIds, dbc) {
  let sql = 'SELECT id, code, libelle, type, solde_initial, actif FROM positions';
  const params = [];
  if (positionIds.length) {
    sql += ` WHERE id IN (${placeholders(positionIds)})`;
    params.push(...positionIds);
  }
  sql += ' ORDER BY id';
  return dbc.query(sql, params);
}

async function loadOperations(positionIds, operationIds, dbc) {
  const filters = ["type_op IN ('encaissement','decaissement','virement')"];
  const params = [];
  if (positionIds.length) {
    filters.push(`(position_id IN (${placeholders(positionIds)}) OR position_source_id IN (${placeholders(positionIds)}))`);
    params.push(...positionIds, ...positionIds);
  }
  if (operationIds.length) {
    filters.push(`id IN (${placeholders(operationIds)})`);
    params.push(...operationIds);
  }
  return dbc.query(`
    SELECT id, date, num_piece, libelle, montant, type_op, statut, dec_statut,
           position_id, position_source_id, accounting_status, reconciliation_status
    FROM operations
    WHERE ${filters.join(' AND ')}
    ORDER BY date, id
  `, params);
}

async function loadLedger(positionIds, operationIds, dbc) {
  const filters = [];
  const params = [];
  if (positionIds.length) {
    filters.push(`caisse_id IN (${placeholders(positionIds)})`);
    params.push(...positionIds);
  }
  if (operationIds.length) {
    filters.push(`operation_id IN (${placeholders(operationIds)})`);
    params.push(...operationIds);
  }
  return dbc.query(`
    SELECT id, caisse_id, operation_id, type_mouvement, montant,
           solde_avant, solde_apres, reference, created_at
    FROM cash_ledger
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY caisse_id, created_at, id
  `, params);
}

async function loadBalances(positionIds, dbc) {
  const params = [];
  let sql = 'SELECT caisse_id, solde_courant, derniere_operation_id, updated_at FROM cashbox_balances';
  if (positionIds.length) {
    sql += ` WHERE caisse_id IN (${placeholders(positionIds)})`;
    params.push(...positionIds);
  }
  return dbc.query(sql, params);
}

async function loadReferencedOperations(ids, dbc) {
  if (!ids.length) return [];
  return dbc.query(`
    SELECT id, date, num_piece, libelle, montant, type_op, statut, dec_statut,
           position_id, position_source_id, accounting_status, reconciliation_status
    FROM operations
    WHERE id IN (${placeholders(ids)})
  `, ids);
}

async function loadAccountingEntries(operationIds, dbc) {
  if (!operationIds.length) return [];
  const originals = await dbc.query(`
    SELECT e.id, e.entry_no, e.entry_date, e.journal_code, e.source_module,
           e.source_record_id, e.status,
           COUNT(l.id) AS line_count,
           COALESCE(SUM(l.debit), 0) AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
    FROM accounting_entries e
    LEFT JOIN accounting_entry_lines l ON l.entry_id = e.id
    WHERE e.source_module IN ('cash_receipt','cash_disbursement','internal_transfer')
      AND e.source_record_id IN (${placeholders(operationIds)})
    GROUP BY e.id
    ORDER BY e.id
  `, operationIds);

  const entryIds = originals.map(row => Number(row.id));
  if (!entryIds.length) return originals;
  const reversals = await dbc.query(`
    SELECT e.id, e.entry_no, e.entry_date, e.journal_code, e.source_module,
           e.source_record_id, e.status,
           COUNT(l.id) AS line_count,
           COALESCE(SUM(l.debit), 0) AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
    FROM accounting_entries e
    LEFT JOIN accounting_entry_lines l ON l.entry_id = e.id
    WHERE e.source_module = 'accounting_reversal'
      AND e.source_record_id IN (${placeholders(entryIds)})
    GROUP BY e.id
    ORDER BY e.id
  `, entryIds);
  return [...originals, ...reversals];
}

function buildPositionReports(positions, effectiveOperations, ledgerRows, balanceRows) {
  const ledgerByPosition = new Map();
  for (const row of ledgerRows) {
    const id = Number(row.caisse_id);
    if (!ledgerByPosition.has(id)) ledgerByPosition.set(id, []);
    ledgerByPosition.get(id).push(row);
  }
  const cacheByPosition = new Map(balanceRows.map(row => [Number(row.caisse_id), row]));
  const sequenceMismatches = [];

  const reports = positions.map(position => {
    const positionId = Number(position.id);
    const initial = amount(position.solde_initial);
    const relatedOperations = effectiveOperations.filter(operation =>
      Number(operation.position_id) === positionId || Number(operation.position_source_id) === positionId);
    const operationsBalance = amount(relatedOperations.reduce(
      (total, operation) => total + operationDeltaForPosition(operation, positionId),
      initial,
    ));
    const rows = ledgerByPosition.get(positionId) || [];
    let previous = initial;
    for (const row of rows) {
      if (differs(row.solde_avant, previous)) {
        sequenceMismatches.push({
          ledger_id: Number(row.id),
          position_id: positionId,
          expected_solde_avant: previous,
          actual_solde_avant: amount(row.solde_avant),
        });
      }
      const movementExpected = row.type_mouvement === 'credit'
        ? amount(row.solde_avant) + amount(row.montant)
        : row.type_mouvement === 'debit'
          ? amount(row.solde_avant) - amount(row.montant)
          : null;
      if (movementExpected !== null && differs(row.solde_apres, movementExpected)) {
        sequenceMismatches.push({
          ledger_id: Number(row.id),
          position_id: positionId,
          expected_solde_apres: amount(movementExpected),
          actual_solde_apres: amount(row.solde_apres),
        });
      }
      previous = amount(row.solde_apres);
    }
    const ledgerBalance = rows.length ? amount(rows[rows.length - 1].solde_apres) : initial;
    const cache = cacheByPosition.get(positionId) || null;
    const cacheBalance = cache ? amount(cache.solde_courant) : null;
    const operationsLedgerMismatch = differs(operationsBalance, ledgerBalance);
    const operationsCacheMismatch = cache
      ? differs(operationsBalance, cacheBalance)
      : relatedOperations.length > 0;

    return {
      position_id: positionId,
      code: position.code || null,
      libelle: position.libelle || null,
      type: position.type || null,
      solde_initial: initial,
      effective_operations: relatedOperations.length,
      ledger_rows: rows.length,
      operations_balance: operationsBalance,
      ledger_balance: ledgerBalance,
      cached_balance: cacheBalance,
      balance_mismatch: operationsLedgerMismatch || operationsCacheMismatch,
      issues: [
        ...(operationsLedgerMismatch ? ['operations_vs_ledger'] : []),
        ...(operationsCacheMismatch ? [cache ? 'operations_vs_cache' : 'cache_missing'] : []),
      ],
    };
  });

  return { reports, sequenceMismatches };
}

function analyzeLedger(effectiveOperations, allOperationsById, ledgerRows) {
  const ledgerByOperation = new Map();
  for (const row of ledgerRows) {
    if (!row.operation_id) continue;
    const operationId = Number(row.operation_id);
    if (!ledgerByOperation.has(operationId)) ledgerByOperation.set(operationId, []);
    ledgerByOperation.get(operationId).push(row);
  }

  const missing = [];
  const duplicates = [];
  for (const operation of effectiveOperations) {
    const rows = ledgerByOperation.get(Number(operation.id)) || [];
    for (const leg of expectedLedgerLegs(operation)) {
      const matches = rows.filter(row =>
        Number(row.caisse_id) === leg.caisse_id
        && row.type_mouvement === leg.type_mouvement
        && !differs(row.montant, leg.montant));
      if (!matches.length) {
        missing.push({ operation_id: Number(operation.id), type_op: operation.type_op, ...leg });
      } else if (matches.length > 1) {
        duplicates.push({ operation_id: Number(operation.id), type_op: operation.type_op, ...leg, ledger_ids: matches.map(row => Number(row.id)) });
      }
    }
  }

  const orphans = [];
  const invalid = [];
  for (const row of ledgerRows) {
    if (!row.operation_id) continue;
    const operation = allOperationsById.get(Number(row.operation_id));
    if (!operation) {
      orphans.push({ ledger_id: Number(row.id), operation_id: Number(row.operation_id), position_id: Number(row.caisse_id) });
    } else if (!isEffectiveOperation(operation)) {
      invalid.push({ ledger_id: Number(row.id), operation_id: Number(operation.id), operation_status: operation.statut, payment_status: operation.dec_statut || null });
    }
  }
  return { missing, duplicates, orphans, invalid };
}

function analyzeAccounting(allOperations, effectiveOperations, entries) {
  const originalEntries = entries.filter(entry => entry.source_module !== 'accounting_reversal');
  const reversals = entries.filter(entry => entry.source_module === 'accounting_reversal');
  const postedByOperation = new Map();
  for (const entry of originalEntries) {
    if (entry.status !== 'posted') continue;
    postedByOperation.set(`${entry.source_module}:${Number(entry.source_record_id)}`, entry);
  }
  const postedReversalByEntry = new Map(
    reversals.filter(entry => entry.status === 'posted').map(entry => [Number(entry.source_record_id), entry]),
  );

  const missing = [];
  const syncedWithoutPosted = [];
  for (const operation of effectiveOperations) {
    const key = `${SOURCE_BY_TYPE[operation.type_op]}:${Number(operation.id)}`;
    const posted = postedByOperation.get(key);
    if (!posted) {
      missing.push({ operation_id: Number(operation.id), type_op: operation.type_op, accounting_status: operation.accounting_status || null });
    }
    if (operation.accounting_status === 'synced' && !posted) {
      syncedWithoutPosted.push({ operation_id: Number(operation.id), type_op: operation.type_op });
    }
  }

  const unbalanced = entries
    .filter(entry => entry.status === 'posted')
    .filter(entry => Number(entry.line_count || 0) < 2
      || amount(entry.debit) <= 0
      || differs(entry.debit, entry.credit))
    .map(entry => ({
      entry_id: Number(entry.id),
      entry_no: entry.entry_no,
      line_count: Number(entry.line_count || 0),
      debit: amount(entry.debit),
      credit: amount(entry.credit),
    }));

  const cancelledWithoutReversal = [];
  for (const operation of allOperations.filter(row => row.statut === 'annule')) {
    const entry = postedByOperation.get(`${SOURCE_BY_TYPE[operation.type_op]}:${Number(operation.id)}`);
    if (entry && !postedReversalByEntry.has(Number(entry.id))) {
      cancelledWithoutReversal.push({ operation_id: Number(operation.id), accounting_entry_id: Number(entry.id), entry_no: entry.entry_no });
    }
  }

  return { missing, syncedWithoutPosted, unbalanced, cancelledWithoutReversal };
}

async function buildFinanceIntegrityReport(options = {}, dbc = db) {
  const positionIds = normalizeIds(options.positionIds);
  const operationIds = normalizeIds(options.operationIds);
  const positions = await loadPositions(positionIds, dbc);
  const scopedPositionIds = positions.map(row => Number(row.id));
  const operations = await loadOperations(scopedPositionIds, operationIds, dbc);
  const effectiveOperations = operations.filter(isEffectiveOperation);
  const ledgerRows = await loadLedger(scopedPositionIds, operationIds, dbc);
  const balanceRows = await loadBalances(scopedPositionIds, dbc);

  const operationMap = new Map(operations.map(row => [Number(row.id), row]));
  const missingReferencedIds = [...new Set(ledgerRows
    .map(row => Number(row.operation_id || 0))
    .filter(id => id > 0 && !operationMap.has(id)))];
  const referencedOperations = await loadReferencedOperations(missingReferencedIds, dbc);
  for (const operation of referencedOperations) operationMap.set(Number(operation.id), operation);

  const { reports: positionReports, sequenceMismatches } = buildPositionReports(
    positions,
    effectiveOperations,
    ledgerRows,
    balanceRows,
  );
  const ledger = analyzeLedger(effectiveOperations, operationMap, ledgerRows);
  const accountingEntries = await loadAccountingEntries(operations.map(row => Number(row.id)), dbc);
  const accounting = analyzeAccounting(operations, effectiveOperations, accountingEntries);

  const summary = {
    positions_checked: positionReports.length,
    operations_checked: operations.length,
    effective_operations: effectiveOperations.length,
    ledger_rows: ledgerRows.length,
    accounting_entries: accountingEntries.length,
    balance_mismatches: positionReports.filter(row => row.balance_mismatch).length,
    ledger_sequence_mismatches: sequenceMismatches.length,
    operations_missing_ledger: ledger.missing.length,
    duplicate_ledger_legs: ledger.duplicates.length,
    ledger_orphans: ledger.orphans.length,
    ledger_invalid_operations: ledger.invalid.length,
    operations_missing_accounting: accounting.missing.length,
    synced_without_posted: accounting.syncedWithoutPosted.length,
    unbalanced_entries: accounting.unbalanced.length,
    cancelled_operations_without_reversal: accounting.cancelledWithoutReversal.length,
  };
  const critical = Object.entries(summary)
    .filter(([key]) => !['positions_checked', 'operations_checked', 'effective_operations', 'ledger_rows', 'accounting_entries'].includes(key))
    .reduce((total, [, value]) => total + Number(value || 0), 0);

  return {
    ok: critical === 0,
    generated_at: new Date().toISOString(),
    read_only: true,
    scope: {
      position_ids: positionIds,
      operation_ids: operationIds,
    },
    summary,
    positions: positionReports,
    issues: {
      ledger_sequence_mismatches: sequenceMismatches,
      operations_missing_ledger: ledger.missing,
      duplicate_ledger_legs: ledger.duplicates,
      ledger_orphans: ledger.orphans,
      ledger_invalid_operations: ledger.invalid,
      operations_missing_accounting: accounting.missing,
      synced_without_posted: accounting.syncedWithoutPosted,
      unbalanced_entries: accounting.unbalanced,
      cancelled_operations_without_reversal: accounting.cancelledWithoutReversal,
    },
  };
}

module.exports = {
  EPSILON,
  buildFinanceIntegrityReport,
  expectedLedgerLegs,
  isEffectiveOperation,
  operationDeltaForPosition,
};
