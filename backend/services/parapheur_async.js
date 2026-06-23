'use strict';

const db = require('../db');

const VALID_PRIORITIES = ['normal', 'urgent', 'confidentiel'];
const VALID_TYPES = [
  'decaissement', 'paiement_cnss', 'paiement_dgi', 'demande_achat',
  'facture_fournisseur', 'conge', 'avance_salaire', 'revision_salariale',
  'offboarding', 'contrat', 'attestation_stage', 'facture_client',
  'correspondance', 'reclamation_agent', 'amelioration_agent',
];

function normalizePriority(priority) {
  return VALID_PRIORITIES.includes(priority) ? priority : 'normal';
}

function validatePayload(payload) {
  if (!payload.type || !VALID_TYPES.includes(payload.type)) {
    throw new Error(`Type parapheur invalide: ${payload.type || 'vide'}`);
  }
  if (!payload.titre || !String(payload.titre).trim()) {
    throw new Error('Titre parapheur obligatoire');
  }
  if (!payload.initiateur_id) {
    throw new Error('Initiateur parapheur obligatoire');
  }
}

async function auditConnector(tx, status, payload, recordId) {
  await tx.execute(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
    VALUES ('parapheur', ?, ?, ?, ?)
  `, [
    Number(recordId || payload.ref_source_id || 0),
    `connector_${status}`,
    JSON.stringify({
      type: payload.type,
      titre: payload.titre,
      ref_source_table: payload.ref_source_table || null,
      ref_source_id: payload.ref_source_id || null,
    }),
    payload.initiateur_id || null,
  ]);
}

async function creerEntreeParapheurDansTransaction(tx, payload = {}) {
  if (!tx || typeof tx.queryOne !== 'function' || typeof tx.execute !== 'function') {
    throw new TypeError('Transaction DB asynchrone requise');
  }
  validatePayload(payload);

  if (payload.ref_source_table && payload.ref_source_id) {
    const duplicate = await tx.queryOne(`
      SELECT id FROM parapheur
      WHERE ref_source_table = ? AND ref_source_id = ?
        AND statut NOT IN ('approuve','rejete')
      ORDER BY id DESC
      LIMIT 1
    `, [payload.ref_source_table, payload.ref_source_id]);
    if (duplicate) {
      await auditConnector(tx, 'duplicate', payload, duplicate.id);
      return duplicate.id;
    }
  }

  const result = await tx.execute(`
    INSERT INTO parapheur
      (type, titre, initiateur_id, priorite, statut, echeance_legale,
       montant, pieces_jointes, note_assistante, ref_source_table, ref_source_id)
    VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?, ?, ?)
  `, [
    payload.type,
    String(payload.titre).trim(),
    payload.initiateur_id,
    normalizePriority(payload.priorite),
    payload.echeance_legale || null,
    payload.montant || null,
    payload.pieces_jointes ? JSON.stringify(payload.pieces_jointes) : null,
    payload.note_assistante || null,
    payload.ref_source_table || null,
    payload.ref_source_id || null,
  ]);

  const parapheurId = result.insertId;
  if (!parapheurId) throw new Error('Création parapheur sans identifiant');

  await tx.execute(`
    INSERT INTO parapheur_actions
      (parapheur_id, acteur_id, acteur_role, action_type, commentaire, is_interim)
    VALUES (?, ?, 'system', 'soumis', 'Création connecteur critique', 0)
  `, [parapheurId, payload.initiateur_id]);

  await auditConnector(tx, 'created', payload, parapheurId);
  return parapheurId;
}

async function notifierParapheurTarget(titre, dbc = db) {
  try {
    const interim = await dbc.queryOne(
      'SELECT * FROM parapheur_interim WHERE actif = 1 ORDER BY id DESC LIMIT 1',
    );
    const cible = interim && !interim.remplacant_id ? 'dg' : 'assistante_direction';
    const users = await dbc.query(
      'SELECT id FROM users WHERE actif = 1 AND (role = ? OR roles LIKE ?)',
      [cible, `%${cible}%`],
    );
    for (const user of users) {
      await dbc.execute(`
        INSERT INTO notif_messages (user_id, message, type, lu, created_at)
        VALUES (?, ?, 'parapheur', 0, NOW())
      `, [user.id, `Nouvelle demande parapheur : ${titre}`]);
    }

    if (interim) {
      const dgs = await dbc.query(
        "SELECT id FROM users WHERE actif = 1 AND (role = 'dg' OR roles LIKE '%dg%')",
      );
      for (const user of dgs) {
        await dbc.execute(`
          INSERT INTO notif_messages (user_id, message, type, lu, created_at)
          VALUES (?, ?, 'parapheur', 0, NOW())
        `, [user.id, `[Copie intérim] Nouvelle demande parapheur : ${titre}`]);
      }
    }
  } catch (error) {
    console.error('[parapheur-notification-async]', error.message);
  }
}

module.exports = {
  creerEntreeParapheurDansTransaction,
  notifierParapheurTarget,
};
