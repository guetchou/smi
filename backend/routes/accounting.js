'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const {
  VALID_OPERATION_TYPES,
  AccountingWorkflowError,
  normalizeRuleInput,
  findAccountingMappingForOperation,
  generateAccountingEntryForOperation,
  createAccountingReversal,
  validateAccountingEntry,
  listAccountingAnomalies,
  listAccountingEntryLines,
} = require('../services/accounting');

const router = express.Router();

function canManageAccounting(user) {
  return hasRole(user, 'admin', 'finance', 'dg');
}

function accountingErrorResponse(res, error) {
  if (error instanceof AccountingWorkflowError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
  }
  console.error('[accounting]', error);
  return res.status(500).json({ error: 'Erreur interne du workflow comptable' });
}

router.get('/accounts', async (_req, res) => {
  const rows = await db.query(`
    SELECT id, code, label, account_class, is_active
    FROM accounting_accounts
    WHERE is_active = 1
    ORDER BY code ASC
  `);
  res.json({ rows });
});

router.get('/mapping-rules', async (req, res) => {
  const activeOnly = req.query.active !== '0';
  const rows = await db.query(`
    SELECT r.id, r.operation_type, r.operation_nature, r.payment_method,
           r.position_type, r.third_party_type, r.journal_code, r.is_active,
           r.debit_account_id, da.code as debit_account_code, da.label as debit_account_label,
           r.credit_account_id, ca.code as credit_account_code, ca.label as credit_account_label,
           r.created_at, r.updated_at
    FROM accounting_mapping_rules r
    JOIN accounting_accounts da ON da.id = r.debit_account_id
    JOIN accounting_accounts ca ON ca.id = r.credit_account_id
    ${activeOnly ? 'WHERE r.is_active = 1' : ''}
    ORDER BY r.operation_type, r.operation_nature, r.payment_method, r.position_type, r.third_party_type
  `);
  res.json({ rows });
});

router.post('/mapping-rules', async (req, res) => {
  if (!canManageAccounting(req.user)) return res.status(403).json({ error: 'Paramétrage comptable réservé à Admin, Finance ou DG' });
  const rule = normalizeRuleInput(req.body);

  if (!VALID_OPERATION_TYPES.includes(rule.operation_type)) {
    return res.status(400).json({ error: 'Type opération invalide' });
  }
  if (!rule.journal_code) return res.status(400).json({ error: 'Journal comptable requis' });
  if (!rule.debit_account_id || !rule.credit_account_id) return res.status(400).json({ error: 'Comptes débit et crédit requis' });
  if (rule.debit_account_id === rule.credit_account_id) return res.status(400).json({ error: 'Compte débit et crédit doivent être différents' });

  const accounts = await db.query(`
    SELECT id FROM accounting_accounts
    WHERE is_active = 1 AND id IN (?, ?)
  `, [rule.debit_account_id, rule.credit_account_id]);
  if (accounts.length !== 2) return res.status(400).json({ error: 'Compte OHADA introuvable ou inactif' });

  try {
    const result = await db.execute(`
      INSERT INTO accounting_mapping_rules
        (operation_type, operation_nature, payment_method, position_type, third_party_type,
         debit_account_id, credit_account_id, journal_code, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      rule.operation_type, rule.operation_nature, rule.payment_method, rule.position_type, rule.third_party_type,
      rule.debit_account_id, rule.credit_account_id, rule.journal_code, rule.is_active,
    ]);
    const created = await db.queryOne('SELECT * FROM accounting_mapping_rules WHERE id = ?', [result.insertId]);
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || /UNIQUE constraint failed/i.test(e.message || '')) {
      return res.status(409).json({ error: 'Règle de mapping comptable déjà existante pour ces critères' });
    }
    throw e;
  }
});

router.patch('/mapping-rules/:id/status', async (req, res) => {
  if (!canManageAccounting(req.user)) {
    return res.status(403).json({ error: 'Paramétrage comptable réservé à Admin, Finance ou DG' });
  }
  const isActive = req.body?.is_active === true || req.body?.is_active === 1 ? 1 : 0;
  if (isActive && req.body?.confirmed !== true) {
    return res.status(400).json({ error: 'Confirmation explicite requise pour activer une règle comptable' });
  }
  const rule = await db.queryOne(`
    SELECT r.*, da.is_active as debit_active, ca.is_active as credit_active
    FROM accounting_mapping_rules r
    JOIN accounting_accounts da ON da.id = r.debit_account_id
    JOIN accounting_accounts ca ON ca.id = r.credit_account_id
    WHERE r.id = ?
  `, [req.params.id]);
  if (!rule) return res.status(404).json({ error: 'Règle comptable introuvable' });
  if (isActive && (!Number(rule.debit_active) || !Number(rule.credit_active))) {
    return res.status(422).json({ error: 'Activation impossible : un compte OHADA est inactif' });
  }
  if (Number(rule.debit_account_id) === Number(rule.credit_account_id)) {
    return res.status(422).json({ error: 'Activation impossible : comptes débit et crédit identiques' });
  }

  await db.transaction(async tx => {
    await tx.execute(
      'UPDATE accounting_mapping_rules SET is_active = ?, updated_at = NOW() WHERE id = ?',
      [isActive, rule.id]
    );
    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('accounting_mapping_rules', ?, ?, ?, ?)
    `, [
      rule.id,
      isActive ? 'accounting_mapping_activated' : 'accounting_mapping_deactivated',
      JSON.stringify({
        operation_type: rule.operation_type,
        operation_nature: rule.operation_nature,
        payment_method: rule.payment_method,
        position_type: rule.position_type,
        third_party_type: rule.third_party_type,
      }),
      req.user.id,
    ]);
  });

  const updated = await db.queryOne('SELECT * FROM accounting_mapping_rules WHERE id = ?', [rule.id]);
  res.json(updated);
});

