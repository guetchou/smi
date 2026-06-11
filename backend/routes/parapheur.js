'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { sendMail } = require('../services/email');
const { hasRole } = require('./auth');

const FINAL_STATUSES = ['approuve', 'rejete'];
const DG_ACTION_STATUSES = ['transmis_dg', 'delegue', 'en_avis'];
const VALID_TYPES = [
  'decaissement', 'paiement_cnss', 'paiement_dgi', 'demande_achat',
  'facture_fournisseur', 'conge', 'avance_salaire', 'revision_salariale',
  'offboarding', 'contrat', 'attestation_stage', 'facture_client',
  'correspondance', 'reclamation_agent', 'amelioration_agent'
];
const VALID_PRIORITIES = ['normal', 'urgent', 'confidentiel'];

function primaryRole(user) {
  return user?.role || 'unknown';
}

function requireAnyRole(user, ...roles) {
  return hasRole(user, ...roles);
}

async function interimActif() {
  return db.queryOne(`
    SELECT * FROM parapheur_interim
    WHERE actif = 1
    ORDER BY id DESC
    LIMIT 1
  `, []);
}

async function getActiveUserOrFail(userId) {
  const user = await db.queryOne(
    'SELECT id, nom, prenom, email, role, actif FROM users WHERE id = ? AND actif = 1',
    [userId]
  );
  if (!user) {
    const err = new Error('Destinataire introuvable ou inactif');
    err.status = 400;
    throw err;
  }
  return user;
}

async function logAction(parapheurId, acteurId, acteurRole, actionType, commentaire, destinataireId, isInterim) {
  await db.execute(`
    INSERT INTO parapheur_actions
      (parapheur_id, acteur_id, acteur_role, action_type, commentaire, destinataire_id, is_interim)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    parapheurId,
    acteurId,
    acteurRole || 'unknown',
    actionType,
    commentaire || null,
    destinataireId || null,
    isInterim ? 1 : 0,
  ]);
}

async function touchUpdated(id) {
  await db.execute('UPDATE parapheur SET updated_at = NOW() WHERE id = ?', [id]);
}

async function sendNotif(userId, message, type) {
  try {
    await db.execute(`
      INSERT INTO notif_messages (user_id, message, type, lu, created_at)
      VALUES (?, ?, ?, 0, NOW())
    `, [userId, message, type || 'info']);
  } catch (_) {
    // Notification non bloquante : certains environnements de test n'ont pas notif_messages.
  }
}

async function notifyRole(role, message, type) {
  const users = await db.query(`
    SELECT id FROM users
    WHERE actif = 1
      AND (role = ? OR roles LIKE ?)
  `, [role, `%"${role}"%`]);
  for (const u of users) await sendNotif(u.id, message, type);
}

async function notifyAssistante(message, type) {
  const interim = await interimActif();
  await notifyRole('assistante_direction', message, type);
  if (interim) await notifyRole('dg', message, type);
}

async function emailUser(userId, subject, body) {
  try {
    const u = await db.queryOne('SELECT email, nom FROM users WHERE id = ?', [userId]);
    if (u?.email) sendMail({ to: u.email, subject, html: emailWrap(u.nom || '', body) }).catch(() => {});
  } catch (_) {}
}

function emailWrap(nom, body) {
  return `<div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1A50D9,#1545B5);padding:24px;text-align:center">
      <h1 style="margin:0;font-size:18px;color:white">TOP CENTER — Parapheur numérique</h1>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 12px">Bonjour <strong>${nom}</strong>,</p>
      ${body}
      <div style="margin-top:20px;text-align:center">
        <a href="${process.env.APP_URL || 'https://talatala.topcenter.cg'}/app/direction/parapheur" style="background:linear-gradient(135deg,#1A50D9,#1545B5);color:white;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Accéder au parapheur →</a>
      </div>
      <p style="margin-top:16px;font-size:11px;color:#475569">Tala SMI · TOP CENTER · ${new Date().toLocaleString('fr-FR')}</p>
    </div>
  </div>`;
}

function normalizePriority(priority) {
  if (!priority) return 'normal';
  return VALID_PRIORITIES.includes(priority) ? priority : 'normal';
}

async function getParapheurOr404(id, res) {
  const p = await db.queryOne('SELECT * FROM parapheur WHERE id = ?', [id]);
  if (!p) {
    res.status(404).json({ ok: false, error: 'Introuvable' });
    return null;
  }
  return p;
}

function assertNotFinal(p) {
  if (FINAL_STATUSES.includes(p.statut)) {
    const err = new Error(`Demande déjà clôturée (${p.statut})`);
    err.status = 409;
    throw err;
  }
}

function httpError(res, err) {
  res.status(err.status || 500).json({ ok: false, error: err.message });
}

async function auditSourceSync(p, decision, status, details, userId) {
  try {
    await db.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('parapheur', ?, ?, ?, ?)
    `, [p.id, `parapheur_source_${status}`, JSON.stringify({ decision, ...details }), userId || null]);
  } catch (_) {}
}

