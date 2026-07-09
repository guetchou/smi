'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { creerNotification, declencherAlerte } = require('../services/notif');
const { attemptAutomaticAccountingForOperation } = require('../services/accounting');
const { enqueueOperationSyncIfEnabled } = require('../services/dolibarr_integration');
const {
  normalizeOperationInput,
  canonicalReadinessForInput,
} = require('../services/finance-operation-canonical');
const { normalizeNumericFieldsInPlace, parseAmount } = require('../services/numeric');
const {
  CashReceiptWorkflowError,
  approveCashReceipt,
  confirmCashReceipt,
  createCashReceiptDraft,
  disputeCashReceipt,
  rejectCashReceipt,
  returnCashReceiptToDraft,
  submitCashReceipt,
} = require('../services/cash-receipt-workflow');

const router = express.Router();

router.use((req, _res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    normalizeNumericFieldsInPlace(req.body);
  }
  next();
});

async function allowed(user, permission, fallbackRoles = []) {
  if (await can(user, permission)) return true;
  return hasRole(user, ...fallbackRoles);
}

function workflowErrorResponse(res, error) {
  if (error instanceof CashReceiptWorkflowError) {
    return res.status(error.status || 409).json({
      error: error.message,
      code: error.code,
      details: error.details || {},
    });
  }
  console.error('[cash-receipt-workflow]', error);
  return res.status(500).json({ error: 'Erreur interne du workflow encaissement' });
}

async function getReceipt(id) {
  return db.queryOne(`
    SELECT * FROM operations
    WHERE id = ? AND type_op = 'encaissement'
  `, [id]);
}

async function auditReceipt(id, action, details, userId) {
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
    await auditReceipt(operation?.id, 'dolibarr_enqueue_skipped', {
      code: error.code || error.name || 'DOLIBARR_ENQUEUE_FAILED',
      message: error.message,
    }, actor?.id);
    return { queued: false, reason: error.code || 'error' };
  }
}

async function canOverrideSelfControl(user) {
  return await can(user, 'cash.receipt.override_self_control') || hasRole(user, 'admin');
}

function notifyAfterCommit({ type, title, message, operationId, actorId }) {
  setImmediate(() => {
    try {
      creerNotification({
        type,
        titre: title,
        message,
        srcTable: 'operations',
        srcId: operationId,
        createdBy: actorId,
      });
    } catch (_) {}
  });
}

router.get('/encaissements/config', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.configure', ['admin', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission de configuration des encaissements requise' });
  }
  const row = await db.queryOne(`
    SELECT setting_value, description, updated_by, updated_at
    FROM finance_workflow_settings
    WHERE setting_key='cash_receipt_attachment_threshold'
  `);
  return res.json({
    cash_receipt_attachment_threshold: Number(row?.setting_value || 500000),
    description: row?.description || null,
    updated_by: row?.updated_by || null,
    updated_at: row?.updated_at || null,
  });
});

