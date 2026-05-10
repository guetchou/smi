/**
 * MODULE FACTURES CLIENTS — Prompt 3
 * Workflow : brouillon → emise → envoyee → partiellement_payee → payee
 * Paiements partiels, annulation avec motif, rapport impayés, relances.
 */
const express = require('express');
const db      = require('../database');
const { requireAuth, hasRole } = require('./auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function auditLog(userId, action, recordId, details = '') {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, 'factures_clients', ?, ?, datetime('now'))
    `).run(userId, action, recordId,
      typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (_) { /* non-bloquant */ }
}

function genNumero() {
  const annee = new Date().getFullYear();
  const last  = db.prepare(`
    SELECT numero FROM factures_clients
    WHERE numero LIKE 'FAC-${annee}-%'
    ORDER BY id DESC LIMIT 1
  `).get();
  if (!last) return `FAC-${annee}-0001`;
  const n = parseInt(last.numero.split('-')[2], 10) || 0;
  return `FAC-${annee}-${String(n + 1).padStart(4, '0')}`;
}

function getLignes(factureId) {
  return db.prepare(
    'SELECT * FROM factures_clients_lignes WHERE facture_id = ? ORDER BY ordre ASC, id ASC'
  ).all(factureId);
}

function saveLignes(factureId, lignes) {
  db.prepare('DELETE FROM factures_clients_lignes WHERE facture_id = ?').run(factureId);
  const ins = db.prepare(`
    INSERT INTO factures_clients_lignes
      (facture_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  lignes.forEach((l, i) => {
    const qte  = Number(l.quantite)      || 1;
    const pu   = Number(l.prix_unitaire) || 0;
    const rem  = Number(l.remise)        || 0;
    const taxe = Number(l.taux_taxe)     || 0;
    const ht   = qte * pu * (1 - rem / 100);
    const ttc  = ht * (1 + taxe / 100);
    ins.run(
      factureId,
      l.type || 'service',
      l.designation,
      qte, pu, rem, taxe,
      Math.round(ht  * 100) / 100,
      Math.round(ttc * 100) / 100,
      l.ordre != null ? l.ordre : i
    );
  });
}

function calcTotaux(lignes, remiseGlobale = 0) {
  let ht = 0, taxes = 0;
  for (const l of lignes) {
    const qte  = Number(l.quantite)      || 1;
    const pu   = Number(l.prix_unitaire) || 0;
    const rem  = Number(l.remise)        || 0;
    const taxe = Number(l.taux_taxe)     || 0;
    const montHT   = qte * pu * (1 - rem / 100);
    const montTaxe = montHT * (taxe / 100);
    ht    += montHT;
    taxes += montTaxe;
  }
  const remGlob = ht * ((remiseGlobale || 0) / 100);
  const htFinal = ht - remGlob;
  return {
    montant_ht:    Math.round(htFinal          * 100) / 100,
    montant_taxes: Math.round(taxes            * 100) / 100,
    montant_ttc:   Math.round((htFinal + taxes)* 100) / 100,
  };
}

// Statuts dans lesquels la facture est verrouillée (pas de modification)
const STATUTS_VERROUILLES = ['emise','envoyee','partiellement_payee','payee','annulee','avoir_emis','irrecouvrable'];

// ── GET /api/factures-clients ─────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { statut, client_id, type, date_debut, date_fin,
          en_retard, search, limit = 50, offset = 0 } = req.query;

  const where  = ['1=1'];
  const params = [];

  if (statut)    { where.push('f.statut = ?');     params.push(statut); }
  if (client_id) { where.push('f.client_id = ?');  params.push(client_id); }
  if (type)      { where.push('f.type = ?');        params.push(type); }
  if (date_debut){ where.push('f.date_facture >= ?');params.push(date_debut); }
  if (date_fin)  { where.push('f.date_facture <= ?');params.push(date_fin); }
  if (en_retard === '1') {
    where.push("f.date_echeance < date('now')");
    where.push("f.statut NOT IN ('payee','annulee','avoir_emis','irrecouvrable')");
  }
  if (search) {
    where.push('(f.numero LIKE ? OR f.objet LIKE ? OR c.nom LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const sql = `
    SELECT f.*,
           c.nom  AS client_nom,
           c.email AS client_email,
           u.nom  AS commercial_nom,
           CAST((julianday('now') - julianday(f.date_echeance)) AS INTEGER) AS jours_retard
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN users   u ON u.id = f.commercial_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.date_facture DESC, f.id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const rows  = db.prepare(sql).all(...params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM factures_clients f
     LEFT JOIN clients c ON c.id = f.client_id
     WHERE ${where.join(' AND ')}`
  ).get(...params.slice(0, -2)).n;

  res.json({ factures: rows, total });
});

// ── GET /api/factures-clients/rapport/impayes ─────────────────────────────────
// Doit être AVANT /:id pour ne pas être capturé comme id
router.get('/rapport/impayes', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*,
           c.nom        AS client_nom,
           c.email      AS client_email,
           c.telephone  AS client_telephone,
           CAST((julianday('now') - julianday(f.date_echeance)) AS INTEGER) AS jours_retard,
           (SELECT MAX(r.created_at) FROM relances r
            WHERE r.reference_type='facture_client' AND r.reference_id=f.id) AS derniere_relance
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.date_echeance < date('now')
      AND f.statut NOT IN ('payee','annulee','avoir_emis','irrecouvrable')
    ORDER BY jours_retard DESC
  `).all();
  res.json({ impayes: rows, total: rows.length });
});