async function syncSourceDecision(p, decision, actorId, reason) {
  if (!p.ref_source_table || !p.ref_source_id) return { skipped: true, reason: 'no_source_ref' };

  if (p.ref_source_table === 'operations' && p.type === 'decaissement') {
    const op = await db.queryOne('SELECT * FROM operations WHERE id = ? AND type_op = ?', [p.ref_source_id, 'decaissement']);
    if (!op) return { skipped: true, reason: 'operation_missing' };
    if (op.dec_statut === 'paye' || op.statut === 'valide') return { skipped: true, reason: 'operation_already_paid_or_validated' };

    if (decision === 'approuve') {
      await db.execute(`
        UPDATE operations
        SET dec_statut='valide',
            validated_by=?,
            validated_at=NOW(),
            updated_at=NOW()
        WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut, 'brouillon') IN ('brouillon','soumis','rejete')
      `, [actorId, p.ref_source_id]);
      return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_valide' };
    }

    if (decision === 'rejete') {
      await db.execute(`
        UPDATE operations
        SET dec_statut='rejete',
            motif_rejet=?,
            rejete_par=?,
            rejete_at=NOW(),
            updated_at=NOW()
        WHERE id=? AND type_op='decaissement' AND COALESCE(dec_statut, 'brouillon') NOT IN ('paye','annule')
      `, [reason || 'Rejet parapheur', actorId, p.ref_source_id]);
      return { synced: true, table: 'operations', id: p.ref_source_id, action: 'dec_statut_rejete' };
    }
  }

  return { skipped: true, reason: 'unsupported_source_type', table: p.ref_source_table, type: p.type };
}

// ─── GET /api/parapheur — liste selon rôle ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    let rows;

    if (requireAnyRole(req.user, 'dg', 'manager')) {
      rows = await db.query(`
        SELECT p.*,
               TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom,
               TRIM(t.nom || CASE WHEN COALESCE(t.prenom,'') != '' THEN ' ' || t.prenom ELSE '' END) AS transmis_par_nom
        FROM parapheur p
        LEFT JOIN users u ON u.id = p.initiateur_id
        LEFT JOIN users t ON t.id = p.transmis_par_id
        WHERE p.statut IN ('transmis_dg','en_avis','delegue')
        ORDER BY
          CASE p.priorite WHEN 'urgent' THEN 0 WHEN 'confidentiel' THEN 1 ELSE 2 END,
          ISNULL(p.echeance_legale), p.echeance_legale ASC,
          p.created_at ASC
      `, []);
    } else if (requireAnyRole(req.user, 'assistante_direction')) {
      rows = await db.query(`
        SELECT p.*,
               TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom
        FROM parapheur p
        LEFT JOIN users u ON u.id = p.initiateur_id
        WHERE p.statut = 'en_attente_assistante'
        ORDER BY
          CASE p.priorite WHEN 'urgent' THEN 0 WHEN 'confidentiel' THEN 1 ELSE 2 END,
          p.created_at ASC
      `, []);
    } else {
      rows = await db.query(`
        SELECT p.*
        FROM parapheur p
        WHERE p.initiateur_id = ?
        ORDER BY p.created_at DESC
      `, [userId]);
    }

    res.json({ ok: true, data: rows });
  } catch (e) { httpError(res, e); }
});

