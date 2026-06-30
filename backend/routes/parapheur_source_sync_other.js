'use strict';

/**
 * Intercepteur de décision parapheur.
 * Routes interceptées avant backend/routes/parapheur.js :
 *   POST /api/parapheur/:id/approuver
 *   POST /api/parapheur/:id/rejeter
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { parseAmount } = require('../services/numeric');

const router = express.Router();
const DG_ACTION_STATUSES = ['transmis_dg', 'delegue', 'en_avis'];
const FINAL_STATUSES = ['approuve', 'rejete'];
const IS_MYSQL_DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql';

function userHas(user, ...roles) { return hasRole(user, ...roles); }
function roleOf(user) { return user?.role || 'unknown'; }
function money(n) {
  const amount = parseAmount(n, 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function lockForUpdate() { return IS_MYSQL_DRIVER ? ' FOR UPDATE' : ''; }

async function action(dbc, parapheurId, user, type, comment, destId = null) {
  try {
    await dbc.execute(`
      INSERT INTO parapheur_actions
        (parapheur_id, acteur_id, acteur_role, action_type, commentaire, destinataire_id, is_interim)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [parapheurId, user?.id || null, roleOf(user), type, comment || null, destId || null]);
  } catch (_) {}
}
async function audit(dbc, p, decision, status, details, userId) {
  try {
    await dbc.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('parapheur', ?, ?, ?, ?)
    `, [p.id, `parapheur_source_${status}`, JSON.stringify({ decision, ...details }), userId || null]);
  } catch (_) {}
}
async function sourceAudit(dbc, table, id, actionName, details, userId) {
  try {
    await dbc.execute(`INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?, ?, ?, ?, ?)`,
      [table, id, actionName, JSON.stringify(details || {}), userId || null]);
  } catch (_) {}
}
async function notif(userId, message, type = 'parapheur') {
  try {
    await db.execute(`INSERT INTO notif_messages (user_id, message, type, lu, created_at) VALUES (?, ?, ?, 0, NOW())`, [userId, message, type]);
  } catch (_) {}
}
async function getParapheur(dbc, id, { forUpdate = false } = {}) {
  return dbc.queryOne(`SELECT * FROM parapheur WHERE id=?${forUpdate ? lockForUpdate() : ''}`, [id]);
}
function assertDecisionAllowed(p) {
  if (!p) { const e = new Error('Demande parapheur introuvable'); e.status = 404; throw e; }
  if (FINAL_STATUSES.includes(p.statut)) { const e = new Error(`Demande déjà clôturée (${p.statut})`); e.status = 409; throw e; }
  if (!DG_ACTION_STATUSES.includes(p.statut)) { const e = new Error(`Statut incorrect pour décision DG (${p.statut})`); e.status = 400; throw e; }
}
function assertChanged(result, reason) {
  if (!result || Number(result.affectedRows || 0) < 1) return { skipped: true, reason };
  return null;
}

async function recomputeLeaveCounters(dbc, employeId) {
  try {
    const year = String(new Date().getFullYear());
    const emp = await dbc.queryOne(`SELECT id, date_embauche, conges_report_n1, conges_maladie_droit FROM employes WHERE id=?${lockForUpdate()}`, [employeId]);
    if (!emp) return null;
    let acquis = 0;
    if (emp.date_embauche) {
      const p = await dbc.queryOne("SELECT valeur FROM parametres WHERE cle='conges_jours_par_mois'", []);
      const taux = Number(p?.valeur || 2.5);
      const now = new Date();
      const emb = new Date(emp.date_embauche);
      const debAnnee = new Date(now.getFullYear(), 0, 1);
      const ref = emb > debAnnee ? emb : debAnnee;
      const mois = Math.min(12, Math.max(0, (now.getFullYear() - ref.getFullYear()) * 12 + (now.getMonth() - ref.getMonth()) + (now.getDate() >= ref.getDate() ? 1 : 0)));
      acquis = Math.min(30, Math.round(mois * taux * 2) / 2);
    }
    const annual = await dbc.query(`
      SELECT COALESCE(SUM(nb_jours),0) AS pris FROM employes_conges
      WHERE employe_id=? AND type_conge='annuel' AND statut IN ('approuve','termine') AND SUBSTR(CAST(date_debut AS CHAR), 1, 4)=?
    `, [employeId, year]);
    const sick = await dbc.query(`
      SELECT COALESCE(SUM(nb_jours),0) AS pris FROM employes_conges
      WHERE employe_id=? AND type_conge='maladie' AND statut IN ('approuve','termine') AND SUBSTR(CAST(date_debut AS CHAR), 1, 4)=?
    `, [employeId, year]);
    const report = Number(emp.conges_report_n1 || 0);
    const annualTaken = Number(annual?.[0]?.pris || 0);
    const sickTaken = Number(sick?.[0]?.pris || 0);
    const sickRight = Number(emp.conges_maladie_droit || 15);
    await dbc.execute(`
      UPDATE employes
      SET conges_acquis_annuel=?, conges_pris_annuel=?, conges_solde_annuel=?,
          conges_maladie_pris=?, conges_maladie_solde=?, updated_at=NOW()
      WHERE id=?
    `, [acquis, annualTaken, Math.round((acquis + report - annualTaken) * 10) / 10, sickTaken, Math.max(0, sickRight - sickTaken), employeId]);
    return { acquis, annualTaken, sickTaken };
  } catch (e) { return { warning: 'leave_counter_recompute_failed', error: e.message }; }
}

async function syncOperation(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'operations' || p.type !== 'decaissement') return null;
  const op = await dbc.queryOne(`SELECT * FROM operations WHERE id=? AND type_op=?${lockForUpdate()}`, [p.ref_source_id, 'decaissement']);
  if (!op) return { skipped: true, reason: 'operation_missing' };
  const decStatut = op.dec_statut || 'brouillon';
  if (decision === 'approuve') {
    if (decStatut === 'paye' || decStatut === 'valide' || op.statut === 'valide') return { skipped: true, reason: 'operation_already_paid_or_validated' };
    if (decStatut === 'annule') return { skipped: true, reason: 'operation_final_annule' };
    const result = await dbc.execute(`UPDATE operations SET dec_statut='valide', validated_by=?, validated_at=NOW(), updated_at=NOW() WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut,'brouillon') IN ('brouillon','soumis','rejete')`, [actorId, p.ref_source_id]);
    const changed = assertChanged(result, 'operation_status_changed');
    if (changed) return changed;
    return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_valide' };
  }
  if (decStatut === 'rejete') return { skipped: true, reason: 'operation_final_rejete' };
  if (['paye', 'annule'].includes(decStatut)) return { skipped: true, reason: `cannot_reject_operation_${decStatut}` };
  const result = await dbc.execute(`UPDATE operations SET dec_statut='rejete', motif_rejet=?, rejete_par=?, rejete_at=NOW(), updated_at=NOW() WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut,'brouillon') NOT IN ('paye','annule')`, [reason || 'Rejet parapheur', actorId, p.ref_source_id]);
  const changed = assertChanged(result, 'operation_status_changed');
  if (changed) return changed;
  return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_rejete' };
}

async function syncAdvance(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'employes_avances' || p.type !== 'avance_salaire') return null;
  const av = await dbc.queryOne(`SELECT * FROM employes_avances WHERE id=?${lockForUpdate()}`, [p.ref_source_id]);
  if (!av) return { skipped: true, reason: 'advance_missing' };
  if (['decaisse', 'solde', 'annule'].includes(av.statut_workflow)) return { skipped: true, reason: `advance_final_${av.statut_workflow}` };
  if (decision === 'approuve') {
    const result = await dbc.execute(`UPDATE employes_avances SET statut_workflow='approuve_dg', approuve_par=?, approuve_at=NOW(), updated_at=NOW() WHERE id=? AND statut_workflow IN ('brouillon','soumis','rejete')`, [actorId, p.ref_source_id]);
    const changed = assertChanged(result, 'advance_status_changed');
    if (changed) return changed;
    return { synced: true, table: 'employes_avances', id: p.ref_source_id, action: 'statut_workflow_approuve_dg' };
  }
  const result = await dbc.execute(`UPDATE employes_avances SET statut_workflow='rejete', statut='annule', rejete_par=?, rejete_at=NOW(), motif_rejet=?, updated_at=NOW() WHERE id=? AND statut_workflow NOT IN ('decaisse','solde','annule')`, [actorId, reason || 'Rejet parapheur', p.ref_source_id]);
  const changed = assertChanged(result, 'advance_status_changed');
  if (changed) return changed;
  return { synced: true, table: 'employes_avances', id: p.ref_source_id, action: 'statut_workflow_rejete' };
}

async function syncLeave(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'employes_conges' || p.type !== 'conge') return null;
  const cg = await dbc.queryOne(`SELECT * FROM employes_conges WHERE id=?${lockForUpdate()}`, [p.ref_source_id]);
  if (!cg) return { skipped: true, reason: 'leave_missing' };
  if (['termine', 'annule'].includes(cg.statut)) return { skipped: true, reason: `leave_final_${cg.statut}` };
  if (decision === 'approuve') {
    if (cg.statut === 'approuve') return { skipped: true, reason: 'leave_status_approuve' };
    if (!['demande', 'valide_sup', 'refuse'].includes(cg.statut)) return { skipped: true, reason: `leave_status_${cg.statut}` };
    const overlap = await dbc.queryOne(`SELECT id FROM employes_conges WHERE employe_id=? AND id<>? AND statut='approuve' AND date_debut <= ? AND date_fin >= ? LIMIT 1`, [cg.employe_id, cg.id, cg.date_fin, cg.date_debut]);
    if (overlap) return { skipped: true, reason: 'leave_overlap', overlap_id: overlap.id };
    const result = await dbc.execute(`UPDATE employes_conges SET statut='approuve', approuve_par=?, approuve_at=NOW(), updated_by=?, updated_at=NOW() WHERE id=? AND statut IN ('demande','valide_sup','refuse')`, [actorId, actorId, cg.id]);
    const changed = assertChanged(result, 'leave_status_changed');
    if (changed) return changed;
    const counters = await recomputeLeaveCounters(dbc, cg.employe_id);
    return { synced: true, table: 'employes_conges', id: cg.id, action: 'statut_approuve', counters };
  }
  if (cg.statut === 'refuse') return { skipped: true, reason: 'leave_status_refuse' };
  if (['approuve', 'termine'].includes(cg.statut)) return { skipped: true, reason: `cannot_reject_${cg.statut}` };
  const result = await dbc.execute(`UPDATE employes_conges SET statut='refuse', refuse_par=?, refuse_at=NOW(), refuse_motif=?, updated_by=?, updated_at=NOW() WHERE id=? AND statut IN ('demande','valide_sup')`, [actorId, reason || 'Rejet parapheur', actorId, cg.id]);
  const changed = assertChanged(result, 'leave_status_changed');
  if (changed) return changed;
  return { synced: true, table: 'employes_conges', id: cg.id, action: 'statut_refuse' };
}

async function syncPurchase(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'demandes_achat' || p.type !== 'demande_achat') return null;
  const da = await dbc.queryOne(`SELECT * FROM demandes_achat WHERE id=?${lockForUpdate()}`, [p.ref_source_id]);
  if (!da) return { skipped: true, reason: 'purchase_missing' };
  if (['approuve', 'rejete'].includes(da.statut)) return { skipped: true, reason: `purchase_final_${da.statut}`, decaissement_id: da.decaissement_id || null };
  if (decision === 'rejete') {
    const result = await dbc.execute(`UPDATE demandes_achat SET statut='rejete', motif_rejet=?, approuve_par_id=?, date_approbation=CURDATE(), updated_at=NOW() WHERE id=? AND statut IN ('brouillon','soumis')`, [reason || 'Rejet parapheur', actorId, da.id]);
    const changed = assertChanged(result, 'purchase_status_changed');
    if (changed) return changed;
    await sourceAudit(dbc, 'demandes_achat', da.id, 'rejeter_parapheur', { motif: reason || 'Rejet parapheur' }, actorId);
    return { synced: true, table: 'demandes_achat', id: da.id, action: 'statut_rejete' };
  }
  let decaissementId = da.decaissement_id || null;
  if (!decaissementId) {
    const libelle = `Demande d'achat ${da.numero} — ${da.service_demandeur}`;
    const op = await dbc.execute(`
      INSERT INTO operations (type_op, date, libelle, montant, statut, dec_statut, categorie_id, position_id, ref_externe, created_by, submitted_by, submitted_at, validated_by, validated_at)
      VALUES ('decaissement', CURDATE(), ?, ?, 'en_attente', 'valide', (SELECT id FROM categories WHERE type IN ('decaissement','depense') ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END, id LIMIT 1), (SELECT id FROM positions ORDER BY id LIMIT 1), ?, ?, ?, NOW(), ?, NOW())
    `, [libelle, money(da.total_general), da.numero, actorId, actorId, actorId]);
    decaissementId = op?.insertId || op?.lastInsertRowid || null;
  }
  const result = await dbc.execute(`UPDATE demandes_achat SET statut='approuve', approuve_par_id=?, date_approbation=CURDATE(), decaissement_id=COALESCE(decaissement_id, ?), updated_at=NOW() WHERE id=? AND statut IN ('brouillon','soumis')`, [actorId, decaissementId, da.id]);
  const changed = assertChanged(result, 'purchase_status_changed');
  if (changed) return changed;
  await sourceAudit(dbc, 'demandes_achat', da.id, 'approuver_parapheur', { decaissement_id: decaissementId, montant: da.total_general }, actorId);
  return { synced: true, table: 'demandes_achat', id: da.id, action: 'statut_approuve', decaissement_id: decaissementId };
}

async function applySalaryRevision(dbc, rev, actorId) {
  const agent = await dbc.queryOne(`SELECT salaire_base, prime_transport, prime_logement FROM employes WHERE id=?${lockForUpdate()}`, [rev.employe_id]);
  if (!agent) return { skipped: true, reason: 'agent_missing_for_revision' };
  await dbc.execute(`UPDATE employes SET salaire_base=?, prime_transport=?, prime_logement=?, grille_categorie_id=?, grille_echelon_id=?, updated_at=NOW() WHERE id=?`, [money(rev.salaire_propose), money(rev.transport_propose || agent.prime_transport || 0), money(rev.logement_propose || agent.prime_logement || 0), rev.nouvelle_categorie_id || null, rev.nouvel_echelon_id || null, rev.employe_id]);
  await dbc.execute(`
    INSERT INTO historique_salaires (employe_id, date_effet, ancien_salaire, nouveau_salaire, ancien_transport, nouveau_transport, ancien_logement, nouveau_logement, ancienne_categorie_id, nouvelle_categorie_id, ancien_echelon_id, nouvel_echelon_id, motif, type_revision, demande_revision_id, approved_by, approved_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
  `, [rev.employe_id, rev.date_effet, money(rev.salaire_actuel), money(rev.salaire_propose), money(rev.transport_actuel), money(rev.transport_propose), money(rev.logement_actuel), money(rev.logement_propose), null, rev.nouvelle_categorie_id || null, null, rev.nouvel_echelon_id || null, rev.motif, rev.type_revision, rev.id, actorId, actorId]);
  await dbc.execute("UPDATE demandes_revision_salaire SET statut='applique', updated_at=NOW() WHERE id=?", [rev.id]);
  return { applied: true };
}

async function syncSalaryRevision(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'demandes_revision_salaire' || p.type !== 'revision_salariale') return null;
  const rev = await dbc.queryOne(`SELECT * FROM demandes_revision_salaire WHERE id=?${lockForUpdate()}`, [p.ref_source_id]);
  if (!rev) return { skipped: true, reason: 'revision_missing' };
  if (['applique', 'rejete', 'annule'].includes(rev.statut)) return { skipped: true, reason: `revision_final_${rev.statut}` };
  if (decision === 'rejete') {
    const result = await dbc.execute(`UPDATE demandes_revision_salaire SET statut='rejete', motif_rejet=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=? AND statut IN ('soumis_dg','soumis_rh')`, [reason || 'Rejet parapheur', actorId, rev.id]);
    const changed = assertChanged(result, 'revision_status_changed');
    if (changed) return changed;
    await sourceAudit(dbc, 'demandes_revision_salaire', rev.id, 'rejeter_parapheur', { motif: reason || 'Rejet parapheur' }, actorId);
    return { synced: true, table: 'demandes_revision_salaire', id: rev.id, action: 'statut_rejete' };
  }
  if (!['soumis_dg', 'soumis_rh', 'ajourne'].includes(rev.statut)) return { skipped: true, reason: `revision_status_${rev.statut}` };
  const result = await dbc.execute(`UPDATE demandes_revision_salaire SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=? AND statut IN ('soumis_dg','soumis_rh','ajourne')`, ['Approuvé via parapheur', actorId, rev.id]);
  const changed = assertChanged(result, 'revision_status_changed');
  if (changed) return changed;
  const refreshed = await dbc.queryOne(`SELECT * FROM demandes_revision_salaire WHERE id=?${lockForUpdate()}`, [rev.id]);
  const apply = String(refreshed.date_effet || '').slice(0, 10) <= todayISO() ? await applySalaryRevision(dbc, refreshed, actorId) : { applied: false, date_effet: refreshed.date_effet };
  await sourceAudit(dbc, 'demandes_revision_salaire', rev.id, 'approuver_parapheur', { salaire_propose: rev.salaire_propose, ...apply }, actorId);
  return { synced: true, table: 'demandes_revision_salaire', id: rev.id, action: apply.applied ? 'statut_applique' : 'statut_approuve', ...apply };
}

async function syncOffboarding(dbc, p, decision, actorId, reason) {
  if (p.ref_source_table !== 'employes_sortie' || p.type !== 'offboarding') return null;
  const dossier = await dbc.queryOne(`SELECT * FROM employes_sortie WHERE id=?${lockForUpdate()}`, [p.ref_source_id]);
  if (!dossier) return { skipped: true, reason: 'offboarding_missing' };
  if (['valide', 'solde', 'rejete', 'annule'].includes(dossier.statut)) return { skipped: true, reason: `offboarding_final_${dossier.statut}` };

  if (decision === 'rejete') {
    const result = await dbc.execute(`UPDATE employes_sortie SET statut='rejete', motif_rejet=?, validated_by=?, validated_at=NOW(), updated_at=NOW() WHERE id=? AND statut IN ('initie','calcule')`, [reason || 'Rejet parapheur', actorId, dossier.id]);
    const changed = assertChanged(result, 'offboarding_status_changed');
    if (changed) return changed;
    await sourceAudit(dbc, 'employes_sortie', dossier.id, 'rejeter_parapheur', { motif: reason || 'Rejet parapheur' }, actorId);
    return { synced: true, table: 'employes_sortie', id: dossier.id, action: 'statut_rejete' };
  }

  const result = await dbc.execute(`UPDATE employes_sortie SET statut='valide', validated_by=?, validated_at=NOW(), updated_at=NOW() WHERE id=? AND statut IN ('initie','calcule')`, [actorId, dossier.id]);
  const changed = assertChanged(result, 'offboarding_status_changed');
  if (changed) return changed;
  await dbc.execute(`UPDATE employes SET actif=0, statut_dossier='sorti', motif_sortie=?, date_sortie=?, updated_at=NOW() WHERE id=?`, [dossier.type_sortie, dossier.date_depart_effectif, dossier.employe_id]);
  await sourceAudit(dbc, 'employes_sortie', dossier.id, 'valider_parapheur', { employe_id: dossier.employe_id, type_sortie: dossier.type_sortie, solde_tout_compte_total: dossier.solde_tout_compte_total }, actorId);
  await sourceAudit(dbc, 'employes', dossier.employe_id, 'statut_sorti_parapheur', { motif: dossier.type_sortie, sortie_id: dossier.id }, actorId);
  return { synced: true, table: 'employes_sortie', id: dossier.id, action: 'statut_valide', employe_id: dossier.employe_id };
}

async function syncSource(dbc, p, decision, actorId, reason) {
  if (!p.ref_source_table || !p.ref_source_id) return { skipped: true, reason: 'no_source_ref' };
  const handlers = [syncOperation, syncAdvance, syncLeave, syncPurchase, syncSalaryRevision, syncOffboarding];
  for (const h of handlers) {
    const r = await h(dbc, p, decision, actorId, reason);
    if (r) return r;
  }
  return { skipped: true, reason: 'unsupported_source_type', table: p.ref_source_table, type: p.type };
}

function sourceSyncIsConsistent(sync, decision) {
  if (!sync?.skipped) return false;
  if (sync.reason === 'no_source_ref') return true;
  const approveConsistent = new Set([
    'operation_already_paid_or_validated',
    'advance_final_decaisse',
    'advance_final_solde',
    'leave_status_approuve',
    'leave_final_termine',
    'purchase_final_approuve',
    'revision_final_applique',
    'offboarding_final_valide',
    'offboarding_final_solde',
  ]);
  const rejectConsistent = new Set([
    'operation_final_rejete',
    'advance_final_annule',
    'leave_status_refuse',
    'leave_final_annule',
    'purchase_final_rejete',
    'revision_final_rejete',
    'revision_final_annule',
    'offboarding_final_rejete',
    'offboarding_final_annule',
  ]);
  return decision === 'approuve' ? approveConsistent.has(sync.reason) : rejectConsistent.has(sync.reason);
}

function isBlockingSourceSync(sync, decision, p) {
  if (sync?.synced) return false;
  if (sourceSyncIsConsistent(sync, decision)) return false;
  if (!p.ref_source_table && !p.ref_source_id && sync?.reason === 'no_source_ref') return false;
  return true;
}

function buildSourceSyncError(sync, p, decision) {
  const e = new Error('Synchronisation source bloquée');
  e.status = 409;
  e.source_sync = sync;
  e.parapheur = p;
  e.decision = decision;
  return e;
}

async function decide(req, res, decision) {
  try {
    if (!userHas(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const motif = decision === 'rejete' ? String(req.body?.motif || '').trim() : String(req.body?.commentaire || '').trim();
    if (decision === 'rejete' && !motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

    const result = await db.transaction(async (tx) => {
      const p = await getParapheur(tx, req.params.id, { forUpdate: true });
      assertDecisionAllowed(p);
      const sync = await syncSource(tx, p, decision, req.user.id, motif);
      if (isBlockingSourceSync(sync, decision, p)) throw buildSourceSyncError(sync, p, decision);
      const updateResult = await tx.execute('UPDATE parapheur SET statut=?, updated_at=NOW() WHERE id=? AND statut NOT IN (\'approuve\',\'rejete\')', [decision, p.id]);
      const changed = assertChanged(updateResult, 'parapheur_status_changed');
      if (changed) throw buildSourceSyncError(changed, p, decision);
      await action(tx, p.id, req.user, decision, motif || null);
      await audit(tx, p, decision, sync?.synced ? 'synced' : 'consistent_skip', sync, req.user.id);
      return { p, sync };
    });

    await notif(result.p.initiateur_id, decision === 'approuve' ? `Votre demande "${result.p.titre}" a été approuvée` : `Votre demande "${result.p.titre}" a été rejetée : ${motif}`, decision === 'approuve' ? 'parapheur_ok' : 'parapheur_ko');
    res.json({ ok: true, source_sync: result.sync });
  } catch (e) {
    if (e.source_sync && e.parapheur) await audit(db, e.parapheur, e.decision || decision, 'blocked', e.source_sync, req.user?.id || null);
    res.status(e.status || 500).json({ ok: false, error: e.message, ...(e.source_sync ? { source_sync: e.source_sync } : {}) });
  }
}

router.post('/:id/approuver', (req, res) => decide(req, res, 'approuve'));
router.post('/:id/rejeter',   (req, res) => decide(req, res, 'rejete'));

module.exports = router;
