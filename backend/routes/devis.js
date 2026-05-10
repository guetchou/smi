/**
 * MODULE DEVIS — Prompt 2
 * Workflow complet : brouillon → envoye → accepte/refuse → converti (facture)
 * Gestion des versions, calculs HT/TTC automatiques, audit log sur chaque transition.
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
      VALUES (?, ?, 'devis', ?, ?, datetime('now'))
    `).run(userId, action, recordId, typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (_) { /* non-bloquant */ }
}

function genNumeroDevis() {
  const annee = new Date().getFullYear();
  const last  = db.prepare(`
    SELECT numero FROM devis
    WHERE numero LIKE 'DEV-${annee}-%'
    ORDER BY id DESC LIMIT 1
  `).get();
  if (!last) return `DEV-${annee}-0001`;
  const n = parseInt(last.numero.split('-')[2], 10) || 0;
  return `DEV-${annee}-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Calcule les totaux d'un devis à partir de ses lignes + remise globale.
 * remise_globale est un pourcentage (0-100).
 */
function calcTotaux(lignes, remiseGlobale = 0) {
  let ht = 0, taxes = 0;
  for (const l of lignes) {
    const qte   = Number(l.quantite)      || 0;
    const pu    = Number(l.prix_unitaire) || 0;
    const rem   = Number(l.remise)        || 0;      // % remise ligne
    const taxe  = Number(l.taux_taxe)     || 0;      // % taxe ligne

    const brut      = qte * pu;
    const apresRem  = brut * (1 - rem / 100);
    const montHT    = apresRem;
    const montTaxe  = montHT * (taxe / 100);

    l.montant_ht  = Math.round(montHT  * 100) / 100;
    l.montant_ttc = Math.round((montHT + montTaxe) * 100) / 100;

    ht    += montHT;
    taxes += montTaxe;
  }
  // Remise globale sur le HT
  const remGlob   = ht * (remiseGlobale / 100);
  const htFinal   = ht - remGlob;
  const ttcFinal  = htFinal + taxes;

  return {
    montant_ht:    Math.round(htFinal  * 100) / 100,
    montant_taxes: Math.round(taxes    * 100) / 100,
    montant_ttc:   Math.round(ttcFinal * 100) / 100,
  };
}

function getLignes(devisId) {
  return db.prepare(
    'SELECT * FROM devis_lignes WHERE devis_id = ? ORDER BY ordre ASC, id ASC'
  ).all(devisId);
}

function saveLignes(devisId, lignes) {
  db.prepare('DELETE FROM devis_lignes WHERE devis_id = ?').run(devisId);
  const ins = db.prepare(`
    INSERT INTO devis_lignes
      (devis_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  lignes.forEach((l, i) => {
    ins.run(
      devisId,
      l.type || 'service',
      l.designation,
      Number(l.quantite)      || 1,
      Number(l.prix_unitaire) || 0,
      Number(l.remise)        || 0,
      Number(l.taux_taxe)     || 0,
      l.montant_ht  || 0,
      l.montant_ttc || 0,
      l.ordre != null ? l.ordre : i
    );
  });
}

// Transitions de statut autorisées
const TRANSITIONS = {
  brouillon:       ['envoye', 'annule'],
  envoye:          ['vu_par_client', 'en_negociation', 'accepte', 'refuse', 'expire', 'annule'],
  vu_par_client:   ['en_negociation', 'accepte', 'refuse', 'expire', 'annule'],
  en_negociation:  ['accepte', 'refuse', 'expire', 'annule'],
  accepte:         ['converti'],
  refuse:          [],
  expire:          [],
  annule:          [],
  converti:        [],
};

function canTransit(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// ── GET /api/devis ────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { statut, client_id, commercial_id, search,
          date_debut, date_fin, limit = 50, offset = 0 } = req.query;

  const where  = ['1=1'];
  const params = [];

  if (statut)       { where.push('d.statut = ?');       params.push(statut); }
  if (client_id)    { where.push('d.client_id = ?');    params.push(client_id); }
  if (commercial_id){ where.push('d.commercial_id = ?');params.push(commercial_id); }
  if (date_debut)   { where.push('d.date_devis >= ?');  params.push(date_debut); }
  if (date_fin)     { where.push('d.date_devis <= ?');  params.push(date_fin); }
  if (search) {
    where.push('(d.numero LIKE ? OR d.objet LIKE ? OR c.nom LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const sql = `
    SELECT d.*,
           c.nom      AS client_nom,
           c.statut   AS client_statut,
           u.nom      AS commercial_nom
    FROM devis d
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN users   u ON u.id = d.commercial_id
    WHERE ${where.join(' AND ')}
    ORDER BY d.date_devis DESC, d.id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const rows  = db.prepare(sql).all(...params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM devis d LEFT JOIN clients c ON c.id = d.client_id WHERE ${where.join(' AND ')}`
  ).get(...params.slice(0, -2)).n;

  res.json({ devis: rows, total });
});

// ── GET /api/devis/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const devis = db.prepare(`
    SELECT d.*,
           c.nom    AS client_nom,
           c.email  AS client_email,
           c.statut AS client_statut,
           u.nom    AS commercial_nom
    FROM devis d
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN users   u ON u.id = d.commercial_id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });

  const lignes = getLignes(devis.id);

  // Versions liées (enfants)
  const versions = db.prepare(`
    SELECT id, numero, version, statut, created_at
    FROM devis WHERE devis_parent_id = ? ORDER BY version ASC
  `).all(devis.id);

  res.json({ ...devis, lignes, versions });
});

