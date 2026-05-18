'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { sendMail } = require('../services/email');

// ─── Helpers ────────────────────────────────────────────────────────────────

function interimActif() {
  return db.prepare(`
    SELECT * FROM parapheur_interim WHERE actif = 1 ORDER BY id DESC LIMIT 1
  `).get();
}

function userInfo(id) {
  return db.prepare('SELECT id, nom, prenom, role FROM users WHERE id = ?').get(id);
}

function logAction(parapheurId, acteurId, acteurRole, actionType, commentaire, destinataireId, isInterim) {
  db.prepare(`
    INSERT INTO parapheur_actions
      (parapheur_id, acteur_id, acteur_role, action_type, commentaire, destinataire_id, is_interim)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(parapheurId, acteurId, acteurRole, actionType, commentaire || null, destinataireId || null, isInterim ? 1 : 0);
}

function touchUpdated(id) {
  db.prepare("UPDATE parapheur SET updated_at = datetime('now') WHERE id = ?").run(id);
}

function sendNotif(userId, message, type) {
  try {
    db.prepare(`
      INSERT INTO notif_messages (user_id, message, type, lu, created_at)
      VALUES (?, ?, ?, 0, datetime('now'))
    `).run(userId, message, type || 'info');
  } catch (_) { /* notif_messages peut ne pas exister en dev */ }
}

function notifyRole(role, message, type) {
  const users = db.prepare("SELECT id FROM users WHERE role = ? AND actif = 1").all(role);
  users.forEach(u => sendNotif(u.id, message, type));
}

function notifyAssistante(message, type) {
  const interim = interimActif();
  notifyRole('assistante_direction', message, type);
  if (interim) notifyRole('dg', message, type);
}

function emailUser(userId, subject, body) {
  try {
    const u = db.prepare('SELECT email, nom FROM users WHERE id = ?').get(userId);
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
        <a href="https://talatala.topcenter.cg/dashboard.html" style="background:linear-gradient(135deg,#1A50D9,#1545B5);color:white;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Accéder à l'application →</a>
      </div>
      <p style="margin-top:16px;font-size:11px;color:#475569">Tala SMI · TOP CENTER · ${new Date().toLocaleString('fr-FR')}</p>
    </div>
  </div>`;
}

// ─── GET /api/parapheur — liste selon rôle ────────────────────────────────

router.get('/', (req, res) => {
  const { role, id: userId } = req.user;
  let rows;

  if (role === 'dg') {
    rows = db.prepare(`
      SELECT p.*,
             u.nom || ' ' || u.prenom AS initiateur_nom,
             t.nom || ' ' || t.prenom AS transmis_par_nom
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      LEFT JOIN users t ON t.id = p.transmis_par_id
      WHERE p.statut IN ('transmis_dg','en_avis','delegue')
      ORDER BY
        CASE p.priorite WHEN 'urgent' THEN 0 WHEN 'confidentiel' THEN 1 ELSE 2 END,
        p.echeance_legale ASC NULLS LAST,
        p.created_at ASC
    `).all();
  } else if (role === 'assistante_direction') {
    rows = db.prepare(`
      SELECT p.*,
             u.nom || ' ' || u.prenom AS initiateur_nom
      FROM parapheur p
      LEFT JOIN users u ON u.id = p.initiateur_id
      WHERE p.statut = 'en_attente_assistante'
      ORDER BY
        CASE p.priorite WHEN 'urgent' THEN 0 WHEN 'confidentiel' THEN 1 ELSE 2 END,
        p.created_at ASC
    `).all();
  } else {
    // Initiateur : voir ses propres demandes
    rows = db.prepare(`
      SELECT p.*
      FROM parapheur p
      WHERE p.initiateur_id = ?
      ORDER BY p.created_at DESC
    `).all(userId);
  }

  res.json({ ok: true, data: rows });
});

// ─── GET /api/parapheur/historique — historique complet (DG + assistante) ──

router.get('/historique', (req, res) => {
  const { role } = req.user;
  if (!['dg','assistante_direction','admin'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Accès refusé' });
  }
  const rows = db.prepare(`
    SELECT p.*,
           u.nom || ' ' || u.prenom AS initiateur_nom,
           t.nom || ' ' || t.prenom AS transmis_par_nom
    FROM parapheur p
    LEFT JOIN users u ON u.id = p.initiateur_id
    LEFT JOIN users t ON t.id = p.transmis_par_id
    ORDER BY p.updated_at DESC
    LIMIT 200
  `).all();
  res.json({ ok: true, data: rows });
});

// ─── GET /api/parapheur/:id ───────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const p = db.prepare(`
    SELECT p.*,
           u.nom || ' ' || u.prenom AS initiateur_nom,
           t.nom || ' ' || t.prenom AS transmis_par_nom
    FROM parapheur p
    LEFT JOIN users u ON u.id = p.initiateur_id
    LEFT JOIN users t ON t.id = p.transmis_par_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const actions = db.prepare(`
    SELECT a.*,
           u.nom || ' ' || u.prenom AS acteur_nom,
           d.nom || ' ' || d.prenom AS destinataire_nom
    FROM parapheur_actions a
    LEFT JOIN users u ON u.id = a.acteur_id
    LEFT JOIN users d ON d.id = a.destinataire_id
    WHERE a.parapheur_id = ?
    ORDER BY a.created_at ASC
  `).all(p.id);

  res.json({ ok: true, data: { ...p, actions } });
});

