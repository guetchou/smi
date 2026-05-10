/**
 * SERVICE NOTIFICATIONS — Moteur de règles, anti-doublon, audit, livraison
 * Couvre : notifications, rappels, alertes, envois email, escalades
 */
'use strict';

const db         = require('../database');
const { sendMail } = require('./email');
const crypto     = require('crypto');

// Bus SSE — référence chargée lazily pour éviter la dépendance circulaire
function _ssePush(userId, event, data) {
  try {
    const { ssePush } = require('../routes/notifs');
    ssePush(userId, event, data);
  } catch (_) {}
}
function _sseBroadcast(event, data) {
  try {
    const { sseBroadcast } = require('../routes/notifs');
    sseBroadcast(event, data);
  } catch (_) {}
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

function param(cle, defaut = null) {
  const row = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
  return row ? row.valeur : defaut;
}

function moduleActif() {
  return param('notif_actif', '1') === '1';
}

function regle(type) {
  return db.prepare('SELECT * FROM notif_regles WHERE type = ? AND actif = 1').get(type);
}

function usersParRoles(roles) {
  if (!roles || !roles.length) return [];
  const placeholders = roles.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, nom, email FROM users
     WHERE actif = 1
       AND (role IN (${placeholders})
         OR EXISTS (
           SELECT 1 FROM json_each(COALESCE(roles,'[]')) j WHERE j.value IN (${placeholders})
         )
       )`
  ).all(...roles, ...roles);
}

function rolesDestArr(type) {
  const r = regle(type);
  if (!r) return ['admin'];
  try { return JSON.parse(r.roles_dest); } catch { return ['admin']; }
}

// Clé de déduplication — une même alerte ne génère qu'un envoi email par heure par destinataire
function dedupKey(type, srcId, canal, userId) {
  const heure = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return crypto.createHash('sha1')
    .update(`${type}:${srcId ?? ''}:${canal}:${userId}:${heure}`)
    .digest('hex');
}

// ─── Audit ────────────────────────────────────────────────────────────────────

function audit(tableName, recordId, action, details, userId = null) {
  try {
    db.prepare(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)"
    ).run(tableName, recordId, action, JSON.stringify(details), userId);
  } catch (_) { /* non-bloquant */ }
}

// ─── LIVRAISON EMAIL ──────────────────────────────────────────────────────────

async function envoyerEmail({ userId, destinataire, type, srcId, subject, html, notifId = null, alerteId = null, rappelId = null }) {
  if (!destinataire) return;

  const key = dedupKey(type, srcId, 'email', userId);

  // Anti-doublon : INSERT OR IGNORE sur dedup_key unique
  let envoi;
  try {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO notif_envois
        (notif_id, alerte_id, rappel_id, canal, destinataire, user_id, statut, dedup_key)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const result = ins.run(notifId, alerteId, rappelId, 'email', destinataire, userId, 'en_attente', key);
    if (result.changes === 0) return; // doublon dans la fenêtre d'une heure
    envoi = result.lastInsertRowid;
  } catch (_) { return; }

  try {
    await sendMail({ to: destinataire, subject, html });
    db.prepare(
      "UPDATE notif_envois SET statut='envoye', sent_at=datetime('now'), tentatives=tentatives+1, derniere_tentative=datetime('now') WHERE id=?"
    ).run(envoi);
    audit('email', 0, 'sent', { to: destinataire, type, src_id: srcId }, userId);
  } catch (err) {
    db.prepare(
      "UPDATE notif_envois SET statut='echec', erreur=?, tentatives=tentatives+1, derniere_tentative=datetime('now') WHERE id=?"
    ).run(err.message, envoi);
    audit('email', 0, 'failed', { to: destinataire, type, erreur: err.message }, userId);
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

/**
 * Crée une notification pour un ou plusieurs utilisateurs.
 * opts = { type, titre, message, srcTable?, srcId?, roles?, userIds?, priorite?, createdBy? }
 *
 * - Si userIds est fourni : livré exactement à ces utilisateurs.
 * - Sinon : destinataires déduits depuis notif_regles.roles_dest.
 * - Anti-doublon : une seule notif par (type × srcId × userId) dans la même heure.
 */
function creerNotification(opts) {
  if (!moduleActif()) return [];
  const { type, titre, message, srcTable = null, srcId = null,
          roles = null, userIds = null, priorite = null, createdBy = null } = opts;

  const r = regle(type);
  if (!r) return [];

  const prio  = priorite ?? r.priorite_defaut;
  const cibles = userIds
    ? db.prepare(`SELECT id, nom, email FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) AND actif=1`).all(...userIds)
    : usersParRoles(roles ?? JSON.parse(r.roles_dest ?? '["admin"]'));

  const ins = db.prepare(`
    INSERT INTO notif_messages
      (type, famille, priorite, titre, message, user_id, src_table, src_id)
    VALUES ('notification','notification',?,?,?,?,?,?)
  `);

  const ids = [];
  const tx = db.transaction(() => {
    for (const u of cibles) {
      // Anti-doublon inapp : même type+srcId dans la dernière heure
      // datetime('now','-1 hour') reste en UTC SQLite — format cohérent avec les données
      const exist = db.prepare(`
        SELECT id FROM notif_messages
        WHERE type=? AND (src_id IS ?) AND user_id=?
          AND created_at > datetime('now','-1 hour')
          AND statut != 'archivee'
        LIMIT 1
      `).get(type, srcId, u.id);
      if (exist) { ids.push(exist.id); continue; }

      const res = ins.run(prio, titre, message, u.id, srcTable, srcId);
      ids.push(res.lastInsertRowid);
      audit('notif_messages', res.lastInsertRowid, 'created',
        { type, user_id: u.id, src_table: srcTable, src_id: srcId }, createdBy);
      // SSE : badge + message immédiat pour cet utilisateur
      setImmediate(() => {
        const newCount = db.prepare(
          "SELECT COUNT(*) as c FROM notif_messages WHERE user_id=? AND statut='non_lue'"
        ).get(u.id)?.c ?? 0;
        _ssePush(u.id, 'badge',   { count: newCount });
        _ssePush(u.id, 'message', { id: res.lastInsertRowid, type, famille: 'notification', priorite: prio, titre, message, statut: 'non_lue', src_table: srcTable, src_id: srcId, created_at: new Date().toISOString() });
      });
    }
  });
  tx();

  // Envoi email asynchrone si canal_email activé
  if (r.canal_email) {
    setImmediate(() => {
      for (const u of cibles) {
        if (!u.email) continue;
        const notifId = ids[cibles.indexOf(u)];
        envoyerEmail({
          userId:      u.id,
          destinataire: u.email,
          type, srcId,
          subject:     `[TOP CENTER] ${titre}`,
          html:        `<div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:14px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#1A50D9,#1545B5);padding:24px;text-align:center">
              <h2 style="margin:0;font-size:18px;color:#fff">TOP CENTER — Tala SMI</h2>
            </div>
            <div style="padding:24px">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600">${titre}</p>
              <p style="margin:0;color:#94a3b8;font-size:13px">${message}</p>
              <p style="margin:20px 0 0;font-size:11px;color:#475569">${new Date().toLocaleString('fr-FR')}</p>
            </div>
          </div>`,
          notifId
        }).catch(() => {});
      }
    });
  }

  return ids;
}

// ─── ALERTES ─────────────────────────────────────────────────────────────────

/**
 * Crée ou met à jour une alerte active.
 * Déduplication stricte : une seule alerte active par (type × src × position).
 * opts = { type, titre, message, srcTable?, srcId?, positionId?, details?, createdBy? }
 * Retourne { id, created: bool }
 */
function declencherAlerte(opts) {
  if (!moduleActif()) return null;
  const { type, titre, message,
          srcTable = null, srcId = null, positionId = null,
          details = null, createdBy = null } = opts;

  const r = regle(type);
  if (!r) return null;

  const prio    = r.priorite_defaut;
  const bloque  = prio === 'bloquant' ? 1 : 0;
  const now     = new Date().toISOString();
  const detJson = details ? JSON.stringify(details) : null;

  // Chercher une alerte active existante (non résolue)
  const existing = db.prepare(`
    SELECT id, statut FROM alertes_actives
    WHERE type=?
      AND COALESCE(src_table,'')   = COALESCE(?,'')
      AND COALESCE(src_id,-1)      = COALESCE(?,-1)
      AND COALESCE(position_id,-1) = COALESCE(?,-1)
      AND statut NOT IN ('resolue')
  `).get(type, srcTable, srcId, positionId);

  if (existing) {
    // Mettre à jour la détection (heartbeat) sans changer le statut acquitté
    db.prepare(
      "UPDATE alertes_actives SET derniere_detection=?, message=?, details=?, updated_at=? WHERE id=?"
    ).run(now, message, detJson, now, existing.id);
    return { id: existing.id, created: false };
  }

  // Nouvelle alerte
  const res = db.prepare(`
    INSERT INTO alertes_actives
      (type, priorite, bloquant, src_table, src_id, position_id, titre, message, details)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(type, prio, bloque, srcTable, srcId, positionId, titre, message, detJson);

  const id = res.lastInsertRowid;
  audit('alertes_actives', id, 'created', { type, priorite: prio, bloquant: bloque }, createdBy);

  // Créer une notif inapp pour chaque destinataire de la règle
  const roles = JSON.parse(r.roles_dest ?? '["admin"]');
  const cibles = usersParRoles(roles);
  const insMsg = db.prepare(`
    INSERT INTO notif_messages (type, famille, priorite, titre, message, user_id, src_table, src_id)
    VALUES (?, 'alerte', ?, ?, ?, ?, ?, ?)
  `);
  const txMsg = db.transaction(() => {
    for (const u of cibles) insMsg.run(type, prio, titre, message, u.id, srcTable, srcId);
  });
  txMsg();

  // SSE : pousser l'alerte en temps réel à tous les clients concernés
  setImmediate(() => {
    const alertePayload = { id, type, priorite: prio, bloquant: bloque, titre, message, statut: 'active', position_id: positionId ?? null };
    if (prio === 'bloquant') {
      _sseBroadcast('alerte', alertePayload);
    } else {
      for (const u of cibles) {
        _ssePush(u.id, 'alerte', alertePayload);
        const cnt = db.prepare("SELECT COUNT(*) as c FROM notif_messages WHERE user_id=? AND statut='non_lue'").get(u.id)?.c ?? 0;
        _ssePush(u.id, 'badge', { count: cnt });
      }
    }
  });

  // Envoi email si canal_email activé sur la règle
  if (r.canal_email) {
    setImmediate(() => {
      for (const u of cibles) {
        if (!u.email) continue;
        envoyerEmail({
          userId:      u.id,
          destinataire: u.email,
          type, srcId,
          subject:     `⚠️ Alerte TOP CENTER — ${titre}`,
          html: _htmlAlerte(prio, titre, message),
          alerteId:    id
        }).catch(() => {});
      }
    });
  }

  return { id, created: true };
}

