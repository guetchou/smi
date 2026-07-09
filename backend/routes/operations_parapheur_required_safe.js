'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const {
  canWriteOperation,
  canPayCashOut,
} = require('../services/cash-operation-permissions');
const {
  CashOutSeparationError,
  assertApprovalSeparation,
} = require('../services/cash-out-separation');
const {
  creerNotification,
  declencherAlerte,
  resoudreAlerte,
  evaluerAlerteSoldes,
} = require('../services/notif');
const { attemptAutomaticAccountingForOperation } = require('../services/accounting');
const { buildOperationView } = require('../services/finance-operations');
const { enqueueOperationSyncIfEnabled } = require('../services/dolibarr_integration');
const {
  FinanceOperationCanonicalError,
  TreasuryLedgerError,
  canonicalReadinessForInput,
  createCanonicalOperation,
  normalizeOperationInput,
  payCanonicalDisbursement,
} = require('../services/finance-operation-canonical');

const router = express.Router();
const ENC_CREATE_ROLES = ['admin', 'caissier', 'finance', 'dg'];

function fmt(n) { return new Intl.NumberFormat('fr-FR').format(Number(n || 0)); }

function serializeOperation(op) {
  if (!op) return op;
  const montant = Number(op.montant || 0);
  return buildOperationView({
    ...op,
    detail: op.libelle,
    n_piece: op.num_piece,
    recette: op.type_op === 'encaissement' ? montant : 0,
    depense: op.type_op === 'decaissement' ? montant : 0,
    solde: Number(op.solde_position || 0),
    mode_paiement: op.mode_reglement === 'virement_bancaire' ? 'virement' : op.mode_reglement,
    couleur: op.cat_couleur || op.couleur || op.pos_couleur,
  });
}

function canonicalErrorResponse(res, error) {
  if (error instanceof FinanceOperationCanonicalError || error instanceof TreasuryLedgerError) {
    return res.status(error.status || 409).json({
      error: error.message,
      code: error.code,
      details: error.details || {},
    });
  }
  console.error('[operations-canonical]', error);
  return res.status(500).json({ error: 'Erreur interne du workflow de trésorerie canonique' });
}

async function getDec(id) {
  return db.queryOne("SELECT * FROM operations WHERE id=? AND type_op='decaissement'", [id]);
}

async function hasCanonicalLedger(operationId) {
  const row = await db.queryOne(`
    SELECT id FROM cash_ledger
    WHERE operation_id = ? AND leg_code IS NOT NULL
    LIMIT 1
  `, [operationId]);
  return row || null;
}

async function auditDec(id, action, details, userId) {
  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
      'operations', id, action, details ? JSON.stringify(details) : null, userId || null,
    ]);
  } catch (_) {}
}

async function enqueueDolibarrOperation(operation, actor) {
  try {
    return await enqueueOperationSyncIfEnabled({
      operationId: operation.id,
      operation,
      actor,
      db,
    });
  } catch (error) {
    try {
      await auditDec(operation?.id, 'dolibarr_enqueue_skipped', {
        code: error.code || error.name || 'DOLIBARR_ENQUEUE_FAILED',
        message: error.message,
      }, actor?.id);
    } catch (_) {}
    return { queued: false, reason: error.code || 'error' };
  }
}

async function createParapheurInTransaction(tx, payload) {
  const duplicate = await tx.queryOne(`
    SELECT id FROM parapheur
    WHERE ref_source_table=? AND ref_source_id=?
      AND statut NOT IN ('approuve','rejete')
    ORDER BY id DESC
    LIMIT 1
  `, [payload.ref_source_table, payload.ref_source_id]);
  if (duplicate) return duplicate.id;

  const r = await tx.execute(`
    INSERT INTO parapheur
      (type, titre, initiateur_id, priorite, statut, echeance_legale,
       montant, pieces_jointes, note_assistante, ref_source_table, ref_source_id)
    VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
  `, [
    payload.type,
    payload.titre,
    payload.initiateur_id,
    payload.priorite || 'normal',
    null,
    payload.montant || null,
    null,
    null,
    payload.ref_source_table,
    payload.ref_source_id,
  ]);

  const parapheurId = r.insertId;
  if (!parapheurId) throw new Error('Parapheur insert failed');

  await tx.execute(`
    INSERT INTO parapheur_actions
      (parapheur_id, acteur_id, acteur_role, action_type, commentaire, is_interim)
    VALUES (?, ?, 'service', 'soumis', 'creation obligatoire', 0)
  `, [parapheurId, payload.initiateur_id]);

  return parapheurId;
}

