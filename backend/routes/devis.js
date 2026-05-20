/**
 * MODULE DEVIS — Prompt 2
 * Workflow complet : brouillon → envoye → accepte/refuse → converti (facture)
 * Gestion des versions, calculs HT/TTC automatiques, audit log sur chaque transition.
 */
const express = require('express');
const db      = require('../db');
const { requireAuth, hasRole } = require('./auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function auditLog(userId, action, recordId, details = '') {
  try {
    await db.execute(`
      INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, 'devis', ?, ?, NOW())
    `, [userId, action, recordId, typeof details === 'object' ? JSON.stringify(details) : details]);
  } catch (_) { /* non-bloquant */ }
}

async function genNumeroDevis() {
  const annee = new Date().getFullYear();
  const last  = await db.queryOne(`
    SELECT numero FROM devis
    WHERE numero LIKE 'DEV-${annee}-%'
    ORDER BY id DESC LIMIT 1
  `);
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

async function getLignes(devisId) {
  return db.query(
    'SELECT * FROM devis_lignes WHERE devis_id = ? ORDER BY ordre ASC, id ASC',
    [devisId]
  );
}

async function saveLignes(tx, devisId, lignes) {
  await tx.execute('DELETE FROM devis_lignes WHERE devis_id = ?', [devisId]);
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    await tx.execute(`
      INSERT INTO devis_lignes
        (devis_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);
  }
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
router.get('/', requireAuth, async (req, res) => {
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

  const rows  = await db.query(sql, params);
  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM devis d LEFT JOIN clients c ON c.id = d.client_id WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  )).n;

  res.json({ devis: rows, total });
});

// ── GET /api/devis/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const devis = await db.queryOne(`
    SELECT d.*,
           c.nom    AS client_nom,
           c.email  AS client_email,
           c.statut AS client_statut,
           u.nom    AS commercial_nom
    FROM devis d
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN users   u ON u.id = d.commercial_id
    WHERE d.id = ?
  `, [req.params.id]);

  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });

  const lignes = await getLignes(devis.id);

  // Versions liées (enfants)
  const versions = await db.query(`
    SELECT id, numero, version, statut, created_at
    FROM devis WHERE devis_parent_id = ? ORDER BY version ASC
  `, [devis.id]);

  res.json({ ...devis, lignes, versions });
});

// ── POST /api/devis ───────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
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
  const client = await db.queryOne('SELECT id, statut FROM clients WHERE id = ?', [client_id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  for (const l of lignes) {
    if (!l.designation?.trim()) return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });
  }

  const totaux  = calcTotaux(lignes, remise_globale);
  const numero  = await genNumeroDevis();

  const lastInsertId = await db.transaction(async (tx) => {
    const result = await tx.execute(`
      INSERT INTO devis
        (numero, client_id, objet, date_devis, date_validite, statut,
         montant_ht, montant_taxes, montant_ttc, remise_globale,
         conditions_paiement, delai_livraison, commercial_id, notes,
         version, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, 'brouillon',
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         1, ?, NOW(), NOW())
    `, [
      numero, client_id, objet.trim(), date_devis, date_validite || null,
      totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc,
      Number(remise_globale),
      conditions_paiement || null, delai_livraison || null,
      commercial_id || req.user.id, notes || null,
      req.user.id
    ]);

    await saveLignes(tx, result.insertId, lignes);
    return result.insertId;
  });

  await auditLog(req.user.id, 'CREATE', lastInsertId, { numero, client_id, objet });

  const created = await db.queryOne('SELECT * FROM devis WHERE id = ?', [lastInsertId]);
  res.status(201).json({ ...created, lignes: await getLignes(lastInsertId) });
});

// ── PUT /api/devis/:id ────────────────────────────────────────────────────────
// Modification uniquement si statut = brouillon
router.put('/:id', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier un devis' });
  const devis = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (devis.statut !== 'brouillon')
    return res.status(403).json({ error: `Modification impossible — statut actuel : ${devis.statut}` });

  const {
    client_id, objet, date_devis, date_validite,
    remise_globale, conditions_paiement, delai_livraison,
    commercial_id, notes, lignes
  } = req.body;

  const newLignes = lignes || await getLignes(devis.id);
  if (!newLignes.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

  const remise  = remise_globale != null ? Number(remise_globale) : devis.remise_globale;
  const totaux  = calcTotaux(newLignes, remise);
  const before  = { ...devis };

  await db.transaction(async (tx) => {
    await tx.execute(`
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
        updated_at          = NOW()
      WHERE id = ?
    `, [
      client_id    || null, objet?.trim() || null,
      date_devis   || null, date_validite || null,
      remise,
      totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc,
      conditions_paiement || null, delai_livraison || null,
      commercial_id || null, notes !== undefined ? notes : null,
      devis.id
    ]);

    if (lignes) await saveLignes(tx, devis.id, newLignes);
  });

  const updated = await db.queryOne('SELECT * FROM devis WHERE id = ?', [devis.id]);
  await auditLog(req.user.id, 'UPDATE', devis.id, { before, after: updated });

  res.json({ ...updated, lignes: await getLignes(devis.id) });
});

// ── POST /api/devis/:id/envoyer ───────────────────────────────────────────────
router.post('/:id/envoyer', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'envoye'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → envoye` });

  await db.execute(`
    UPDATE devis SET statut = 'envoye', date_envoi = NOW(), updated_at = NOW()
    WHERE id = ?
  `, [devis.id]);

  await auditLog(req.user.id, 'ENVOYER', devis.id, { ancienStatut: devis.statut, nouveauStatut: 'envoye' });
  res.json({ ok: true, statut: 'envoye' });
});

