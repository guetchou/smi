/**
 * ROUTES NOTIFICATIONS / RAPPELS / ALERTES
 * Préfixe : /api/notifs
 */
'use strict';

const express = require('express');
const db      = require('../database');
const {
  creerNotification, declencherAlerte, resoudreAlerte,
  planifierRappel, annulerRappels,
  getPreferences, setPreferences,
} = require('../services/notif');
const { hasRole } = require('./auth');
const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(user) { return hasRole(user, 'admin'); }

function param(cle, def = null) {
  const r = db.prepare('SELECT valeur FROM parametres WHERE cle=?').get(cle);
  return r ? r.valeur : def;
}

function paginationOpts(query) {
  const limit  = Math.min(Math.max(parseInt(query.limit  ?? 50,  10), 1), 200);
  const offset = Math.max(parseInt(query.offset ?? 0, 10), 0);
  return { limit, offset };
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

// GET /api/notifs/messages — fil de l'utilisateur connecté
router.get('/messages', (req, res) => {
  const { statut, famille, priorite } = req.query;
  const { limit, offset } = paginationOpts(req.query);

  let where = 'WHERE user_id = ?';
  const params = [req.user.id];

  if (statut)   { where += ' AND statut = ?';   params.push(statut); }
  if (famille)  { where += ' AND famille = ?';  params.push(famille); }
  if (priorite) { where += ' AND priorite = ?'; params.push(priorite); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM notif_messages ${where}`).get(...params).c;
  const rows  = db.prepare(
    `SELECT * FROM notif_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, items: rows });
});

// GET /api/notifs/messages/count — badge compteur (non lues)
router.get('/messages/count', (req, res) => {
  const count = db.prepare(
    "SELECT COUNT(*) as c FROM notif_messages WHERE user_id=? AND statut='non_lue'"
  ).get(req.user.id).c;
  res.json({ count });
});

// PATCH /api/notifs/messages/:id/lire — marquer une notification lue
router.patch('/messages/:id/lire', (req, res) => {
  const row = db.prepare(
    'SELECT id, user_id FROM notif_messages WHERE id=?'
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Notification introuvable' });
  if (row.user_id !== req.user.id && !isAdmin(req.user))
    return res.status(403).json({ error: 'Accès refusé' });

  db.prepare(
    "UPDATE notif_messages SET statut='lue', acquitte_at=datetime('now'), acquitte_par=?, updated_at=datetime('now') WHERE id=? AND statut='non_lue'"
  ).run(req.user.id, row.id);
  res.json({ ok: true });
});

// PATCH /api/notifs/messages/tout-lire — marquer toutes lues (pour l'utilisateur connecté)
router.patch('/messages/tout-lire', (req, res) => {
  const res2 = db.prepare(
    "UPDATE notif_messages SET statut='lue', acquitte_at=datetime('now'), acquitte_par=?, updated_at=datetime('now') WHERE user_id=? AND statut='non_lue'"
  ).run(req.user.id, req.user.id);
  res.json({ ok: true, nb: res2.changes });
});

// PATCH /api/notifs/messages/:id/archiver
router.patch('/messages/:id/archiver', (req, res) => {
  const row = db.prepare('SELECT id, user_id FROM notif_messages WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Notification introuvable' });
  if (row.user_id !== req.user.id && !isAdmin(req.user))
    return res.status(403).json({ error: 'Accès refusé' });

  db.prepare(
    "UPDATE notif_messages SET statut='archivee', updated_at=datetime('now') WHERE id=?"
  ).run(row.id);
  res.json({ ok: true });
});

// DELETE /api/notifs/messages/archivees — purge manuelle des archivées de l'utilisateur
router.delete('/messages/archivees', (req, res) => {
  const res2 = db.prepare(
    "DELETE FROM notif_messages WHERE user_id=? AND statut='archivee'"
  ).run(req.user.id);
  res.json({ ok: true, nb: res2.changes });
});

// ─── ALERTES ─────────────────────────────────────────────────────────────────

