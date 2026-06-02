'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const {
  VALID_OPERATION_TYPES,
  normalizeRuleInput,
  findAccountingMappingForOperation,
  listAccountingEntryLines,
} = require('../services/accounting');

const router = express.Router();

function canManageAccounting(user) {
  return hasRole(user, 'admin', 'finance', 'dg');
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

module.exports = router;
