'use strict';

/**
 * Service connecteur parapheur numérique.
 *
 * Mode par défaut : non bloquant, pour conserver la compatibilité historique.
 * Mode critique : passer { required: true } pour bloquer le flux appelant si
 * l'entrée parapheur ne peut pas être créée.
 */
const db = require('../database');

const VALID_PRIORITIES = ['normal', 'urgent', 'confidentiel'];
const VALID_TYPES = [
  'decaissement', 'paiement_cnss', 'paiement_dgi', 'demande_achat',
  'facture_fournisseur', 'conge', 'avance_salaire', 'revision_salariale',
  'offboarding', 'contrat', 'attestation_stage', 'facture_client',
  'correspondance', 'reclamation_agent', 'amelioration_agent'
];

function normalizePriority(priority) {
  return VALID_PRIORITIES.includes(priority) ? priority : 'normal';
}

function fail(required, message, cause) {
  if (required) {
    const err = new Error(message);
    err.cause = cause;
    throw err;
  }
  if (cause) console.error('[parapheur-connecteur] Erreur:', cause.message);
  return null;
}

function auditConnector(status, payload, error) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('parapheur', ?, ?, ?, ?)
    `).run(
      Number(payload.ref_source_id || 0),
      `connector_${status}`,
      JSON.stringify({
        type: payload.type,
        titre: payload.titre,
        ref_source_table: payload.ref_source_table || null,
        ref_source_id: payload.ref_source_id || null,
        error: error ? error.message : null,
      }),
      payload.initiateur_id || null
    );
  } catch (_) {}
}

function findActiveDuplicate(ref_source_table, ref_source_id) {
  if (!ref_source_table || !ref_source_id) return null;
  return db.prepare(`
    SELECT id FROM parapheur
    WHERE ref_source_table = ? AND ref_source_id = ?
      AND statut NOT IN ('approuve','rejete')
    ORDER BY id DESC
    LIMIT 1
  `).get(ref_source_table, ref_source_id);
}

function notifyParapheurTarget(titre) {
  try {
    const interim = db.prepare('SELECT * FROM parapheur_interim WHERE actif = 1 ORDER BY id DESC LIMIT 1').get();
    const cible = (interim && !interim.remplacant_id) ? 'dg' : 'assistante_direction';
    const users = db.prepare("SELECT id FROM users WHERE actif = 1 AND (role = ? OR roles LIKE ?)").all(cible, `%"${cible}"%`);
    users.forEach(u => {
      try {
        db.prepare(`
          INSERT INTO notif_messages (user_id, message, type, lu, created_at)
          VALUES (?, ?, 'parapheur', 0, datetime('now'))
        `).run(u.id, `Nouvelle demande parapheur : ${titre}`);
      } catch (_) {}
    });

    if (interim) {
      const dgs = db.prepare("SELECT id FROM users WHERE actif = 1 AND (role = 'dg' OR roles LIKE '%\"dg\"%')").all();
      dgs.forEach(u => {
        try {
          db.prepare(`
            INSERT INTO notif_messages (user_id, message, type, lu, created_at)
            VALUES (?, ?, 'parapheur', 0, datetime('now'))
          `).run(u.id, `[Copie intérim] Nouvelle demande parapheur : ${titre}`);
        } catch (_) {}
      });
    }
  } catch (_) {}
}

function creerEntreeParapheur(payload = {}) {
  const required = payload.required === true;
  try {
    const {
      type,
      titre,
      initiateur_id,
      montant,
      echeance_legale,
      ref_source_table,
      ref_source_id,
      priorite,
      pieces_jointes,
      note_assistante,
    } = payload;

    if (!type || !VALID_TYPES.includes(type)) {
      return fail(required, `Type parapheur invalide: ${type || 'vide'}`);
    }
    if (!titre || !String(titre).trim()) {
      return fail(required, 'Titre parapheur obligatoire');
    }
    if (!initiateur_id) {
      return fail(required, 'Initiateur parapheur obligatoire');
    }

    const duplicate = findActiveDuplicate(ref_source_table, ref_source_id);
    if (duplicate) {
      auditConnector('duplicate', payload, null);
      return duplicate.id;
    }

    const r = db.prepare(`
      INSERT INTO parapheur
        (type, titre, initiateur_id, priorite, statut, echeance_legale,
         montant, pieces_jointes, note_assistante, ref_source_table, ref_source_id)
      VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
    `).run(
      type,
      String(titre).trim(),
      initiateur_id,
      normalizePriority(priorite),
      echeance_legale || null,
      montant || null,
      pieces_jointes ? JSON.stringify(pieces_jointes) : null,
      note_assistante || null,
      ref_source_table || null,
      ref_source_id || null
    );

    const newId = r.lastInsertRowid;

    db.prepare(`
      INSERT INTO parapheur_actions
        (parapheur_id, acteur_id, acteur_role, action_type, commentaire, is_interim)
      VALUES (?, ?, 'system', 'soumis', ?, 0)
    `).run(newId, initiateur_id, required ? 'Création connecteur critique' : null);

    notifyParapheurTarget(String(titre).trim());
    auditConnector('created', { ...payload, ref_source_id: newId }, null);
    return newId;
  } catch (err) {
    auditConnector('failed', payload, err);
    return fail(required, `Création parapheur impossible: ${err.message}`, err);
  }
}

module.exports = { creerEntreeParapheur };