// GET /api/notifs/alertes — liste des alertes actives (selon rôle)
router.get('/alertes', (req, res) => {
  const { statut, priorite, type } = req.query;
  const { limit, offset } = paginationOpts(req.query);

  // Un non-admin ne voit que les alertes dont il est destinataire selon les règles
  let where = "WHERE 1=1";
  const params = [];

  // Filtre par statut (défaut : non résolues)
  const filtreStatut = statut ?? 'actives';
  if (filtreStatut === 'actives') {
    where += " AND a.statut NOT IN ('resolue')";
  } else if (filtreStatut !== 'toutes') {
    where += ' AND a.statut = ?'; params.push(filtreStatut);
  }
  if (priorite) { where += ' AND a.priorite = ?';  params.push(priorite); }
  if (type)     { where += ' AND a.type = ?';       params.push(type); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM alertes_actives a ${where}`).get(...params).c;
  const rows  = db.prepare(
    `SELECT a.*, p.code as pos_code, p.libelle as pos_libelle
     FROM alertes_actives a
     LEFT JOIN positions p ON p.id = a.position_id
     ${where}
     ORDER BY
       CASE a.priorite WHEN 'bloquant' THEN 0 WHEN 'critique' THEN 1 WHEN 'avertissement' THEN 2 ELSE 3 END,
       a.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, items: rows });
});

// GET /api/notifs/alertes/bloquantes — alertes bloquantes actives (pour vérif API décaissement)
router.get('/alertes/bloquantes', (req, res) => {
  const { position_id } = req.query;
  let sql = "SELECT * FROM alertes_actives WHERE bloquant=1 AND statut NOT IN ('resolue')";
  const params = [];
  if (position_id) { sql += ' AND position_id=?'; params.push(position_id); }
  res.json(db.prepare(sql).all(...params));
});

// PATCH /api/notifs/alertes/:id/acquitter
router.patch('/alertes/:id/acquitter', (req, res) => {
  const alerte = db.prepare('SELECT * FROM alertes_actives WHERE id=?').get(req.params.id);
  if (!alerte) return res.status(404).json({ error: 'Alerte introuvable' });

  // Seuls finance+admin peuvent acquitter les alertes système
  if (!hasRole(req.user, 'admin', 'finance', 'rh', 'caissier'))
    return res.status(403).json({ error: 'Accès refusé' });

  db.prepare(
    "UPDATE alertes_actives SET statut='acquittee', acquitte_par=?, acquitte_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND statut='active'"
  ).run(req.user.id, alerte.id);

  db.prepare(
    "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('alertes_actives',?,?,?,?)"
  ).run(alerte.id, 'acquitted', JSON.stringify({ par: req.user.id }), req.user.id);

  res.json({ ok: true });
});

// PATCH /api/notifs/alertes/:id/resoudre — clôture manuelle (admin)
router.patch('/alertes/:id/resoudre', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const alerte = db.prepare('SELECT id FROM alertes_actives WHERE id=?').get(req.params.id);
  if (!alerte) return res.status(404).json({ error: 'Alerte introuvable' });

  db.prepare(
    "UPDATE alertes_actives SET statut='resolue', resolu_at=datetime('now'), resolu_auto=0, updated_at=datetime('now') WHERE id=?"
  ).run(alerte.id);

  db.prepare(
    "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('alertes_actives',?,?,?,?)"
  ).run(alerte.id, 'resolved', JSON.stringify({ manual: true, par: req.user.id }), req.user.id);

  res.json({ ok: true });
});

// PATCH /api/notifs/alertes/:id/override — forcer passage malgré solde négatif (admin)
router.patch('/alertes/:id/override', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const { motif } = req.body;
  if (!motif || !motif.trim())
    return res.status(400).json({ error: 'Motif obligatoire pour l\'override' });

  const alerte = db.prepare(
    "SELECT id FROM alertes_actives WHERE id=? AND bloquant=1"
  ).get(req.params.id);
  if (!alerte) return res.status(404).json({ error: 'Alerte bloquante introuvable' });

  db.prepare(
    "UPDATE alertes_actives SET override_par=?, override_at=datetime('now'), override_motif=?, updated_at=datetime('now') WHERE id=?"
  ).run(req.user.id, motif.trim(), alerte.id);

  db.prepare(
    "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('alertes_actives',?,?,?,?)"
  ).run(alerte.id, 'override', JSON.stringify({ par: req.user.id, motif: motif.trim() }), req.user.id);

  res.json({ ok: true });
});

// ─── RAPPELS ─────────────────────────────────────────────────────────────────

// GET /api/notifs/rappels — liste (admin/rh/finance)
router.get('/rappels', (req, res) => {
  if (!hasRole(req.user, 'admin', 'rh', 'finance'))
    return res.status(403).json({ error: 'Accès refusé' });

  const { statut, type } = req.query;
  const { limit, offset } = paginationOpts(req.query);

  let where = "WHERE 1=1";
  const params = [];
  if (statut) { where += ' AND statut=?';        params.push(statut); }
  if (type)   { where += ' AND type=?';          params.push(type); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM notif_rappels ${where}`).get(...params).c;
  const rows  = db.prepare(
    `SELECT * FROM notif_rappels ${where} ORDER BY declenche_a ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, items: rows });
});