// ── GET /api/factures-clients/relances/dues ───────────────────────────────────
router.get('/relances/dues', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.numero, f.client_id, f.reste_a_payer, f.date_echeance,
           c.nom AS client_nom, c.email AS client_email,
           CAST((julianday('now') - julianday(f.date_echeance)) AS INTEGER) AS jours_retard,
           (SELECT COUNT(*) FROM relances r
            WHERE r.reference_type='facture_client' AND r.reference_id=f.id) AS nb_relances
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.date_echeance < date('now')
      AND f.statut NOT IN ('payee','annulee','avoir_emis','irrecouvrable')
    ORDER BY jours_retard DESC
  `).all();
  res.json({ dues: rows, total: rows.length });
});

// ── GET /api/factures-clients/:id ─────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const facture = db.prepare(`
    SELECT f.*,
           c.nom        AS client_nom,
           c.email      AS client_email,
           c.telephone  AS client_telephone,
           c.statut     AS client_statut,
           u.nom        AS commercial_nom,
           CAST((julianday('now') - julianday(f.date_echeance)) AS INTEGER) AS jours_retard
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN users   u ON u.id = f.commercial_id
    WHERE f.id = ?
  `).get(req.params.id);

  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });

  const lignes    = getLignes(facture.id);
  const paiements = db.prepare(
    'SELECT * FROM factures_clients_paiements WHERE facture_id = ? ORDER BY date_paiement DESC'
  ).all(facture.id);
  const relances  = db.prepare(
    "SELECT * FROM relances WHERE reference_type='facture_client' AND reference_id = ? ORDER BY created_at DESC"
  ).all(facture.id);

  res.json({ ...facture, lignes, paiements, relances });
});

// ── POST /api/factures-clients ────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour créer une facture' });
  const {
    client_id, devis_id, type = 'definitive', objet,
    date_facture, date_echeance, mode_paiement_attendu = 'especes',
    commercial_id, notes, lignes = []
  } = req.body;

  if (!client_id)     return res.status(400).json({ error: 'client_id requis' });
  if (!objet?.trim()) return res.status(400).json({ error: 'objet requis' });
  if (!date_facture)  return res.status(400).json({ error: 'date_facture requise' });
  if (!lignes.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

  const client = db.prepare('SELECT id, statut FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  if (['suspendu', 'mauvais_payeur'].includes(client.statut))
    return res.status(403).json({ error: `Facturation impossible — client ${client.statut}` });

  for (const l of lignes) {
    if (!l.designation?.trim())
      return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });
  }

  const totaux = calcTotaux(lignes);
  const numero = genNumero();

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO factures_clients
      (numero, client_id, devis_id, type, objet, date_facture, date_echeance, statut,
       montant_ht, montant_taxes, montant_ttc, montant_paye, reste_a_payer,
       mode_paiement_attendu, commercial_id, notes, created_by, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'brouillon',
       ?, ?, ?, 0, ?,
       ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    numero, client_id, devis_id || null, type, objet.trim(),
    date_facture, date_echeance || null,
    totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc, totaux.montant_ttc,
    mode_paiement_attendu, commercial_id || req.user.id,
    notes || null, req.user.id
  );

  saveLignes(lastInsertRowid, lignes);
  auditLog(req.user.id, 'CREATE', lastInsertRowid, { numero, client_id, objet });

  const created = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ ...created, lignes: getLignes(lastInsertRowid) });
});

// ── PUT /api/factures-clients/:id ─────────────────────────────────────────────
// Modification uniquement si statut = brouillon
router.put('/:id', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier une facture' });
  const facture = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(req.params.id);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (STATUTS_VERROUILLES.includes(facture.statut))
    return res.status(403).json({ error: `Modification impossible — statut : ${facture.statut}` });

  const { objet, date_facture, date_echeance, type,
          mode_paiement_attendu, commercial_id, notes, lignes } = req.body;

  const newLignes = lignes || getLignes(facture.id);
  const totaux    = calcTotaux(newLignes);
  const before    = { ...facture };

  db.prepare(`
    UPDATE factures_clients SET
      objet                 = COALESCE(?, objet),
      date_facture          = COALESCE(?, date_facture),
      date_echeance         = COALESCE(?, date_echeance),
      type                  = COALESCE(?, type),
      mode_paiement_attendu = COALESCE(?, mode_paiement_attendu),
      commercial_id         = COALESCE(?, commercial_id),
      notes                 = COALESCE(?, notes),
      montant_ht            = ?,
      montant_taxes         = ?,
      montant_ttc           = ?,
      reste_a_payer         = ? - montant_paye,
      updated_at            = datetime('now')
    WHERE id = ?
  `).run(
    objet?.trim() || null, date_facture || null, date_echeance || null,
    type || null, mode_paiement_attendu || null, commercial_id || null,
    notes !== undefined ? notes : null,
    totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc, totaux.montant_ttc,
    facture.id
  );

  if (lignes) saveLignes(facture.id, newLignes);

  const updated = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(facture.id);
  auditLog(req.user.id, 'UPDATE', facture.id, { before, after: updated });
  res.json({ ...updated, lignes: getLignes(facture.id) });
});

// ── POST /api/factures-clients/:id/emettre ────────────────────────────────────
// Verrouille la facture — plus de modification possible
router.post('/:id/emettre', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour émettre une facture' });
  const facture = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(req.params.id);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (facture.statut !== 'brouillon')
    return res.status(400).json({ error: `Émission impossible — statut actuel : ${facture.statut}` });

  const lignes = getLignes(facture.id);
  if (!lignes.length)
    return res.status(400).json({ error: 'Impossible d\'émettre une facture sans lignes' });

  db.prepare(`
    UPDATE factures_clients
    SET statut = 'emise', updated_at = datetime('now')
    WHERE id = ?
  `).run(facture.id);

  auditLog(req.user.id, 'EMETTRE', facture.id, { ancienStatut: 'brouillon' });
  res.json({ ok: true, statut: 'emise' });
});

// ── POST /api/factures-clients/:id/enregistrer-paiement ──────────────────────
router.post('/:id/enregistrer-paiement', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg', 'caissier'))
    return res.status(403).json({ error: 'Permission insuffisante pour enregistrer un paiement' });
  const facture = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(req.params.id);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });

  const PAYABLES = ['emise','envoyee','partiellement_payee','en_retard'];
  if (!PAYABLES.includes(facture.statut))
    return res.status(400).json({ error: `Paiement impossible — statut : ${facture.statut}` });

  const { montant, mode_paiement = 'especes', date_paiement, reference, notes } = req.body;

  if (!montant || Number(montant) <= 0)
    return res.status(400).json({ error: 'Montant invalide' });
  if (!date_paiement)
    return res.status(400).json({ error: 'date_paiement requise' });

  const montantNum    = Number(montant);
  const nouveauPaye   = Math.round((facture.montant_paye + montantNum) * 100) / 100;
  const nouveauReste  = Math.round((facture.montant_ttc  - nouveauPaye) * 100) / 100;

  if (montantNum > facture.reste_a_payer + 0.01)
    return res.status(400).json({
      error: `Montant (${montantNum}) supérieur au reste à payer (${facture.reste_a_payer})`
    });

  // Déterminer le nouveau statut
  let nouveauStatut;
  if (nouveauReste <= 0.01)          nouveauStatut = 'payee';
  else if (nouveauPaye > 0)          nouveauStatut = 'partiellement_payee';
  else                               nouveauStatut = facture.statut;

  const tx = db.transaction(() => {
    // Enregistrer le paiement
    const { lastInsertRowid: paiId } = db.prepare(`
      INSERT INTO factures_clients_paiements
        (facture_id, montant, date_paiement, mode_paiement, reference, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(facture.id, montantNum, date_paiement,
           mode_paiement, reference || null, notes || null, req.user.id);

    // Mettre à jour la facture
    db.prepare(`
      UPDATE factures_clients SET
        montant_paye  = ?,
        reste_a_payer = ?,
        statut        = ?,
        updated_at    = datetime('now')
      WHERE id = ?
    `).run(nouveauPaye, Math.max(0, nouveauReste), nouveauStatut, facture.id);

    // Mettre à jour l'encours du client (solde)
    // (pas de solde_crediteur modifié ici — calculé dynamiquement dans /solde)

    return paiId;
  });

  const paiId = tx();

  auditLog(req.user.id, 'PAIEMENT', facture.id, {
    montant: montantNum, mode_paiement, nouveauStatut,
    montant_paye: nouveauPaye, reste_a_payer: Math.max(0, nouveauReste)
  });

  const updated = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(facture.id);
  res.json({ ok: true, facture: updated, paiement_id: paiId });
});