router.get('/mapping-rules/for-operation/:id', async (req, res) => {
  const op = await db.queryOne(`
    SELECT o.*, p.type as position_type, c.type as categorie_type
    FROM operations o
    LEFT JOIN positions p ON p.id = o.position_id
    LEFT JOIN categories c ON c.id = o.categorie_id
    WHERE o.id = ?
  `, [req.params.id]);
  if (!op) return res.status(404).json({ error: 'Opération introuvable' });

  const rule = await findAccountingMappingForOperation(op);
  if (!rule) {
    return res.status(404).json({
      error: 'Aucune règle de mapping comptable OHADA ne couvre cette opération',
      operation_id: op.id,
      accounting_status: op.accounting_status || 'pending',
    });
  }
  res.json({ operation_id: op.id, rule });
});

router.get('/entries', async (req, res) => {
  const rows = await listAccountingEntryLines({
    debut: req.query.debut,
    fin: req.query.fin,
    journal_code: req.query.journal_code,
    source_module: req.query.source_module,
    status: req.query.status || 'posted',
    limit: req.query.limit,
  });

  const totals = rows.reduce((acc, row) => {
    acc.debit += Number(row.debit || 0);
    acc.credit += Number(row.credit || 0);
    return acc;
  }, { debit: 0, credit: 0 });

  res.json({ rows, totals, balanced: Math.abs(totals.debit - totals.credit) < 0.01 });
});

router.post('/entries/generate', async (req, res) => {
  if (!canManageAccounting(req.user)) {
    return res.status(403).json({ error: 'Génération comptable réservée à Admin, Finance ou DG' });
  }
  const operationId = Number(req.body?.operation_id || 0);
  if (!operationId) return res.status(400).json({ error: 'Opération source requise' });
  try {
    const result = await generateAccountingEntryForOperation({ operationId, userId: req.user.id });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    accountingErrorResponse(res, error);
  }
});

router.post('/entries/:id/validate', async (req, res) => {
  if (!canManageAccounting(req.user)) {
    return res.status(403).json({ error: 'Validation comptable réservée à Admin, Finance ou DG' });
  }
  try {
    const result = await validateAccountingEntry({
      entryId: Number(req.params.id),
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    accountingErrorResponse(res, error);
  }
});

router.post('/entries/:id/reverse', async (req, res) => {
  if (!canManageAccounting(req.user)) {
    return res.status(403).json({ error: 'Contre-écriture réservée à Admin, Finance ou DG' });
  }
  try {
    const result = await createAccountingReversal({
      entryId: Number(req.params.id),
      userId: req.user.id,
      reversalDate: req.body?.date,
      reason: req.body?.reason,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    accountingErrorResponse(res, error);
  }
});

router.get('/anomalies', async (req, res) => {
  try {
    res.json(await listAccountingAnomalies({
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (error) {
    accountingErrorResponse(res, error);
  }
});

module.exports = router;