router.get('/historique', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager', 'assistante_direction', 'admin')) {
      return res.status(403).json({ ok: false, error: 'Accès refusé' });
    }
    const rows = await db.query(`
      SELECT p.*,
             TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom,
             TRIM(t.nom || CASE WHEN COALESCE(t.prenom,'') != '' THEN ' ' || t.prenom ELSE '' END) AS transmis_par_nom
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      LEFT JOIN users t ON t.id = p.transmis_par_id
      ORDER BY p.updated_at DESC
      LIMIT 200
    `, []);
    res.json({ ok: true, data: rows });
  } catch (e) { httpError(res, e); }
});

router.get('/interim/actif', async (req, res) => {
  try {
    const interim = await db.queryOne(`
      SELECT i.*,
             TRIM(a.nom || CASE WHEN COALESCE(a.prenom,'') != '' THEN ' ' || a.prenom ELSE '' END) AS absent_nom,
             TRIM(r.nom || CASE WHEN COALESCE(r.prenom,'') != '' THEN ' ' || r.prenom ELSE '' END) AS remplacant_nom,
             TRIM(d.nom || CASE WHEN COALESCE(d.prenom,'') != '' THEN ' ' || d.prenom ELSE '' END) AS declare_par_nom
      FROM parapheur_interim i
      LEFT JOIN users a ON a.id = i.absent_id
      LEFT JOIN users r ON r.id = i.remplacant_id
      LEFT JOIN users d ON d.id = i.declare_par_id
      WHERE i.actif = 1
      ORDER BY i.id DESC LIMIT 1
    `, []);
    res.json({ ok: true, data: interim || null });
  } catch (e) { httpError(res, e); }
});

router.get('/interim/historique-remplacement', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager', 'assistante_direction', 'admin')) {
      return res.status(403).json({ ok: false, error: 'Accès refusé' });
    }
    const rows = await db.query(`
      SELECT a.*,
             TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS acteur_nom,
             p.titre, p.type
      FROM parapheur_actions a
      JOIN parapheur p ON p.id = a.parapheur_id
      LEFT JOIN users u ON u.id = a.acteur_id
      WHERE a.is_interim = 1
      ORDER BY a.created_at DESC
      LIMIT 100
    `, []);
    res.json({ ok: true, data: rows });
  } catch (e) { httpError(res, e); }
});

router.get('/alertes/echeances', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager', 'admin')) {
      return res.status(403).json({ ok: false, error: 'Accès refusé' });
    }
    const rows = await db.query(`
      SELECT p.*,
             TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom,
             DATEDIFF(p.echeance_legale, CURDATE()) AS jours_restants
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      WHERE p.echeance_legale IS NOT NULL
        AND p.statut NOT IN ('approuve','rejete')
        AND DATEDIFF(p.echeance_legale, CURDATE()) <= 5
      ORDER BY jours_restants ASC
    `, []);
    res.json({ ok: true, data: rows });
  } catch (e) { httpError(res, e); }
});

router.get('/:id', async (req, res) => {
  try {
    const p = await db.queryOne(`
      SELECT p.*,
             TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom,
             TRIM(t.nom || CASE WHEN COALESCE(t.prenom,'') != '' THEN ' ' || t.prenom ELSE '' END) AS transmis_par_nom
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      LEFT JOIN users t ON t.id = p.transmis_par_id
      WHERE p.id = ?
    `, [req.params.id]);
    if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

    const canView = p.initiateur_id === req.user.id
      || requireAnyRole(req.user, 'admin', 'dg', 'manager', 'assistante_direction')
      || (p.statut === 'delegue' || p.statut === 'en_avis');
    if (!canView) return res.status(403).json({ ok: false, error: 'Accès refusé' });

    const actions = await db.query(`
      SELECT a.*,
             TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS acteur_nom,
             TRIM(d.nom || CASE WHEN COALESCE(d.prenom,'') != '' THEN ' ' || d.prenom ELSE '' END) AS destinataire_nom
      FROM parapheur_actions a
      LEFT JOIN users u ON u.id = a.acteur_id
      LEFT JOIN users d ON d.id = a.destinataire_id
      WHERE a.parapheur_id = ?
      ORDER BY a.created_at ASC
    `, [p.id]);

    res.json({ ok: true, data: { ...p, actions } });
  } catch (e) { httpError(res, e); }
});

