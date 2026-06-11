'use strict';

/**
 * Intercepteur décaissements : rend obligatoire la création parapheur lors de la
 * soumission d'un décaissement manuel.
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { creerEntreeParapheur } = require('../services/parapheur');
const { declencherAlerte } = require('../services/notif');

const router = express.Router();
const WRITE_ROLES = ['admin', 'finance', 'caissier', 'dg', 'assistante_direction', 'delegue'];
const APPROVE_ROLES = ['admin', 'dg', 'finance'];

function canWrite(user) {
  return hasRole(user, ...WRITE_ROLES);
}
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
function fmt(n) { return new Intl.NumberFormat('fr-FR').format(Number(n || 0)); }

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

    await db.transaction(async (tx) => {
      await tx.execute(`UPDATE operations SET dec_statut='soumis', submitted_by=?, submitted_at=NOW(), updated_at=NOW() WHERE id=?`, [req.user.id, op.id]);
      const parapheurId = creerEntreeParapheur({
        type: 'decaissement',
        titre: `Décaissement — ${op.libelle} (${fmt(op.montant)} XAF)`,
        initiateur_id: req.user.id,
        montant: op.montant,
        ref_source_table: 'operations',
        ref_source_id: op.id,
        required: true,
      });
      await tx.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
        'operations', op.id, 'dec_soumis', JSON.stringify({ montant: op.montant, libelle: op.libelle, parapheur_id: parapheurId, required_parapheur: true }), req.user.id,
      ]);
      op.parapheur_id = parapheurId;
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

    res.json({ ok: true, dec_statut: 'soumis', parapheur_id: op.parapheur_id });
  } catch (e) { next(e); }
});

module.exports = router;
