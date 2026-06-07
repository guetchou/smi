'use strict';

const db = require('../db');

const VALID_OPERATION_TYPES = ['encaissement', 'decaissement', 'virement'];
const WILDCARD = '*';
const ACCOUNTING_ERROR_PREFIX = 'ACCOUNTING_';
const SOURCE_MODULE_BY_OPERATION_TYPE = {
  encaissement: 'cash_receipt',
  decaissement: 'cash_disbursement',
  virement: 'internal_transfer',
};
const OPERATION_SOURCE_MODULES = new Set(Object.values(SOURCE_MODULE_BY_OPERATION_TYPE));
const REVERSAL_SOURCE_MODULE = 'accounting_reversal';

class AccountingWorkflowError extends Error {
  constructor(code, message, status = 422, details = {}) {
    super(message);
    this.name = 'AccountingWorkflowError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeRuleInput(body = {}) {
  return {
    operation_type: String(body.operation_type || '').trim(),
    operation_nature: String(body.operation_nature || WILDCARD).trim() || WILDCARD,
    payment_method: String(body.payment_method || WILDCARD).trim() || WILDCARD,
    position_type: String(body.position_type || WILDCARD).trim() || WILDCARD,
    third_party_type: String(body.third_party_type || WILDCARD).trim() || WILDCARD,
    debit_account_id: Number(body.debit_account_id || 0),
    credit_account_id: Number(body.credit_account_id || 0),
    journal_code: String(body.journal_code || '').trim().toUpperCase(),
    is_active: body.is_active === true || body.is_active === 1 || body.is_active === '1' ? 1 : 0,
  };
}

function operationThirdPartyType(operation) {
  if (operation?.employe_id) return 'agent';
  if (String(operation?.tiers || '').trim()) return 'tiers';
  return WILDCARD;
}

function accountingCriteriaForOperation(operation) {
  return {
    operation_type: operation?.type_op || '',
    operation_nature: operation?.categorie_id ? String(operation.categorie_id) : WILDCARD,
    payment_method: operation?.mode_reglement || WILDCARD,
    position_type: operation?.position_type || WILDCARD,
    third_party_type: operationThirdPartyType(operation),
  };
}

function ruleMatchesCriteria(rule, criteria) {
  return rule.operation_type === criteria.operation_type
    && [criteria.operation_nature, WILDCARD].includes(String(rule.operation_nature))
    && [criteria.payment_method, WILDCARD].includes(String(rule.payment_method))
    && [criteria.position_type, WILDCARD].includes(String(rule.position_type))
    && [criteria.third_party_type, WILDCARD].includes(String(rule.third_party_type));
}

function mappingSpecificity(rule, criteria) {
  return [
    ['operation_nature', criteria.operation_nature],
    ['payment_method', criteria.payment_method],
    ['position_type', criteria.position_type],
    ['third_party_type', criteria.third_party_type],
  ].reduce((score, [key, value]) => score + (String(rule[key]) === String(value) ? 1 : 0), 0);
}

function selectAccountingMapping(operation, rules = []) {
  const criteria = accountingCriteriaForOperation(operation);
  return rules
    .filter(rule => Number(rule.is_active) === 1 && ruleMatchesCriteria(rule, criteria))
    .sort((a, b) => mappingSpecificity(b, criteria) - mappingSpecificity(a, criteria) || Number(a.id) - Number(b.id))[0] || null;
}

async function listActiveAccountingMappings(dbc = db) {
  return dbc.query(`
    SELECT r.*,
           da.code as debit_account_code, da.label as debit_account_label,
           ca.code as credit_account_code, ca.label as credit_account_label
    FROM accounting_mapping_rules r
    JOIN accounting_accounts da ON da.id = r.debit_account_id AND da.is_active = 1
    JOIN accounting_accounts ca ON ca.id = r.credit_account_id AND ca.is_active = 1
    WHERE r.is_active = 1
    ORDER BY r.operation_type, r.id ASC
  `);
}

async function findAccountingMappingForOperation(operation, dbc = db) {
  if (!operation || !VALID_OPERATION_TYPES.includes(operation.type_op)) return null;
  const rules = await listActiveAccountingMappings(dbc);
  return selectAccountingMapping(operation, rules);
}

async function getOperationForAccounting(operationId, dbc = db) {
  return dbc.queryOne(`
    SELECT o.*, p.type as position_type, p.code as position_code,
           ps.type as source_position_type, ps.code as source_position_code,
           c.nom as categorie_nom, c.type as categorie_type
    FROM operations o
    LEFT JOIN positions p ON p.id = o.position_id
    LEFT JOIN positions ps ON ps.id = o.position_source_id
    LEFT JOIN categories c ON c.id = o.categorie_id
    WHERE o.id = ?
  `, [operationId]);
}

function assertOperationEligible(operation) {
  if (!operation) {
    throw new AccountingWorkflowError('ACCOUNTING_OPERATION_NOT_FOUND', 'Opération introuvable', 404);
  }
  if (!VALID_OPERATION_TYPES.includes(operation.type_op)) {
    throw new AccountingWorkflowError('ACCOUNTING_OPERATION_TYPE_INVALID', 'Type d’opération non comptabilisable', 422);
  }
  if (operation.statut !== 'valide') {
    throw new AccountingWorkflowError('ACCOUNTING_OPERATION_NOT_VALIDATED', 'L’opération doit être validée avant comptabilisation', 409);
  }
  if (operation.type_op === 'decaissement' && operation.dec_statut !== 'paye') {
    throw new AccountingWorkflowError('ACCOUNTING_DISBURSEMENT_NOT_PAID', 'Le décaissement doit être payé avant comptabilisation', 409);
  }
  if (!Number.isFinite(Number(operation.montant)) || Number(operation.montant) <= 0) {
    throw new AccountingWorkflowError('ACCOUNTING_AMOUNT_INVALID', 'Le montant comptable doit être strictement positif', 422);
  }
}

async function assertAccountingPeriodOpen(date, dbc = db) {
  if (!date) {
    throw new AccountingWorkflowError('ACCOUNTING_DATE_MISSING', 'Date comptable manquante', 422);
  }
  const parsed = new Date(`${String(date).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AccountingWorkflowError('ACCOUNTING_DATE_INVALID', 'Date comptable invalide', 422);
  }
  const closed = await dbc.queryOne(
    'SELECT 1 AS found FROM periodes_cloturees WHERE annee = ? AND mois = ? LIMIT 1',
    [parsed.getFullYear(), parsed.getMonth() + 1]
  );
  if (closed) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_PERIOD_CLOSED',
      `Période ${String(date).slice(0, 7)} clôturée : comptabilisation interdite`,
      409
    );
  }
}

async function auditAccounting(tableName, recordId, action, details, userId, dbc = db) {
  await dbc.execute(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
    VALUES (?, ?, ?, ?, ?)
  `, [tableName, recordId, action, details ? JSON.stringify(details) : null, userId || null]);
}

async function ensureAccountingSyncError(operationId, errorType, errorMessage, details, dbc = db) {
  const existing = await dbc.queryOne(`
    SELECT id
    FROM sync_errors
    WHERE source_module = 'operations'
      AND source_record_id = ?
      AND error_type = ?
      AND status = 'open'
    LIMIT 1
  `, [operationId, errorType]);
  if (existing) return existing.id;

  const result = await dbc.execute(`
    INSERT INTO sync_errors
      (source_module, source_record_id, error_type, error_message, technical_details, status, created_at, updated_at)
    VALUES
      ('operations', ?, ?, ?, ?, 'open', NOW(), NOW())
  `, [operationId, errorType, errorMessage, details ? JSON.stringify(details) : null]);
  return result.insertId;
}

async function resolveAccountingSyncErrors(operationId, userId, dbc = db) {
  await dbc.execute(`
    UPDATE sync_errors
    SET status = 'resolved', resolved_by = ?, resolved_at = NOW(), updated_at = NOW()
    WHERE source_module = 'operations'
      AND source_record_id = ?
      AND error_type LIKE 'ACCOUNTING_%'
      AND status = 'open'
  `, [userId || null, operationId]);
}

async function markAccountingFailure(operationId, error, userId, dbc = db) {
  if (!operationId || !error?.code?.startsWith(ACCOUNTING_ERROR_PREFIX)) return;
  const details = { code: error.code, ...(error.details || {}) };
  await dbc.execute(`
    UPDATE operations
    SET accounting_status = 'error', updated_at = NOW()
    WHERE id = ? AND statut != 'annule'
  `, [operationId]);
  await resolveAccountingSyncErrors(operationId, userId, dbc);
  await ensureAccountingSyncError(operationId, error.code, error.message, details, dbc);
  await auditAccounting('operations', operationId, 'accounting_generation_failed', details, userId, dbc);
}

function entryNumberForOperation(rule, operation) {
  const source = SOURCE_MODULE_BY_OPERATION_TYPE[operation.type_op] || 'operation';
  const sourceCode = {
    cash_receipt: 'ENC',
    cash_disbursement: 'DEC',
    internal_transfer: 'VIR',
  }[source] || 'OP';
  return `${rule.journal_code}-${sourceCode}-${String(operation.id).padStart(8, '0')}`;
}

function entryLinePositions(operation) {
  if (operation.type_op === 'encaissement') {
    return { debit: operation.position_id || null, credit: null };
  }
  if (operation.type_op === 'decaissement') {
    return { debit: null, credit: operation.position_id || null };
  }
  return {
    debit: operation.position_id || null,
    credit: operation.position_source_id || null,
  };
}

async function loadAccountingEntry(entryId, dbc = db) {
  const entry = await dbc.queryOne('SELECT * FROM accounting_entries WHERE id = ?', [entryId]);
  if (!entry) return null;
  entry.lines = await dbc.query(`
    SELECT l.*, a.code as account_code, a.label as account_label
    FROM accounting_entry_lines l
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.entry_id = ?
    ORDER BY l.id ASC
  `, [entryId]);
  return entry;
}

async function accountingOperationContext(entry, dbc = db) {
  if (!entry) return null;
  let sourceEntry = entry;
  if (entry.source_module === REVERSAL_SOURCE_MODULE) {
    sourceEntry = await dbc.queryOne(
      'SELECT * FROM accounting_entries WHERE id = ?',
      [entry.source_record_id]
    );
  }
  if (!sourceEntry || !OPERATION_SOURCE_MODULES.has(sourceEntry.source_module)) return null;
  return {
    operationId: Number(sourceEntry.source_record_id),
    sourceEntry,
  };
}

function localIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeReversalInput({ reversalDate, reason }) {
  const date = String(reversalDate || localIsoDate()).trim();
  const normalizedReason = String(reason || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AccountingWorkflowError('ACCOUNTING_REVERSAL_DATE_INVALID', 'Date de contre-écriture invalide', 422);
  }
  if (normalizedReason.length < 5) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_REVERSAL_REASON_REQUIRED',
      'Le motif de contre-écriture doit contenir au moins 5 caractères',
      422
    );
  }
  return { reversalDate: date, reason: normalizedReason };
}

