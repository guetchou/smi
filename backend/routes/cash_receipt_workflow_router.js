'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { creerNotification, declencherAlerte } = require('../services/notif');
const { attemptAutomaticAccountingForOperation } = require('../services/accounting');
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

// Le flux contrôlé ne gouverne que les encaissements qu'il a lui-même pris en
// charge. La création le dit déjà : quand la position n'est pas prête, elle passe
// la main (`next()`) et l'opération naît par la voie historique, sans
// business_status. La modification, elle, ne le disait pas — elle interrogeait
// TOUT encaissement. Le routeur refusait donc de laisser modifier ce qu'il
// avait refusé de créer, en invoquant une soumission qui n'avait jamais eu lieu.
//
// Mesuré le 07/09/2026 en production sur REC-2026-000001 : PUT /operations/1
// rendait 409 « Modification interdite après soumission » alors que
// submitted_at, validated_at et paid_at valaient tous les trois NULL. Corriger
// la date d'une opération saisie avant l'activation du flux était impossible,
// sans qu'aucun écran n'explique pourquoi.
//
// C'est « absent ≠ zéro » sous une autre forme : un business_status absent
// n'est pas un dossier soumis, c'est un dossier que ce flux n'a jamais vu.
function gouverneParLeFluxControle(operation) {
  return Boolean(operation && operation.business_status);
}

// Au brouillon et non payé, les routes historiques restent la voie normale.
function modifiableEnLEtat(operation) {
  return operation.business_status === 'draft' && operation.payment_status === 'unpaid';
}

// Les routes historiques de modification/suppression restent utilisables uniquement au brouillon.
router.put('/:id', async (req, res, next) => {
  const operation = await getReceipt(req.params.id);
  if (!operation) return next();
  if (!gouverneParLeFluxControle(operation)) return next();
  if (modifiableEnLEtat(operation)) return next();
  return res.status(409).json({
    error: 'Modification interdite après soumission. Utiliser le retour en brouillon contrôlé.',
    code: 'CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION',
    business_status: operation.business_status,
  });
});

router.delete('/:id', async (req, res, next) => {
  const operation = await getReceipt(req.params.id);
  if (!operation) return next();
  if (!gouverneParLeFluxControle(operation)) return next();
  if (modifiableEnLEtat(operation)) return next();
  return res.status(409).json({
    error: 'Suppression interdite après soumission. Rejeter ou placer en litige.',
    code: 'CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION',
    business_status: operation.business_status,
  });
});
router.gouverneParLeFluxControle = gouverneParLeFluxControle;
router.modifiableEnLEtat = modifiableEnLEtat;

module.exports = router;
