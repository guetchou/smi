'use strict';

/**
 * Intercepteur de décision parapheur.
 *
 * Objectif : éviter qu'une demande soit "approuvée" dans le parapheur sans effet
 * métier dans la source RH/finance liée.
 *
 * Routes interceptées avant backend/routes/parapheur.js :
 *   POST /api/parapheur/:id/approuver
 *   POST /api/parapheur/:id/rejeter
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');

const router = express.Router();
const DG_ACTION_STATUSES = ['transmis_dg', 'delegue', 'en_avis'];
const FINAL_STATUSES = ['approuve', 'rejete'];

function userHas(user, ...roles) {
  return hasRole(user, ...roles);
}
function roleOf(user) {
  return user?.role || 'unknown';
}
async function action(parapheurId, user, type, comment, destId = null) {
  try {
    await db.execute(`
      INSERT INTO parapheur_actions
        (parapheur_id, acteur_id, acteur_role, action_type, commentaire, destinataire_id, is_interim)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [parapheurId, user?.id || null, roleOf(user), type, comment || null, destId || null]);
  } catch (_) {}
}
async function audit(p, decision, status, details, userId) {
  try {
    await db.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('parapheur', ?, ?, ?, ?)
    `, [p.id, `parapheur_source_${status}`, JSON.stringify({ decision, ...details }), userId || null]);
  } catch (_) {}
}
async function notif(userId, message, type = 'parapheur') {
  try {
    await db.execute(`
      INSERT INTO notif_messages (user_id, message, type, lu, created_at)
      VALUES (?, ?, ?, 0, NOW())
    `, [userId, message, type]);
  } catch (_) {}
}
async function getParapheur(id) {
  return db.queryOne('SELECT * FROM parapheur WHERE id=?', [id]);
}
function assertDecisionAllowed(p) {
  if (!p) {
    const e = new Error('Demande parapheur introuvable');
    e.status = 404;
    throw e;
  }
  if (FINAL_STATUSES.includes(p.statut)) {
    const e = new Error(`Demande déjà clôturée (${p.statut})`);
    e.status = 409;
    throw e;
  }
  if (!DG_ACTION_STATUSES.includes(p.statut)) {
    const e = new Error(`Statut incorrect pour décision DG (${p.statut})`);
    e.status = 400;
    throw e;
  }
}
async function recomputeLeaveCounters(employeId) {
  try {
    const year = String(new Date().getFullYear());
    const emp = await db.queryOne('SELECT id, date_embauche, conges_report_n1, conges_maladie_droit FROM employes WHERE id=?', [employeId]);
    if (!emp) return null;

    let acquis = 0;
    if (emp.date_embauche) {
      const p = await db.queryOne("SELECT valeur FROM parametres WHERE cle='conges_jours_par_mois'", []);
      const taux = Number(p?.valeur || 2.5);
      const now = new Date();
      const emb = new Date(emp.date_embauche);
      const debAnnee = new Date(now.getFullYear(), 0, 1);
      const ref = emb > debAnnee ? emb : debAnnee;
      const mois = Math.min(12, Math.max(0, (now.getFullYear() - ref.getFullYear()) * 12 + (now.getMonth() - ref.getMonth()) + (now.getDate() >= ref.getDate() ? 1 : 0)));
      acquis = Math.min(30, Math.round(mois * taux * 2) / 2);
    }

    const annual = await db.queryOne(`
      SELECT COALESCE(SUM(nb_jours),0) AS pris
      FROM employes_conges
      WHERE employe_id=?
        AND type_conge='annuel'
        AND statut IN ('approuve','termine')
        AND SUBSTR(CAST(date_debut AS CHAR), 1, 4)=?
    `, [employeId, year]);
    const sick = await db.queryOne(`
      SELECT COALESCE(SUM(nb_jours),0) AS pris
      FROM employes_conges
      WHERE employe_id=?
        AND type_conge='maladie'
        AND statut IN ('approuve','termine')
        AND SUBSTR(CAST(date_debut AS CHAR), 1, 4)=?
    `, [employeId, year]);

    const report = Number(emp.conges_report_n1 || 0);
    const annualTaken = Number(annual?.pris || 0);
    const sickTaken = Number(sick?.pris || 0);
    const sickRight = Number(emp.conges_maladie_droit || 15);

    await db.execute(`
      UPDATE employes
      SET conges_acquis_annuel=?,
          conges_pris_annuel=?,
          conges_solde_annuel=?,
          conges_maladie_pris=?,
          conges_maladie_solde=?,
          updated_at=NOW()
      WHERE id=?
    `, [
      acquis,
      annualTaken,
      Math.round((acquis + report - annualTaken) * 10) / 10,
      sickTaken,
      Math.max(0, sickRight - sickTaken),
      employeId,
    ]);
    return { acquis, annualTaken, sickTaken };
  } catch (e) {
    return { warning: 'leave_counter_recompute_failed', error: e.message };
  }
}
async function syncOperation(p, decision, actorId, reason) {
  if (p.ref_source_table !== 'operations' || p.type !== 'decaissement') return null;
  const op = await db.queryOne('SELECT * FROM operations WHERE id=? AND type_op=?', [p.ref_source_id, 'decaissement']);
  if (!op) return { skipped: true, reason: 'operation_missing' };
  if (decision === 'approuve') {
    if (op.dec_statut === 'paye' || op.statut === 'valide') return { skipped: true, reason: 'operation_already_paid_or_validated' };
    await db.execute(`
      UPDATE operations
      SET dec_statut='valide', validated_by=?, validated_at=NOW(), updated_at=NOW()
      WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut,'brouillon') IN ('brouillon','soumis','rejete')
    `, [actorId, p.ref_source_id]);
    return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_valide' };
  }
  await db.execute(`
    UPDATE operations
    SET dec_statut='rejete', motif_rejet=?, rejete_par=?, rejete_at=NOW(), updated_at=NOW()
    WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut,'brouillon') NOT IN ('paye','annule')
  `, [reason || 'Rejet parapheur', actorId, p.ref_source_id]);
  return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_rejete' };
}
async function syncAdvance(p, decision, actorId, reason) {
  if (p.ref_source_table !== 'employes_avances' || p.type !== 'avance_salaire') return null;
  const av = await db.queryOne('SELECT * FROM employes_avances WHERE id=?', [p.ref_source_id]);
  if (!av) return { skipped: true, reason: 'advance_missing' };
  if (['decaisse', 'solde', 'annule'].includes(av.statut_workflow)) return { skipped: true, reason: `advance_final_${av.statut_workflow}` };
  if (decision === 'approuve') {
    await db.execute(`
      UPDATE employes_avances
      SET statut_workflow='approuve_dg', approuve_par=?, approuve_at=NOW(), updated_at=NOW()
      WHERE id=? AND statut_workflow IN ('brouillon','soumis','rejete')
    `, [actorId, p.ref_source_id]);
    return { synced: true, table: 'employes_avances', id: p.ref_source_id, action: 'statut_workflow_approuve_dg' };
  }
  await db.execute(`
    UPDATE employes_avances
    SET statut_workflow='rejete', statut='annule', rejete_par=?, rejete_at=NOW(), motif_rejet=?, updated_at=NOW()
    WHERE id=? AND statut_workflow NOT IN ('decaisse','solde','annule')
  `, [actorId, reason || 'Rejet parapheur', p.ref_source_id]);
  return { synced: true, table: 'employes_avances', id: p.ref_source_id, action: 'statut_workflow_rejete' };
}
async function syncLeave(p, decision, actorId, reason) {
  if (p.ref_source_table !== 'employes_conges' || p.type !== 'conge') return null;
  const cg = await db.queryOne('SELECT * FROM employes_conges WHERE id=?', [p.ref_source_id]);
  if (!cg) return { skipped: true, reason: 'leave_missing' };
  if (['termine', 'annule'].includes(cg.statut)) return { skipped: true, reason: `leave_final_${cg.statut}` };
  if (decision === 'approuve') {
    if (!['demande', 'valide_sup', 'refuse'].includes(cg.statut)) return { skipped: true, reason: `leave_status_${cg.statut}` };
    const overlap = await db.queryOne(`
      SELECT id, date_debut, date_fin
      FROM employes_conges
      WHERE employe_id=? AND id<>? AND statut='approuve'
        AND date_debut <= ? AND date_fin >= ?
      LIMIT 1
    `, [cg.employe_id, cg.id, cg.date_fin, cg.date_debut]);
    if (overlap) return { skipped: true, reason: 'leave_overlap', overlap_id: overlap.id };
    await db.execute(`
      UPDATE employes_conges
      SET statut='approuve', approuve_par=?, approuve_at=NOW(), updated_by=?, updated_at=NOW()
      WHERE id=? AND statut IN ('demande','valide_sup','refuse')
    `, [actorId, actorId, cg.id]);
    const counters = await recomputeLeaveCounters(cg.employe_id);
    return { synced: true, table: 'employes_conges', id: cg.id, action: 'statut_approuve', counters };
  }
  if (['approuve', 'termine'].includes(cg.statut)) return { skipped: true, reason: `cannot_reject_${cg.statut}` };
  await db.execute(`
    UPDATE employes_conges
    SET statut='refuse', refuse_par=?, refuse_at=NOW(), refuse_motif=?, updated_by=?, updated_at=NOW()
    WHERE id=? AND statut IN ('demande','valide_sup')
  `, [actorId, reason || 'Rejet parapheur', actorId, cg.id]);
  return { synced: true, table: 'employes_conges', id: cg.id, action: 'statut_refuse' };
}
async function syncSource(p, decision, actorId, reason) {
  if (!p.ref_source_table || !p.ref_source_id) return { skipped: true, reason: 'no_source_ref' };
  const handlers = [syncOperation, syncAdvance, syncLeave];
  for (const h of handlers) {
    const r = await h(p, decision, actorId, reason);
    if (r) return r;
  }
  return { skipped: true, reason: 'unsupported_source_type', table: p.ref_source_table, type: p.type };
}
async function decide(req, res, decision) {
  try {
    if (!userHas(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const p = await getParapheur(req.params.id);
    assertDecisionAllowed(p);

    const motif = decision === 'rejete' ? String(req.body?.motif || '').trim() : String(req.body?.commentaire || '').trim();
    if (decision === 'rejete' && !motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

    const sync = await syncSource(p, decision, req.user.id, motif);
    if (sync?.skipped && ['leave_overlap'].includes(sync.reason)) {
      await audit(p, decision, 'blocked', sync, req.user.id);
      return res.status(409).json({ ok: false, error: 'Synchronisation source bloquée', source_sync: sync });
    }

    await db.execute('UPDATE parapheur SET statut=?, updated_at=NOW() WHERE id=?', [decision, p.id]);
    await action(p.id, req.user, decision, motif || null);
    await audit(p, decision, sync?.synced ? 'synced' : 'skipped', sync, req.user.id);
    await notif(p.initiateur_id, decision === 'approuve' ? `Votre demande "${p.titre}" a été approuvée` : `Votre demande "${p.titre}" a été rejetée : ${motif}`, decision === 'approuve' ? 'parapheur_ok' : 'parapheur_ko');

    res.json({ ok: true, source_sync: sync });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
}

router.post('/:id/approuver', (req, res) => decide(req, res, 'approuve'));
router.post('/:id/rejeter',   (req, res) => decide(req, res, 'rejete'));

module.exports = router;
