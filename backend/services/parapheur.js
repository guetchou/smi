'use strict';
/**
 * Service connecteur parapheur numérique.
 * Crée automatiquement une entrée parapheur depuis n'importe quel module.
 * Ne bloque jamais — les erreurs sont avalées silencieusement.
 */
const db = require('../database');

function creerEntreeParapheur({ type, titre, initiateur_id, montant, echeance_legale, ref_source_table, ref_source_id, priorite }) {
  try {
    // Éviter les doublons : une seule entrée active par (table, id)
    if (ref_source_table && ref_source_id) {
      const existing = db.prepare(`
        SELECT id FROM parapheur
        WHERE ref_source_table = ? AND ref_source_id = ?
          AND statut NOT IN ('approuve','rejete')
      `).get(ref_source_table, ref_source_id);
      if (existing) return existing.id;
    }

    const r = db.prepare(`
      INSERT INTO parapheur
        (type, titre, initiateur_id, priorite, statut, echeance_legale,
         montant, ref_source_table, ref_source_id)
      VALUES (?, ?, ?, ?, 'en_attente_assistante', ?, ?, ?, ?)
    `).run(
      type, titre, initiateur_id,
      priorite || 'normal',
      echeance_legale || null,
      montant || null,
      ref_source_table || null,
      ref_source_id || null
    );

    const newId = r.lastInsertRowid;

    db.prepare(`
      INSERT INTO parapheur_actions
        (parapheur_id, acteur_id, acteur_role, action_type, is_interim)
      VALUES (?, ?, 'system', 'soumis', 0)
    `).run(newId, initiateur_id);

    // Notifier assistante (ou DG si intérim sans remplaçant)
    const interim = db.prepare(`SELECT * FROM parapheur_interim WHERE actif = 1 ORDER BY id DESC LIMIT 1`).get();
    const cible = (interim && !interim.remplacant_id) ? 'dg' : 'assistante_direction';
    const users = db.prepare(`SELECT id FROM users WHERE role = ? AND actif = 1`).all(cible);
    users.forEach(u => {
      try {
        db.prepare(`
          INSERT INTO notif_messages (user_id, message, type, lu, created_at)
          VALUES (?, ?, 'parapheur', 0, datetime('now'))
        `).run(u.id, `Nouvelle demande parapheur : ${titre}`);
      } catch (_) {}
    });
    // Si intérim : DG reçoit aussi en copie directe
    if (interim) {
      const dgs = db.prepare(`SELECT id FROM users WHERE role = 'dg' AND actif = 1`).all();
      dgs.forEach(u => {
        try {
          db.prepare(`
            INSERT INTO notif_messages (user_id, message, type, lu, created_at)
            VALUES (?, ?, 'parapheur', 0, datetime('now'))
          `).run(u.id, `[Copie intérim] Nouvelle demande parapheur : ${titre}`);
        } catch (_) {}
      });
    }

    return newId;
  } catch (err) {
    // Le connecteur ne doit jamais bloquer le flux principal
    console.error('[parapheur-connecteur] Erreur:', err.message);
    return null;
  }
}

module.exports = { creerEntreeParapheur };