// ── POST /api/devis/:id/accepter ──────────────────────────────────────────────
router.post('/:id/accepter', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'accepte'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → accepte` });

  const { preuve } = req.body; // motif / description preuve acceptation

  await db.execute(`
    UPDATE devis SET
      statut            = 'accepte',
      date_acceptation  = NOW(),
      preuve_acceptation = ?,
      updated_at        = NOW()
    WHERE id = ?
  `, [preuve || null, devis.id]);

  await auditLog(req.user.id, 'ACCEPTER', devis.id, { ancienStatut: devis.statut, preuve: preuve || null });
  res.json({ ok: true, statut: 'accepte' });
});

// ── POST /api/devis/:id/refuser ───────────────────────────────────────────────
router.post('/:id/refuser', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const devis = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canTransit(devis.statut, 'refuse'))
    return res.status(400).json({ error: `Transition impossible : ${devis.statut} → refuse` });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Le motif de refus est obligatoire' });

  await db.execute(`
    UPDATE devis SET statut = 'refuse', motif_refus = ?, updated_at = NOW()
    WHERE id = ?
  `, [motif.trim(), devis.id]);

  await auditLog(req.user.id, 'REFUSER', devis.id, { ancienStatut: devis.statut, motif });
  res.json({ ok: true, statut: 'refuse', motif });
});

// ── POST /api/devis/:id/dupliquer ─────────────────────────────────────────────
// Crée une nouvelle version (version + 1) liée au devis parent
router.post('/:id/dupliquer', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const parent = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!parent) return res.status(404).json({ error: 'Devis introuvable' });

  // Trouver la version max parmi les versions liées à la racine
  const racineId = parent.devis_parent_id || parent.id;
  const maxVer   = await db.queryOne(`
    SELECT MAX(version) AS v FROM devis
    WHERE id = ? OR devis_parent_id = ?
  `, [racineId, racineId]);
  const newVersion = (maxVer?.v || parent.version) + 1;
  const numero     = await genNumeroDevis();

  const lignesParent = await getLignes(parent.id);

  const lastInsertId = await db.transaction(async (tx) => {
    const result = await tx.execute(`
      INSERT INTO devis
        (numero, client_id, objet, date_devis, date_validite, statut,
         montant_ht, montant_taxes, montant_ttc, remise_globale,
         conditions_paiement, delai_livraison, commercial_id, notes,
         version, devis_parent_id, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, CURDATE(), ?, 'brouillon',
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, NOW(), NOW())
    `, [
      numero, parent.client_id, parent.objet, parent.date_validite,
      parent.montant_ht, parent.montant_taxes, parent.montant_ttc, parent.remise_globale,
      parent.conditions_paiement, parent.delai_livraison, parent.commercial_id, parent.notes,
      newVersion, racineId, req.user.id
    ]);

    await saveLignes(tx, result.insertId, lignesParent);
    return result.insertId;
  });

  await auditLog(req.user.id, 'DUPLIQUER', lastInsertId, {
    parentId: parent.id, version: newVersion, numero
  });

  const created = await db.queryOne('SELECT * FROM devis WHERE id = ?', [lastInsertId]);
  res.status(201).json({ ...created, lignes: await getLignes(lastInsertId) });
});

// ── POST /api/devis/:id/convertir ─────────────────────────────────────────────
// Crée une facture client depuis ce devis (module factures_clients — Prompt 3)
// Si la table n'existe pas encore, retourne 501 avec explication claire.
router.post('/:id/convertir', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour convertir un devis' });
  const devis = await db.queryOne('SELECT * FROM devis WHERE id = ?', [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
  if (devis.statut !== 'accepte')
    return res.status(400).json({ error: 'Seul un devis accepté peut être converti en facture' });

  // Vérifier que le module factures_clients existe (Prompt 3)
  let tableExisteFact = false;
  try {
    await db.queryOne('SELECT 1 FROM factures_clients LIMIT 1');
    tableExisteFact = true;
  } catch (_) {}

  if (!tableExisteFact) {
    return res.status(501).json({
      error: 'Module Factures clients non encore déployé (Prompt 3). Créer la facture manuellement.'
    });
  }

  const lignes = await getLignes(devis.id);
  const annee  = new Date().getFullYear();
  const lastFac = await db.queryOne(`
    SELECT numero FROM factures_clients WHERE numero LIKE 'FAC-${annee}-%' ORDER BY id DESC LIMIT 1
  `);
  const nFac = lastFac ? parseInt(lastFac.numero.split('-')[2], 10) + 1 : 1;
  const numeroFac = `FAC-${annee}-${String(nFac).padStart(4, '0')}`;

  // Date d'échéance = aujourd'hui + délai paiement client
  const client = await db.queryOne('SELECT delai_paiement_autorise FROM clients WHERE id = ?', [devis.client_id]);
  const delai  = client?.delai_paiement_autorise || 30;
  const echeance = new Date();
  echeance.setDate(echeance.getDate() + delai);

  const facId = await db.transaction(async (tx) => {
    const facResult = await tx.execute(`
      INSERT INTO factures_clients
        (numero, client_id, devis_id, type, objet, date_facture, date_echeance, statut,
         montant_ht, montant_taxes, montant_ttc, montant_paye, reste_a_payer,
         commercial_id, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, 'definitive', ?, CURDATE(), ?, 'brouillon',
         ?, ?, ?, 0, ?,
         ?, ?, NOW(), NOW())
    `, [
      numeroFac, devis.client_id, devis.id, devis.objet,
      echeance.toISOString().split('T')[0],
      devis.montant_ht, devis.montant_taxes, devis.montant_ttc, devis.montant_ttc,
      devis.commercial_id, req.user.id
    ]);

    // Copier les lignes
    for (const l of lignes) {
      await tx.execute(`
        INSERT INTO factures_clients_lignes
          (facture_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [facResult.insertId, l.type, l.designation, l.quantite, l.prix_unitaire, l.remise, l.taux_taxe, l.montant_ht, l.montant_ttc, l.ordre]);
    }

    // Passer le devis en converti
    await tx.execute(`UPDATE devis SET statut = 'converti', updated_at = NOW() WHERE id = ?`, [devis.id]);

    return facResult.insertId;
  });

  await auditLog(req.user.id, 'CONVERTIR', devis.id, { factureId: facId, numeroFac });

  const facture = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [facId]);
  res.status(201).json({ ok: true, facture });
});