router.put('/encaissements/config', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.configure', ['admin'])) {
    return res.status(403).json({ error: 'Configuration réservée à l’administrateur' });
  }
  const threshold = parseAmount(req.body?.cash_receipt_attachment_threshold, NaN);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return res.status(422).json({ error: 'Seuil de pièce justificative invalide' });
  }
  await db.transaction(async tx => {
    await tx.execute(`
      INSERT INTO finance_workflow_settings
        (setting_key, setting_value, description, updated_by, updated_at)
      VALUES ('cash_receipt_attachment_threshold', ?,
              'Montant XAF à partir duquel une pièce justificative est obligatoire pour un encaissement', ?, NOW())
      ON DUPLICATE KEY UPDATE
        setting_value=VALUES(setting_value), updated_by=VALUES(updated_by), updated_at=NOW()
    `, [String(Math.round(threshold)), req.user.id]);
    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('finance_workflow_settings', 0, 'cash_receipt_config_updated', ?, ?)
    `, [JSON.stringify({ cash_receipt_attachment_threshold: Math.round(threshold) }), req.user.id]);
  });
  return res.json({ ok: true, cash_receipt_attachment_threshold: Math.round(threshold) });
});

// Intercepte uniquement les encaissements sur positions canoniques.
router.post('/', async (req, res, next) => {
  const input = normalizeOperationInput(req.body);
  if (input.type_op !== 'encaissement') return next();

  let readiness;
  try {
    readiness = await canonicalReadinessForInput(input);
  } catch (error) {
    return next(error);
  }
  if (!readiness.ready) return next();

  if (!await allowed(req.user, 'cash.receipt.create', ['admin', 'caissier', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission cash.receipt.create requise' });
  }

  try {
    const result = await createCashReceiptDraft({ input, actorId: req.user.id });
    notifyAfterCommit({
      type: 'NOTIF_ENC_BROUILLON',
      title: 'Encaissement créé en brouillon',
      message: `${result.operation.libelle} — ${Number(result.operation.montant).toLocaleString('fr-FR')} XAF`,
      operationId: result.operationId,
      actorId: req.user.id,
    });
    return res.status(201).json({
      ...result.operation,
      workflow: 'cash_receipt_controlled',
      ledger_posted: false,
    });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.put('/encaissements/:id/soumettre', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.submit', ['admin', 'caissier', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission cash.receipt.submit requise' });
  }
  try {
    const result = await submitCashReceipt({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      allowOtherSubmitter: hasRole(req.user, 'admin'),
    });
    setImmediate(() => {
      try {
        declencherAlerte({
          type: 'ALRT_ENC_SOUMIS',
          titre: 'Encaissement à valider',
          message: `${result.operation.libelle} — ${Number(result.operation.montant).toLocaleString('fr-FR')} XAF`,
          srcTable: 'operations',
          srcId: result.operationId,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });
    return res.json({ ok: true, operation: result.operation, ledger_posted: false });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.put('/encaissements/:id/valider', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.approve', ['admin', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission cash.receipt.approve requise' });
  }
  const allowOverride = await canOverrideSelfControl(req.user);
  try {
    const result = await approveCashReceipt({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      allowSelfOverride: allowOverride && Boolean(req.body?.override_self_control),
      overrideReason: req.body?.override_reason,
    });
    notifyAfterCommit({
      type: 'NOTIF_ENC_VALIDE',
      title: 'Encaissement validé — fonds à confirmer',
      message: `${result.operation.libelle} — validation administrative sans impact sur le solde`,
      operationId: result.operationId,
      actorId: req.user.id,
    });
    return res.json({ ok: true, operation: result.operation, ledger_posted: false });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.post('/encaissements/:id/confirmer', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.confirm', ['admin', 'caissier', 'finance'])) {
    return res.status(403).json({ error: 'Permission cash.receipt.confirm requise' });
  }
  const allowOverride = await canOverrideSelfControl(req.user);
  try {
    const result = await confirmCashReceipt({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      allowSelfOverride: allowOverride && Boolean(req.body?.override_self_control),
      overrideReason: req.body?.override_reason,
    });

    let accountingWarning = null;
    try {
      await attemptAutomaticAccountingForOperation({
        operationId: result.operationId,
        userId: req.user.id,
      });
    } catch (error) {
      accountingWarning = {
        code: 'ACCOUNTING_GENERATION_FAILED',
        message: error.message,
      };
    }

    if (result.confirmed) {
      await enqueueDolibarrOperation(result.operation, req.user);
      notifyAfterCommit({
        type: 'NOTIF_ENC_CONFIRME',
        title: 'Fonds encaissés confirmés',
        message: `${result.operation.libelle} — ${Number(result.operation.montant).toLocaleString('fr-FR')} XAF`,
        operationId: result.operationId,
        actorId: req.user.id,
      });
    }
    return res.json({
      ok: true,
      confirmed: result.confirmed,
      idempotent: result.idempotent,
      operation: result.operation,
      ledger_ids: result.ledger.rows.map(row => Number(row.id)),
      accounting_warning: accountingWarning,
    });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.put('/encaissements/:id/rejeter', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.approve', ['admin', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission de rejet requise' });
  }
  try {
    const result = await rejectCashReceipt({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      reason: req.body?.reason,
    });
    return res.json({ ok: true, operation: result.operation, ledger_posted: false });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.put('/encaissements/:id/litige', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.dispute', ['admin', 'finance', 'dg'])) {
    return res.status(403).json({ error: 'Permission cash.receipt.dispute requise' });
  }
  try {
    const result = await disputeCashReceipt({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      reason: req.body?.reason,
    });
    return res.json({ ok: true, operation: result.operation, ledger_posted: false });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

router.put('/encaissements/:id/retour-brouillon', async (req, res) => {
  if (!await allowed(req.user, 'cash.receipt.dispute', ['admin', 'finance'])) {
    return res.status(403).json({ error: 'Permission de retour en brouillon requise' });
  }
  try {
    const result = await returnCashReceiptToDraft({
      operationId: Number(req.params.id),
      actorId: req.user.id,
      reason: req.body?.reason,
    });
    return res.json({ ok: true, operation: result.operation, ledger_posted: false });
  } catch (error) {
    return workflowErrorResponse(res, error);
  }
});

// Les routes historiques de modification/suppression restent utilisables uniquement au brouillon.
router.put('/:id', async (req, res, next) => {
  const operation = await getReceipt(req.params.id);
  if (!operation) return next();
  if (operation.business_status === 'draft' && operation.payment_status === 'unpaid') return next();
  return res.status(409).json({
    error: 'Modification interdite après soumission. Utiliser le retour en brouillon contrôlé.',
    code: 'CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION',
    business_status: operation.business_status,
  });
});

router.delete('/:id', async (req, res, next) => {
  const operation = await getReceipt(req.params.id);
  if (!operation) return next();
  if (operation.business_status === 'draft' && operation.payment_status === 'unpaid') return next();
  return res.status(409).json({
    error: 'Suppression interdite après soumission. Rejeter ou placer en litige.',
    code: 'CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION',
    business_status: operation.business_status,
  });
});

module.exports = router;