/**
 * Résoudre automatiquement une alerte quand la condition disparaît.
 */
function resoudreAlerte(type, srcTable = null, srcId = null, positionId = null) {
  const now = new Date().toISOString();
  const res = db.prepare(`
    UPDATE alertes_actives
    SET statut='resolue', resolu_at=?, resolu_auto=1, updated_at=?
    WHERE type=?
      AND COALESCE(src_table,'')   = COALESCE(?,'')
      AND COALESCE(src_id,-1)      = COALESCE(?,-1)
      AND COALESCE(position_id,-1) = COALESCE(?,-1)
      AND statut NOT IN ('resolue')
  `).run(now, now, type, srcTable, srcId, positionId);
  if (res.changes > 0) {
    audit('alertes_actives', 0, 'resolved',
      { type, src_table: srcTable, src_id: srcId, auto: true });
    // SSE : notifier la résolution à tous les clients
    setImmediate(() => _sseBroadcast('alerte_resolue', { type, src_table: srcTable, src_id: srcId }));
  }
  return res.changes;
}

// ─── RAPPELS ─────────────────────────────────────────────────────────────────

/**
 * Planifie un rappel unique (idempotent sur type × src × J).
 * opts = { type, srcTable, srcId, declenchementJ?, declenchementH?, declenche_a }
 */