router.post('/', async (req, res) => {
  try {
    const { type, titre, priorite, echeance_legale, montant, pieces_jointes,
            note_assistante, ref_source_table, ref_source_id } = req.body;
    if (!type || !titre) return res.status(400).json({ ok: false, error: 'type et titre obligatoires' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ ok: false, error: 'Type de demande invalide' });

    const r = await db.execute(`
      INSERT INTO parapheur
        (type, titre, initiateur_id, priorite, statut, echeance_legale, montant,
         pieces_jointes, note_assistante, ref_source_table, ref_source_id)
      VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
    `, [
      type,
      titre,
      req.user.id,
      normalizePriority(priorite),
      echeance_legale || null,
      montant || null,
      pieces_jointes ? JSON.stringify(pieces_jointes) : null,
      note_assistante || null,
      ref_source_table || null,
      ref_source_id || null,
    ]);

    await logAction(r.insertId, req.user.id, primaryRole(req.user), 'soumis', null, null, false);
    const interim = await interimActif();
    if (interim && !interim.remplacant_id) await notifyRole('dg', `Nouvelle demande parapheur : ${titre}`, 'parapheur');
    else await notifyAssistante(`Nouvelle demande parapheur : ${titre}`, 'parapheur');

    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/note', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'assistante_direction')) {
      return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
    }
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (p.statut !== 'en_attente_assistante') return res.status(400).json({ ok: false, error: 'Statut incorrect' });

    const { note, priorite } = req.body;
    const updates = [];
    const vals = [];
    if (note !== undefined) { updates.push('note_assistante = ?'); vals.push(note); }
    if (priorite !== undefined) { updates.push('priorite = ?'); vals.push(normalizePriority(priorite)); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Rien à modifier' });

    vals.push(p.id);
    await db.execute(`UPDATE parapheur SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);
    await logAction(p.id, req.user.id, primaryRole(req.user), priorite ? 'priorite_changee' : 'note_ajoutee', note || priorite, null, false);
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/transmettre', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'assistante_direction')) {
      return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
    }
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (p.statut !== 'en_attente_assistante') return res.status(400).json({ ok: false, error: 'Statut incorrect' });

    const interim = await interimActif();
    const isInterim = interim && Number(interim.remplacant_id) === Number(req.user.id);
    await db.execute(`
      UPDATE parapheur
      SET statut='transmis_dg', transmis_par_id=?, transmis_par_role=?, updated_at=NOW()
      WHERE id=?
    `, [req.user.id, isInterim ? 'interim' : 'titulaire', p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'transmis_dg', req.body.note || null, null, isInterim);
    await notifyRole('dg', `Demande transmise au DG : ${p.titre}`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/rejeter-assistante', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'assistante_direction')) {
      return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
    }
    const interim = await interimActif();
    if (interim && Number(interim.remplacant_id) === Number(req.user.id)) {
      return res.status(403).json({ ok: false, error: 'Le remplaçant ne peut pas rejeter' });
    }
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (p.statut !== 'en_attente_assistante') return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const motif = String(req.body?.motif || '').trim();
    if (!motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

    const syncResult = await syncSourceDecision(p, 'rejete', req.user.id, motif);
    await db.execute('UPDATE parapheur SET statut = \'rejete\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'rejete', motif, null, false);
    await auditSourceSync(p, 'rejete', syncResult.synced ? 'synced' : 'skipped', syncResult, req.user.id);
    await sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été rejetée par l'assistante : ${motif}`, 'parapheur');
    await notifyRole('dg', `Rejet assistante (lecture) — "${p.titre}"`, 'parapheur');
    res.json({ ok: true, source_sync: syncResult });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/approuver', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) {
      return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    }
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });

    const syncResult = await syncSourceDecision(p, 'approuve', req.user.id, req.body?.commentaire || null);
    await db.execute('UPDATE parapheur SET statut = \'approuve\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'approuve', req.body.commentaire || null, null, false);
    await auditSourceSync(p, 'approuve', syncResult.synced ? 'synced' : 'skipped', syncResult, req.user.id);
    await sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été approuvée`, 'parapheur_ok');
    setImmediate(() => emailUser(p.initiateur_id, `✅ Demande approuvée — ${p.titre}`,
      `<p>Votre demande <strong>${p.titre}</strong> a été <strong style="color:#16a34a">approuvée</strong>.</p>`));
    res.json({ ok: true, source_sync: syncResult });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/rejeter', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) {
      return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    }
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const motif = String(req.body?.motif || '').trim();
    if (!motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

    const syncResult = await syncSourceDecision(p, 'rejete', req.user.id, motif);
    await db.execute('UPDATE parapheur SET statut = \'rejete\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'rejete', motif, null, false);
    await auditSourceSync(p, 'rejete', syncResult.synced ? 'synced' : 'skipped', syncResult, req.user.id);
    await sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été rejetée : ${motif}`, 'parapheur_ko');
    setImmediate(() => emailUser(p.initiateur_id, `❌ Demande rejetée — ${p.titre}`,
      `<p>Votre demande <strong>${p.titre}</strong> a été rejetée.</p><p style="color:#94a3b8">Motif : ${motif}</p>`));
    res.json({ ok: true, source_sync: syncResult });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/eclaircissement', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message obligatoire' });
    await logAction(p.id, req.user.id, primaryRole(req.user), 'eclaircissement', message, p.initiateur_id, false);
    await touchUpdated(p.id);
    await sendNotif(p.initiateur_id, `Le DG demande un éclaircissement sur "${p.titre}" : ${message}`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/correction', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message obligatoire' });
    await db.execute('UPDATE parapheur SET statut = \'en_correction\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'correction', message, p.initiateur_id, false);
    await sendNotif(p.initiateur_id, `Correction demandée sur "${p.titre}" : ${message}`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/deleguer', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const destinataireId = Number(req.body?.destinataire_id || 0);
    if (!destinataireId) return res.status(400).json({ ok: false, error: 'Destinataire obligatoire' });
    await getActiveUserOrFail(destinataireId);
    await db.execute('UPDATE parapheur SET statut = \'delegue\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'delegue', req.body.commentaire || null, destinataireId, false);
    await sendNotif(destinataireId, `Le DG vous a délégué la demande "${p.titre}"`, 'parapheur');
    await sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été déléguée`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/avis', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'manager')) return res.status(403).json({ ok: false, error: 'Réservé au DG' });
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (!DG_ACTION_STATUSES.includes(p.statut)) return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const destinataireId = Number(req.body?.destinataire_id || 0);
    const question = String(req.body?.question || '').trim();
    if (!destinataireId || !question) return res.status(400).json({ ok: false, error: 'destinataire_id et question obligatoires' });
    await getActiveUserOrFail(destinataireId);
    await db.execute('UPDATE parapheur SET statut = \'en_avis\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'avis_demande', question, destinataireId, false);
    await sendNotif(destinataireId, `Le DG demande votre avis sur "${p.titre}" : ${question}`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/repondre-avis', async (req, res) => {
  try {
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    assertNotFinal(p);
    if (p.statut !== 'en_avis') return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    const reponse = String(req.body?.reponse || '').trim();
    if (!reponse) return res.status(400).json({ ok: false, error: 'Réponse obligatoire' });
    await logAction(p.id, req.user.id, primaryRole(req.user), 'avis_donne', reponse, null, false);
    await db.execute('UPDATE parapheur SET statut = \'transmis_dg\', updated_at = NOW() WHERE id = ?', [p.id]);
    await notifyRole('dg', `Avis reçu sur "${p.titre}"`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/:id/retour-correction', async (req, res) => {
  try {
    const p = await getParapheurOr404(req.params.id, res); if (!p) return;
    if (Number(p.initiateur_id) !== Number(req.user.id)) return res.status(403).json({ ok: false, error: 'Seul l\'initiateur peut renvoyer' });
    if (p.statut !== 'en_correction') return res.status(400).json({ ok: false, error: 'Statut incorrect' });
    await db.execute('UPDATE parapheur SET statut = \'en_attente_assistante\', updated_at = NOW() WHERE id = ?', [p.id]);
    await logAction(p.id, req.user.id, primaryRole(req.user), 'retour_correction', req.body.commentaire || null, null, false);
    await notifyAssistante(`Demande corrigée et renvoyée : ${p.titre}`, 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/interim/declarer', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'admin', 'assistante_direction')) return res.status(403).json({ ok: false, error: 'Accès refusé' });
    const { absent_id, remplacant_id, date_debut, date_fin_prevue } = req.body;
    if (!absent_id || !date_debut) return res.status(400).json({ ok: false, error: 'absent_id et date_debut obligatoires' });
    await getActiveUserOrFail(absent_id);
    if (remplacant_id) await getActiveUserOrFail(remplacant_id);
    await db.execute('UPDATE parapheur_interim SET actif = 0 WHERE actif = 1', []);
    const r = await db.execute(`
      INSERT INTO parapheur_interim
        (absent_id, remplacant_id, declare_par_id, date_debut, date_fin_prevue, actif)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [absent_id, remplacant_id || null, req.user.id, date_debut, date_fin_prevue || null]);
    if (remplacant_id) await sendNotif(remplacant_id, 'Vous êtes désigné remplaçant de l\'assistante de direction', 'parapheur');
    await notifyRole('dg', 'Intérim assistante activé — vous recevez les demandes en direct', 'parapheur');
    res.json({ ok: true, id: r.insertId });
  } catch (e) { httpError(res, e); }
});