// ── POST /api/factures-clients/:id/annuler ────────────────────────────────────
// Motif obligatoire — jamais de suppression physique
router.post('/:id/annuler', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour annuler une facture' });

  const facture = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(req.params.id);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (['annulee', 'payee'].includes(facture.statut))
    return res.status(400).json({ error: `Annulation impossible — statut : ${facture.statut}` });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Le motif d\'annulation est obligatoire' });

  db.prepare(`
    UPDATE factures_clients SET
      statut           = 'annulee',
      motif_annulation = ?,
      updated_at       = datetime('now')
    WHERE id = ?
  `).run(motif.trim(), facture.id);

  auditLog(req.user.id, 'ANNULER', facture.id, {
    ancienStatut: facture.statut, motif: motif.trim()
  });
  res.json({ ok: true, statut: 'annulee', motif: motif.trim() });
});

// ── POST /api/factures-clients/:id/relancer ───────────────────────────────────
router.post('/:id/relancer', requireAuth, (req, res) => {
  const facture = db.prepare(`
    SELECT f.*, c.nom AS client_nom, c.email AS client_email
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.id = ?
  `).get(req.params.id);

  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (['payee', 'annulee'].includes(facture.statut))
    return res.status(400).json({ error: 'Relance inutile — facture déjà payée ou annulée' });

  const { type_relance = 'J7', canal = 'email', notes } = req.body;

  // Enregistrer la relance
  db.prepare(`
    INSERT INTO relances
      (reference_type, reference_id, client_id, type_relance, date_relance, statut, canal, notes, created_by, created_at)
    VALUES ('facture_client', ?, ?, ?, date('now'), 'envoyee', ?, ?, ?, datetime('now'))
  `).run(facture.id, facture.client_id, type_relance, canal, notes || null, req.user.id);

  // Tentative envoi email si canal=email et email disponible
  let emailEnvoye = false;
  if (canal === 'email' && facture.client_email) {
    try {
      const { sendRelanceFacture } = require('../services/email');
      if (typeof sendRelanceFacture === 'function') {
        sendRelanceFacture(facture.client_email, facture.client_nom, {
          numero: facture.numero,
          montant: facture.reste_a_payer,
          date_echeance: facture.date_echeance
        }).catch(e => console.error('[RELANCE email]', e.message));
        emailEnvoye = true;
      }
    } catch (_) { /* service email non disponible */ }
  }

  auditLog(req.user.id, 'RELANCER', facture.id, { type_relance, canal, emailEnvoye });
  res.json({ ok: true, type_relance, canal, email_envoye: emailEnvoye });
});

// ── Mise à jour auto des factures en retard (appelée depuis cron) ─────────────
function marquerFacturesEnRetard() {
  const result = db.prepare(`
    UPDATE factures_clients
    SET statut = 'en_retard', updated_at = datetime('now')
    WHERE statut IN ('emise','envoyee','partiellement_payee')
      AND date_echeance IS NOT NULL
      AND date_echeance < date('now')
  `).run();
  if (result.changes > 0)
    console.log(`[FACTURES cron] ${result.changes} factures passées en en_retard`);
}

module.exports = router;
module.exports.marquerFacturesEnRetard = marquerFacturesEnRetard;