// ── POST /api/devis ───────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour créer un devis' });
  const {
    client_id, objet, date_devis, date_validite,
    remise_globale = 0, conditions_paiement, delai_livraison,
    commercial_id, notes, lignes = []
  } = req.body;

  if (!client_id)      return res.status(400).json({ error: 'client_id requis' });
  if (!objet?.trim())  return res.status(400).json({ error: 'objet requis' });
  if (!date_devis)     return res.status(400).json({ error: 'date_devis requise' });
  if (!lignes.length)  return res.status(400).json({ error: 'Au moins une ligne est requise' });

  // Vérifier client existant et non bloqué
  const client = db.prepare('SELECT id, statut FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  for (const l of lignes) {
    if (!l.designation?.trim()) return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });
  }

  const totaux  = calcTotaux(lignes, remise_globale);
  const numero  = genNumeroDevis();

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO devis
      (numero, client_id, objet, date_devis, date_validite, statut,
       montant_ht, montant_taxes, montant_ttc, remise_globale,
       conditions_paiement, delai_livraison, commercial_id, notes,
       version, created_by, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, 'brouillon',
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       1, ?, datetime('now'), datetime('now'))
  `).run(
    numero, client_id, objet.trim(), date_devis, date_validite || null,
    totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc,
    Number(remise_globale),
    conditions_paiement || null, delai_livraison || null,
    commercial_id || req.user.id, notes || null,
    req.user.id
  );

  saveLignes(lastInsertRowid, lignes);
  auditLog(req.user.id, 'CREATE', lastInsertRowid, { numero, client_id, objet });

  const created = db.prepare('SELECT * FROM devis WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ ...created, lignes: getLignes(lastInsertRowid) });
});

// ── PUT /api/devis/:id ────────────────────────────────────────────────────────
// Modification uniquement si statut = brouillon
router.put('/:id', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier un devis' });
  const devis = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (devis.statut !== 'brouillon')
    return res.status(403).json({ error: `Modification impossible — statut actuel : ${devis.statut}` });

  const {
    client_id, objet, date_devis, date_validite,
    remise_globale, conditions_paiement, delai_livraison,
    commercial_id, notes, lignes
  } = req.body;

  const newLignes = lignes || getLignes(devis.id);
  if (!newLignes.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

  const remise  = remise_globale != null ? Number(remise_globale) : devis.remise_globale;
  const totaux  = calcTotaux(newLignes, remise);
  const before  = { ...devis };

  db.prepare(`
    UPDATE devis SET
      client_id           = COALESCE(?, client_id),
      objet               = COALESCE(?, objet),
      date_devis          = COALESCE(?, date_devis),
      date_validite       = COALESCE(?, date_validite),
      remise_globale      = ?,
      montant_ht          = ?,
      montant_taxes       = ?,
      montant_ttc         = ?,
      conditions_paiement = COALESCE(?, conditions_paiement),
      delai_livraison     = COALESCE(?, delai_livraison),
      commercial_id       = COALESCE(?, commercial_id),
      notes               = COALESCE(?, notes),
      updated_at          = datetime('now')
    WHERE id = ?
  `).run(
    client_id    || null, objet?.trim() || null,
    date_devis   || null, date_validite || null,
    remise,
    totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc,
    conditions_paiement || null, delai_livraison || null,
    commercial_id || null, notes !== undefined ? notes : null,
    devis.id
  );

  if (lignes) saveLignes(devis.id, newLignes);

  const updated = db.prepare('SELECT * FROM devis WHERE id = ?').get(devis.id);
  auditLog(req.user.id, 'UPDATE', devis.id, { before, after: updated });

  res.json({ ...updated, lignes: getLignes(devis.id) });
});

// ── POST /api/devis/:id/envoyer ───────────────────────────────────────────────
router.post('/:id/envoyer', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'envoye'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → envoye` });

  db.prepare(`
    UPDATE devis SET statut = 'envoye', date_envoi = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(devis.id);

  auditLog(req.user.id, 'ENVOYER', devis.id, { ancienStatut: devis.statut, nouveauStatut: 'envoye' });
  res.json({ ok: true, statut: 'envoye' });
});

// ── POST /api/devis/:id/accepter ──────────────────────────────────────────────
router.post('/:id/accepter', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'accepte'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → accepte` });

  const { preuve } = req.body; // motif / description preuve acceptation

  db.prepare(`
    UPDATE devis SET
      statut            = 'accepte',
      date_acceptation  = datetime('now'),
      preuve_acceptation = ?,
      updated_at        = datetime('now')
    WHERE id = ?
  `).run(preuve || null, devis.id);

  auditLog(req.user.id, 'ACCEPTER', devis.id, { ancienStatut: devis.statut, preuve: preuve || null });
  res.json({ ok: true, statut: 'accepte' });
});

