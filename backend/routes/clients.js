/**
 * MODULE CLIENTS — Prompt 1
 * Gestion complète des clients avec numérotation auto, statuts, plafond crédit, encours.
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
      VALUES (?, ?, 'clients', ?, ?, NOW())
    `, [userId, action, recordId, typeof details === 'object' ? JSON.stringify(details) : details]);
  } catch (_) { /* non-bloquant */ }
}

async function genNumeroClient() {
  const last = await db.queryOne(`
    SELECT numero_client FROM clients
    WHERE numero_client LIKE 'CLT-%'
    ORDER BY id DESC LIMIT 1
  `);
  if (!last) return 'CLT-0001';
  const n = parseInt(last.numero_client.split('-')[1], 10) || 0;
  return `CLT-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Calcule l'encours d'un client = somme des factures clients non payées.
 * Si la table factures_clients n'existe pas encore (Prompt 3 non exécuté), retourne 0.
 */
async function calcEncours(clientId) {
  try {
    const row = await db.queryOne(`
      SELECT COALESCE(SUM(reste_a_payer), 0) AS encours
      FROM factures_clients
      WHERE client_id = ?
        AND statut NOT IN ('payee', 'annulee', 'avoir_emis', 'irrecouvrable')
    `, [clientId]);
    return row ? row.encours : 0;
  } catch (_) {
    return 0; // table pas encore créée
  }
}

// ── GET /api/clients ──────────────────────────────────────────────────────────
// Filtres : statut, type, search (nom, telephone, email, numero_client)
router.get('/', requireAuth, async (req, res) => {
  const { statut, type, search, limit = 100, offset = 0 } = req.query;

  let where = ['1=1'];
  const params = [];

  if (statut)  { where.push('c.statut = ?');  params.push(statut); }
  if (type)    { where.push('c.type = ?');     params.push(type); }
  if (search) {
    where.push('(c.nom LIKE ? OR c.telephone LIKE ? OR c.email LIKE ? OR c.numero_client LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const sql = `
    SELECT c.*,
           u.nom AS created_by_nom
    FROM clients c
    LEFT JOIN users u ON u.id = c.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY c.nom ASC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const rows  = await db.query(sql, params);
  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM clients c WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  )).n;

  res.json({ clients: rows, total });
});

// ── GET /api/clients/:id ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const client = await db.queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  // Historique factures si module disponible
  let factures = [];
  try {
    factures = await db.query(`
      SELECT id, numero, date_facture, date_echeance, montant_ttc, montant_paye, reste_a_payer, statut
      FROM factures_clients
      WHERE client_id = ?
      ORDER BY date_facture DESC
      LIMIT 20
    `, [client.id]);
  } catch (_) {}

  // Historique devis si module disponible
  let devis = [];
  try {
    devis = await db.query(`
      SELECT id, numero, date_devis, montant_ttc, statut
      FROM devis
      WHERE client_id = ?
      ORDER BY date_devis DESC
      LIMIT 20
    `, [client.id]);
  } catch (_) {}

  const encours = await calcEncours(client.id);
  res.json({ ...client, encours, factures, devis });
});

// ── POST /api/clients ─────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour créer un client' });
  const {
    nom, type = 'particulier', telephone, whatsapp, email,
    adresse, ville, pays = 'Congo', rccm, nif, contact_principal,
    categorie_client, plafond_credit = 0, delai_paiement_autorise = 30, notes
  } = req.body;

  if (!nom || !nom.trim()) return res.status(400).json({ error: 'Le nom du client est requis' });

  const numero_client = await genNumeroClient();

  const result = await db.execute(`
    INSERT INTO clients
      (numero_client, nom, type, telephone, whatsapp, email, adresse, ville, pays,
       rccm, nif, contact_principal, categorie_client, plafond_credit,
       delai_paiement_autorise, notes, statut, solde_crediteur, created_by, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, 'actif', 0, ?, NOW(), NOW())
  `, [
    numero_client, nom.trim(), type, telephone || null, whatsapp || null,
    email || null, adresse || null, ville || null, pays,
    rccm || null, nif || null, contact_principal || null, categorie_client || null,
    Number(plafond_credit), Number(delai_paiement_autorise),
    notes || null, req.user.id
  ]);

  const created = await db.queryOne('SELECT * FROM clients WHERE id = ?', [result.insertId]);
  await auditLog(req.user.id, 'CREATE', result.insertId, { numero_client, nom });
  res.status(201).json(created);
});

