'use strict';

const db = require('../db');

const EPSILON = 0.01;

class TreasuryLedgerError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.name = 'TreasuryLedgerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function money(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function differs(left, right) {
  return Math.abs(money(left) - money(right)) >= EPSILON;
}

function expectedLedgerLegs(operation) {
  const amount = money(operation?.montant);
  if (!operation || amount <= 0) {
    throw new TreasuryLedgerError('TREASURY_AMOUNT_INVALID', 'Le montant de trésorerie doit être strictement positif', 422);
  }

  if (operation.type_op === 'encaissement') {
    return [{
      leg_code: 'receipt',
      caisse_id: Number(operation.position_id),
      type_mouvement: 'credit',
      montant: amount,
    }];
  }

  if (operation.type_op === 'decaissement') {
    return [{
      leg_code: 'disbursement',
      caisse_id: Number(operation.position_id),
      type_mouvement: 'debit',
      montant: amount,
    }];
  }

  if (operation.type_op === 'virement') {
    const source = Number(operation.position_source_id);
    const destination = Number(operation.position_id);
    if (!source || !destination) {
      throw new TreasuryLedgerError('TREASURY_TRANSFER_POSITION_REQUIRED', 'Positions source et destination requises', 422);
    }
    if (source === destination) {
      throw new TreasuryLedgerError('TREASURY_TRANSFER_SAME_POSITION', 'Source et destination doivent être différentes', 422);
    }
    return [
      {
        leg_code: 'transfer_source',
        caisse_id: source,
        type_mouvement: 'debit',
        montant: amount,
      },
      {
        leg_code: 'transfer_destination',
        caisse_id: destination,
        type_mouvement: 'credit',
        montant: amount,
      },
    ];
  }

  throw new TreasuryLedgerError('TREASURY_OPERATION_TYPE_INVALID', 'Type d’opération non pris en charge par le ledger', 422);
}

function assertOperationEffective(operation) {
  if (!operation) {
    throw new TreasuryLedgerError('TREASURY_OPERATION_NOT_FOUND', 'Opération introuvable', 404);
  }
  if (operation.statut !== 'valide') {
    throw new TreasuryLedgerError('TREASURY_OPERATION_NOT_EFFECTIVE', 'L’opération doit être validée avant posting trésorerie');
  }
  if (operation.type_op === 'decaissement' && operation.dec_statut !== 'paye') {
    throw new TreasuryLedgerError('TREASURY_DISBURSEMENT_NOT_PAID', 'Le décaissement doit être payé avant posting trésorerie');
  }
}

