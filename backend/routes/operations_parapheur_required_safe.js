'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const {
  creerNotification,
  declencherAlerte,
  resoudreAlerte,
  evaluerAlerteSoldes,
} = require('../services/notif');
const { attemptAutomaticAccountingForOperation } = require('../services/accounting');
const { buildOperationView } = require('../services/finance-operations');
const {
  FinanceOperationCanonicalError,
  TreasuryLedgerError,
  canonicalReadinessForInput,
  createCanonicalOperation,
  normalizeOperationInput,
  payCanonicalDisbursement,
} = require('../services/finance-operation-canonical');

const router = express.Router();
const WRITE_ROLES = ['admin', 'finance', 'caissier', 'rh', 'dg', 'assistante_direction', 'delegue'];
const APPROVE_ROLES = ['admin', 'dg', 'finance'];
const PAY_ROLES = ['admin', 'finance', 'caissier'];
const ENC_CREATE_ROLES = ['admin', 'caissier', 'finance', 'dg'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function fmt(n) { return new Intl.NumberFormat('fr-FR').format(Number(n || 0)); }

async function canApproveDec(user) {
  if (await can(user, 'cash.decaissement.validate')) return true;
  if (hasRole(user, ...APPROVE_ROLES)) return true;
  if (hasRole(user, 'delegue')) {
    const d = await db.queryOne(`
      SELECT id FROM delegations_approbation
      WHERE delegue_id = ? AND actif = 1
        AND date_debut <= CURDATE()
        AND (date_fin IS NULL OR date_fin >= CURDATE())
      LIMIT 1
    `, [user.id]);
    return !!d;
  }
  return false;
}

async function canPay(user) {
  return await can(user, 'cash.out.pay') || hasRole(user, ...PAY_ROLES);
}

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

async function auditDec(id, action, details, userId) {
  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
      'operations', id, action, details ? JSON.stringify(details) : null, userId || null,
    ]);
  } catch (_) {}
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

  if (!canWrite(req.user)) {
    return res.status(403).json({ error: 'Accès refusé — rôle autorisé requis pour enregistrer une opération' });
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
  const operation = await getDec(req.params.id);
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

  if (!await canPay(req.user)) {
    return res.status(403).json({ error: 'Permission cash.out.pay requise pour payer' });
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
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle autorisé requis pour soumettre un décaissement' });
    const op = await getDec(req.params.id);
    if (!op) return res.status(404).json({ error: 'Décaissement introuvable' });
    if (op.dec_statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul brouillon peut être soumis` });

    if (await canApproveDec(req.user)) {
      await db.execute(`
        UPDATE operations
        SET dec_statut='valide', submitted_by=?, submitted_at=NOW(), validated_by=?, validated_at=NOW(), updated_at=NOW()
        WHERE id=?
      `, [req.user.id, req.user.id, op.id]);
      await auditDec(op.id, 'dec_soumis_auto_valide', { montant: op.montant, libelle: op.libelle }, req.user.id);
      return res.json({ ok: true, dec_statut: 'valide', auto_validated: true });
    }

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

module.exports = router;
