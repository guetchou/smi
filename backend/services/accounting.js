'use strict';

const db = require('../db');

const VALID_OPERATION_TYPES = ['encaissement', 'decaissement', 'virement'];
const WILDCARD = '*';

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
    is_active: body.is_active === false || body.is_active === 0 ? 0 : 1,
  };
}

async function findAccountingMappingForOperation(operation, dbc = db) {
  if (!operation) return null;
  const typeOp = operation.type_op;
  if (!VALID_OPERATION_TYPES.includes(typeOp)) return null;

  const nature = operation.categorie_id ? String(operation.categorie_id) : WILDCARD;
  const paymentMethod = operation.mode_reglement || WILDCARD;
  const positionType = operation.position_type || WILDCARD;
  const thirdPartyType = operation.employe_id ? 'agent' : operation.tiers ? 'tiers' : WILDCARD;

  return dbc.queryOne(`
    SELECT r.*,
           da.code as debit_account_code, da.label as debit_account_label,
           ca.code as credit_account_code, ca.label as credit_account_label
    FROM accounting_mapping_rules r
    JOIN accounting_accounts da ON da.id = r.debit_account_id AND da.is_active = 1
    JOIN accounting_accounts ca ON ca.id = r.credit_account_id AND ca.is_active = 1
    WHERE r.is_active = 1
      AND r.operation_type = ?
      AND r.operation_nature IN (?, ?)
      AND r.payment_method IN (?, ?)
      AND r.position_type IN (?, ?)
      AND r.third_party_type IN (?, ?)
    ORDER BY
      CASE WHEN r.operation_nature = ? THEN 0 ELSE 1 END,
      CASE WHEN r.payment_method = ? THEN 0 ELSE 1 END,
      CASE WHEN r.position_type = ? THEN 0 ELSE 1 END,
      CASE WHEN r.third_party_type = ? THEN 0 ELSE 1 END,
      r.id ASC
    LIMIT 1
  `, [
    typeOp,
    nature, WILDCARD,
    paymentMethod, WILDCARD,
    positionType, WILDCARD,
    thirdPartyType, WILDCARD,
    nature, paymentMethod, positionType, thirdPartyType,
  ]);
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
           e.status, l.id as line_id, l.third_party_id, l.debit, l.credit,
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
  normalizeRuleInput,
  findAccountingMappingForOperation,
  listAccountingEntryLines,
};