function planifierRappel(opts) {
  if (!moduleActif()) return null;
  const { type, srcTable, srcId,
          declenchementJ = null, declenchementH = null, declenche_a } = opts;

  const r = regle(type);
  if (!r) return null;

  // Idempotent : ne crée pas si déjà actif pour ce J-N
  try {
    const res = db.prepare(`
      INSERT INTO notif_rappels (type, src_table, src_id, declenchement_j, declenchement_h, declenche_a)
      VALUES (?,?,?,?,?,?)
    `).run(type, srcTable, srcId, declenchementJ, declenchementH, declenche_a);
    return res.lastInsertRowid;
  } catch (e) {
    if (e.message.includes('UNIQUE')) return null; // déjà planifié
    throw e;
  }
}

/**
 * Annule tous les rappels actifs d'un type pour un objet donné.
 * Appelé quand la condition est résolue (ex: employé sorti avant fin contrat).
 */
function annulerRappels(type, srcTable, srcId, motif = null) {
  return db.prepare(`
    UPDATE notif_rappels SET statut='annule', annule_motif=?, updated_at=datetime('now')
    WHERE type=? AND src_table=? AND src_id=?
      AND statut NOT IN ('annule','acquitte')
  `).run(motif, type, srcTable, srcId).changes;
}

/**
 * Moteur cron : déclenche les rappels planifiés dont l'heure est atteinte.
 * À appeler depuis un setInterval toutes les 60 s.
 */
