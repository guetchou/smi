/**
 * MODULE FACTURES CLIENTS — Prompt 3
 * Workflow : brouillon → emise → envoyee → partiellement_payee → payee
 * Paiements partiels, annulation avec motif, rapport impayés, relances.
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
      VALUES (?, ?, 'factures_clients', ?, ?, NOW())
    `, [userId, action, recordId,
      typeof details === 'object' ? JSON.stringify(details) : details]);
  } catch (_) { /* non-bloquant */ }
}

async function genNumero() {
  const annee = new Date().getFullYear();
  const last  = await db.queryOne(`
    SELECT numero FROM factures_clients
    WHERE numero LIKE 'FAC-${annee}-%'
    ORDER BY id DESC LIMIT 1
  `);
  if (!last) return `FAC-${annee}-0001`;
  const n = parseInt(last.numero.split('-')[2], 10) || 0;
  return `FAC-${annee}-${String(n + 1).padStart(4, '0')}`;
}

async function getLignes(factureId) {
  return db.query(
    'SELECT * FROM factures_clients_lignes WHERE facture_id = ? ORDER BY ordre ASC, id ASC',
    [factureId]
  );
}

async function saveLignes(tx, factureId, lignes) {
  await tx.execute('DELETE FROM factures_clients_lignes WHERE facture_id = ?', [factureId]);
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    const qte  = Number(l.quantite)      || 1;
    const pu   = Number(l.prix_unitaire) || 0;
    const rem  = Number(l.remise)        || 0;
    const taxe = Number(l.taux_taxe)     || 0;
    const ht   = qte * pu * (1 - rem / 100);
    const ttc  = ht * (1 + taxe / 100);
    await tx.execute(`
      INSERT INTO factures_clients_lignes
        (facture_id, type, designation, quantite, prix_unitaire, remise, taux_taxe, montant_ht, montant_ttc, ordre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      factureId,
      l.type || 'service',
      l.designation,
      qte, pu, rem, taxe,
      Math.round(ht  * 100) / 100,
      Math.round(ttc * 100) / 100,
      l.ordre != null ? l.ordre : i
    ]);
  }
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
router.get('/', requireAuth, async (req, res) => {
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
    where.push("f.date_echeance < CURDATE()");
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
           DATEDIFF(NOW(), f.date_echeance) AS jours_retard
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN users   u ON u.id = f.commercial_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.date_facture DESC, f.id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const rows  = await db.query(sql, params);
  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM factures_clients f
     LEFT JOIN clients c ON c.id = f.client_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  )).n;

  res.json({ factures: rows, total });
});

// ── GET /api/factures-clients/rapport/impayes ─────────────────────────────────
// Doit être AVANT /:id pour ne pas être capturé comme id
router.get('/rapport/impayes', requireAuth, async (req, res) => {
  const rows = await db.query(`
    SELECT f.*,
           c.nom        AS client_nom,
           c.email      AS client_email,
           c.telephone  AS client_telephone,
           DATEDIFF(NOW(), f.date_echeance) AS jours_retard,
           (SELECT MAX(r.created_at) FROM relances r
            WHERE r.reference_type='facture_client' AND r.reference_id=f.id) AS derniere_relance
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.date_echeance < CURDATE()
      AND f.statut NOT IN ('payee','annulee','avoir_emis','irrecouvrable')
    ORDER BY jours_retard DESC
  `);
  res.json({ impayes: rows, total: rows.length });
});

// ── GET /api/factures-clients/relances/dues ───────────────────────────────────
router.get('/relances/dues', requireAuth, async (req, res) => {
  const rows = await db.query(`
    SELECT f.id, f.numero, f.client_id, f.reste_a_payer, f.date_echeance,
           c.nom AS client_nom, c.email AS client_email,
           DATEDIFF(NOW(), f.date_echeance) AS jours_retard,
           (SELECT COUNT(*) FROM relances r
            WHERE r.reference_type='facture_client' AND r.reference_id=f.id) AS nb_relances
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.date_echeance < CURDATE()
      AND f.statut NOT IN ('payee','annulee','avoir_emis','irrecouvrable')
    ORDER BY jours_retard DESC
  `);
  res.json({ dues: rows, total: rows.length });
});

// ── GET /api/factures-clients/:id ─────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const facture = await db.queryOne(`
    SELECT f.*,
           c.nom        AS client_nom,
           c.email      AS client_email,
           c.telephone  AS client_telephone,
           c.statut     AS client_statut,
           u.nom        AS commercial_nom,
           DATEDIFF(NOW(), f.date_echeance) AS jours_retard
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN users   u ON u.id = f.commercial_id
    WHERE f.id = ?
  `, [req.params.id]);

  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });

  const lignes    = await getLignes(facture.id);
  const paiements = await db.query(
    'SELECT * FROM factures_clients_paiements WHERE facture_id = ? ORDER BY date_paiement DESC',
    [facture.id]
  );
  const relances  = await db.query(
    "SELECT * FROM relances WHERE reference_type='facture_client' AND reference_id = ? ORDER BY created_at DESC",
    [facture.id]
  );

  res.json({ ...facture, lignes, paiements, relances });
});

// ── POST /api/factures-clients ────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
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

  const client = await db.queryOne('SELECT id, statut FROM clients WHERE id = ?', [client_id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  if (['suspendu', 'mauvais_payeur'].includes(client.statut))
    return res.status(403).json({ error: `Facturation impossible — client ${client.statut}` });

  for (const l of lignes) {
    if (!l.designation?.trim())
      return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });
  }

  const totaux = calcTotaux(lignes);
  const numero = await genNumero();

  const lastInsertId = await db.transaction(async (tx) => {
    const result = await tx.execute(`
      INSERT INTO factures_clients
        (numero, client_id, devis_id, type, objet, date_facture, date_echeance, statut,
         montant_ht, montant_taxes, montant_ttc, montant_paye, reste_a_payer,
         mode_paiement_attendu, commercial_id, notes, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'brouillon',
         ?, ?, ?, 0, ?,
         ?, ?, ?, ?, NOW(), NOW())
    `, [
      numero, client_id, devis_id || null, type, objet.trim(),
      date_facture, date_echeance || null,
      totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc, totaux.montant_ttc,
      mode_paiement_attendu, commercial_id || req.user.id,
      notes || null, req.user.id
    ]);

    await saveLignes(tx, result.insertId, lignes);
    return result.insertId;
  });

  await auditLog(req.user.id, 'CREATE', lastInsertId, { numero, client_id, objet });

  const created = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [lastInsertId]);
  res.status(201).json({ ...created, lignes: await getLignes(lastInsertId) });
});

// ── PUT /api/factures-clients/:id ─────────────────────────────────────────────
// Modification uniquement si statut = brouillon
router.put('/:id', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier une facture' });
  const facture = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [req.params.id]);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (STATUTS_VERROUILLES.includes(facture.statut))
    return res.status(403).json({ error: `Modification impossible — statut : ${facture.statut}` });

  const { objet, date_facture, date_echeance, type,
          mode_paiement_attendu, commercial_id, notes, lignes } = req.body;

  const newLignes = lignes || await getLignes(facture.id);
  const totaux    = calcTotaux(newLignes);
  const before    = { ...facture };

  await db.transaction(async (tx) => {
    await tx.execute(`
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
        updated_at            = NOW()
      WHERE id = ?
    `, [
      objet?.trim() || null, date_facture || null, date_echeance || null,
      type || null, mode_paiement_attendu || null, commercial_id || null,
      notes !== undefined ? notes : null,
      totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc, totaux.montant_ttc,
      facture.id
    ]);

    if (lignes) await saveLignes(tx, facture.id, newLignes);
  });

  const updated = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [facture.id]);
  await auditLog(req.user.id, 'UPDATE', facture.id, { before, after: updated });
  res.json({ ...updated, lignes: await getLignes(facture.id) });
});

// ── POST /api/factures-clients/:id/emettre ────────────────────────────────────
// Verrouille la facture — plus de modification possible
router.post('/:id/emettre', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour émettre une facture' });
  const facture = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [req.params.id]);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (facture.statut !== 'brouillon')
    return res.status(400).json({ error: `Émission impossible — statut actuel : ${facture.statut}` });

  const lignes = await getLignes(facture.id);
  if (!lignes.length)
    return res.status(400).json({ error: 'Impossible d\'émettre une facture sans lignes' });

  await db.execute(`
    UPDATE factures_clients
    SET statut = 'emise', updated_at = NOW()
    WHERE id = ?
  `, [facture.id]);

  await auditLog(req.user.id, 'EMETTRE', facture.id, { ancienStatut: 'brouillon' });
  res.json({ ok: true, statut: 'emise' });
});

// ── POST /api/factures-clients/:id/enregistrer-paiement ──────────────────────
router.post('/:id/enregistrer-paiement', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg', 'caissier'))
    return res.status(403).json({ error: 'Permission insuffisante pour enregistrer un paiement' });
  const facture = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [req.params.id]);
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

  const paiId = await db.transaction(async (tx) => {
    // Enregistrer le paiement
    const paiResult = await tx.execute(`
      INSERT INTO factures_clients_paiements
        (facture_id, montant, date_paiement, mode_paiement, reference, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [facture.id, montantNum, date_paiement,
           mode_paiement, reference || null, notes || null, req.user.id]);

    // Mettre à jour la facture
    await tx.execute(`
      UPDATE factures_clients SET
        montant_paye  = ?,
        reste_a_payer = ?,
        statut        = ?,
        updated_at    = NOW()
      WHERE id = ?
    `, [nouveauPaye, Math.max(0, nouveauReste), nouveauStatut, facture.id]);

    return paiResult.insertId;
  });

  await auditLog(req.user.id, 'PAIEMENT', facture.id, {
    montant: montantNum, mode_paiement, nouveauStatut,
    montant_paye: nouveauPaye, reste_a_payer: Math.max(0, nouveauReste)
  });

  const updated = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [facture.id]);
  res.json({ ok: true, facture: updated, paiement_id: paiId });
});