async function createAccountingReversalInContext({ entryId, userId, reversalDate, reason }, dbc) {
  const input = normalizeReversalInput({ reversalDate, reason });
  const original = await loadAccountingEntry(entryId, dbc);
  if (!original) {
    throw new AccountingWorkflowError('ACCOUNTING_ENTRY_NOT_FOUND', 'Écriture comptable introuvable', 404);
  }
  if (original.status !== 'posted') {
    throw new AccountingWorkflowError(
      'ACCOUNTING_REVERSAL_REQUIRES_POSTED_ENTRY',
      'Seule une écriture comptabilisée peut être contrepassée',
      409
    );
  }
  if (original.source_module === REVERSAL_SOURCE_MODULE) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_REVERSAL_OF_REVERSAL_FORBIDDEN',
      'Une contre-écriture ne peut pas être contrepassée directement',
      409
    );
  }
  if (input.reversalDate < String(original.entry_date).slice(0, 10)) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_REVERSAL_DATE_BEFORE_ORIGINAL',
      'La date de contre-écriture ne peut pas précéder l’écriture d’origine',
      422
    );
  }

  const existing = await dbc.queryOne(`
    SELECT *
    FROM accounting_entries
    WHERE source_module = ?
      AND source_record_id = ?
      AND status IN ('posted', 'draft')
    ORDER BY CASE status WHEN 'posted' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, [REVERSAL_SOURCE_MODULE, original.id]);
  if (existing) {
    return { entry: await loadAccountingEntry(existing.id, dbc), created: false };
  }

  await assertAccountingPeriodOpen(input.reversalDate, dbc);
  const entryNo = `AN-${String(original.id).padStart(8, '0')}`;
  const label = `Contre-écriture ${original.entry_no} — ${input.reason}`.slice(0, 255);
  const result = await dbc.execute(`
    INSERT INTO accounting_entries
      (entry_no, entry_date, journal_code, source_module, source_record_id, label, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `, [
    entryNo,
    input.reversalDate,
    original.journal_code,
    REVERSAL_SOURCE_MODULE,
    original.id,
    label,
    userId || null,
  ]);

  for (const line of original.lines) {
    await dbc.execute(`
      INSERT INTO accounting_entry_lines
        (entry_id, account_id, third_party_id, debit, credit, label, position_id, budget_line_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      result.insertId,
      line.account_id,
      line.third_party_id || null,
      Number(line.credit || 0),
      Number(line.debit || 0),
      label,
      line.position_id || null,
      line.budget_line_id || null,
    ]);
  }

  await auditAccounting('accounting_entries', result.insertId, 'accounting_reversal_generated', {
    original_entry_id: original.id,
    original_entry_no: original.entry_no,
    reason: input.reason,
    reversal_date: input.reversalDate,
  }, userId, dbc);

  return { entry: await loadAccountingEntry(result.insertId, dbc), created: true };
}