router.post('/interim/valider-retour', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg')) return res.status(403).json({ ok: false, error: 'Seul le DG peut valider le retour' });
    const interim = await interimActif();
    if (!interim) return res.status(400).json({ ok: false, error: 'Pas d\'intérim actif' });
    await db.execute(`
      UPDATE parapheur_interim
      SET actif=0, date_retour_effectif=CURDATE(), valide_retour_par_id=?, valide_retour_at=NOW()
      WHERE id=?
    `, [req.user.id, interim.id]);
    await sendNotif(interim.absent_id, 'Votre retour a été validé par le DG — vous reprenez vos droits', 'parapheur');
    if (interim.remplacant_id) await sendNotif(interim.remplacant_id, 'Fin de mission intérim — vos droits élargis sont révoqués', 'parapheur');
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

router.post('/alertes/envoyer-j2', async (req, res) => {
  try {
    if (!requireAnyRole(req.user, 'dg', 'admin')) return res.status(403).json({ ok: false, error: 'Accès refusé' });
    const j2items = await db.query(`
      SELECT p.*, TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != '' THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      WHERE p.echeance_legale IS NOT NULL
        AND p.statut NOT IN ('approuve','rejete')
        AND DATEDIFF(p.echeance_legale, CURDATE()) <= 2
        AND DATEDIFF(p.echeance_legale, CURDATE()) >= 0
    `, []);
    if (!j2items.length) return res.json({ ok: true, sent: 0 });
    const dgs = await db.query("SELECT id, email, nom FROM users WHERE actif = 1 AND (role IN ('dg','admin') OR roles LIKE '%\"dg\"%' OR roles LIKE '%\"admin\"%')", []);
    const rows = j2items.map(p =>
      `<tr><td style="padding:6px;border-bottom:1px solid #1e293b">${p.titre}</td>
           <td style="padding:6px;border-bottom:1px solid #1e293b;color:#f87171;font-weight:700">${p.echeance_legale}</td>
           <td style="padding:6px;border-bottom:1px solid #1e293b">${p.initiateur_nom || '—'}</td></tr>`
    ).join('');
    dgs.forEach(u => {
      if (!u.email) return;
      sendMail({
        to: u.email,
        subject: `🔴 Parapheur — ${j2items.length} échéance(s) dans 48h`,
        html: emailWrap(u.nom || '', `<p style="color:#f87171;font-weight:600">⚠️ ${j2items.length} demande(s) arrivent à échéance dans moins de 48h :</p><table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>${rows}</tbody></table>`),
      }).catch(() => {});
    });
    res.json({ ok: true, sent: dgs.length });
  } catch (e) { httpError(res, e); }
});

module.exports = router;