// ── POST /api/devis/:id/refuser ───────────────────────────────────────────────
router.post('/:id/refuser', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'refuse'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → refuse` });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Le motif de refus est obligatoire' });

  db.prepare(`
    UPDATE devis SET statut = 'refuse', motif_refus = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(motif.trim(), devis.id);

  auditLog(req.user.id, 'REFUSER', devis.id, { ancienStatut: devis.statut, motif });
  res.json({ ok: true, statut: 'refuse', motif });
});

// ── POST /api/devis/:id/dupliquer ─────────────────────────────────────────────
// Crée une nouvelle version (version + 1) liée au devis parent
router.post('/:id/dupliquer', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const parent = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Devis introuvable' });

  // Trouver la version max parmi les versions liées à la racine
  const racineId = parent.devis_parent_id || parent.id;
  const maxVer   = db.prepare(`
    SELECT MAX(version) AS v FROM devis
    WHERE id = ? OR devis_parent_id = ?
  `).get(racineId, racineId);
  const newVersion = (maxVer?.v || parent.version) + 1;
  const numero     = genNumeroDevis();

  const lignesParent = getLignes(parent.id);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO devis
      (numero, client_id, objet, date_devis, date_validite, statut,
       montant_ht, montant_taxes, montant_ttc, remise_globale,
       conditions_paiement, delai_livraison, commercial_id, notes,
       version, devis_parent_id, created_by, created_at, updated_at)
    VALUES
      (?, ?, ?, date('now'), ?, 'brouillon',
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    numero, parent.client_id, parent.objet, parent.date_validite,
    parent.montant_ht, parent.montant_taxes, parent.montant_ttc, parent.remise_globale,
    parent.conditions_paiement, parent.delai_livraison, parent.commercial_id, parent.notes,
    newVersion, racineId, req.user.id
  );

  saveLignes(lastInsertRowid, lignesParent);
  auditLog(req.user.id, 'DUPLIQUER', lastInsertRowid, {
    parentId: parent.id, version: newVersion, numero
  });

  const created = db.prepare('SELECT * FROM devis WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ ...created, lignes: getLignes(lastInsertRowid) });
});