async function getPositionLedgerReadiness(positionIds, dbc = db) {
  const ids = [...new Set((positionIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { ready: false, positions: [], reason: 'position_missing' };
  const marks = ids.map(() => '?').join(',');
  try {
    const rows = await dbc.query(`
      SELECT id, ledger_status
      FROM positions
      WHERE id IN (${marks}) AND actif = 1
      ORDER BY id
    `, ids);
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    const positions = ids.map(id => ({
      id,
      ledger_status: byId.get(id)?.ledger_status || 'legacy',
      found: byId.has(id),
    }));
    return {
      ready: positions.every(position => position.found && position.ledger_status === 'ready'),
      positions,
      reason: positions.every(position => position.found) ? 'not_ready' : 'position_missing',
    };
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR' || /no such column/i.test(error.message || '')) {
      return {
        ready: false,
        positions: ids.map(id => ({ id, ledger_status: 'legacy', found: true })),
        reason: 'migration_missing',
      };
    }
    throw error;
  }
}

async function lockPositionState(positionId, tx) {
  const position = await tx.queryOne(`
    SELECT id, code, libelle, type, solde_initial, actif, ledger_status
    FROM positions
    WHERE id = ?
    FOR UPDATE
  `, [positionId]);
  if (!position || !Number(position.actif)) {
    throw new TreasuryLedgerError('TREASURY_POSITION_NOT_FOUND', `Position ${positionId} inactive ou introuvable`, 404, { position_id: positionId });
  }
  if (position.ledger_status !== 'ready') {
    throw new TreasuryLedgerError(
      'TREASURY_POSITION_NOT_READY',
      `Position ${position.code || position.id} non préparée pour le ledger canonique`,
      409,
      { position_id: positionId, ledger_status: position.ledger_status || 'legacy' },
    );
  }

  const balance = await tx.queryOne(`
    SELECT caisse_id, solde_courant, derniere_operation_id, updated_at
    FROM cashbox_balances
    WHERE caisse_id = ?
    FOR UPDATE
  `, [positionId]);
  if (!balance) {
    throw new TreasuryLedgerError(
      'TREASURY_BALANCE_NOT_INITIALIZED',
      `Solde canonique non initialisé pour ${position.code || position.id}`,
      409,
      { position_id: positionId },
    );
  }

  const latest = await tx.queryOne(`
    SELECT id, solde_apres
    FROM cash_ledger
    WHERE caisse_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `, [positionId]);

  const current = money(balance.solde_courant);
  if (latest && differs(latest.solde_apres, current)) {
    throw new TreasuryLedgerError(
      'TREASURY_BALANCE_DIVERGED',
      `Le cache de solde diverge du dernier mouvement pour ${position.code || position.id}`,
      409,
      {
        position_id: positionId,
        cached_balance: current,
        ledger_balance: money(latest.solde_apres),
        latest_ledger_id: Number(latest.id),
      },
    );
  }
  if (!latest && differs(position.solde_initial, current)) {
    throw new TreasuryLedgerError(
      'TREASURY_OPENING_BALANCE_DIVERGED',
      `Le solde courant sans ledger diffère du solde initial pour ${position.code || position.id}`,
      409,
      {
        position_id: positionId,
        initial_balance: money(position.solde_initial),
        cached_balance: current,
      },
    );
  }

  return { position, balance, latest, current };
}

async function lockPositionStates(legs, tx) {
  const ids = [...new Set(legs.map(leg => Number(leg.caisse_id)))].sort((a, b) => a - b);
  const states = new Map();
  for (const id of ids) states.set(id, await lockPositionState(id, tx));
  return states;
}

function validateExistingLeg(existing, expected) {
  if (Number(existing.caisse_id) !== Number(expected.caisse_id)
    || existing.type_mouvement !== expected.type_mouvement
    || differs(existing.montant, expected.montant)) {
    throw new TreasuryLedgerError(
      'TREASURY_LEDGER_IDEMPOTENCY_CONFLICT',
      `La jambe ${expected.leg_code} existe avec des valeurs différentes`,
      409,
      {
        ledger_id: Number(existing.id),
        expected,
        actual: {
          caisse_id: Number(existing.caisse_id),
          type_mouvement: existing.type_mouvement,
          montant: money(existing.montant),
        },
      },
    );
  }
}

async function postOperationToLedgerInContext({ operation, userId, allowNegative = false, failAfterLeg = null }, tx) {
  assertOperationEffective(operation);
  const operationId = Number(operation.id);
  const legs = expectedLedgerLegs(operation);

  const existingRows = await tx.query(`
    SELECT id, operation_id, caisse_id, type_mouvement, montant,
           solde_avant, solde_apres, leg_code, created_at
    FROM cash_ledger
    WHERE operation_id = ? AND leg_code IS NOT NULL
    ORDER BY id
    FOR UPDATE
  `, [operationId]);
  const existingByCode = new Map(existingRows.map(row => [row.leg_code, row]));

  for (const leg of legs) {
    const existing = existingByCode.get(leg.leg_code);
    if (existing) validateExistingLeg(existing, leg);
  }
  const expectedCodes = new Set(legs.map(leg => leg.leg_code));
  const unexpected = existingRows.filter(row => !expectedCodes.has(row.leg_code));
  if (unexpected.length) {
    throw new TreasuryLedgerError(
      'TREASURY_LEDGER_UNEXPECTED_LEG',
      'Des jambes ledger inattendues existent pour cette opération',
      409,
      { operation_id: operationId, ledger_ids: unexpected.map(row => Number(row.id)) },
    );
  }
  if (existingRows.length === legs.length) {
    return { posted: false, idempotent: true, rows: existingRows };
  }
  if (existingRows.length > 0) {
    throw new TreasuryLedgerError(
      'TREASURY_LEDGER_PARTIAL_OPERATION',
      'Le ledger contient seulement une partie des jambes attendues',
      409,
      { operation_id: operationId, expected: legs.length, actual: existingRows.length },
    );
  }

  const states = await lockPositionStates(legs, tx);
  const rows = [];
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const state = states.get(Number(leg.caisse_id));
    const before = money(state.current);
    const after = leg.type_mouvement === 'credit'
      ? money(before + leg.montant)
      : money(before - leg.montant);

    if (leg.type_mouvement === 'debit' && after < -EPSILON && !allowNegative) {
      throw new TreasuryLedgerError(
        'TREASURY_INSUFFICIENT_BALANCE',
        `Solde insuffisant sur ${state.position.code || state.position.id}`,
        409,
        {
          position_id: Number(leg.caisse_id),
          available: before,
          requested: leg.montant,
        },
      );
    }

    const result = await tx.execute(`
      INSERT INTO cash_ledger
        (caisse_id, operation_id, type_mouvement, montant, solde_avant,
         solde_apres, reference, created_by, leg_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      leg.caisse_id,
      operationId,
      leg.type_mouvement,
      leg.montant,
      before,
      after,
      operation.num_piece || null,
      userId,
      leg.leg_code,
    ]);

    await tx.execute(`
      UPDATE cashbox_balances
      SET solde_courant = ?, derniere_operation_id = ?, updated_at = NOW()
      WHERE caisse_id = ?
    `, [after, operationId, leg.caisse_id]);

    state.current = after;
    rows.push({
      id: result.insertId,
      operation_id: operationId,
      ...leg,
      solde_avant: before,
      solde_apres: after,
    });

    if (failAfterLeg && (failAfterLeg === true || Number(failAfterLeg) === index + 1)) {
      throw new Error(`TREASURY_LEDGER_TEST_FAILURE_AFTER_LEG_${index + 1}`);
    }
  }

  await tx.execute(`
    UPDATE operations
    SET treasury_status = 'synced', updated_at = NOW()
    WHERE id = ?
  `, [operationId]);
  await tx.execute(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
    VALUES ('operations', ?, 'treasury_ledger_posted', ?, ?)
  `, [operationId, JSON.stringify({
    operation_type: operation.type_op,
    ledger_ids: rows.map(row => row.id),
    legs: rows.map(row => ({
      leg_code: row.leg_code,
      caisse_id: row.caisse_id,
      type_mouvement: row.type_mouvement,
      montant: row.montant,
      solde_avant: row.solde_avant,
      solde_apres: row.solde_apres,
    })),
  }), userId || null]);

  return { posted: true, idempotent: false, rows };
}

async function postOperationToLedger({ operationId, userId, allowNegative = false, failAfterLeg = null }, dbc = db) {
  const work = async tx => {
    const operation = await tx.queryOne('SELECT * FROM operations WHERE id = ? FOR UPDATE', [operationId]);
    return postOperationToLedgerInContext({ operation, userId, allowNegative, failAfterLeg }, tx);
  };
  return dbc === db ? db.transaction(work) : work(dbc);
}

module.exports = {
  EPSILON,
  TreasuryLedgerError,
  expectedLedgerLegs,
  getPositionLedgerReadiness,
  postOperationToLedger,
  postOperationToLedgerInContext,
};
