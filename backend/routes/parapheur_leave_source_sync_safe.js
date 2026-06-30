'use strict';

const express = require('express');
const db = require('../db');
const { approveLeave, rejectLeave } = require('../services/leave_transition_workflow');

const router = express.Router();
const FINAL = new Set(['approuve', 'rejete']);
const ACTIONABLE = new Set(['transmis_dg', 'delegue', 'en_avis']);
const IS_MYSQL = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql';
const lock = () => IS_MYSQL ? ' FOR UPDATE' : '';

function isLeaveParapheur(p) {
  return p?.type === 'conge' && p?.ref_source_table === 'employes_conges' && p?.ref_source_id;
}

async function decide(req, res, next, decision) {
  try {
    const probe = await db.queryOne('SELECT id, type, ref_source_table, ref_source_id FROM parapheur WHERE id=?', [req.params.id]);
    if (!isLeaveParapheur(probe)) return next();

    const roles = new Set([req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])].filter(Boolean));
    if (!roles.has('dg') && !roles.has('manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });

    const motif = decision === 'rejete'
      ? String(req.body?.motif || '').trim()
      : String(req.body?.commentaire || '').trim();
    if (decision === 'rejete' && !motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

    const result = await db.transaction(async (tx) => {
      const p = await tx.queryOne(`SELECT * FROM parapheur WHERE id=?${lock()}`, [req.params.id]);
      if (!p) { const e = new Error('Demande parapheur introuvable'); e.status = 404; throw e; }
      if (FINAL.has(p.statut)) { const e = new Error(`Demande déjà clôturée (${p.statut})`); e.status = 409; throw e; }
      if (!ACTIONABLE.has(p.statut)) { const e = new Error(`Statut incorrect pour décision DG (${p.statut})`); e.status = 400; throw e; }

      const leave = await tx.queryOne(`SELECT id, employe_id, statut FROM employes_conges WHERE id=?${lock()}`, [p.ref_source_id]);
      if (!leave) { const e = new Error('Congé source introuvable'); e.status = 404; throw e; }

      const transition = decision === 'approuve'
        ? await approveLeave({ employeeId: leave.employe_id, leaveId: leave.id, actorId: req.user.id, dbc: tx })
        : await rejectLeave({ employeeId: leave.employe_id, leaveId: leave.id, actorId: req.user.id, reason: motif, dbc: tx });

      const changed = await tx.execute(
        "UPDATE parapheur SET statut=?, updated_at=NOW() WHERE id=? AND statut NOT IN ('approuve','rejete')",
        [decision, p.id],
      );
      if (Number(changed?.affectedRows || 0) < 1) { const e = new Error('Décision parapheur concurrente'); e.status = 409; throw e; }

      await tx.execute(`
        INSERT INTO parapheur_actions
          (parapheur_id, acteur_id, acteur_role, action_type, commentaire, destinataire_id, is_interim)
        VALUES (?, ?, ?, ?, ?, NULL, 0)
      `, [p.id, req.user.id, req.user.role || 'unknown', decision, motif || null]);

      try {
        await tx.execute(`
          INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
          VALUES ('parapheur', ?, ?, ?, ?)
        `, [p.id, 'parapheur_leave_single_engine', JSON.stringify({ decision, leave_id: leave.id, transition }), req.user.id]);
      } catch (_) {}

      return { p, leave, transition };
    });

    try {
      await db.execute(
        'INSERT INTO notif_messages (user_id, message, type, lu, created_at) VALUES (?, ?, ?, 0, NOW())',
        [result.p.initiateur_id, decision === 'approuve' ? `Votre demande "${result.p.titre}" a été approuvée` : `Votre demande "${result.p.titre}" a été rejetée : ${motif}`, decision === 'approuve' ? 'parapheur_ok' : 'parapheur_ko'],
      );
    } catch (_) {}

    return res.json({ ok: true, source_sync: { synced: true, table: 'employes_conges', id: result.leave.id, action: `statut_${result.transition.statut}`, counters: result.transition.counters } });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error.message, ...(error.details || {}) });
  }
}

router.post('/:id/approuver', (req, res, next) => decide(req, res, next, 'approuve'));
router.post('/:id/rejeter', (req, res, next) => decide(req, res, next, 'rejete'));

module.exports = router;