// ── CRON interne : passer les devis expirés ───────────────────────────────────
// Appelé depuis server.js dans le cron 24h
async function expireDevisEchus() {
  const result = await db.execute(`
    UPDATE devis
    SET statut = 'expire', updated_at = NOW()
    WHERE statut IN ('brouillon','envoye','vu_par_client','en_negociation')
      AND date_validite IS NOT NULL
      AND date_validite < CURDATE()
  `);
  if (result.affectedRows > 0)
    console.log(`[DEVIS cron] ${result.affectedRows} devis passés en expire`);
}

// ── Helpers PDF ───────────────────────────────────────────────────────────────
async function getSociete() {
  const r = await db.queryOne("SELECT valeur FROM parametres WHERE cle='societe'");
  return r ? r.valeur : 'TOP CENTER';
}
async function getDevise() {
  const r = await db.queryOne("SELECT valeur FROM parametres WHERE cle='devise'");
  return r ? r.valeur : 'XAF';
}

const { generatePdf } = require('../services/pdf');

function buildHtmlDevis(devis, lignes, devise, societe) {
  const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v || 0);
  const fmtDate = d => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  const lignesHtml = lignes.map(l => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 10px;font-size:11px">${l.designation || '—'}</td>
      <td style="padding:7px 10px;text-align:center;font-size:11px">${l.quantite}</td>
      <td style="padding:7px 10px;text-align:right;font-size:11px">${fmt(l.prix_unitaire)}</td>
      <td style="padding:7px 10px;text-align:right;font-size:11px">${l.remise > 0 ? l.remise + '%' : '—'}</td>
      <td style="padding:7px 10px;text-align:right;font-size:11px;font-weight:600">${fmt(l.montant_ht)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b}
  .accent{background:linear-gradient(135deg,#1A50D9,#2563eb);height:5px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding:12mm 14mm 8mm}
  .brand{font-size:22px;font-weight:700;color:#1A50D9}
  .brand-sub{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
  .brand-addr{font-size:9px;color:#94a3b8;line-height:1.6;margin-top:6px}
  .doc-badge{display:inline-block;background:#eff6ff;border:2px solid #1A50D9;color:#1A50D9;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:3px 10px;border-radius:4px;margin-bottom:4px}
  .doc-title{font-size:26px;font-weight:700;color:#0f172a;text-align:right}
  .doc-num{font-size:12px;color:#475569;text-align:right;margin-top:3px}
  .validity{display:inline-block;background:#fef9c3;color:#713f12;font-size:8px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;margin-top:3px}
  .divider{height:1px;background:linear-gradient(to right,#1A50D9,#e2e8f0);margin:0 14mm}
  .parties{display:flex;gap:4mm;padding:5mm 14mm;background:#f8fafc}
  .party{flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:9px 11px}
  .party.hl{border-color:#1A50D9;border-width:2px}
  .party-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#1A50D9;margin-bottom:5px}
  .party-name{font-size:12px;font-weight:700;color:#0f172a;margin-bottom:3px}
  .party-detail{font-size:9px;color:#475569;line-height:1.7}
  .meta{background:#1A50D9;color:#fff;padding:3mm 14mm;display:flex;justify-content:space-between;font-size:9px}
  .meta-item{text-align:center}
  .meta-label{opacity:.7;text-transform:uppercase;letter-spacing:.5px}
  .meta-val{font-weight:700;margin-top:2px}
  .content{padding:5mm 14mm}
  table{width:100%;border-collapse:collapse}
  thead th{background:#0f172a;color:#fff;font-weight:600;padding:7px 10px;font-size:9px;text-transform:uppercase}
  thead th.r{text-align:right}thead th.c{text-align:center}
  .summary{display:flex;justify-content:space-between;padding:4mm 14mm;gap:4mm}
  .notes-box{flex:1;background:#f8fafc;border-left:3px solid #1A50D9;border-radius:0 5px 5px 0;padding:9px 11px}
  .notes-title{font-size:8px;font-weight:700;text-transform:uppercase;color:#1A50D9;margin-bottom:5px}
  .notes-text{font-size:9px;color:#475569;line-height:1.7}
  .tot{width:70mm}
  .tot-line{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #f1f5f9;color:#475569}
  .tot-line .v{font-weight:600;color:#334155}
  .tot-grand{display:flex;justify-content:space-between;background:#1A50D9;color:#fff;font-weight:700;font-size:13px;padding:8px 10px;border-radius:6px;margin-top:6px}
  .accept{display:flex;gap:4mm;padding:0 14mm 4mm}
  .accept-box{flex:1;border:1.5px dashed #cbd5e1;border-radius:6px;padding:8px 10px}
  .accept-box.cta{border-color:#1A50D9;border-style:solid;background:#eff6ff}
  .accept-title{font-size:8px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:8px}
  .accept-box.cta .accept-title{color:#1A50D9}
  .sig-line{height:1px;background:#e2e8f0;margin-bottom:20px}
  .sig-sub{font-size:8px;color:#94a3b8;text-align:center}
  .footer{background:#0f172a;color:rgba(255,255,255,.7);padding:4mm 14mm;display:flex;justify-content:space-between;font-size:8px;line-height:1.7}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head><body>
<div class="accent"></div>
<div class="header">
  <div>
    <div class="brand">${societe}</div>
    <div class="brand-sub">SARL</div>
    <div class="brand-addr">Brazzaville, République du Congo<br>contact@topcenter.cg</div>
  </div>
  <div style="text-align:right">
    <div><span class="doc-badge">Proposition commerciale</span></div>
    <div class="doc-title">DEVIS</div>
    <div class="doc-num">${devis.numero}</div>
    <div class="doc-num" style="font-size:10px;margin-top:2px">Établi le ${fmtDate(devis.date_devis)}</div>
    ${devis.date_validite ? `<div style="text-align:right"><span class="validity">Valable jusqu'au ${fmtDate(devis.date_validite)}</span></div>` : ''}
  </div>
</div>

<div class="divider"></div>

<div class="parties">
  <div class="party">
    <div class="party-label">De</div>
    <div class="party-name">${societe} SARL</div>
    <div class="party-detail">Brazzaville, République du Congo<br>contact@topcenter.cg</div>
  </div>
  <div class="party hl">
    <div class="party-label">À l'attention de</div>
    <div class="party-name">${devis.client_nom || '—'}</div>
    <div class="party-detail">${devis.client_email || ''}</div>
  </div>
</div>

<div class="meta">
  <div class="meta-item"><div class="meta-label">Référence</div><div class="meta-val">${devis.numero}</div></div>
  <div class="meta-item"><div class="meta-label">Date</div><div class="meta-val">${fmtDate(devis.date_devis)}</div></div>
  <div class="meta-item"><div class="meta-label">Validité</div><div class="meta-val">${fmtDate(devis.date_validite)}</div></div>
  <div class="meta-item"><div class="meta-label">Remise glob.</div><div class="meta-val">${devis.remise_globale || 0}%</div></div>
  <div class="meta-item"><div class="meta-label">Devise</div><div class="meta-val">${devise}</div></div>
</div>

<div class="content">
<br>
<table>
  <thead><tr>
    <th style="width:44%;text-align:left">Désignation</th>
    <th class="c" style="width:8%">Qté</th>
    <th style="width:8%;text-align:left">Unité</th>
    <th class="r" style="width:13%">P.U. HT</th>
    <th class="r" style="width:10%">Remise</th>
    <th class="r" style="width:17%">Total HT</th>
  </tr></thead>
  <tbody>${lignesHtml}</tbody>
</table>
</div>

<div class="summary">
  <div class="notes-box">
    <div class="notes-title">Conditions &amp; Observations</div>
    <div class="notes-text">${devis.conditions_paiement ? '• Paiement : ' + devis.conditions_paiement + '<br>' : ''}${devis.delai_livraison ? '• Délai livraison : ' + devis.delai_livraison + '<br>' : ''}${devis.notes || 'Prix fermes pour la durée de validité du devis.'}</div>
  </div>
  <div class="tot">
    <div class="tot-line"><span>Total HT</span><span class="v">${fmt(devis.montant_ht)} ${devise}</span></div>
    ${devis.remise_globale > 0 ? `<div class="tot-line"><span>Remise globale (${devis.remise_globale}%)</span><span class="v">- ${fmt(devis.montant_ht * devis.remise_globale / 100)} ${devise}</span></div>` : ''}
    <div class="tot-line"><span>Taxes</span><span class="v">${fmt(devis.montant_taxes)} ${devise}</span></div>
    <div class="tot-grand"><span>TOTAL TTC</span><span>${fmt(devis.montant_ttc)} ${devise}</span></div>
  </div>
</div>

<div class="accept">
  <div class="accept-box cta">
    <div class="accept-title">Bon pour accord — Cachet &amp; Signature client</div>
    <div class="sig-line"></div>
    <div class="sig-line"></div>
    <div class="sig-sub">Date : ___/___/______</div>
  </div>
  <div class="accept-box">
    <div class="accept-title">Établi par — ${societe} SARL</div>
    <div class="sig-line"></div>
    <div class="sig-line"></div>
    <div class="sig-sub">Commercial chargé du compte</div>
  </div>
</div>

<div class="footer">
  <div>${societe} SARL — Brazzaville, Congo</div>
  <div style="text-align:center">${devis.numero} — Tala SMI</div>
  <div style="text-align:right">contact@topcenter.cg</div>
</div>
</body></html>`;
}

// ── GET /api/devis/:id/pdf ────────────────────────────────────────────────────
router.get('/:id/pdf', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const devis = await db.queryOne(`
    SELECT d.*, c.nom AS client_nom, c.email AS client_email
    FROM devis d
    LEFT JOIN clients c ON c.id = d.client_id
    WHERE d.id = ?
  `, [req.params.id]);
  if (!devis) return res.status(404).json({ error: 'Devis introuvable' });

  const lignes = await getLignes(devis.id);

  try {
    const html   = buildHtmlDevis(devis, lignes, await getDevise(), await getSociete());
    const pdfBuf = await generatePdf(html, { prefix: 'dev', marginTop: '0mm', marginBottom: '0mm', marginLeft: '0mm', marginRight: '0mm' });
    const nomFich = `devis_${devis.numero}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    await auditLog(req.user.id, 'PDF_DOWNLOAD', devis.id, { numero: devis.numero, par: req.user.email });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFich}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: 'Génération PDF échouée : ' + e.message });
  }
});

module.exports = router;
module.exports.expireDevisEchus = expireDevisEchus;
