'use strict';

/**
 * Intercepteur achats : rend obligatoire la création parapheur à la soumission
 * d'une demande d'achat non auto-approuvée.
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { creerNotification } = require('../services/notif');

const router = express.Router();
const ROLES_APPROUVER = ['admin', 'dg'];

function genFmt(n) { return new Intl.NumberFormat('fr-FR').format(Number(n || 0)); }
function isAdmin(user) { return hasRole(user, 'admin'); }

async function canApprove(user) {
  if (await can(user, 'purchase.validate')) return true;
  if (hasRole(user, ...ROLES_APPROUVER)) return true;
  if (hasRole(user, 'delegue')) {
    const deleg = await db.queryOne(`
      SELECT id FROM delegations_approbation
      WHERE delegue_id = ? AND actif = 1
        AND date_debut <= CURDATE()
        AND (date_fin IS NULL OR date_fin >= CURDATE())
      LIMIT 1
    `, [user.id]);
    return !!deleg;
  }
  return false;
}

async function audit(table, recordId, action, details, userId) {
  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
      table, recordId, action, details ? JSON.stringify(details) : null, userId || null,
    ]);
  } catch (_) {}
}

async function getAchatApproverUserIds() {
  const rows = await db.query(`
    SELECT DISTINCT u.id
    FROM users u
    LEFT JOIN delegations_approbation d
      ON d.delegue_id = u.id
      AND d.actif = 1
      AND d.date_debut <= CURDATE()
      AND (d.date_fin IS NULL OR d.date_fin >= CURDATE())
    WHERE u.actif = 1
      AND (
        u.role IN ('admin','dg')
        OR u.roles LIKE '%"admin"%'
        OR u.roles LIKE '%"dg"%'
        OR d.id IS NOT NULL
      )
  `, []);
  return rows.map(r => r.id);
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
  if (!parapheurId) throw new Error('Parapheur achat non créé');

  await tx.execute(`
    INSERT INTO parapheur_actions
      (parapheur_id, acteur_id, acteur_role, action_type, commentaire, is_interim)
    VALUES (?, ?, 'service', 'soumis', 'creation obligatoire', 0)
  `, [parapheurId, payload.initiateur_id]);

  return parapheurId;
}

async function approuverDemandeAchat(da, user) {
  const approbateurId = user.id;
  const approbateurNom = user.nom || user.email || 'approbateur';

  const result = await db.transaction(async (tx) => {
    if (da.statut === 'brouillon') {
      await tx.execute("UPDATE demandes_achat SET statut = 'soumis', updated_at = NOW() WHERE id = ?", [da.id]);
    }
    await tx.execute(`
      UPDATE demandes_achat SET
        statut = 'approuve', approuve_par_id = ?, approuve_par_nom = ?,
        date_approbation = CURDATE(), updated_at = NOW()
      WHERE id = ?
    `, [approbateurId, approbateurNom, da.id]);

    const libelle = `Demande d'achat ${da.numero} — ${da.service_demandeur}`;
    const op = await tx.execute(`
      INSERT INTO operations (type_op, date, libelle, montant, statut, dec_statut,
        categorie_id, position_id, ref_externe, created_by,
        submitted_by, submitted_at, validated_by, validated_at)
      VALUES ('decaissement', CURDATE(), ?, ?, 'en_attente', 'valide',
        (SELECT id FROM categories WHERE type IN ('decaissement','depense') ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END, id LIMIT 1),
        (SELECT id FROM positions ORDER BY id LIMIT 1),
        ?, ?, ?, NOW(), ?, NOW())
    `, [libelle, da.total_general, da.numero, approbateurId, approbateurId, approbateurId]);

    await tx.execute('UPDATE demandes_achat SET decaissement_id = ? WHERE id = ?', [op.insertId, da.id]);
    return op.insertId;
  });

  await audit('operations', result, 'dec_valide_achat', { achat_id: da.id, numero: da.numero, montant: da.total_general }, approbateurId);
  const daUpdated = await db.queryOne('SELECT * FROM demandes_achat WHERE id = ?', [da.id]);
  return { decId: result, daUpdated };
}

router.put('/:id/soumettre', async (req, res, next) => {
  try {
    const da = await db.queryOne('SELECT * FROM demandes_achat WHERE id = ?', [req.params.id]);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (da.statut !== 'brouillon') return res.status(400).json({ error: "La demande n'est pas en brouillon" });
    if (da.demandeur_id !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Seul le créateur peut soumettre' });

    if (await canApprove(req.user)) {
      const { decId, daUpdated } = await approuverDemandeAchat(da, req.user);
      return res.json({ ok: true, da: daUpdated, decaissement_id: decId, dec_statut: 'valide', auto_approved: true });
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute("UPDATE demandes_achat SET statut = 'soumis', updated_at = NOW() WHERE id = ?", [da.id]);
      const daUpdated = await tx.queryOne('SELECT * FROM demandes_achat WHERE id = ?', [da.id]);
      const parapheurId = await createParapheurInTransaction(tx, {
        type: 'demande_achat',
        titre: `Demande d'achat ${daUpdated.numero} — ${genFmt(daUpdated.total_general)} XAF`,
        initiateur_id: req.user.id,
        montant: daUpdated.total_general,
        ref_source_table: 'demandes_achat',
        ref_source_id: daUpdated.id,
        priorite: Number(daUpdated.total_general || 0) >= 500000 ? 'urgent' : 'normal',
      });
      await tx.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)', [
        'demandes_achat', da.id, 'soumettre', JSON.stringify({ parapheur_id: parapheurId, required_parapheur: true }), req.user.id,
      ]);
      return { daUpdated, parapheurId };
    });

    setImmediate(async () => {
      try {
        creerNotification({
          type: 'NOTIF_ACHAT_SOUMIS',
          titre: `Demande d'achat à approuver — ${result.daUpdated.numero}`,
          message: `${result.daUpdated.service_demandeur || 'Service'} — ${genFmt(result.daUpdated.total_general)} XAF soumis par ${req.user.nom || req.user.email}`,
          srcTable: 'demandes_achat', srcId: result.daUpdated.id,
          userIds: await getAchatApproverUserIds(), createdBy: req.user.id,
        });
      } catch (_) {}
    });

    res.json({ ok: true, da: result.daUpdated, parapheur_id: result.parapheurId });
  } catch (e) { next(e); }
});

module.exports = router;
