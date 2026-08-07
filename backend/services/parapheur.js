'use strict';

/**
 * Service connecteur parapheur numérique.
 *
 * Mode par défaut : non bloquant, pour conserver la compatibilité historique.
 * Mode critique : passer { required: true } pour bloquer le flux appelant si
 * l'entrée parapheur ne peut pas être créée.
 */
const db = require('../db');

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

async function auditConnector(status, payload, error) {
  try {
    await db.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
      VALUES ('parapheur', ?, ?, ?, ?)
    `, [
      Number(payload.ref_source_id || 0),
      `connector_${status}`,
      JSON.stringify({
        type: payload.type,
        titre: payload.titre,
        ref_source_table: payload.ref_source_table || null,
        ref_source_id: payload.ref_source_id || null,
        error: error ? error.message : null,
      }),
      payload.initiateur_id || null,
    ]);
  } catch (_) {}
}

async function findActiveDuplicate(ref_source_table, ref_source_id) {
  if (!ref_source_table || !ref_source_id) return null;
  return db.queryOne(`
    SELECT id FROM parapheur
    WHERE ref_source_table = ? AND ref_source_id = ?
      AND statut NOT IN ('approuve','rejete')
    ORDER BY id DESC
    LIMIT 1
  `, [ref_source_table, ref_source_id]);
}

async function notifyParapheurTarget(titre) {
  try {
    const interim = await db.queryOne('SELECT * FROM parapheur_interim WHERE actif = 1 ORDER BY id DESC LIMIT 1');
    const cible = (interim && !interim.remplacant_id) ? 'dg' : 'assistante_direction';
    const users = await db.query("SELECT id FROM users WHERE actif = 1 AND (role = ? OR roles LIKE ?)", [cible, `%\"${cible}\"%`]);
    for (const user of users) {
      try {
        await db.execute(`
          INSERT INTO notif_messages (user_id, message, type, lu, created_at)
          VALUES (?, ?, 'parapheur', 0, NOW())
        `, [user.id, `Nouvelle demande parapheur : ${titre}`]);
      } catch (_) {}
    }

    if (interim) {
      const dgs = await db.query("SELECT id FROM users WHERE actif = 1 AND (role = 'dg' OR roles LIKE '%\"dg\"%')");
      for (const user of dgs) {
        try {
          await db.execute(`
            INSERT INTO notif_messages (user_id, message, type, lu, created_at)
            VALUES (?, ?, 'parapheur', 0, NOW())
          `, [user.id, `[Copie intérim] Nouvelle demande parapheur : ${titre}`]);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

async function creerEntreeParapheur(payload = {}) {
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

    const duplicate = await findActiveDuplicate(ref_source_table, ref_source_id);
    if (duplicate) {
      await auditConnector('duplicate', payload, null);
      return duplicate.id;
    }

    const result = await db.execute(`
      INSERT INTO parapheur
        (type, titre, initiateur_id, priorite, statut, echeance_legale,
         montant, pieces_jointes, note_assistante, ref_source_table, ref_source_id)
      VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
    `, [
      type,
      String(titre).trim(),
      initiateur_id,
      normalizePriority(priorite),
      echeance_legale || null,
      montant || null,
      pieces_jointes ? JSON.stringify(pieces_jointes) : null,
      note_assistante || null,
      ref_source_table || null,
      ref_source_id || null,
    ]);

    const newId = result.insertId;
    if (!newId) return fail(required, 'Création parapheur sans identifiant');

    await db.execute(`
      INSERT INTO parapheur_actions
        (parapheur_id, acteur_id, acteur_role, action_type, commentaire, is_interim)
      VALUES (?, ?, 'system', 'soumis', ?, 0)
    `, [newId, initiateur_id, required ? 'Création connecteur critique' : null]);

    await notifyParapheurTarget(String(titre).trim());
    await auditConnector('created', { ...payload, ref_source_id: newId }, null);
    return newId;
  } catch (err) {
    await auditConnector('failed', payload, err);
    return fail(required, `Création parapheur impossible: ${err.message}`, err);
  }
}

module.exports = { creerEntreeParapheur };