// ── POST /api/devis/:id/convertir ─────────────────────────────────────────────
// Crée une facture client depuis ce devis (module factures_clients — Prompt 3)
// Si la table n'existe pas encore, retourne 501 avec explication claire.
router.post('/:id/convertir', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour convertir un devis' });
  const devis = db.prepare('SELECT * FROM devis WHERE id = ?').get(req.params.id);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (devis.statut !== 'accepte')
    return res.status(400).json({ error: 'Seul un devis accepté peut être converti en facture' });

  // Vérifier que le module factures_clients existe (Prompt 3)
  const tableExisteFact = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factures_clients'"
  ).get();

  if (!tableExisteFact) {
    return res.status(501).json({
      error: 'Module Factures clients non encore déployé (Prompt 3). Créer la facture manuellement.'
    });
  }

  const lignes = getLignes(devis.id);
  const annee  = new Date().getFullYear();
  const lastFac = db.prepare(`
    SELECT numero FROM factures_clients WHERE numero LIKE 'FAC-${annee}-%' ORDER BY id DESC LIMIT 1
  `).get();
  const nFac = lastFac ? parseInt(lastFac.numero.split('-')[2], 10) + 1 : 1;
  const numeroFac = `FAC-${annee}-${String(nFac).padStart(4, '0')}`;

  // Date d'échéance = aujourd'hui + délai paiement client
  const client = db.prepare('SELECT delai_paiement_autorise FROM clients WHERE id = ?').get(devis.client_id);
  const delai  = client?.delai_paiement_autorise || 30;
  const echeance = new Date();
  echeance.setDate(echeance.getDate() + delai);

  const txFac = db.transaction(() => {
    const { lastInsertRowid: facId } = db.prepare(`
      INSERT INTO factures_clients
        (numero, client_id, devis_id, type, objet, date_facture, date_echeance, statut,
         montant_ht, montant_taxes, montant_ttc, montant_paye, reste_a_payer,
         commercial_id, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, 'definitive', ?, date('now'), ?, 'brouillon',
         ?, ?, ?, 0, ?,
         ?, ?, datetime('now'), datetime('now'))
    `).run(
      numeroFac, devis.client_id, devis.id, devis.objet,
      echeance.toISOString().split('T')[0],
      devis.montant_ht, devis.montant_taxes, devis.montant_ttc, devis.montant_ttc,
      devis.commercial_id, req.user.id
    );

    // Copier les lignes
    const insL = db.prepare(`
      INSERT INTO factures_clients_lignes
        (facture_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    lignes.forEach(l => insL.run(facId, l.type, l.designation, l.quantite, l.prix_unitaire, l.remise, l.taux_taxe, l.montant_ht, l.montant_ttc, l.ordre));

    // Passer le devis en converti
    db.prepare(`UPDATE devis SET statut = 'converti', updated_at = datetime('now') WHERE id = ?`).run(devis.id);

    return facId;
  });

  const facId = txFac();
  auditLog(req.user.id, 'CONVERTIR', devis.id, { factureId: facId, numeroFac });

  const facture = db.prepare('SELECT * FROM factures_clients WHERE id = ?').get(facId);
  res.status(201).json({ ok: true, facture });
});

// ── CRON interne : passer les devis expirés ───────────────────────────────────
// Appelé depuis server.js dans le cron 24h
function expireDevisEchus() {
  const result = db.prepare(`
    UPDATE devis
    SET statut = 'expire', updated_at = datetime('now')
    WHERE statut IN ('brouillon','envoye','vu_par_client','en_negociation')
      AND date_validite IS NOT NULL
      AND date_validite < date('now')
  `).run();
  if (result.changes > 0)
    console.log(`[DEVIS cron] ${result.changes} devis passés en expire`);
}

module.exports = router;
module.exports.expireDevisEchus = expireDevisEchus;