// ── PUT /api/clients/:id ──────────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'commercial', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier un client' });
  const client = await db.queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  const {
    nom, type, telephone, whatsapp, email, adresse, ville, pays,
    rccm, nif, contact_principal, categorie_client,
    plafond_credit, delai_paiement_autorise, notes
  } = req.body;

  const before = { ...client };

  await db.execute(`
    UPDATE clients SET
      nom                     = COALESCE(?, nom),
      type                    = COALESCE(?, type),
      telephone               = COALESCE(?, telephone),
      whatsapp                = COALESCE(?, whatsapp),
      email                   = COALESCE(?, email),
      adresse                 = COALESCE(?, adresse),
      ville                   = COALESCE(?, ville),
      pays                    = COALESCE(?, pays),
      rccm                    = COALESCE(?, rccm),
      nif                     = COALESCE(?, nif),
      contact_principal       = COALESCE(?, contact_principal),
      categorie_client        = COALESCE(?, categorie_client),
      plafond_credit          = COALESCE(?, plafond_credit),
      delai_paiement_autorise = COALESCE(?, delai_paiement_autorise),
      notes                   = COALESCE(?, notes),
      updated_at              = NOW()
    WHERE id = ?
  `, [
    nom || null, type || null, telephone || null, whatsapp || null,
    email || null, adresse || null, ville || null, pays || null,
    rccm || null, nif || null, contact_principal || null, categorie_client || null,
    plafond_credit != null ? Number(plafond_credit) : null,
    delai_paiement_autorise != null ? Number(delai_paiement_autorise) : null,
    notes !== undefined ? notes : null,
    client.id
  ]);

  const updated = await db.queryOne('SELECT * FROM clients WHERE id = ?', [client.id]);
  await auditLog(req.user.id, 'UPDATE', client.id, { before, after: updated });
  res.json(updated);
});

// ── POST /api/clients/:id/suspendre ──────────────────────────────────────────
// Changer statut avec motif obligatoire (suspend / réactive / mauvais_payeur / archive)
router.post('/:id/suspendre', requireAuth, async (req, res) => {
  // Seuls finance, admin, dg peuvent changer le statut d'un client
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const client = await db.queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  const { statut, motif } = req.body;
  const statutsValides = ['actif', 'suspendu', 'mauvais_payeur', 'archive'];
  if (!statutsValides.includes(statut))
    return res.status(400).json({ error: `Statut invalide. Valeurs acceptées : ${statutsValides.join(', ')}` });

  if (statut !== 'actif' && (!motif || !motif.trim()))
    return res.status(400).json({ error: 'Le motif est obligatoire pour ce changement de statut' });

  const oldStatut = client.statut;
  await db.execute(`
    UPDATE clients SET statut = ?, updated_at = NOW() WHERE id = ?
  `, [statut, client.id]);

  await auditLog(req.user.id, 'STATUT_CHANGE', client.id, {
    ancienStatut: oldStatut, nouveauStatut: statut, motif: motif || null
  });

  res.json({ ok: true, statut, motif: motif || null });
});

// ── GET /api/clients/:id/solde ────────────────────────────────────────────────
// Solde créditeur, encours, plafond restant
router.get('/:id/solde', requireAuth, async (req, res) => {
  const client = await db.queryOne('SELECT id, nom, plafond_credit, solde_crediteur, statut FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  const encours          = await calcEncours(client.id);
  const plafond_restant  = Math.max(0, client.plafond_credit - encours);
  const depasse_plafond  = client.plafond_credit > 0 && encours > client.plafond_credit;

  res.json({
    client_id:       client.id,
    nom:             client.nom,
    statut:          client.statut,
    plafond_credit:  client.plafond_credit,
    solde_crediteur: client.solde_crediteur,
    encours,
    plafond_restant,
    depasse_plafond
  });
});

module.exports = router;
