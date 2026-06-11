'use strict';

/**
 * Intercepteur achats : rend obligatoire la création parapheur à la soumission
 * d'une demande d'achat non auto-approuvée.
 */
const express = require('express');
const db = require('../database');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { creerNotification } = require('../services/notif');
const { creerEntreeParapheur } = require('../services/parapheur');

const router = express.Router();
const ROLES_APPROUVER = ['admin', 'dg'];

function genFmt(n) { return new Intl.NumberFormat('fr-FR').format(Number(n || 0)); }
function isAdmin(user) { return hasRole(user, 'admin'); }
function canApprove(user) {
  if (can(user, 'purchase.validate')) return true;
  if (hasRole(user, ...ROLES_APPROUVER)) return true;
  if (hasRole(user, 'delegue')) {
    const deleg = db.prepare(`
      SELECT id FROM delegations_approbation
      WHERE delegue_id = ? AND actif = 1
        AND date_debut <= date('now')
        AND (date_fin IS NULL OR date_fin >= date('now'))
    `).get(user.id);
    return !!deleg;
  }
  return false;
}
function auditOperation(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('operations', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}
function auditAchat(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('demandes_achat', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}
function getAchatApproverUserIds() {
  return db.prepare(`
    SELECT DISTINCT u.id
    FROM users u
    LEFT JOIN delegations_approbation d
      ON d.delegue_id = u.id
      AND d.actif = 1
      AND d.date_debut <= date('now')
      AND (d.date_fin IS NULL OR d.date_fin >= date('now'))
    WHERE u.actif = 1
      AND (
        u.role IN ('admin','dg')
        OR u.roles LIKE '%"admin"%'
        OR u.roles LIKE '%"dg"%'
        OR d.id IS NOT NULL
      )
  `).all().map(r => r.id);
}
function approuverDemandeAchat(da, user) {
  const approbateurId = user.id;
  const approbateurNom = user.nom;
  const approuver = db.transaction(() => {
    if (da.statut === 'brouillon') {
      db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);
    }
    db.prepare(`
      UPDATE demandes_achat SET
        statut = 'approuve', approuve_par_id = ?, approuve_par_nom = ?,
        date_approbation = date('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(approbateurId, approbateurNom, da.id);
    const libelle = `Demande d'achat ${da.numero} — ${da.service_demandeur}`;
    const result = db.prepare(`
      INSERT INTO operations (type_op, date, libelle, montant, statut, dec_statut,
        categorie_id, position_id, ref_externe, created_by,
        submitted_by, submitted_at, validated_by, validated_at)
      VALUES ('decaissement', date('now'), ?, ?, 'en_attente', 'valide',
        (SELECT id FROM categories WHERE type IN ('decaissement','depense') ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END, id LIMIT 1),
        (SELECT id FROM positions ORDER BY id LIMIT 1),
        ?, ?, ?, datetime('now'), ?, datetime('now'))
    `).run(libelle, da.total_general, da.numero, approbateurId, approbateurId, approbateurId);
    db.prepare('UPDATE demandes_achat SET decaissement_id = ? WHERE id = ?').run(result.lastInsertRowid, da.id);
    return result.lastInsertRowid;
  });
  const decId = approuver();
  auditOperation(decId, 'dec_valide_achat', { achat_id: da.id, numero: da.numero, montant: da.total_general }, approbateurId);
  return { decId, daUpdated: db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id) };
}

router.put('/:id/soumettre', (req, res, next) => {
  try {
    const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (da.statut !== 'brouillon') return res.status(400).json({ error: "La demande n'est pas en brouillon" });
    if (da.demandeur_id !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Seul le créateur peut soumettre' });

    if (canApprove(req.user)) {
      const { decId, daUpdated } = approuverDemandeAchat(da, req.user);
      return res.json({ ok: true, da: daUpdated, decaissement_id: decId, dec_statut: 'valide', auto_approved: true });
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);
      const daUpdated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);
      const parapheurId = creerEntreeParapheur({
        type: 'demande_achat',
        titre: `Demande d'achat ${daUpdated.numero} — ${genFmt(daUpdated.total_general)} XAF`,
        initiateur_id: req.user.id,
        montant: daUpdated.total_general,
        ref_source_table: 'demandes_achat',
        ref_source_id: daUpdated.id,
        required: true,
      });
      auditAchat(da.id, 'soumettre', { parapheur_id: parapheurId, required_parapheur: true }, req.user.id);
      return { daUpdated, parapheurId };
    });

    const { daUpdated, parapheurId } = tx();
    setImmediate(() => {
      try {
        creerNotification({
          type: 'NOTIF_ACHAT_SOUMIS',
          titre: `Demande d'achat à approuver — ${daUpdated.numero}`,
          message: `${daUpdated.service_demandeur || 'Service'} — ${genFmt(daUpdated.total_general)} XAF soumis par ${req.user.nom || req.user.email}`,
          srcTable: 'demandes_achat', srcId: daUpdated.id,
          userIds: getAchatApproverUserIds(), createdBy: req.user.id,
        });
      } catch (_) {}
    });
    res.json({ ok: true, da: daUpdated, parapheur_id: parapheurId });
  } catch (e) { next(e); }
});

module.exports = router;
