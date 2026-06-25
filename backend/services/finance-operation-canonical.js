'use strict';

const db = require('../db');
const {
  TreasuryLedgerError,
  getPositionLedgerReadiness,
  postOperationToLedgerInContext,
} = require('./treasury-ledger');
const { parseAmount } = require('./numeric');

class FinanceOperationCanonicalError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'FinanceOperationCanonicalError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeType(value) {
  if (value === 'recette') return 'encaissement';
  if (value === 'depense') return 'decaissement';
  return value;
}

function normalizeMode(value) {
  if (value === 'virement') return 'virement_bancaire';
  if (value === 'carte') return 'autres';
  return value || 'especes';
}

function hasValue(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function normalizeOperationInput(body = {}) {
  const recette = hasValue(body.recette) ? parseAmount(body.recette, NaN) : 0;
  const depense = hasValue(body.depense) ? parseAmount(body.depense, NaN) : 0;
  const legacyAmount = recette > 0 ? recette : depense > 0 ? depense : undefined;
  const type = normalizeType(body.type_op || body.type || (recette > 0 ? 'encaissement' : depense > 0 ? 'decaissement' : null));
  const montant = hasValue(body.montant)
    ? parseAmount(body.montant, NaN)
    : parseAmount(legacyAmount, 0);

  return {
    date: body.date ? String(body.date).slice(0, 10) : null,
    num_piece: body.num_piece || body.n_piece || null,
    libelle: String(body.libelle || body.detail || '').trim(),
    tiers: body.tiers ? String(body.tiers).trim() : null,
    montant,
    type_op: type,
    position_id: Number(body.position_id || 0),
    position_source_id: body.position_source_id ? Number(body.position_source_id) : null,
    categorie_id: body.categorie_id ? Number(body.categorie_id) : null,
    mode_reglement: normalizeMode(body.mode_reglement || body.mode_paiement),
    ref_externe: body.ref_externe ? String(body.ref_externe).trim() : null,
    piece_justificative: body.piece_justificative || null,
    decharge_signee: body.decharge_signee ? 1 : 0,
    employe_id: body.employe_id ? Number(body.employe_id) : null,
  };
}

function positionIdsForInput(input) {
  return input.type_op === 'virement'
    ? [input.position_source_id, input.position_id]
    : [input.position_id];
}

async function canonicalReadinessForInput(input, dbc = db) {
  return getPositionLedgerReadiness(positionIdsForInput(input), dbc);
}

function validateInput(input) {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new FinanceOperationCanonicalError('FINANCE_DATE_REQUIRED', 'Date valide requise');
  }
  if (!input.libelle) throw new FinanceOperationCanonicalError('FINANCE_LABEL_REQUIRED', 'Libellé requis');
  if (!Number.isFinite(input.montant) || input.montant <= 0) {
    throw new FinanceOperationCanonicalError('FINANCE_AMOUNT_INVALID', 'Montant doit être > 0');
  }
  if (!['encaissement', 'decaissement', 'virement'].includes(input.type_op)) {
    throw new FinanceOperationCanonicalError('FINANCE_TYPE_INVALID', 'Type opération invalide');
  }
  if (!input.position_id) throw new FinanceOperationCanonicalError('FINANCE_POSITION_REQUIRED', 'Position requise');
  if (input.type_op === 'virement') {
    if (!input.position_source_id) throw new FinanceOperationCanonicalError('FINANCE_SOURCE_POSITION_REQUIRED', 'Position source requise');
    if (input.position_source_id === input.position_id) {
      throw new FinanceOperationCanonicalError('FINANCE_TRANSFER_SAME_POSITION', 'Source et destination doivent être différentes');
    }
  } else if (!input.categorie_id) {
    throw new FinanceOperationCanonicalError('FINANCE_CATEGORY_REQUIRED', 'Rubrique comptable requise');
  }
}

async function assertPeriodOpen(date, tx) {
  const parsed = new Date(`${date}T00:00:00`);
  const closed = await tx.queryOne(`
    SELECT id FROM periodes_cloturees
    WHERE annee = ? AND mois = ?
    LIMIT 1
  `, [parsed.getFullYear(), parsed.getMonth() + 1]);
  if (closed) {
    throw new FinanceOperationCanonicalError(
      'FINANCE_PERIOD_CLOSED',
      `Période ${date.slice(0, 7)} clôturée — aucune écriture autorisée`,
      409,
    );
  }
}