// ─── POST /api/parapheur — soumettre une demande ──────────────────────────

router.post('/', (req, res) => {
  const { role, id: userId } = req.user;
  const { type, titre, priorite, echeance_legale, montant, pieces_jointes,
          note_assistante, ref_source_table, ref_source_id } = req.body;

  if (!type || !titre) {
    return res.status(400).json({ ok: false, error: 'type et titre obligatoires' });
  }

  const validTypes = [
    'decaissement','paiement_cnss','paiement_dgi','demande_achat',
    'facture_fournisseur','conge','avance_salaire','revision_salariale',
    'offboarding','contrat','attestation_stage','facture_client',
    'correspondance','reclamation_agent','amelioration_agent'
  ];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ ok: false, error: 'Type de demande invalide' });
  }

  const r = db.prepare(`
    INSERT INTO parapheur
      (type, titre, initiateur_id, priorite, statut, echeance_legale, montant,
       pieces_jointes, note_assistante, ref_source_table, ref_source_id)
    VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
  `).run(
    type, titre, userId,
    priorite || 'normal',
    echeance_legale || null,
    montant || null,
    pieces_jointes ? JSON.stringify(pieces_jointes) : null,
    note_assistante || null,
    ref_source_table || null,
    ref_source_id || null
  );

  const newId = r.lastInsertRowid;
  logAction(newId, userId, role, 'soumis', null, null, false);

  // Notifier assistante (ou DG si intérim sans remplaçant)
  const interim = interimActif();
  if (interim && !interim.remplacant_id) {
    notifyRole('dg', `Nouvelle demande parapheur : ${titre}`, 'parapheur');
  } else {
    notifyAssistante(`Nouvelle demande parapheur : ${titre}`, 'parapheur');
  }

  res.json({ ok: true, id: newId });
});

// ─── POST /api/parapheur/:id/note — assistante ajoute note/priorité ───────