// PATCH /api/notifs/rappels/:id/acquitter
router.patch('/rappels/:id/acquitter', (req, res) => {
  if (!hasRole(req.user, 'admin', 'rh', 'finance', 'caissier'))
    return res.status(403).json({ error: 'Accès refusé' });

  const rap = db.prepare('SELECT id FROM notif_rappels WHERE id=?').get(req.params.id);
  if (!rap) return res.status(404).json({ error: 'Rappel introuvable' });

  db.prepare(
    "UPDATE notif_rappels SET statut='acquitte', acquitte_par=?, acquitte_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND statut IN ('declenche','retarde','escalade')"
  ).run(req.user.id, rap.id);

  db.prepare(
    "INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES ('notif_rappels',?,?,?,?)"
  ).run(rap.id, 'acquitted', JSON.stringify({ par: req.user.id }), req.user.id);

  res.json({ ok: true });
});

// POST /api/notifs/rappels — planifier manuellement (admin)
router.post('/rappels', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { type, src_table, src_id, declenchement_j, declenchement_h, declenche_a } = req.body;
  if (!type || !src_table || !src_id || !declenche_a)
    return res.status(400).json({ error: 'type, src_table, src_id, declenche_a requis' });

  const id = planifierRappel({ type, srcTable: src_table, srcId: src_id,
    declenchementJ: declenchement_j ?? null, declenchementH: declenchement_h ?? null,
    declenche_a });

  if (!id) return res.status(409).json({ error: 'Rappel déjà planifié pour cet objet/J-N' });
  res.status(201).json({ id });
});

// DELETE /api/notifs/rappels/:id — annuler (admin)
router.delete('/rappels/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const rap = db.prepare('SELECT * FROM notif_rappels WHERE id=?').get(req.params.id);
  if (!rap) return res.status(404).json({ error: 'Rappel introuvable' });

  db.prepare(
    "UPDATE notif_rappels SET statut='annule', annule_motif=?, updated_at=datetime('now') WHERE id=?"
  ).run(req.body?.motif ?? 'Annulation manuelle', rap.id);
  res.json({ ok: true });
});

// ─── RÈGLES (admin) ───────────────────────────────────────────────────────────

// GET /api/notifs/regles
router.get('/regles', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  res.json(db.prepare('SELECT * FROM notif_regles ORDER BY famille, type').all());
});

// PATCH /api/notifs/regles/:type — modifier actif, canaux, délais (admin)
router.patch('/regles/:type', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const regle = db.prepare('SELECT id FROM notif_regles WHERE type=?').get(req.params.type);
  if (!regle) return res.status(404).json({ error: 'Règle introuvable' });

  const allowed = ['actif','canal_inapp','canal_email','canal_push','canal_son',
                   'escalade_delai_h','grace_h','params'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' });

  const set = fields.map(f => `${f}=?`).join(', ');
  db.prepare(`UPDATE notif_regles SET ${set}, updated_at=datetime('now') WHERE type=?`)
    .run(...fields.map(f => req.body[f]), req.params.type);

  db.prepare(
    "INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES ('notif_regles',?,?,?,?)"
  ).run(regle.id, 'update', JSON.stringify({ champs: fields, par: req.user.id }), req.user.id);

  res.json({ ok: true });
});

// ─── PRÉFÉRENCES UTILISATEUR ──────────────────────────────────────────────────

// GET /api/notifs/preferences
router.get('/preferences', (req, res) => {
  res.json(getPreferences(req.user.id));
});

// PUT /api/notifs/preferences
router.put('/preferences', (req, res) => {
  const allowed = ['son_actif','son_info_actif','son_avert_actif','son_critique_actif',
                   'son_volume','son_plage_debut','son_plage_fin','notif_digest','push_actif'];
  const data = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  if (!Object.keys(data).length)
    return res.status(400).json({ error: 'Aucun champ valide fourni' });

  // son_volume : forcer dans [0.0, 1.0]
  if (data.son_volume !== undefined) {
    data.son_volume = Math.min(1.0, Math.max(0.0, parseFloat(data.son_volume) || 0.5));
  }

  setPreferences(req.user.id, data);
  res.json({ ok: true, preferences: getPreferences(req.user.id) });
});