function modeRequiresReference(mode) {
  return ['cheque', 'virement_bancaire', 'mobile_money'].includes(normalizeMode(mode));
}

async function assertExternalReferenceAvailable(input, tx) {
  if (!modeRequiresReference(input.mode_reglement)) return;
  if (!input.ref_externe) {
    throw new FinanceOperationCanonicalError(
      'FINANCE_EXTERNAL_REFERENCE_REQUIRED',
      'Référence externe obligatoire pour chèque, virement bancaire ou mobile money',
    );
  }
  const duplicate = await tx.queryOne(`
    SELECT id, num_piece
    FROM operations
    WHERE statut != 'annule'
      AND type_op = ?
      AND mode_reglement = ?
      AND LOWER(TRIM(ref_externe)) = LOWER(TRIM(?))
    LIMIT 1
    FOR UPDATE
  `, [input.type_op, input.mode_reglement, input.ref_externe]);
  if (duplicate) {
    throw new FinanceOperationCanonicalError(
      'FINANCE_EXTERNAL_REFERENCE_DUPLICATE',
      `Référence externe déjà utilisée sur l’opération ${duplicate.num_piece || `#${duplicate.id}`}`,
      409,
    );
  }
}

function workflowStates(type) {
  if (type === 'decaissement') {
    return {
      statut: 'en_attente',
      dec_statut: 'brouillon',
      treasury_status: 'pending',
      accounting_status: 'pending',
      budget_status: 'pending',
      allocation_status: 'pending',
      business_status: 'draft',
      approval_status: 'draft',
      payment_status: 'unpaid',
      reconciliation_status: 'pending',
    };
  }
  return {
    statut: 'valide',
    dec_statut: null,
    treasury_status: 'pending',
    accounting_status: 'pending',
    budget_status: 'pending',
    allocation_status: 'pending',
    business_status: 'validated',
    approval_status: 'approved',
    payment_status: 'paid',
    reconciliation_status: 'pending',
  };
}

async function loadOperation(id, dbc = db) {
  return dbc.queryOne(`
    SELECT o.*, p.libelle AS position_libelle, p.type AS position_type,
           ps.libelle AS position_source_libelle,
           c.nom AS categorie_nom, c.couleur AS cat_couleur
    FROM operations o
    LEFT JOIN positions p ON p.id = o.position_id
    LEFT JOIN positions ps ON ps.id = o.position_source_id
    LEFT JOIN categories c ON c.id = o.categorie_id
    WHERE o.id = ?
  `, [id]);
}

async function createCanonicalOperation({ input: rawInput, userId, failAfterLeg = null }, dbc = db) {
  const input = normalizeOperationInput(rawInput);
  validateInput(input);
  if (!userId) throw new FinanceOperationCanonicalError('FINANCE_ACTOR_REQUIRED', 'Auteur obligatoire', 422);

  const result = await dbc.transaction(async tx => {
    await assertPeriodOpen(input.date, tx);
    await assertExternalReferenceAvailable(input, tx);
    const readiness = await canonicalReadinessForInput(input, tx);
    if (!readiness.ready) {
      throw new FinanceOperationCanonicalError(
        'FINANCE_LEDGER_NOT_READY',
        'Une position de trésorerie n’est pas prête pour le ledger canonique',
        409,
        readiness,
      );
    }

    const states = workflowStates(input.type_op);
    const inserted = await tx.execute(`
      INSERT INTO operations
        (date, num_piece, libelle, tiers, montant, type_op, position_id,
         position_source_id, categorie_id, mode_reglement, ref_externe,
         piece_justificative, decharge_signee, employe_id, created_by,
         statut, dec_statut, treasury_status, accounting_status,
         budget_status, allocation_status, business_status, approval_status,
         payment_status, reconciliation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      input.date,
      input.num_piece,
      input.libelle,
      input.tiers,
      input.montant,
      input.type_op,
      input.position_id,
      input.position_source_id,
      input.categorie_id,
      input.mode_reglement,
      input.ref_externe,
      input.piece_justificative,
      input.decharge_signee,
      input.employe_id,
      userId,
      states.statut,
      states.dec_statut,
      states.treasury_status,
      states.accounting_status,
      states.budget_status,
      states.allocation_status,
      states.business_status,
      states.approval_status,
      states.payment_status,
      states.reconciliation_status,
    ]);
    const operationId = inserted.insertId;
    if (!operationId) throw new Error('Création de l’opération sans identifiant');

    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('operations', ?, 'finance_operation_created', ?, ?)
    `, [operationId, JSON.stringify({
      type_op: input.type_op,
      montant: input.montant,
      position_id: input.position_id,
      position_source_id: input.position_source_id,
      ledger_mode: 'canonical',
    }), userId]);

    let ledger = null;
    if (input.type_op !== 'decaissement') {
      const operation = await tx.queryOne('SELECT * FROM operations WHERE id = ? FOR UPDATE', [operationId]);
      ledger = await postOperationToLedgerInContext({
        operation,
        userId,
        failAfterLeg,
      }, tx);
    }
    return { operationId, ledger };
  });

  return {
    ...result,
    operation: await loadOperation(result.operationId, dbc),
  };
}