// ── POST /api/factures-clients/:id/annuler ────────────────────────────────────
// Motif obligatoire — jamais de suppression physique
router.post('/:id/annuler', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour annuler une facture' });

  const facture = await db.queryOne('SELECT * FROM factures_clients WHERE id = ?', [req.params.id]);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (['annulee', 'payee'].includes(facture.statut))
    return res.status(400).json({ error: `Annulation impossible — statut : ${facture.statut}` });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Le motif d\'annulation est obligatoire' });

  await db.execute(`
    UPDATE factures_clients SET
      statut           = 'annulee',
      motif_annulation = ?,
      updated_at       = NOW()
    WHERE id = ?
  `, [motif.trim(), facture.id]);

  await auditLog(req.user.id, 'ANNULER', facture.id, {
    ancienStatut: facture.statut, motif: motif.trim()
  });
  res.json({ ok: true, statut: 'annulee', motif: motif.trim() });
});

// ── POST /api/factures-clients/:id/relancer ───────────────────────────────────
router.post('/:id/relancer', requireAuth, async (req, res) => {
  const facture = await db.queryOne(`
    SELECT f.*, c.nom AS client_nom, c.email AS client_email
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.id = ?
  `, [req.params.id]);

  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });
  if (['payee', 'annulee'].includes(facture.statut))
    return res.status(400).json({ error: 'Relance inutile — facture déjà payée ou annulée' });

  const { type_relance = 'J7', canal = 'email', notes } = req.body;

  // Enregistrer la relance
  await db.execute(`
    INSERT INTO relances
      (reference_type, reference_id, client_id, type_relance, date_relance, statut, canal, notes, created_by, created_at)
    VALUES ('facture_client', ?, ?, ?, CURDATE(), 'envoyee', ?, ?, ?, NOW())
  `, [facture.id, facture.client_id, type_relance, canal, notes || null, req.user.id]);

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

  await auditLog(req.user.id, 'RELANCER', facture.id, { type_relance, canal, emailEnvoye });
  res.json({ ok: true, type_relance, canal, email_envoye: emailEnvoye });
});