// ─── CANAUX PAR TYPE (préférences avancées) ───────────────────────────────────

// GET /api/notifs/canaux — canaux désactivés par l'utilisateur
router.get('/canaux', (req, res) => {
  const rows = db.prepare(
    'SELECT type, canal, actif FROM notif_canaux WHERE user_id=?'
  ).all(req.user.id);
  res.json(rows);
});

// PUT /api/notifs/canaux/:type/:canal
router.put('/canaux/:type/:canal', (req, res) => {
  const { type, canal } = req.params;
  const CANAUX_VALIDES = ['inapp','email','push','son'];
  if (!CANAUX_VALIDES.includes(canal))
    return res.status(400).json({ error: `Canal invalide : ${canal}` });

  const regle = db.prepare('SELECT priorite_defaut FROM notif_regles WHERE type=?').get(type);
  if (!regle) return res.status(404).json({ error: 'Type de notification inconnu' });

  // Impossible de désactiver inapp pour critique/bloquant (sauf admin)
  const { actif } = req.body;
  if (actif === 0 && canal === 'inapp' &&
      ['critique','bloquant'].includes(regle.priorite_defaut) && !isAdmin(req.user))
    return res.status(403).json({ error: 'Canal inapp obligatoire pour les alertes critiques' });

  db.prepare(`
    INSERT INTO notif_canaux (user_id, type, canal, actif) VALUES (?,?,?,?)
    ON CONFLICT(user_id, type, canal) DO UPDATE SET actif=excluded.actif, updated_at=datetime('now')
  `).run(req.user.id, type, canal, actif ? 1 : 0);

  res.json({ ok: true });
});

// ─── PUSH SOUSCRIPTIONS (v2 — structure prête, envoi désactivé) ───────────────

// POST /api/notifs/push/subscribe
router.post('/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'endpoint, keys.p256dh et keys.auth requis' });

  try {
    db.prepare(`
      INSERT INTO push_souscriptions (user_id, endpoint, key_p256dh, key_auth, user_agent)
      VALUES (?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id=excluded.user_id, key_p256dh=excluded.key_p256dh,
        key_auth=excluded.key_auth, actif=1, erreur_410_at=NULL
    `).run(req.user.id, endpoint, keys.p256dh, keys.auth,
           req.headers['user-agent'] ?? null);

    db.prepare(
      "UPDATE user_preferences SET push_actif=1, updated_at=datetime('now') WHERE user_id=?"
    ).run(req.user.id);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur enregistrement souscription' });
  }
});

// DELETE /api/notifs/push/unsubscribe
router.delete('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis' });

  db.prepare(
    "UPDATE push_souscriptions SET actif=0 WHERE endpoint=? AND user_id=?"
  ).run(endpoint, req.user.id);

  // Désactiver push dans préférences si plus aucune souscription active
  const nbActives = db.prepare(
    "SELECT COUNT(*) as c FROM push_souscriptions WHERE user_id=? AND actif=1"
  ).get(req.user.id).c;
  if (nbActives === 0) {
    db.prepare(
      "INSERT INTO user_preferences (user_id,push_actif,updated_at) VALUES (?,0,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET push_actif=0,updated_at=datetime('now')"
    ).run(req.user.id);
  }

  res.json({ ok: true });
});

// ─── ADMIN : tableau de bord alertes ─────────────────────────────────────────

// GET /api/notifs/admin/summary — résumé pour le panneau admin
router.get('/admin/summary', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const alertesActives = db.prepare(
    "SELECT priorite, COUNT(*) as nb FROM alertes_actives WHERE statut NOT IN ('resolue') GROUP BY priorite"
  ).all();
  const rappelsDus = db.prepare(
    "SELECT COUNT(*) as nb FROM notif_rappels WHERE statut='declenche'"
  ).get().nb;
  const notifsNonLues = db.prepare(
    "SELECT COUNT(*) as nb FROM notif_messages WHERE statut='non_lue'"
  ).get().nb;
  const envoisEnEchec = db.prepare(
    "SELECT COUNT(*) as nb FROM notif_envois WHERE statut='echec'"
  ).get().nb;

  res.json({ alertesActives, rappelsDus, notifsNonLues, envoisEnEchec });
});