async function requireWritePermission(req, res, next) {
  try {
    let operation = null;
    let amount = Number(req.body?.montant ?? req.body?.depense ?? 0);

    if (req.params?.id) {
      operation = await getDec(req.params.id);
      if (!operation) return next();
      amount = Number(operation.montant || amount || 0);
    } else {
      const input = normalizeOperationInput(req.body || {});
      if (input.type_op !== 'decaissement') return next();
      amount = Number(input.montant || amount || 0);
    }

    if (!await canWriteOperation(req.user, { amount })) {
      return res.status(403).json({
        error: 'Permission cash.out.create requise pour traiter un décaissement',
        permission: 'cash.out.create',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requirePayPermission(req, res, next) {
  try {
    const operation = await getDec(req.params.id);
    if (!operation) return next();
    if (!await canPayCashOut(req.user, { amount: Number(operation.montant || 0) })) {
      return res.status(403).json({
        error: 'Permission cash.out.pay requise pour payer',
        permission: 'cash.out.pay',
      });
    }
    req.cashOutOperation = operation;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireApprovalSeparation(req, res, next) {
  try {
    const operation = await getDec(req.params.id);
    if (!operation) return next();
    if (operation.dec_statut !== 'soumis') return next();
    try {
      assertApprovalSeparation(operation, req.user?.id);
    } catch (error) {
      if (error instanceof CashOutSeparationError && hasRole(req.user, 'admin', 'dg')) {
        await auditDec(req.params.id, 'dec_self_approval_override', {
          code: error.code,
          created_by: error.details.created_by,
          submitted_by: error.details.submitted_by,
          override_role: req.user?.role || null,
        }, req.user?.id);
        return next();
      }
      throw error;
    }
    return next();
  } catch (error) {
    if (error instanceof CashOutSeparationError) {
      const status = error.code === 'CASH_OUT_SELF_APPROVAL_FORBIDDEN' ? 409 : error.status;
      await auditDec(req.params.id, 'dec_auto_validation_bloquee', {
        code: error.code,
        created_by: error.details.created_by,
        submitted_by: error.details.submitted_by,
      }, req.user?.id);
      return res.status(status).json({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }
    return next(error);
  }
}

// Ces gardes sont enregistrés avant les moteurs canonique et historique.
router.post('/', requireWritePermission);
router.put('/:id', requireWritePermission);
router.put('/:id/valider', requireApprovalSeparation);
router.put('/:id/soumettre', requireWritePermission);
router.put('/:id/resoumettre', requireWritePermission);
router.post('/:id/payer', requirePayPermission);

// Dès qu'au moins une position est prête, cet endpoint renvoie son solde canonique.
// Les autres positions restent calculées depuis les opérations pendant la transition.
router.get('/positions', async (_req, res, next) => {
  let positions;
  try {
    positions = await db.query('SELECT * FROM positions WHERE actif = 1 ORDER BY ordre, id');
  } catch (error) {
    return next(error);
  }
  if (!positions.some(position => position.ledger_status === 'ready')) return next();

  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await Promise.all(positions.map(async position => {
      let solde;
      if (position.ledger_status === 'ready') {
        const balance = await db.queryOne(`
          SELECT solde_courant, derniere_operation_id, updated_at
          FROM cashbox_balances
          WHERE caisse_id = ?
        `, [position.id]);
        if (!balance) {
          return {
            ...position,
            ledger_error: 'TREASURY_BALANCE_NOT_INITIALIZED',
            solde: null,
            encaissement_today: 0,
            decaissement_today: 0,
          };
        }
        solde = Number(balance.solde_courant || 0);
      } else {
        const legacy = await db.queryOne(`
          SELECT COALESCE(SUM(CASE
            WHEN type_op='encaissement' AND position_id=? THEN montant
            WHEN type_op='decaissement' AND position_id=? THEN -montant
            WHEN type_op='virement' AND position_id=? THEN montant
            WHEN type_op='virement' AND position_source_id=? THEN -montant
            ELSE 0 END),0) AS delta
          FROM operations
          WHERE statut='valide'
        `, [position.id, position.id, position.id, position.id]);
        solde = Number(position.solde_initial || 0) + Number(legacy?.delta || 0);
      }

      const todayFlow = await db.queryOne(`
        SELECT
          COALESCE(SUM(CASE
            WHEN type_op IN ('encaissement','virement') AND position_id=? THEN montant
            ELSE 0 END),0) AS encaissements,
          COALESCE(SUM(CASE
            WHEN type_op='decaissement' AND position_id=? THEN montant
            WHEN type_op='virement' AND position_source_id=? THEN montant
            ELSE 0 END),0) AS decaissements
        FROM operations
        WHERE statut='valide' AND date=?
      `, [position.id, position.id, position.id, today]);

      return {
        ...position,
        solde,
        balance_source: position.ledger_status === 'ready' ? 'cashbox_balances' : 'operations',
        encaissement_today: Number(todayFlow?.encaissements || 0),
        decaissement_today: Number(todayFlow?.decaissements || 0),
      };
    }));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// Interception progressive : seules les positions explicitement ledger_status='ready'
// utilisent le workflow canonique. Les autres continuent vers le routeur historique.
router.post('/', async (req, res, next) => {
  const input = normalizeOperationInput(req.body);
  let readiness;
  try {
    readiness = await canonicalReadinessForInput(input);
  } catch (error) {
    return next(error);
  }
  if (!readiness.ready) return next();

  if (!await canWriteOperation(req.user, { amount: Number(input.montant || 0) })) {
    return res.status(403).json({ error: 'Permission cash.out.create requise', permission: 'cash.out.create' });
  }
  if (input.type_op === 'encaissement' && !hasRole(req.user, ...ENC_CREATE_ROLES)) {
    return res.status(403).json({ error: 'Enregistrement d’encaissement réservé aux rôles caissier, finance, admin ou DG' });
  }

  try {
    const result = await createCanonicalOperation({ input, userId: req.user.id });
    const operation = result.operation;

    if (operation.statut === 'valide') {
      await attemptAutomaticAccountingForOperation({
        operationId: operation.id,
        userId: req.user.id,
      });
      await enqueueDolibarrOperation(operation, req.user);
    }

    const refreshed = await db.queryOne(`
      SELECT o.*, p.libelle AS position_libelle, p.type AS position_type,
             ps.libelle AS position_source_libelle,
             c.nom AS categorie_nom, c.couleur AS cat_couleur
      FROM operations o
      LEFT JOIN positions p ON p.id = o.position_id
      LEFT JOIN positions ps ON ps.id = o.position_source_id
      LEFT JOIN categories c ON c.id = o.categorie_id
      WHERE o.id = ?
    `, [operation.id]);

    if (operation.statut === 'valide') {
      setImmediate(() => {
        try {
          evaluerAlerteSoldes();
          creerNotification({
            type: 'NOTIF_OP_CREE',
            titre: `${operation.type_op === 'encaissement' ? 'Encaissement' : 'Virement'} enregistré`,
            message: `${operation.libelle} — ${fmt(operation.montant)} XAF`,
            srcTable: 'operations',
            srcId: operation.id,
            createdBy: req.user.id,
          });
        } catch (_) {}
      });
    }

    return res.status(201).json(serializeOperation(refreshed));
  } catch (error) {
    return canonicalErrorResponse(res, error);
  }
});

router.post('/:id/payer', async (req, res, next) => {
  const operation = req.cashOutOperation || await getDec(req.params.id);
  if (!operation) return next();

  let readiness;
  try {
    readiness = await canonicalReadinessForInput({
      type_op: 'decaissement',
      position_id: Number(operation.position_id),
    });
  } catch (error) {
    return next(error);
  }
  if (!readiness.ready) return next();

  if (!await canPayCashOut(req.user, { amount: Number(operation.montant || 0) })) {
    return res.status(403).json({ error: 'Permission cash.out.pay requise pour payer', permission: 'cash.out.pay' });
  }

  if (!req.body?.override_alerte) {
    const alert = await db.queryOne(`
      SELECT id, titre, message FROM alertes_actives
      WHERE position_id = ? AND priorite = 'bloquant'
        AND statut NOT IN ('resolue','acquittee')
      LIMIT 1
    `, [operation.position_id]);
    if (alert && !hasRole(req.user, 'admin')) {
      return res.status(403).json({
        error: `Paiement bloqué — alerte active : ${alert.message}`,
        alerte_id: alert.id,
        bloquant: true,
      });
    }
  }

  try {
    const result = await payCanonicalDisbursement({
      operationId: operation.id,
      userId: req.user.id,
      allowNegative: Boolean(req.body?.override_solde && hasRole(req.user, 'admin')),
    });

    await attemptAutomaticAccountingForOperation({
      operationId: operation.id,
      userId: req.user.id,
    });
    const paidOperation = await db.queryOne('SELECT * FROM operations WHERE id = ?', [operation.id]);
    await enqueueDolibarrOperation(paidOperation || operation, req.user);

    setImmediate(() => {
      try {
        resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', operation.id);
        evaluerAlerteSoldes();
        if (result.paid) {
          creerNotification({
            type: 'NOTIF_OP_CREE',
            titre: 'Décaissement payé',
            message: `${operation.libelle} — ${fmt(operation.montant)} XAF`,
            srcTable: 'operations',
            srcId: operation.id,
            createdBy: req.user.id,
          });
        }
      } catch (_) {}
    });

    return res.json({
      ok: true,
      dec_statut: 'paye',
      montant: Number(operation.montant),
      idempotent: result.idempotent,
      ledger_ids: result.ledger.rows.map(row => Number(row.id)),
    });
  } catch (error) {
    return canonicalErrorResponse(res, error);
  }
});

router.put('/:id/soumettre', async (req, res, next) => {
  try {
    const op = await getDec(req.params.id);
    if (!op) return res.status(404).json({ error: 'Décaissement introuvable' });
    if (!await canWriteOperation(req.user, { amount: Number(op.montant || 0) })) {
      return res.status(403).json({ error: 'Permission cash.out.create requise pour soumettre', permission: 'cash.out.create' });
    }
    if (op.dec_statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul brouillon peut être soumis` });

    const parapheurId = await db.transaction(async (tx) => {
      await tx.execute(`UPDATE operations SET dec_statut='soumis', submitted_by=?, submitted_at=NOW(), updated_at=NOW() WHERE id=?`, [req.user.id, op.id]);
      const id = await createParapheurInTransaction(tx, {
        type: 'decaissement',
        titre: `Décaissement — ${op.libelle} (${fmt(op.montant)} XAF)`,
        initiateur_id: req.user.id,
        montant: op.montant,
        ref_source_table: 'operations',
        ref_source_id: op.id,
        priorite: Number(op.montant || 0) >= 500000 ? 'urgent' : 'normal',
      });
      await tx.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
        'operations', op.id, 'dec_soumis', JSON.stringify({ montant: op.montant, libelle: op.libelle, parapheur_id: id, required_parapheur: true }), req.user.id,
      ]);
      return id;
    });

    setImmediate(() => {
      try {
        declencherAlerte({
          type: 'ALRT_DEC_SOUMIS',
          titre: 'Décaissement à valider',
          message: `${op.libelle} — ${fmt(op.montant)} XAF soumis par ${req.user.nom || req.user.email}`,
          srcTable: 'operations',
          srcId: op.id,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });

    res.json({ ok: true, dec_statut: 'soumis', parapheur_id: parapheurId });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const ledger = await hasCanonicalLedger(req.params.id);
    if (!ledger) return next();
    return res.status(409).json({
      error: 'Modification directe interdite : cette opération a déjà pris effet dans le ledger canonique. Utiliser une contre-opération.',
      code: 'TREASURY_OPERATION_IMMUTABLE',
      ledger_id: Number(ledger.id),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ledger = await hasCanonicalLedger(req.params.id);
    if (!ledger) return next();
    return res.status(409).json({
      error: 'Annulation directe interdite : cette opération a déjà pris effet dans le ledger canonique. Utiliser une contre-opération.',
      code: 'TREASURY_OPERATION_IMMUTABLE',
      ledger_id: Number(ledger.id),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