// ── Mise à jour auto des factures en retard (appelée depuis cron) ─────────────
async function marquerFacturesEnRetard() {
  const result = await db.execute(`
    UPDATE factures_clients
    SET statut = 'en_retard', updated_at = NOW()
    WHERE statut IN ('emise','envoyee','partiellement_payee')
      AND date_echeance IS NOT NULL
      AND date_echeance < CURDATE()
  `);
  if (result.affectedRows > 0)
    console.log(`[FACTURES cron] ${result.affectedRows} factures passées en en_retard`);
}

// ── Helpers partagés PDF ──────────────────────────────────────────────────────
async function getSociete() {
  const r = await db.queryOne("SELECT valeur FROM parametres WHERE cle='societe'");
  return r ? r.valeur : 'TOP CENTER';
}
async function getDevise() {
  const r = await db.queryOne("SELECT valeur FROM parametres WHERE cle='devise'");
  return r ? r.valeur : 'XAF';
}

const { generatePdf } = require('../services/pdf');

function buildHtmlFacture(facture, lignes, devise, societe) {
  const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v || 0);
  const fmtDate = d => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  const statutLabel = {
    brouillon: 'Brouillon', emise: 'Émise', envoyee: 'Envoyée',
    partiellement_payee: 'Part. payée', payee: 'Payée',
    annulee: 'Annulée', en_retard: 'En retard', avoir_emis: 'Avoir émis',
  };

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
  body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b;padding:0}
  .accent{background:#1A50D9;height:5px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding:12mm 14mm 8mm;border-bottom:1px solid #e2e8f0}
  .brand{font-size:22px;font-weight:700;color:#1A50D9}
  .brand-sub{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
  .brand-addr{font-size:9px;color:#94a3b8;line-height:1.6;margin-top:6px}
  .doc-title{font-size:26px;font-weight:700;color:#1A50D9;text-align:right}
  .doc-num{font-size:12px;color:#475569;text-align:right;margin-top:4px}
  .doc-date{font-size:10px;color:#94a3b8;text-align:right;margin-top:2px}
  .statut-chip{display:inline-block;background:#fef9c3;color:#713f12;font-size:8px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:20px;margin-top:4px}
  .parties{display:flex;gap:0;background:#f8fafc;padding:6mm 14mm;border-bottom:1px solid #e2e8f0}
  .party{flex:1;padding-right:10mm}
  .party:last-child{padding-right:0;padding-left:10mm;border-left:1px solid #e2e8f0}
  .party-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#1A50D9;margin-bottom:5px}
  .party-name{font-size:12px;font-weight:700;color:#0f172a;margin-bottom:3px}
  .party-detail{font-size:9px;color:#475569;line-height:1.7}
  .content{padding:6mm 14mm}
  table{width:100%;border-collapse:collapse}
  thead th{background:#1A50D9;color:#fff;font-weight:600;padding:7px 10px;font-size:9px;text-transform:uppercase;letter-spacing:.4px}
  thead th.r{text-align:right}
  thead th.c{text-align:center}
  .totals-row{display:flex;justify-content:flex-end;padding:4mm 14mm}
  .tot{width:70mm}
  .tot-line{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #f1f5f9;color:#475569}
  .tot-line .v{font-weight:600;color:#334155}
  .tot-grand{display:flex;justify-content:space-between;background:#1A50D9;color:#fff;font-weight:700;font-size:13px;padding:8px 10px;border-radius:6px;margin-top:6px}
  .in-words{margin:0 14mm 4mm;padding:5px 10px;background:#eff6ff;border-left:3px solid #1A50D9;font-size:9.5px;color:#1e3a8a;font-style:italic}
  .footer{background:#1A50D9;color:rgba(255,255,255,.8);padding:4mm 14mm;display:flex;justify-content:space-between;font-size:8px;line-height:1.7;margin-top:auto}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head><body>
<div class="accent"></div>
<div class="header">
  <div>
    <div class="brand">${societe}</div>
    <div class="brand-sub">SARL</div>
    <div class="brand-addr">Brazzaville, République du Congo<br>${facture.date_facture ? 'Émise le ' + fmtDate(facture.date_facture) : ''}</div>
  </div>
  <div>
    <div class="doc-title">FACTURE</div>
    <div class="doc-num">${facture.numero}</div>
    ${facture.date_echeance ? `<div class="doc-date">Échéance : ${fmtDate(facture.date_echeance)}</div>` : ''}
    <div style="text-align:right"><span class="statut-chip">${statutLabel[facture.statut] || facture.statut}</span></div>
  </div>
</div>

<div class="parties">
  <div class="party">
    <div class="party-label">Émetteur</div>
    <div class="party-name">${societe} SARL</div>
    <div class="party-detail">Brazzaville, République du Congo<br>contact@topcenter.cg</div>
  </div>
  <div class="party">
    <div class="party-label">Facturé à</div>
    <div class="party-name">${facture.client_nom || '—'}</div>
    <div class="party-detail">${facture.client_email || ''}</div>
  </div>
  <div class="party" style="flex:0.8;border-left:1px solid #e2e8f0">
    <div class="party-label">Références</div>
    <div class="party-detail">
      <div><span style="color:#64748b">Objet :</span> ${facture.objet || '—'}</div>
      <div><span style="color:#64748b">Mode paiement :</span> ${facture.mode_paiement_attendu || '—'}</div>
      ${facture.notes ? `<div style="margin-top:4px;font-style:italic;color:#94a3b8">${facture.notes}</div>` : ''}
    </div>
  </div>
</div>

<div class="content">
<table>
  <thead><tr>
    <th style="width:42%;text-align:left">Désignation</th>
    <th class="c" style="width:9%">Qté</th>
    <th class="r" style="width:14%">P.U. HT</th>
    <th class="r" style="width:10%">Remise</th>
    <th class="r" style="width:15%">Montant HT</th>
  </tr></thead>
  <tbody>${lignesHtml}</tbody>
</table>
</div>

<div class="totals-row">
  <div class="tot">
    <div class="tot-line"><span>Total HT</span><span class="v">${fmt(facture.montant_ht)} ${devise}</span></div>
    <div class="tot-line"><span>Taxes</span><span class="v">${fmt(facture.montant_taxes)} ${devise}</span></div>
    <div class="tot-grand"><span>TOTAL TTC</span><span>${fmt(facture.montant_ttc)} ${devise}</span></div>
    ${facture.montant_paye > 0 ? `<div class="tot-line" style="margin-top:4px"><span>Déjà payé</span><span class="v" style="color:#16a34a">- ${fmt(facture.montant_paye)} ${devise}</span></div>` : ''}
    ${facture.reste_a_payer > 0 ? `<div class="tot-line"><span style="font-weight:700;color:#dc2626">Reste à payer</span><span class="v" style="color:#dc2626;font-weight:700">${fmt(facture.reste_a_payer)} ${devise}</span></div>` : ''}
  </div>
</div>

<div class="in-words">Montant TTC en lettres — document généré par Tala SMI le ${new Date().toLocaleDateString('fr-FR')}</div>

<div class="footer">
  <div>${societe} SARL — Brazzaville, Congo</div>
  <div style="text-align:center">${facture.numero} — Tala SMI</div>
  <div style="text-align:right">contact@topcenter.cg</div>
</div>
</body></html>`;
}

// ── GET /api/factures-clients/:id/pdf ─────────────────────────────────────────
router.get('/:id/pdf', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const facture = await db.queryOne(`
    SELECT f.*, c.nom AS client_nom, c.email AS client_email
    FROM factures_clients f
    LEFT JOIN clients c ON c.id = f.client_id
    WHERE f.id = ?
  `, [req.params.id]);
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' });

  const lignes = await getLignes(facture.id);

  try {
    const html    = buildHtmlFacture(facture, lignes, await getDevise(), await getSociete());
    const pdfBuf  = await generatePdf(html, { prefix: 'fac', marginTop: '0mm', marginBottom: '0mm', marginLeft: '0mm', marginRight: '0mm' });
    const nomFich = `facture_${facture.numero}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    await auditLog(req.user.id, 'PDF_DOWNLOAD', facture.id, { numero: facture.numero, par: req.user.email });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFich}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: 'Génération PDF échouée : ' + e.message });
  }
});

module.exports = router;
module.exports.marquerFacturesEnRetard = marquerFacturesEnRetard;