// GET /api/notifs/admin/envois — log des envois physiques (admin)
router.get('/admin/envois', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { statut } = req.query;
  const { limit, offset } = paginationOpts(req.query);

  let where = 'WHERE 1=1';
  const params = [];
  if (statut) { where += ' AND statut=?'; params.push(statut); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM notif_envois ${where}`).get(...params).c;
  const rows  = db.prepare(
    `SELECT * FROM notif_envois ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, items: rows });
});

// POST /api/notifs/admin/test — créer une notification de test (admin)
router.post('/admin/test', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const ids = creerNotification({
    type:      'NOTIF_USER_CREE',
    titre:     'Test notification',
    message:   'Ceci est une notification de test envoyée manuellement.',
    userIds:   [req.user.id],
    createdBy: req.user.id,
  });
  res.json({ ok: true, ids });
});

// ─── PARAMÈTRES GLOBAUX DU MODULE (admin) ────────────────────────────────────

// GET /api/notifs/admin/params
router.get('/admin/params', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const cles = [
    'notif_actif','notif_retention_jours','notif_digest_heure','notif_son_silence_global',
    'alrt_dec_valid_h','alrt_dec_paiement_h','alrt_achat_sans_suite_h',
    'alrt_connexion_nb_echecs','alrt_connexion_fenetre_min','alrt_user_inactif_jours',
    'alrt_db_volume_mo','push_vapid_public','push_vapid_email','sms_actif'
  ];
  const placeholders = cles.map(() => '?').join(',');
  const rows = db.prepare(`SELECT cle, valeur FROM parametres WHERE cle IN (${placeholders})`).all(...cles);
  const obj = {};
  rows.forEach(r => { obj[r.cle] = r.valeur; });
  res.json(obj);
});

// PUT /api/notifs/admin/params
router.put('/admin/params', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  const allowed = [
    'notif_actif','notif_retention_jours','notif_digest_heure','notif_son_silence_global',
    'alrt_dec_valid_h','alrt_dec_paiement_h','alrt_achat_sans_suite_h',
    'alrt_connexion_nb_echecs','alrt_connexion_fenetre_min','alrt_user_inactif_jours',
    'alrt_db_volume_mo'
  ];
  const upd = db.prepare('INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?,?)');
  const avant = {};
  const apres = {};

  const tx = db.transaction(() => {
    db.prepare(`SELECT cle, valeur FROM parametres WHERE cle IN (${allowed.map(()=>'?').join(',')})`).all(...allowed)
      .forEach(r => { avant[r.cle] = r.valeur; });

    for (const [k, v] of Object.entries(req.body)) {
      if (!allowed.includes(k)) continue;
      upd.run(k, String(v));
      apres[k] = String(v);
    }
  });
  tx();

  db.prepare(
    "INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES ('parametres',0,'update',?,?)"
  ).run(JSON.stringify({ avant, apres }), req.user.id);

  res.json({ ok: true });
});

// ─── SSE : temps réel ────────────────────────────────────────────────────────
// Registre des clients SSE actifs : Map<userId, Set<res>>
const _sseClients = new Map();

/**
 * Pousse un événement SSE à tous les clients connectés d'un utilisateur donné.
 * Appelé par le moteur notif via le bus d'événements interne.
 */
function ssePush(userId, event, data) {
  const clients = _sseClients.get(userId);
  if (!clients || !clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  });
}

/**
 * Pousse un événement à TOUS les clients connectés (ex: alerte solde bloquant).
 */
function sseBroadcast(event, data) {
  _sseClients.forEach((clients) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(res => {
      try { res.write(payload); } catch (_) { clients.delete(res); }
    });
  });
}

// GET /api/notifs/stream — connexion SSE (une par session navigateur)
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx : désactive le buffering
  res.flushHeaders();

  const userId = req.user.id;
  if (!_sseClients.has(userId)) _sseClients.set(userId, new Set());
  _sseClients.get(userId).add(res);

  // Envoyer le compteur non-lus immédiatement à la connexion
  const count = db.prepare(
    "SELECT COUNT(*) as c FROM notif_messages WHERE user_id=? AND statut='non_lue'"
  ).get(userId)?.c ?? 0;
  res.write(`event: badge\ndata: ${JSON.stringify({ count })}\n\n`);

  // Heartbeat toutes les 25s (keep-alive, évite timeout proxy/nginx)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = _sseClients.get(userId);
    if (set) { set.delete(res); if (!set.size) _sseClients.delete(userId); }
  });
});

module.exports = router;
module.exports.ssePush      = ssePush;
module.exports.sseBroadcast = sseBroadcast;