function traiterRappelsDus() {
  if (!moduleActif()) return;

  const dus = db.prepare(`
    SELECT r.*, rg.canal_email, rg.roles_dest, rg.priorite_defaut
    FROM notif_rappels r
    JOIN notif_regles rg ON rg.type = r.type AND rg.actif = 1
    WHERE r.statut = 'planifie'
      AND r.declenche_a <= datetime('now')
  `).all();

  for (const rap of dus) {
    // Marquer déclenché
    db.prepare(
      "UPDATE notif_rappels SET statut='declenche', updated_at=datetime('now') WHERE id=?"
    ).run(rap.id);

    // Créer notifs inapp
    let roles;
    try { roles = JSON.parse(rap.roles_dest); } catch { roles = ['admin']; }
    const cibles = usersParRoles(roles);
    const titre   = _titreRappel(rap.type, rap.src_table, rap.src_id);
    const message = _messageRappel(rap.type, rap.src_table, rap.src_id, rap.declenchement_j);

    const insMsg = db.prepare(`
      INSERT INTO notif_messages (type, famille, priorite, titre, message, user_id, src_table, src_id)
      VALUES (?, 'rappel', ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const u of cibles)
        insMsg.run(rap.type, rap.priorite_defaut, titre, message, u.id, rap.src_table, rap.src_id);
    });
    tx();
    audit('notif_rappels', rap.id, 'triggered', { type: rap.type, src_id: rap.src_id });

    // Email si configuré
    if (rap.canal_email) {
      setImmediate(() => {
        for (const u of cibles) {
          if (!u.email) continue;
          envoyerEmail({
            userId:      u.id,
            destinataire: u.email,
            type: rap.type, srcId: rap.src_id,
            subject:     `[TOP CENTER Rappel] ${titre}`,
            html:        _htmlRappel(rap.priorite_defaut, titre, message),
            rappelId:    rap.id
          }).catch(() => {});
        }
      });
    }
  }
}

// ─── MOTEUR D'ESCALADE ────────────────────────────────────────────────────────

/**
 * Vérifie les alertes et rappels non acquittés dépassant leur délai d'escalade.
 * À appeler depuis setInterval toutes les 5 min.
 */
function traiterEscalades() {
  if (!moduleActif()) return;

  // Alertes actives non acquittées dépassant escalade_delai_h
  const alertes = db.prepare(`
    SELECT a.*, rg.escalade_delai_h, rg.escalade_roles
    FROM alertes_actives a
    JOIN notif_regles rg ON rg.type = a.type AND rg.actif = 1
    WHERE a.statut IN ('active')
      AND rg.escalade_delai_h IS NOT NULL
      AND a.escalade_at IS NULL
      AND (julianday('now') - julianday(a.created_at)) * 24 >= rg.escalade_delai_h
  `).all();

  for (const a of alertes) {
    let escaladeRoles;
    try { escaladeRoles = JSON.parse(a.escalade_roles); } catch { escaladeRoles = ['admin']; }
    const cibles = usersParRoles(escaladeRoles);
    const now = new Date().toISOString();

    db.prepare(
      "UPDATE alertes_actives SET statut='escaladee', escalade_at=?, escalade_vers=?, updated_at=? WHERE id=?"
    ).run(now, JSON.stringify(escaladeRoles), now, a.id);

    audit('alertes_actives', a.id, 'escalated',
      { vers: escaladeRoles, delai_h: a.escalade_delai_h });

    const insMsg = db.prepare(`
      INSERT INTO notif_messages (type, famille, priorite, titre, message, user_id, src_table, src_id)
      VALUES (?, 'alerte', 'critique', ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const u of cibles) {
        insMsg.run(
          a.type,
          `[ESCALADE] ${a.titre}`,
          `Alerte non traitée depuis ${a.escalade_delai_h}h — ${a.message}`,
          u.id, a.src_table, a.src_id
        );
      }
    });
    tx();

    // Email escalade
    setImmediate(() => {
      for (const u of cibles) {
        if (!u.email) continue;
        envoyerEmail({
          userId:      u.id,
          destinataire: u.email,
          type:        a.type,
          srcId:       a.src_id,
          subject:     `🚨 [ESCALADE] Alerte non traitée — ${a.titre}`,
          html:        _htmlAlerte('critique', `[ESCALADE] ${a.titre}`,
                         `Non traitée depuis ${a.escalade_delai_h}h. ${a.message}`),
          alerteId:    a.id
        }).catch(() => {});
      }
    });
  }

  // Rappels déclenchés non acquittés dépassant grace_h
  const rappels = db.prepare(`
    SELECT r.*, rg.grace_h, rg.escalade_delai_h, rg.escalade_roles
    FROM notif_rappels r
    JOIN notif_regles rg ON rg.type = r.type AND rg.actif = 1
    WHERE r.statut = 'declenche'
      AND rg.grace_h IS NOT NULL
      AND r.escalade_at IS NULL
      AND (julianday('now') - julianday(r.updated_at)) * 24 >= rg.grace_h
  `).all();

  for (const rap of rappels) {
    const now = new Date().toISOString();
    let escaladeRoles;
    try { escaladeRoles = JSON.parse(rap.escalade_roles); } catch { escaladeRoles = ['admin']; }
    const cibles = usersParRoles(escaladeRoles ?? ['admin']);

    db.prepare(
      "UPDATE notif_rappels SET statut='escalade', escalade_at=?, escalade_vers=?, updated_at=? WHERE id=?"
    ).run(now, JSON.stringify(escaladeRoles), now, rap.id);

    audit('notif_rappels', rap.id, 'escalated', { vers: escaladeRoles });

    const insMsg = db.prepare(`
      INSERT INTO notif_messages (type, famille, priorite, titre, message, user_id, src_table, src_id)
      VALUES (?, 'rappel', 'avertissement', ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const u of cibles)
        insMsg.run(
          rap.type,
          `[ESCALADE] ${_titreRappel(rap.type, rap.src_table, rap.src_id)}`,
          `Rappel non acquitté depuis ${rap.grace_h}h.`,
          u.id, rap.src_table, rap.src_id
        );
    });
    tx();
  }
}

// ─── PURGE ────────────────────────────────────────────────────────────────────

/**
 * Purge les notifications archivées plus vieilles que notif_retention_jours.
 * À appeler depuis setInterval quotidien.
 */
function purgerAnciennesNotifs() {
  const jours = parseInt(param('notif_retention_jours', '90'), 10);
  const res = db.prepare(`
    DELETE FROM notif_messages
    WHERE statut = 'archivee'
      AND created_at < datetime('now', ? || ' days')
  `).run(`-${jours}`);
  if (res.changes > 0)
    audit('notif_messages', 0, 'purged', { nb: res.changes, retention_jours: jours });
  return res.changes;
}

// ─── VÉRIFICATIONS PÉRIODIQUES ALERTES SOLDE ─────────────────────────────────

/**
 * Réévalue les alertes de solde pour toutes les positions actives.
 * Appelé après chaque opération et toutes les 5 min par le cron.
 */
function evaluerAlerteSoldes() {
  const seuilAlerte   = parseFloat(param('seuil_alerte',   '100000'));
  const seuilCritique = parseFloat(param('seuil_critique', '50000'));

  const positions = db.prepare("SELECT * FROM positions WHERE actif = 1").all();

  for (const pos of positions) {
    // Calculer le solde courant
    const row = db.prepare(`
      SELECT COALESCE(SUM(CASE
        WHEN type_op IN ('encaissement','virement') AND position_id = ? THEN montant
        WHEN type_op = 'decaissement' AND position_id = ?              THEN -montant
        WHEN type_op = 'virement' AND position_source_id = ?           THEN -montant
        ELSE 0 END), 0) as delta
      FROM operations WHERE statut = 'valide'
    `).get(pos.id, pos.id, pos.id);
    const solde = (pos.solde_initial ?? 0) + (row?.delta ?? 0);

    const ctx = { positionId: pos.id, srcTable: 'positions', srcId: pos.id };

    if (solde <= 0) {
      declencherAlerte({ type: 'ALRT_SOLDE_NEGATIF', ...ctx,
        titre:   `Solde négatif — ${pos.libelle}`,
        message: `Solde actuel : ${solde.toLocaleString('fr-FR')} XAF. Décaissements bloqués.`,
        details: { solde, position: pos.code } });
      // Résoudre les alertes de niveau inférieur si négatif
      resoudreAlerte('ALRT_SOLDE_CRITIQUE',      'positions', pos.id, pos.id);
      resoudreAlerte('ALRT_SOLDE_AVERTISSEMENT', 'positions', pos.id, pos.id);
    } else if (solde < seuilCritique) {
      declencherAlerte({ type: 'ALRT_SOLDE_CRITIQUE', ...ctx,
        titre:   `Solde critique — ${pos.libelle}`,
        message: `Solde : ${solde.toLocaleString('fr-FR')} XAF (seuil critique : ${seuilCritique.toLocaleString('fr-FR')} XAF).`,
        details: { solde, seuil: seuilCritique, position: pos.code } });
      resoudreAlerte('ALRT_SOLDE_NEGATIF',       'positions', pos.id, pos.id);
      resoudreAlerte('ALRT_SOLDE_AVERTISSEMENT', 'positions', pos.id, pos.id);
    } else if (solde < seuilAlerte) {
      declencherAlerte({ type: 'ALRT_SOLDE_AVERTISSEMENT', ...ctx,
        titre:   `Solde bas — ${pos.libelle}`,
        message: `Solde : ${solde.toLocaleString('fr-FR')} XAF (seuil : ${seuilAlerte.toLocaleString('fr-FR')} XAF).`,
        details: { solde, seuil: seuilAlerte, position: pos.code } });
      resoudreAlerte('ALRT_SOLDE_NEGATIF',  'positions', pos.id, pos.id);
      resoudreAlerte('ALRT_SOLDE_CRITIQUE', 'positions', pos.id, pos.id);
    } else {
      // Solde OK : résoudre toutes les alertes solde de cette position
      resoudreAlerte('ALRT_SOLDE_NEGATIF',       'positions', pos.id, pos.id);
      resoudreAlerte('ALRT_SOLDE_CRITIQUE',      'positions', pos.id, pos.id);
      resoudreAlerte('ALRT_SOLDE_AVERTISSEMENT', 'positions', pos.id, pos.id);
    }
  }
}

// ─── VÉRIFICATIONS ALERTES MÉTIER (cron périodique) ──────────────────────────

/**
 * Alerte critique + planification rappel J+7 pour factures clients en retard.
 * Cron 24h.
 */
function checkFacturesClientEnRetard() {
  if (!moduleActif()) return;

  const enRetard = db.prepare(`
    SELECT f.id, f.numero, f.montant_ttc, f.montant_paye, f.date_echeance,
           c.nom AS client_nom, c.email AS client_email
    FROM factures_clients f
    JOIN clients c ON c.id = f.client_id
    WHERE f.statut IN ('en_retard','partiellement_payee')
      AND f.date_echeance < date('now')
  `).all();

  for (const f of enRetard) {
    const reste = (f.montant_ttc ?? 0) - (f.montant_paye ?? 0);
    const joursRetard = Math.floor(
      (Date.now() - new Date(f.date_echeance).getTime()) / 86400000
    );

    declencherAlerte({
      type:     'ALRT_FACTURE_CLIENT_RETARD',
      srcTable: 'factures_clients',
      srcId:    f.id,
      titre:    `Facture impayée — ${f.numero} (${f.client_nom})`,
      message:  `Retard de ${joursRetard} j. Reste dû : ${reste.toLocaleString('fr-FR')} XAF.`,
      details:  { facture_id: f.id, client: f.client_nom, reste, joursRetard },
    });

    // Planifier un rappel J+7 si pas déjà existant
    planifierRappel({
      type:           'RAP_FACTURE_CLIENT_RETARD',
      srcTable:       'factures_clients',
      srcId:          f.id,
      declenchementJ: 7,
      declenche_a:    new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  }
}

/**
 * Alertes expiration contrats : avertissement 30j, critique 7j.
 * Cron 24h.
 */
function checkContratsExpirants() {
  if (!moduleActif()) return;

  const contrats = db.prepare(`
    SELECT c.id, c.numero, c.objet, c.date_fin,
           cl.nom AS client_nom
    FROM contrats c
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE c.statut = 'actif'
      AND c.date_fin IS NOT NULL
      AND c.date_fin > date('now')
      AND c.date_fin <= date('now', '+30 days')
  `).all();

  for (const c of contrats) {
    const joursRestants = Math.ceil(
      (new Date(c.date_fin).getTime() - Date.now()) / 86400000
    );

    if (joursRestants <= 7) {
      declencherAlerte({
        type:     'ALRT_CONTRAT_EXPIRATION_CRITIQUE',
        srcTable: 'contrats',
        srcId:    c.id,
        titre:    `Contrat expire dans ${joursRestants} j — ${c.numero}`,
        message:  `${c.objet ?? c.numero} expire le ${c.date_fin}. Action requise.`,
        details:  { contrat_id: c.id, joursRestants, date_fin: c.date_fin },
      });
    } else {
      declencherAlerte({
        type:     'ALRT_CONTRAT_EXPIRATION_AVERT',
        srcTable: 'contrats',
        srcId:    c.id,
        titre:    `Contrat à renouveler — ${c.numero} (${joursRestants} j)`,
        message:  `${c.objet ?? c.numero} expire le ${c.date_fin}.`,
        details:  { contrat_id: c.id, joursRestants, date_fin: c.date_fin },
      });
    }
  }
}

/**
 * Alerte stock bas / rupture pour les produits sous seuil minimum.
 * Cron 5 min.
 */
function checkStockBas() {
  if (!moduleActif()) return;

  const produits = db.prepare(`
    SELECT id, reference, designation, stock_disponible, stock_minimum
    FROM produits
    WHERE actif = 1
      AND stock_minimum IS NOT NULL
      AND stock_disponible <= stock_minimum
  `).all();

  for (const p of produits) {
    const rupture = p.stock_disponible <= 0;
    declencherAlerte({
      type:     rupture ? 'ALRT_STOCK_RUPTURE' : 'ALRT_STOCK_BAS',
      srcTable: 'produits',
      srcId:    p.id,
      titre:    rupture
        ? `Rupture de stock — ${p.reference}`
        : `Stock bas — ${p.reference}`,
      message:  rupture
        ? `${p.designation} : stock nul. Approvisionnement urgent.`
        : `${p.designation} : ${p.stock_disponible} unité(s) (min : ${p.stock_minimum}).`,
      details:  { produit_id: p.id, stock: p.stock_disponible, minimum: p.stock_minimum },
    });
  }

  // Résoudre les alertes pour les produits revenus au-dessus du seuil
  const ok = db.prepare(`
    SELECT id FROM produits
    WHERE actif = 1
      AND (stock_minimum IS NULL OR stock_disponible > stock_minimum)
  `).all();
  for (const p of ok) {
    resoudreAlerte('ALRT_STOCK_BAS',     'produits', p.id);
    resoudreAlerte('ALRT_STOCK_RUPTURE', 'produits', p.id);
  }
}

/**
 * Bloquant si encours client > plafond_credit.
 * Cron 5 min.
 */
function checkEncoursCreditClient() {
  if (!moduleActif()) return;

  const clients = db.prepare(`
    SELECT c.id, c.numero, c.nom, c.email,
           c.plafond_credit, c.encours_credit
    FROM clients c
    WHERE c.actif = 1
      AND c.plafond_credit IS NOT NULL
      AND c.plafond_credit > 0
      AND c.encours_credit > c.plafond_credit
  `).all();

  for (const c of clients) {
    declencherAlerte({
      type:     'ALRT_ENCOURS_PLAFOND',
      srcTable: 'clients',
      srcId:    c.id,
      titre:    `Encours dépassé — ${c.nom} (${c.numero})`,
      message:  `Encours : ${c.encours_credit.toLocaleString('fr-FR')} XAF / Plafond : ${c.plafond_credit.toLocaleString('fr-FR')} XAF. Création de factures bloquée.`,
      details:  { client_id: c.id, encours: c.encours_credit, plafond: c.plafond_credit },
    });
  }

  // Résoudre pour les clients repassés sous le plafond
  const ok = db.prepare(`
    SELECT id FROM clients
    WHERE actif = 1
      AND (plafond_credit IS NULL OR plafond_credit = 0 OR encours_credit <= plafond_credit)
  `).all();
  for (const c of ok) {
    resoudreAlerte('ALRT_ENCOURS_PLAFOND', 'clients', c.id);
  }
}

/**
 * Alerte critique par facture fournisseur échue non payée.
 * Cron 24h.
 */
function checkFacturesFournisseursEchues() {
  if (!moduleActif()) return;

  const echues = db.prepare(`
    SELECT ff.id, ff.numero, ff.montant_ttc, ff.date_echeance,
           f.nom AS fournisseur_nom
    FROM factures_fournisseurs ff
    LEFT JOIN fournisseurs f ON f.id = ff.fournisseur_id
    WHERE ff.statut IN ('validee','partiellement_payee')
      AND ff.date_echeance IS NOT NULL
      AND ff.date_echeance < date('now')
  `).all();

  for (const ff of echues) {
    const joursRetard = Math.floor(
      (Date.now() - new Date(ff.date_echeance).getTime()) / 86400000
    );

    declencherAlerte({
      type:     'ALRT_FACTURE_FOURN_ECHUE',
      srcTable: 'factures_fournisseurs',
      srcId:    ff.id,
      titre:    `Facture fournisseur échue — ${ff.numero}`,
      message:  `${ff.fournisseur_nom ?? 'Fournisseur'} : ${ff.montant_ttc?.toLocaleString('fr-FR')} XAF. Retard : ${joursRetard} j. Paiement requis.`,
      details:  { facture_id: ff.id, fournisseur: ff.fournisseur_nom, montant: ff.montant_ttc, joursRetard },
    });
  }
}

// ─── PRÉFÉRENCES UTILISATEUR ──────────────────────────────────────────────────

function getPreferences(userId) {
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  if (row) return row;
  // Retourne les défauts sans INSERT (insert uniquement à la première modification)
  return {
    user_id: userId,
    son_actif: 1, son_info_actif: 0, son_avert_actif: 1, son_critique_actif: 1,
    son_volume: 0.5, son_plage_debut: '07:00', son_plage_fin: '21:00',
    notif_digest: 0, push_actif: 0
  };
}

function setPreferences(userId, data) {
  const allowed = ['son_actif','son_info_actif','son_avert_actif','son_critique_actif',
                   'son_volume','son_plage_debut','son_plage_fin','notif_digest','push_actif'];
  const fields = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) return;

  // UPSERT : crée la ligne si absente, met à jour sinon
  const existing = db.prepare('SELECT user_id FROM user_preferences WHERE user_id=?').get(userId);
  if (existing) {
    const set = fields.map(f => `${f}=?`).join(', ');
    db.prepare(`UPDATE user_preferences SET ${set}, updated_at=datetime('now') WHERE user_id=?`)
      .run(...fields.map(f => data[f]), userId);
  } else {
    const cols  = ['user_id', ...fields].join(', ');
    const vals  = ['?', ...fields.map(() => '?')].join(', ');
    db.prepare(`INSERT INTO user_preferences (${cols}, updated_at) VALUES (${vals}, datetime('now'))`)
      .run(userId, ...fields.map(f => data[f]));
  }
}

// ─── Templates HTML internes ──────────────────────────────────────────────────

function _htmlAlerte(priorite, titre, message) {
  const color = { bloquant: '#dc2626', critique: '#f59e0b', avertissement: '#f59e0b', info: '#6366f1' }[priorite] ?? '#6366f1';
  return `<div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:14px;overflow:hidden">
    <div style="background:${color};padding:20px 28px">
      <h2 style="margin:0;font-size:17px;color:#fff">${titre}</h2>
    </div>
    <div style="padding:24px">
      <p style="margin:0;color:#cbd5e1;font-size:13px">${message}</p>
      <p style="margin:20px 0 0;font-size:11px;color:#475569">TOP CENTER Caisse · ${new Date().toLocaleString('fr-FR')}</p>
    </div>
  </div>`;
}

function _htmlRappel(priorite, titre, message) {
  return `<div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:14px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 28px">
      <h2 style="margin:0;font-size:17px;color:#fff">${titre}</h2>
    </div>
    <div style="padding:24px">
      <p style="margin:0;color:#cbd5e1;font-size:13px">${message}</p>
      <a href="${process.env.APP_URL || 'https://talatala.topcenter.cg'}/dashboard.html"
         style="display:inline-block;margin-top:20px;background:#4f46e5;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
        Accéder à l'application →
      </a>
      <p style="margin:20px 0 0;font-size:11px;color:#475569">TOP CENTER Caisse · ${new Date().toLocaleString('fr-FR')}</p>
    </div>
  </div>`;
}

function _titreRappel(type, srcTable, srcId) {
  const labels = {
    RAP_SALAIRE_MENSUEL:         'Préparer les bulletins du mois',
    RAP_CONTRAT_FIN:             'Fin de contrat à venir',
    RAP_ESSAI_FIN:               'Fin de période d\'essai',
    RAP_DOCUMENT_EXPIRATION:     'Document expirant',
    RAP_RETRAITE:                'Âge de retraite approchant',
    RAP_AVANCE_ECHEANCE:         'Échéance de remboursement avance',
    RAP_BUDGET_DEPASSE:          'Budget mensuel dépassé',
    RAP_ACHAT_SOUMIS_SANS_SUITE: 'Demande d\'achat sans suite',
  };
  return labels[type] ?? type;
}

function _messageRappel(type, srcTable, srcId, declenchementJ) {
  const jStr = declenchementJ !== null && declenchementJ < 0
    ? ` (dans ${Math.abs(declenchementJ)} jour${Math.abs(declenchementJ) > 1 ? 's' : ''})`
    : '';
  return `Rappel${jStr} — action requise.`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Notifications
  creerNotification,
  // Alertes
  declencherAlerte,
  resoudreAlerte,
  // Rappels
  planifierRappel,
  annulerRappels,
  // Moteur cron
  traiterRappelsDus,
  traiterEscalades,
  purgerAnciennesNotifs,
  evaluerAlerteSoldes,
  // Vérifications alertes métier
  checkFacturesClientEnRetard,
  checkContratsExpirants,
  checkStockBas,
  checkEncoursCreditClient,
  checkFacturesFournisseursEchues,
  // Préférences
  getPreferences,
  setPreferences,
  // Helpers exposés pour tests
  _dedupKey: dedupKey,
};