async function payCanonicalDisbursement({ operationId, userId, allowNegative = false, failAfterLeg = null }, dbc = db) {
  if (!operationId) throw new FinanceOperationCanonicalError('FINANCE_OPERATION_REQUIRED', 'Décaissement requis');
  if (!userId) throw new FinanceOperationCanonicalError('FINANCE_ACTOR_REQUIRED', 'Payeur obligatoire', 422);

  const result = await dbc.transaction(async tx => {
    const operation = await tx.queryOne(`
      SELECT * FROM operations
      WHERE id = ? AND type_op = 'decaissement'
      FOR UPDATE
    `, [operationId]);
    if (!operation) throw new FinanceOperationCanonicalError('FINANCE_DISBURSEMENT_NOT_FOUND', 'Décaissement introuvable', 404);

    const readiness = await getPositionLedgerReadiness([operation.position_id], tx);
    if (!readiness.ready) {
      throw new FinanceOperationCanonicalError('FINANCE_LEDGER_NOT_READY', 'Position non prête pour le ledger canonique', 409, readiness);
    }

    if (operation.dec_statut === 'paye') {
      const ledger = await postOperationToLedgerInContext({ operation, userId, allowNegative, failAfterLeg }, tx);
      return { operationId: Number(operation.id), paid: false, idempotent: true, ledger };
    }
    if (operation.dec_statut !== 'valide') {
      throw new FinanceOperationCanonicalError(
        'FINANCE_DISBURSEMENT_NOT_APPROVED',
        `Statut actuel "${operation.dec_statut}" — seul validé peut être payé`,
        409,
      );
    }

    await tx.execute(`
      UPDATE operations
      SET dec_statut = 'paye', statut = 'valide', paid_by = ?, paid_at = NOW(),
          payment_status = 'paid', treasury_status = 'pending',
          accounting_status = 'pending', budget_status = 'pending',
          allocation_status = 'pending', updated_at = NOW()
      WHERE id = ? AND dec_statut = 'valide'
    `, [userId, operation.id]);

    const paidOperation = await tx.queryOne('SELECT * FROM operations WHERE id = ? FOR UPDATE', [operation.id]);
    const ledger = await postOperationToLedgerInContext({
      operation: paidOperation,
      userId,
      allowNegative,
      failAfterLeg,
    }, tx);

    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('operations', ?, 'dec_paye', ?, ?)
    `, [operation.id, JSON.stringify({
      montant: Number(operation.montant),
      position_id: Number(operation.position_id),
      ledger_mode: 'canonical',
      ledger_ids: ledger.rows.map(row => row.id),
    }), userId]);

    return { operationId: Number(operation.id), paid: true, idempotent: false, ledger };
  });

  return {
    ...result,
    operation: await loadOperation(result.operationId, dbc),
  };
}

module.exports = {
  FinanceOperationCanonicalError,
  TreasuryLedgerError,
  canonicalReadinessForInput,
  createCanonicalOperation,
  loadOperation,
  normalizeOperationInput,
  payCanonicalDisbursement,
  positionIdsForInput,
};