router.post('/:id/note', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['assistante_direction'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { note, priorite } = req.body;
  const updates = [];
  const vals = [];
  if (note !== undefined)    { updates.push('note_assistante = ?'); vals.push(note); }
  if (priorite !== undefined) { updates.push('priorite = ?');       vals.push(priorite); }
  if (!updates.length) return res.status(400).json({ ok: false, error: 'Rien à modifier' });

  vals.push(p.id);
  db.prepare(`UPDATE parapheur SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
  logAction(p.id, userId, role, priorite ? 'priorite_changee' : 'note_ajoutee', note || priorite, null, false);

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/transmettre — assistante transmet au DG ──────

router.post('/:id/transmettre', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['assistante_direction'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });
  if (p.statut !== 'en_attente_assistante') {
    return res.status(400).json({ ok: false, error: 'Statut incorrect' });
  }

  // Déterminer si l'assistante est titulaire ou remplaçant
  const interim = interimActif();
  const isInterim = interim && interim.remplacant_id === userId;
  const transmisRole = isInterim ? 'interim' : 'titulaire';

  db.prepare(`
    UPDATE parapheur SET
      statut = 'transmis_dg',
      transmis_par_id = ?,
      transmis_par_role = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(userId, transmisRole, p.id);

  logAction(p.id, userId, role, 'transmis_dg', req.body.note || null, null, isInterim);
  notifyRole('dg', `Demande transmise au DG : ${p.titre}`, 'parapheur');

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/rejeter-assistante — rejet par titulaire seul ─

router.post('/:id/rejeter-assistante', (req, res) => {
  const { role, id: userId } = req.user;
  if (role !== 'assistante_direction') {
    return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante' });
  }

  // Vérifier que c'est la titulaire (pas un remplaçant)
  const interim = interimActif();
  if (interim && interim.remplacant_id === userId) {
    return res.status(403).json({ ok: false, error: 'Le remplaçant ne peut pas rejeter' });
  }

  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });
  if (p.statut !== 'en_attente_assistante') {
    return res.status(400).json({ ok: false, error: 'Statut incorrect' });
  }

  const { motif } = req.body;
  if (!motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

  db.prepare(`UPDATE parapheur SET statut = 'rejete', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'rejete', motif, null, false);

  sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été rejetée par l'assistante : ${motif}`, 'parapheur');
  notifyRole('dg', `Rejet assistante (lecture) — "${p.titre}"`, 'parapheur');

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/approuver — DG approuve ─────────────────────

router.post('/:id/approuver', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });
  if (!['transmis_dg','delegue','en_avis'].includes(p.statut)) {
    return res.status(400).json({ ok: false, error: 'Statut incorrect' });
  }

  db.prepare(`UPDATE parapheur SET statut = 'approuve', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'approuve', req.body.commentaire || null, null, false);
  sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été approuvée`, 'parapheur_ok');
  setImmediate(() => emailUser(p.initiateur_id, `✅ Demande approuvée — ${p.titre}`,
    `<p>Bonne nouvelle ! Votre demande <strong>${p.titre}</strong> a été <strong style="color:#16a34a">approuvée</strong> par le DG.</p>`));

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/rejeter — DG rejette ────────────────────────

router.post('/:id/rejeter', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { motif } = req.body;
  if (!motif) return res.status(400).json({ ok: false, error: 'Motif obligatoire' });

  db.prepare(`UPDATE parapheur SET statut = 'rejete', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'rejete', motif, null, false);
  sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été rejetée : ${motif}`, 'parapheur_ko');
  setImmediate(() => emailUser(p.initiateur_id, `❌ Demande rejetée — ${p.titre}`,
    `<p>Votre demande <strong>${p.titre}</strong> a été <strong style="color:#dc2626">rejetée</strong> par le DG.</p>
     <p style="color:#94a3b8">Motif : ${motif}</p>`));

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/eclaircissement — DG demande éclaircissement ─

router.post('/:id/eclaircissement', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'Message obligatoire' });

  logAction(p.id, userId, role, 'eclaircissement', message, p.initiateur_id, false);
  touchUpdated(p.id);
  sendNotif(p.initiateur_id, `Le DG demande un éclaircissement sur "${p.titre}" : ${message}`, 'parapheur');
  setImmediate(() => emailUser(p.initiateur_id, `💬 Éclaircissement demandé — ${p.titre}`,
    `<p>Le DG demande un éclaircissement sur votre demande <strong>${p.titre}</strong> :</p>
     <blockquote style="border-left:3px solid #1A50D9;padding-left:12px;color:#94a3b8">${message}</blockquote>
     <p>Merci de répondre via l'application.</p>`));

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/correction — DG renvoie pour correction ──────

router.post('/:id/correction', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'Message obligatoire' });

  db.prepare(`UPDATE parapheur SET statut = 'en_correction', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'correction', message, p.initiateur_id, false);
  sendNotif(p.initiateur_id, `Correction demandée sur "${p.titre}" : ${message}`, 'parapheur');
  setImmediate(() => emailUser(p.initiateur_id, `✏️ Correction demandée — ${p.titre}`,
    `<p>Le DG vous demande de corriger votre demande <strong>${p.titre}</strong> :</p>
     <blockquote style="border-left:3px solid #ea6b00;padding-left:12px;color:#94a3b8">${message}</blockquote>
     <p>Renvoyez la demande corrigée via l'application.</p>`));

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/deleguer — DG délègue ────────────────────────

router.post('/:id/deleguer', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { destinataire_id, commentaire } = req.body;
  if (!destinataire_id) return res.status(400).json({ ok: false, error: 'Destinataire obligatoire' });

  db.prepare(`UPDATE parapheur SET statut = 'delegue', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'delegue', commentaire || null, destinataire_id, false);

  sendNotif(destinataire_id, `Le DG vous a délégué la demande "${p.titre}"`, 'parapheur');
  sendNotif(p.initiateur_id, `Votre demande "${p.titre}" a été déléguée`, 'parapheur');
  setImmediate(() => {
    emailUser(destinataire_id, `👤 Délégation — ${p.titre}`,
      `<p>Le DG vous a délégué la demande <strong>${p.titre}</strong> pour traitement.</p>`);
    emailUser(p.initiateur_id, `👤 Votre demande déléguée — ${p.titre}`,
      `<p>Votre demande <strong>${p.titre}</strong> a été déléguée par le DG.</p>`);
  });

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/avis — DG demande un avis ───────────────────

router.post('/:id/avis', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','manager'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Réservé au DG' });
  }
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { destinataire_id, question } = req.body;
  if (!destinataire_id || !question) {
    return res.status(400).json({ ok: false, error: 'destinataire_id et question obligatoires' });
  }

  db.prepare(`UPDATE parapheur SET statut = 'en_avis', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'avis_demande', question, destinataire_id, false);
  sendNotif(destinataire_id, `Le DG demande votre avis sur "${p.titre}" : ${question}`, 'parapheur');
  setImmediate(() => emailUser(destinataire_id, `👁️ Avis demandé — ${p.titre}`,
    `<p>Le DG sollicite votre avis sur la demande <strong>${p.titre}</strong> :</p>
     <blockquote style="border-left:3px solid #0ea5e9;padding-left:12px;color:#94a3b8">${question}</blockquote>
     <p>Répondez via l'application.</p>`));

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/repondre-avis — réponse à un avis demandé ───

router.post('/:id/repondre-avis', (req, res) => {
  const { id: userId, role } = req.user;
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });

  const { reponse } = req.body;
  if (!reponse) return res.status(400).json({ ok: false, error: 'Réponse obligatoire' });

  logAction(p.id, userId, role, 'avis_donne', reponse, null, false);
  // Remettre en transmis_dg pour que le DG tranche
  db.prepare(`UPDATE parapheur SET statut = 'transmis_dg', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  notifyRole('dg', `Avis reçu sur "${p.titre}"`, 'parapheur');

  res.json({ ok: true });
});

// ─── POST /api/parapheur/:id/retour-correction — initiateur renvoie ───────

router.post('/:id/retour-correction', (req, res) => {
  const { id: userId, role } = req.user;
  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });
  if (p.initiateur_id !== userId) {
    return res.status(403).json({ ok: false, error: 'Seul l\'initiateur peut renvoyer' });
  }
  if (p.statut !== 'en_correction') {
    return res.status(400).json({ ok: false, error: 'Statut incorrect' });
  }

  const { commentaire } = req.body;
  db.prepare(`UPDATE parapheur SET statut = 'en_attente_assistante', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  logAction(p.id, userId, role, 'retour_correction', commentaire || null, null, false);
  notifyAssistante(`Demande corrigée et renvoyée : ${p.titre}`, 'parapheur');

  res.json({ ok: true });
});

// ─── GESTION INTÉRIM ──────────────────────────────────────────────────────

// GET /api/parapheur/interim/actif
router.get('/interim/actif', (req, res) => {
  const interim = db.prepare(`
    SELECT i.*,
           a.nom || ' ' || a.prenom AS absent_nom,
           r.nom || ' ' || r.prenom AS remplacant_nom,
           d.nom || ' ' || d.prenom AS declare_par_nom
    FROM parapheur_interim i
    LEFT JOIN users a ON a.id = i.absent_id
    LEFT JOIN users r ON r.id = i.remplacant_id
    LEFT JOIN users d ON d.id = i.declare_par_id
    WHERE i.actif = 1
    ORDER BY i.id DESC LIMIT 1
  `).get();
  res.json({ ok: true, data: interim || null });
});

// POST /api/parapheur/interim/declarer — déclarer absence assistante
router.post('/interim/declarer', (req, res) => {
  const { role, id: userId } = req.user;
  if (!['dg','admin','assistante_direction'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Accès refusé' });
  }

  const { absent_id, remplacant_id, date_debut, date_fin_prevue } = req.body;
  if (!absent_id || !date_debut) {
    return res.status(400).json({ ok: false, error: 'absent_id et date_debut obligatoires' });
  }

  // Désactiver tout intérim actif existant
  db.prepare(`UPDATE parapheur_interim SET actif = 0 WHERE actif = 1`).run();

  const r = db.prepare(`
    INSERT INTO parapheur_interim
      (absent_id, remplacant_id, declare_par_id, date_debut, date_fin_prevue, actif)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(absent_id, remplacant_id || null, userId, date_debut, date_fin_prevue || null);

  if (remplacant_id) {
    sendNotif(remplacant_id, 'Vous êtes désigné remplaçant de l\'assistante de direction', 'parapheur');
  }
  notifyRole('dg', 'Intérim assistante activé — vous recevez les demandes en direct', 'parapheur');

  res.json({ ok: true, id: r.lastInsertRowid });
});

// POST /api/parapheur/interim/valider-retour — DG valide le retour
router.post('/interim/valider-retour', (req, res) => {
  const { role } = req.user;
  if (role !== 'dg') {
    return res.status(403).json({ ok: false, error: 'Seul le DG peut valider le retour' });
  }

  const interim = interimActif();
  if (!interim) return res.status(400).json({ ok: false, error: 'Pas d\'intérim actif' });

  db.prepare(`
    UPDATE parapheur_interim SET
      actif = 0,
      date_retour_effectif = date('now'),
      valide_retour_par_id = ?,
      valide_retour_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, interim.id);

  sendNotif(interim.absent_id, 'Votre retour a été validé par le DG — vous reprenez vos droits', 'parapheur');
  if (interim.remplacant_id) {
    sendNotif(interim.remplacant_id, 'Fin de mission intérim — vos droits élargis sont révoqués', 'parapheur');
  }

  res.json({ ok: true });
});

// GET /api/parapheur/interim/historique-remplacement — ce que le remplaçant a fait
router.get('/interim/historique-remplacement', (req, res) => {
  const { role } = req.user;
  if (!['dg','assistante_direction','admin'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Accès refusé' });
  }
  const rows = db.prepare(`
    SELECT a.*,
           u.nom || ' ' || u.prenom AS acteur_nom,
           p.titre, p.type
    FROM parapheur_actions a
    JOIN parapheur p ON p.id = a.parapheur_id
    LEFT JOIN users u ON u.id = a.acteur_id
    WHERE a.is_interim = 1
    ORDER BY a.created_at DESC
    LIMIT 100
  `).all();
  res.json({ ok: true, data: rows });
});

// ─── ALERTES ÉCHÉANCES LÉGALES ────────────────────────────────────────────

router.get('/alertes/echeances', (req, res) => {
  const { role } = req.user;
  if (!['dg','manager','admin'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'Accès refusé' });
  }

  const rows = db.prepare(`
    SELECT p.*,
           u.nom || ' ' || u.prenom AS initiateur_nom,
           julianday(p.echeance_legale) - julianday('now') AS jours_restants
    FROM parapheur p
    LEFT JOIN users u ON u.id = p.initiateur_id
    WHERE p.echeance_legale IS NOT NULL
      AND p.statut NOT IN ('approuve','rejete')
      AND julianday(p.echeance_legale) - julianday('now') <= 5
    ORDER BY jours_restants ASC
  `).all();

  res.json({ ok: true, data: rows });
});

// ─── POST /api/parapheur/alertes/envoyer-j2 — cron J-2 email DG ──────────

router.post('/alertes/envoyer-j2', (req, res) => {
  const { role } = req.user;
  if (!['dg','admin'].includes(role)) return res.status(403).json({ ok: false, error: 'Accès refusé' });

  const j2items = db.prepare(`
    SELECT p.*, u.nom || ' ' || u.prenom AS initiateur_nom
    FROM parapheur p
    LEFT JOIN users u ON u.id = p.initiateur_id
    WHERE p.echeance_legale IS NOT NULL
      AND p.statut NOT IN ('approuve','rejete')
      AND julianday(p.echeance_legale) - julianday('now') <= 2
      AND julianday(p.echeance_legale) - julianday('now') >= 0
  `).all();

  if (!j2items.length) return res.json({ ok: true, sent: 0 });

  const dgs = db.prepare("SELECT id, email, nom FROM users WHERE role IN ('dg','admin') AND actif = 1").all();
  const rows = j2items.map(p =>
    `<tr><td style="padding:6px;border-bottom:1px solid #1e293b">${p.titre}</td>
         <td style="padding:6px;border-bottom:1px solid #1e293b;color:#f87171;font-weight:700">${p.echeance_legale}</td>
         <td style="padding:6px;border-bottom:1px solid #1e293b">${p.initiateur_nom||'—'}</td></tr>`
  ).join('');

  dgs.forEach(u => {
    if (!u.email) return;
    sendMail({
      to: u.email,
      subject: `🔴 Parapheur — ${j2items.length} échéance(s) dans 48h`,
      html: emailWrap(u.nom || '', `
        <p style="color:#f87171;font-weight:600">⚠️ ${j2items.length} demande(s) parapheur arrivent à échéance dans moins de 48h :</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr>
            <th style="padding:6px;text-align:left;color:#94a3b8">Demande</th>
            <th style="padding:6px;text-align:left;color:#94a3b8">Échéance</th>
            <th style="padding:6px;text-align:left;color:#94a3b8">Initiateur</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`)
    }).catch(() => {});
  });

  res.json({ ok: true, sent: dgs.length });
});

// ─── DELETE /api/parapheur/:id — suppression (assistante titulaire seulement) ──

router.delete('/:id', (req, res) => {
  const { role, id: userId } = req.user;
  if (role !== 'assistante_direction') {
    return res.status(403).json({ ok: false, error: 'Réservé à l\'assistante titulaire' });
  }

  const interim = interimActif();
  if (interim && interim.remplacant_id === userId) {
    return res.status(403).json({ ok: false, error: 'Le remplaçant ne peut pas supprimer' });
  }

  const p = db.prepare('SELECT * FROM parapheur WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Introuvable' });
  if (!['en_attente_assistante'].includes(p.statut)) {
    return res.status(400).json({ ok: false, error: 'Seules les demandes en attente assistante peuvent être supprimées' });
  }

  db.prepare('DELETE FROM parapheur_actions WHERE parapheur_id = ?').run(p.id);
  db.prepare('DELETE FROM parapheur WHERE id = ?').run(p.id);

  res.json({ ok: true });
});

module.exports = router;