async function createAccountingReversal({ entryId, userId, reversalDate, reason }, dbc = db) {
  if (dbc === db) {
    return db.transaction(tx => createAccountingReversalInContext({
      entryId,
      userId,
      reversalDate,
      reason,
    }, tx));
  }
  return createAccountingReversalInContext({ entryId, userId, reversalDate, reason }, dbc);
}

async function generateAccountingEntryInContext({ operationId, userId }, dbc) {
  const operation = await getOperationForAccounting(operationId, dbc);
  assertOperationEligible(operation);

  const sourceModule = SOURCE_MODULE_BY_OPERATION_TYPE[operation.type_op];
  const existing = await dbc.queryOne(`
    SELECT *
    FROM accounting_entries
    WHERE source_module = ? AND source_record_id = ?
      AND status IN ('posted', 'draft')
    ORDER BY CASE status WHEN 'posted' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, [sourceModule, operation.id]);

  if (existing) {
    if (existing.status === 'posted') {
      const postedReversal = await dbc.queryOne(`
        SELECT id
        FROM accounting_entries
        WHERE source_module = ?
          AND source_record_id = ?
          AND status = 'posted'
        LIMIT 1
      `, [REVERSAL_SOURCE_MODULE, existing.id]);
      await dbc.execute(
        'UPDATE operations SET accounting_status = ?, updated_at = NOW() WHERE id = ?',
        [postedReversal ? 'cancelled' : 'synced', operation.id]
      );
      await resolveAccountingSyncErrors(operation.id, userId, dbc);
    }
    return { entry: await loadAccountingEntry(existing.id, dbc), created: false };
  }

  await assertAccountingPeriodOpen(operation.date, dbc);
  const rule = await findAccountingMappingForOperation(operation, dbc);
  if (!rule) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_MAPPING_MISSING',
      'Aucune règle comptable active ne couvre cette opération',
      422,
      accountingCriteriaForOperation(operation)
    );
  }
  if (Number(rule.debit_account_id) === Number(rule.credit_account_id)) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_MAPPING_INVALID',
      'La règle comptable utilise le même compte au débit et au crédit',
      422,
      { mapping_rule_id: rule.id }
    );
  }

  const amount = Number(Number(operation.montant).toFixed(2));
  const entryNo = entryNumberForOperation(rule, operation);
  const label = String(operation.libelle || operation.num_piece || `Opération ${operation.id}`).trim();
  const result = await dbc.execute(`
    INSERT INTO accounting_entries
      (entry_no, entry_date, journal_code, source_module, source_record_id, label, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `, [entryNo, operation.date, rule.journal_code, sourceModule, operation.id, label, userId || null]);

  const positions = entryLinePositions(operation);
  await dbc.execute(`
    INSERT INTO accounting_entry_lines
      (entry_id, account_id, debit, credit, label, position_id)
    VALUES (?, ?, ?, 0, ?, ?)
  `, [result.insertId, rule.debit_account_id, amount, label, positions.debit]);
  await dbc.execute(`
    INSERT INTO accounting_entry_lines
      (entry_id, account_id, debit, credit, label, position_id)
    VALUES (?, ?, 0, ?, ?, ?)
  `, [result.insertId, rule.credit_account_id, amount, label, positions.credit]);

  await dbc.execute(`
    UPDATE operations
    SET accounting_status = 'pending', updated_at = NOW()
    WHERE id = ?
  `, [operation.id]);
  await resolveAccountingSyncErrors(operation.id, userId, dbc);
  await ensureAccountingSyncError(
    operation.id,
    'ACCOUNTING_SYNC_PENDING',
    'Écriture comptable générée en brouillon et en attente de validation',
    { accounting_entry_id: result.insertId, mapping_rule_id: rule.id },
    dbc
  );
  await auditAccounting('accounting_entries', result.insertId, 'accounting_entry_generated', {
    operation_id: operation.id,
    mapping_rule_id: rule.id,
    debit_account_id: rule.debit_account_id,
    credit_account_id: rule.credit_account_id,
    amount,
  }, userId, dbc);

  return { entry: await loadAccountingEntry(result.insertId, dbc), created: true };
}

async function generateAccountingEntryForOperation({ operationId, userId }, dbc = db) {
  try {
    if (dbc === db) {
      return await db.transaction(tx => generateAccountingEntryInContext({ operationId, userId }, tx));
    }
    return await generateAccountingEntryInContext({ operationId, userId }, dbc);
  } catch (error) {
    if (error instanceof AccountingWorkflowError
      && !['ACCOUNTING_OPERATION_NOT_FOUND', 'ACCOUNTING_OPERATION_NOT_VALIDATED', 'ACCOUNTING_DISBURSEMENT_NOT_PAID'].includes(error.code)) {
      const record = async tx => markAccountingFailure(operationId, error, userId, tx);
      if (dbc === db) await db.transaction(record);
      else await record(dbc);
    }
    throw error;
  }
}

async function attemptAutomaticAccountingForOperation({ operationId, userId }, dbc = db) {
  try {
    return await generateAccountingEntryForOperation({ operationId, userId }, dbc);
  } catch (error) {
    if (!(error instanceof AccountingWorkflowError)) {
      console.error(`[accounting] génération opération ${operationId}:`, error.message);
    }
    return { entry: null, created: false, error: error.code || 'ACCOUNTING_GENERATION_FAILED' };
  }
}

async function validateAccountingEntryInContext({ entryId, userId }, dbc) {
  const entry = await dbc.queryOne('SELECT * FROM accounting_entries WHERE id = ?', [entryId]);
  if (!entry) {
    throw new AccountingWorkflowError('ACCOUNTING_ENTRY_NOT_FOUND', 'Écriture comptable introuvable', 404);
  }
  if (entry.status === 'cancelled') {
    throw new AccountingWorkflowError('ACCOUNTING_ENTRY_CANCELLED', 'Une écriture annulée ne peut pas être validée', 409);
  }
  const operationContext = await accountingOperationContext(entry, dbc);
  if (entry.status === 'posted') {
    if (operationContext) {
      const accountingStatus = entry.source_module === REVERSAL_SOURCE_MODULE ? 'cancelled' : 'synced';
      await dbc.execute(
        'UPDATE operations SET accounting_status = ?, updated_at = NOW() WHERE id = ?',
        [accountingStatus, operationContext.operationId]
      );
      await resolveAccountingSyncErrors(operationContext.operationId, userId, dbc);
    }
    return { entry: await loadAccountingEntry(entry.id, dbc), validated: false };
  }

  await assertAccountingPeriodOpen(entry.entry_date, dbc);
  const totals = await dbc.queryOne(`
    SELECT COUNT(*) as line_count,
           COALESCE(SUM(debit), 0) as debit,
           COALESCE(SUM(credit), 0) as credit
    FROM accounting_entry_lines
    WHERE entry_id = ?
  `, [entry.id]);
  const debit = Number(totals?.debit || 0);
  const credit = Number(totals?.credit || 0);
  if (Number(totals?.line_count || 0) < 2 || debit <= 0 || Math.abs(debit - credit) >= 0.01) {
    throw new AccountingWorkflowError(
      'ACCOUNTING_ENTRY_UNBALANCED',
      'Validation refusée : l’écriture comptable doit contenir au moins deux lignes et être équilibrée',
      422,
      { debit, credit, line_count: Number(totals?.line_count || 0) }
    );
  }

  const updated = await dbc.execute(`
    UPDATE accounting_entries
    SET status = 'posted', validated_by = ?, updated_at = NOW()
    WHERE id = ? AND status = 'draft'
  `, [userId || null, entry.id]);
  if (updated.affectedRows !== 1) {
    const current = await dbc.queryOne('SELECT status FROM accounting_entries WHERE id = ?', [entry.id]);
    if (current?.status !== 'posted') {
      throw new AccountingWorkflowError('ACCOUNTING_ENTRY_CONFLICT', 'Écriture modifiée par un autre utilisateur', 409);
    }
  }

  if (operationContext) {
    const accountingStatus = entry.source_module === REVERSAL_SOURCE_MODULE ? 'cancelled' : 'synced';
    await dbc.execute(`
      UPDATE operations
      SET accounting_status = ?, updated_at = NOW()
      WHERE id = ? AND statut != 'annule'
    `, [accountingStatus, operationContext.operationId]);
    await resolveAccountingSyncErrors(operationContext.operationId, userId, dbc);
  }
  await auditAccounting('accounting_entries', entry.id, 'accounting_entry_posted', {
    source_module: entry.source_module,
    source_record_id: entry.source_record_id,
    debit,
    credit,
  }, userId, dbc);
  if (operationContext) {
    await auditAccounting(
      'operations',
      operationContext.operationId,
      entry.source_module === REVERSAL_SOURCE_MODULE
        ? 'accounting_status_cancelled'
        : 'accounting_status_synced',
      {
        accounting_entry_id: entry.id,
        original_entry_id: entry.source_module === REVERSAL_SOURCE_MODULE
          ? entry.source_record_id
          : entry.id,
      },
      userId,
      dbc
    );
  }

  return { entry: await loadAccountingEntry(entry.id, dbc), validated: true };
}

async function validateAccountingEntry({ entryId, userId }, dbc = db) {
  try {
    if (dbc === db) {
      return await db.transaction(tx => validateAccountingEntryInContext({ entryId, userId }, tx));
    }
    return await validateAccountingEntryInContext({ entryId, userId }, dbc);
  } catch (error) {
    if (error instanceof AccountingWorkflowError
      && ['ACCOUNTING_ENTRY_UNBALANCED', 'ACCOUNTING_PERIOD_CLOSED'].includes(error.code)) {
      const entry = await dbc.queryOne('SELECT * FROM accounting_entries WHERE id = ?', [entryId]);
      const operationContext = entry?.source_module === REVERSAL_SOURCE_MODULE
        ? null
        : await accountingOperationContext(entry, dbc);
      if (operationContext?.operationId) {
        const record = async tx => markAccountingFailure(operationContext.operationId, error, userId, tx);
        if (dbc === db) await db.transaction(record);
        else await record(dbc);
      }
    }
    throw error;
  }
}

async function listAccountingAnomalies(filters = {}, dbc = db) {
  const limit = Math.min(Math.max(Number(filters.limit) || 250, 1), 1000);
  const operations = await dbc.query(`
    SELECT o.id, o.date, o.num_piece, o.libelle, o.tiers, o.montant, o.type_op,
           o.position_id, o.position_source_id, o.categorie_id, o.mode_reglement,
           o.employe_id, o.statut, o.dec_statut, o.accounting_status,
           p.code as position_code, p.libelle as position_libelle, p.type as position_type,
           c.nom as categorie_nom,
           e.id as entry_id, e.entry_no, e.status as entry_status,
           se.error_type, se.error_message, se.created_at as error_created_at
    FROM operations o
    LEFT JOIN positions p ON p.id = o.position_id
    LEFT JOIN categories c ON c.id = o.categorie_id
    LEFT JOIN accounting_entries e ON e.id = (
      SELECT e2.id
      FROM accounting_entries e2
      WHERE e2.source_module = CASE o.type_op
          WHEN 'encaissement' THEN 'cash_receipt'
          WHEN 'decaissement' THEN 'cash_disbursement'
          WHEN 'virement' THEN 'internal_transfer'
        END
        AND e2.source_record_id = o.id
        AND e2.status IN ('posted', 'draft')
      ORDER BY CASE e2.status WHEN 'posted' THEN 0 ELSE 1 END, e2.id ASC
      LIMIT 1
    )
    LEFT JOIN sync_errors se ON se.id = (
      SELECT se2.id
      FROM sync_errors se2
      WHERE se2.source_module = 'operations'
        AND se2.source_record_id = o.id
        AND se2.error_type LIKE 'ACCOUNTING_%'
        AND se2.status = 'open'
      ORDER BY se2.created_at DESC, se2.id DESC
      LIMIT 1
    )
    WHERE o.statut = 'valide'
      AND (o.type_op != 'decaissement' OR o.dec_statut = 'paye')
      AND COALESCE(o.accounting_status, 'pending') IN ('pending', 'error')
    ORDER BY o.date DESC, o.id DESC
    LIMIT ?
  `, [limit]);

  const rules = await listActiveAccountingMappings(dbc);
  const rows = operations.map(operation => {
    const rule = selectAccountingMapping(operation, rules);
    let anomalyCode = 'ACCOUNTING_READY_TO_GENERATE';
    let anomalyLabel = 'Prête à générer';
    if (operation.entry_status === 'draft') {
      anomalyCode = 'ACCOUNTING_ENTRY_DRAFT';
      anomalyLabel = 'Brouillon à valider';
    } else if (!rule) {
      anomalyCode = 'ACCOUNTING_MAPPING_MISSING';
      anomalyLabel = 'Mapping requis';
    } else if (operation.error_type) {
      anomalyCode = operation.error_type;
      anomalyLabel = operation.error_message || 'Anomalie comptable';
    }
    return {
      ...operation,
      third_party_type: operationThirdPartyType(operation),
      mapping_rule_id: rule?.id || null,
      debit_account_code: rule?.debit_account_code || null,
      credit_account_code: rule?.credit_account_code || null,
      journal_code: rule?.journal_code || null,
      anomaly_code: anomalyCode,
      anomaly_label: anomalyLabel,
    };
  });

  const summary = rows.reduce((acc, row) => {
    acc.total += 1;
    if (row.entry_status === 'draft') acc.drafts += 1;
    else if (!row.mapping_rule_id) acc.missing_mapping += 1;
    else acc.ready += 1;
    return acc;
  }, { total: 0, drafts: 0, missing_mapping: 0, ready: 0 });

  return { rows, summary, limit };
}

async function listAccountingEntryLines(filters = {}, dbc = db) {
  const where = [];
  const params = [];

  if (filters.debut) {
    where.push('e.entry_date >= ?');
    params.push(filters.debut);
  }
  if (filters.fin) {
    where.push('e.entry_date <= ?');
    params.push(filters.fin);
  }
  if (filters.journal_code) {
    where.push('e.journal_code = ?');
    params.push(String(filters.journal_code).trim().toUpperCase());
  }
  if (filters.source_module) {
    where.push('e.source_module = ?');
    params.push(String(filters.source_module).trim());
  }
  if (filters.status) {
    where.push('e.status = ?');
    params.push(String(filters.status).trim());
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), 2000);
  params.push(limit);

  return dbc.query(`
    WITH filtered_entries AS (
      SELECT e.*
      FROM accounting_entries e
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.entry_date ASC, e.entry_no ASC
      LIMIT ?
    )
    SELECT e.id as entry_id, e.entry_no, e.entry_date, e.journal_code,
           e.source_module, e.source_record_id, e.label as entry_label,
           e.status,
           (
             SELECT r.id FROM accounting_entries r
             WHERE r.source_module = '${REVERSAL_SOURCE_MODULE}'
               AND r.source_record_id = e.id
               AND r.status IN ('posted', 'draft')
             ORDER BY CASE r.status WHEN 'posted' THEN 0 ELSE 1 END, r.id ASC
             LIMIT 1
           ) as reversal_entry_id,
           (
             SELECT r.status FROM accounting_entries r
             WHERE r.source_module = '${REVERSAL_SOURCE_MODULE}'
               AND r.source_record_id = e.id
               AND r.status IN ('posted', 'draft')
             ORDER BY CASE r.status WHEN 'posted' THEN 0 ELSE 1 END, r.id ASC
             LIMIT 1
           ) as reversal_status,
           l.id as line_id, l.third_party_id, l.debit, l.credit,
           l.label as line_label, l.position_id, l.budget_line_id,
           a.id as account_id, a.code as account_code, a.label as account_label
    FROM filtered_entries e
    JOIN accounting_entry_lines l ON l.entry_id = e.id
    JOIN accounting_accounts a ON a.id = l.account_id
    ORDER BY e.entry_date ASC, e.entry_no ASC, l.id ASC
  `, params);
}

module.exports = {
  VALID_OPERATION_TYPES,
  WILDCARD,
  AccountingWorkflowError,
  normalizeRuleInput,
  accountingCriteriaForOperation,
  selectAccountingMapping,
  findAccountingMappingForOperation,
  generateAccountingEntryForOperation,
  attemptAutomaticAccountingForOperation,
  createAccountingReversal,
  validateAccountingEntry,
  listAccountingAnomalies,
  listAccountingEntryLines,
};
