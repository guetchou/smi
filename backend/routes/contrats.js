/**
 * MODULE CONTRATS & PAIEMENTS RÉCURRENTS — Prompt 6
 * Workflow : brouillon → en_validation → signe → actif → suspendu/resilie/expire/renouvele
 * Génération automatique des échéances à la création.
 * Cron 24h : expiration auto, facturation échéances, alertes.
 */
const express = require('express');
const db      = require('../db');
const { requireAuth, hasRole } = require('./auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function auditLog(userId, action, recordId, details = '') {
  try {
    await db.execute(`INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, 'contrats', ?, ?, NOW())`, [userId, action, recordId,
        typeof details === 'object' ? JSON.stringify(details) : details]);
  } catch (_) {}
}

async function genNumeroContrat() {
  const y = new Date().getFullYear();
  const last = await db.queryOne(
    `SELECT numero FROM contrats WHERE numero LIKE 'CTR-${y}-%' ORDER BY id DESC LIMIT 1`
  );
  const n = last ? parseInt(last.numero.split('-')[2], 10) + 1 : 1;
  return `CTR-${y}-${String(n).padStart(4, '0')}`;
}

/**
 * Génère les échéances d'un contrat selon sa périodicité.
 */
async function genererEcheances(tx, contratId, dateDebut, dateFin, duree_mois, periodicite, montant) {
  const debut = new Date(dateDebut);
  let fin;

  if (dateFin) {
    fin = new Date(dateFin);
  } else if (duree_mois) {
    fin = new Date(debut);
    fin.setMonth(fin.getMonth() + duree_mois);
  } else {
    fin = new Date(debut);
    fin.setFullYear(fin.getFullYear() + 1);
  }

  const current = new Date(debut);
  let count = 0;
  const MAX_ECHEANCES = 120;

  while (current <= fin && count < MAX_ECHEANCES) {
    await tx.execute(`
      INSERT INTO contrats_echeances (contrat_id, date_echeance, montant, statut, created_at, updated_at)
      VALUES (?, ?, ?, 'a_facturer', NOW(), NOW())
    `, [contratId, current.toISOString().split('T')[0], montant]);
    count++;
    if (periodicite === 'jour')       current.setDate(current.getDate() + 1);
    else if (periodicite === 'semaine') current.setDate(current.getDate() + 7);
    else if (periodicite === 'mois')    current.setMonth(current.getMonth() + 1);
    else if (periodicite === 'trimestre') current.setMonth(current.getMonth() + 3);
    else if (periodicite === 'semestre')  current.setMonth(current.getMonth() + 6);
    else if (periodicite === 'annee')     current.setFullYear(current.getFullYear() + 1);
    else break;
  }

  return count;
}

// Transitions de statut autorisées
const TRANSITIONS = {
  brouillon:     ['en_validation', 'signe', 'actif'],
  en_validation: ['signe', 'actif', 'brouillon'],
  signe:         ['actif'],
  actif:         ['suspendu', 'resilie', 'expire', 'renouvele', 'cloture', 'litige'],
  suspendu:      ['actif', 'resilie', 'cloture'],
  litige:        ['actif', 'resilie', 'cloture'],
  resilie:       [],
  expire:        ['renouvele'],
  renouvele:     [],
  cloture:       [],
};

function canTransit(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// ── GET /api/contrats ─────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { statut, partie_type, partie_id, type_contrat,
          search, limit = 50, offset = 0 } = req.query;

  const where = ['1=1']; const params = [];
  if (statut)       { where.push('c.statut = ?');       params.push(statut); }
  if (partie_type)  { where.push('c.partie_type = ?');  params.push(partie_type); }
  if (partie_id)    { where.push('c.partie_id = ?');    params.push(partie_id); }
  if (type_contrat) { where.push('c.type_contrat = ?'); params.push(type_contrat); }
  if (search) {
    where.push('(c.numero LIKE ? OR c.objet LIKE ?)');
    const q = `%${search}%`; params.push(q, q);
  }

  const rows = await db.query(`
    SELECT c.*, u.nom AS created_by_nom,
      (SELECT COUNT(*) FROM contrats_echeances WHERE contrat_id = c.id) AS nb_echeances,
      (SELECT COUNT(*) FROM contrats_echeances WHERE contrat_id = c.id AND statut = 'a_facturer') AS echeances_a_facturer,
      CASE
        WHEN c.date_fin IS NOT NULL AND c.date_fin <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND c.statut = 'actif'
        THEN 1 ELSE 0
      END AS expire_bientot
    FROM contrats c
    LEFT JOIN users u ON u.id = c.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, Number(limit), Number(offset)]);

  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM contrats c WHERE ${where.join(' AND ')}`,
    params
  )).n;

  res.json({ contrats: rows, total });
});

// ── GET /api/contrats/alertes/echeances ───────────────────────────────────────
// Doit être AVANT /:id
router.get('/alertes/echeances', requireAuth, async (req, res) => {
  const rows = await db.query(`
    SELECT c.id, c.numero, c.objet, c.partie_type, c.partie_id,
           c.statut, c.date_fin,
           DATEDIFF(c.date_fin, CURDATE()) AS jours_restants
    FROM contrats c
    WHERE c.statut = 'actif'
      AND c.date_fin IS NOT NULL
      AND DATEDIFF(c.date_fin, CURDATE()) <= 30
    ORDER BY c.date_fin ASC
  `);
  res.json({ alertes: rows, total: rows.length });
});

// ── GET /api/contrats/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const contrat = await db.queryOne(`
    SELECT c.*, u.nom AS created_by_nom
    FROM contrats c
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.id = ?
  `, [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });

  const echeances = await db.query(`
    SELECT * FROM contrats_echeances WHERE contrat_id = ? ORDER BY date_echeance ASC
  `, [contrat.id]);

  // Versions liées
  const versions = await db.query(`
    SELECT id, numero, statut, created_at FROM contrats WHERE contrat_parent_id = ?
  `, [contrat.id]);

  res.json({ ...contrat, echeances, versions });
});

// ── POST /api/contrats ────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour créer un contrat' });
  const {
    partie_id, partie_type, type_contrat, objet,
    date_debut, date_fin, duree_mois, renouvellement_auto = 0,
    montant = 0, periodicite = 'mois',
    conditions_paiement, penalites, obligations, notes
  } = req.body;

  if (!partie_id)    return res.status(400).json({ error: 'partie_id requis' });
  if (!partie_type)  return res.status(400).json({ error: 'partie_type requis' });
  if (!type_contrat) return res.status(400).json({ error: 'type_contrat requis' });
  if (!objet?.trim()) return res.status(400).json({ error: 'objet requis' });
  if (!date_debut)   return res.status(400).json({ error: 'date_debut requise' });

  const numero = await genNumeroContrat();

  const id = await db.transaction(async (tx) => {
    const result = await tx.execute(`
      INSERT INTO contrats
        (numero, partie_id, partie_type, type_contrat, objet,
         date_debut, date_fin, duree_mois, renouvellement_auto,
         montant, periodicite, conditions_paiement, penalites,
         obligations, statut, notes, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, 'brouillon', ?, ?, NOW(), NOW())
    `, [
      numero, partie_id, partie_type, type_contrat, objet.trim(),
      date_debut, date_fin || null, duree_mois || null, renouvellement_auto ? 1 : 0,
      Number(montant), periodicite, conditions_paiement || null,
      penalites || null, obligations || null, notes || null, req.user.id
    ]);

    let nbEch = 0;
    if (Number(montant) > 0) {
      nbEch = await genererEcheances(
        tx, result.insertId, date_debut, date_fin || null,
        duree_mois || null, periodicite, Number(montant)
      );
    }

    await tx.execute(
      "INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at) VALUES (?, 'CREATE', 'contrats', ?, ?, NOW())",
      [req.user.id, result.insertId, JSON.stringify({ numero, nbEcheances: nbEch })]
    );

    return result.insertId;
  });

  const created = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [id]);
  const echeances = await db.query('SELECT * FROM contrats_echeances WHERE contrat_id = ? ORDER BY date_echeance ASC', [id]);
  res.status(201).json({ ...created, echeances });
});

// ── PUT /api/contrats/:id ─────────────────────────────────────────────────────
// Modification uniquement si brouillon ou en_validation
router.put('/:id', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour modifier un contrat' });
  const contrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });
  if (!['brouillon', 'en_validation'].includes(contrat.statut))
    return res.status(403).json({ error: `Modification impossible — statut : ${contrat.statut}` });

  const {
    objet, date_debut, date_fin, duree_mois, renouvellement_auto,
    montant, periodicite, conditions_paiement, penalites, obligations, notes
  } = req.body;

  const before = { ...contrat };

  await db.execute(`
    UPDATE contrats SET
      objet               = COALESCE(?, objet),
      date_debut          = COALESCE(?, date_debut),
      date_fin            = COALESCE(?, date_fin),
      duree_mois          = COALESCE(?, duree_mois),
      renouvellement_auto = COALESCE(?, renouvellement_auto),
      montant             = COALESCE(?, montant),
      periodicite         = COALESCE(?, periodicite),
      conditions_paiement = COALESCE(?, conditions_paiement),
      penalites           = COALESCE(?, penalites),
      obligations         = COALESCE(?, obligations),
      notes               = COALESCE(?, notes),
      updated_at          = NOW()
    WHERE id = ?
  `, [
    objet?.trim() || null, date_debut || null, date_fin || null,
    duree_mois != null ? Number(duree_mois) : null,
    renouvellement_auto != null ? (renouvellement_auto ? 1 : 0) : null,
    montant != null ? Number(montant) : null,
    periodicite || null, conditions_paiement || null,
    penalites || null, obligations || null,
    notes !== undefined ? notes : null,
    contrat.id
  ]);

  const updated = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [contrat.id]);
  await auditLog(req.user.id, 'UPDATE', contrat.id, { before, after: updated });
  res.json(updated);
});

// ── POST /api/contrats/:id/activer ────────────────────────────────────────────
router.post('/:id/activer', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour activer un contrat' });
  const contrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });
  if (!canTransit(contrat.statut, 'actif'))
    return res.status(400).json({ error: `Activation impossible depuis statut : ${contrat.statut}` });

  await db.execute(`UPDATE contrats SET statut = 'actif', updated_at = NOW() WHERE id = ?`, [contrat.id]);
  await auditLog(req.user.id, 'ACTIVER', contrat.id, { ancienStatut: contrat.statut });
  res.json({ ok: true, statut: 'actif' });
});

// ── POST /api/contrats/:id/suspendre ─────────────────────────────────────────
router.post('/:id/suspendre', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const contrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });
  if (!canTransit(contrat.statut, 'suspendu'))
    return res.status(400).json({ error: `Suspension impossible depuis statut : ${contrat.statut}` });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Motif obligatoire pour suspendre un contrat' });

  await db.execute(`UPDATE contrats SET statut = 'suspendu', motif_suspension = ?, updated_at = NOW() WHERE id = ?`,
    [motif.trim(), contrat.id]);
  await auditLog(req.user.id, 'SUSPENDRE', contrat.id, { ancienStatut: contrat.statut, motif });
  res.json({ ok: true, statut: 'suspendu', motif });
});

// ── POST /api/contrats/:id/resilier ──────────────────────────────────────────
router.post('/:id/resilier', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const contrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });
  if (!canTransit(contrat.statut, 'resilie'))
    return res.status(400).json({ error: `Résiliation impossible depuis statut : ${contrat.statut}` });

  const { motif, date_resiliation } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Motif obligatoire pour résilier un contrat' });

  const dateRes = date_resiliation || new Date().toISOString().split('T')[0];

  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE contrats SET statut = 'resilie', motif_resiliation = ?, date_resiliation = ?, updated_at = NOW() WHERE id = ?`,
      [motif.trim(), dateRes, contrat.id]);
    // Annuler les échéances futures non facturées
    await tx.execute(`UPDATE contrats_echeances SET statut = 'annule', updated_at = NOW()
      WHERE contrat_id = ? AND statut = 'a_facturer' AND date_echeance > ?`,
      [contrat.id, dateRes]);
  });

  await auditLog(req.user.id, 'RESILIER', contrat.id, { motif, date_resiliation: dateRes });

  // Alerte RH si ce contrat est lié à un ou plusieurs agents
  setImmediate(async () => {
    try {
      const agentsLies = await db.query(
        "SELECT id, nom, prenom FROM employes WHERE contrat_id = ? AND actif = 1", [contrat.id]
      );
      if (agentsLies.length > 0) {
        const { creerNotification } = require('../services/notif');
        const rhUsers = await db.query(
          "SELECT id FROM users WHERE actif=1 AND (role IN ('admin','rh') OR roles LIKE '%\"rh\"%' OR roles LIKE '%\"admin\"%')"
        );
        const noms = agentsLies.map(a => `${a.nom} ${a.prenom}`).join(', ');
        rhUsers.forEach(u => creerNotification({
          type: 'NOTIF_CONTRAT_RESILIE_AGENT',
          titre: 'Contrat résilié lié à un agent',
          message: `Le contrat ${contrat.numero} vient d'être résilié. Il est lié à l'agent / aux agents suivants sans contrat actif : ${noms}. Veuillez mettre à jour leur dossier.`,
          srcTable: 'contrats', srcId: contrat.id,
          destinataire_id: u.id,
        }));
      }
    } catch (_) {}
  });

  res.json({ ok: true, statut: 'resilie', motif, date_resiliation: dateRes });
});

// ── POST /api/contrats/:id/renouveler ─────────────────────────────────────────
router.post('/:id/renouveler', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour renouveler un contrat' });
  const contrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [req.params.id]);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });
  if (!canTransit(contrat.statut, 'renouvele'))
    return res.status(400).json({ error: `Renouvellement impossible depuis statut : ${contrat.statut}` });

  const { date_debut, date_fin, montant, notes } = req.body;
  const newDebut  = date_debut  || contrat.date_fin || new Date().toISOString().split('T')[0];
  const newMontant = montant != null ? Number(montant) : contrat.montant;
  const numero    = await genNumeroContrat();

  const newId = await db.transaction(async (tx) => {
    // Marquer l'ancien comme renouvelé
    await tx.execute(`UPDATE contrats SET statut = 'renouvele', updated_at = NOW() WHERE id = ?`, [contrat.id]);

    // Créer le nouveau contrat lié
    const result = await tx.execute(`
      INSERT INTO contrats
        (numero, partie_id, partie_type, type_contrat, objet,
         date_debut, date_fin, duree_mois, renouvellement_auto,
         montant, periodicite, conditions_paiement, penalites, obligations,
         statut, notes, contrat_parent_id, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         'brouillon', ?, ?, ?, NOW(), NOW())
    `, [
      numero, contrat.partie_id, contrat.partie_type, contrat.type_contrat, contrat.objet,
      newDebut, date_fin || null, contrat.duree_mois, contrat.renouvellement_auto,
      newMontant, contrat.periodicite, contrat.conditions_paiement,
      contrat.penalites, contrat.obligations,
      notes || contrat.notes, contrat.id, req.user.id
    ]);

    let nbEch = 0;
    if (newMontant > 0) {
      nbEch = await genererEcheances(
        tx, result.insertId, newDebut, date_fin || null,
        contrat.duree_mois, contrat.periodicite, newMontant
      );
    }

    await tx.execute(
      "INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at) VALUES (?, 'RENOUVELER', 'contrats', ?, ?, NOW())",
      [req.user.id, result.insertId, JSON.stringify({ ancienContratId: contrat.id, numero, nbEcheances: nbEch })]
    );

    return result.insertId;
  });

  const newContrat = await db.queryOne('SELECT * FROM contrats WHERE id = ?', [newId]);
  const echeances  = await db.query('SELECT * FROM contrats_echeances WHERE contrat_id = ? ORDER BY date_echeance ASC', [newId]);
  res.status(201).json({ ...newContrat, echeances });
});

// ── Fonctions cron (appelées depuis server.js) ────────────────────────────────

/**
 * Passe les contrats expirés (date_fin dépassée) en statut=expire.
 */
async function expireContratsEchus() {
  const result = await db.execute(`
    UPDATE contrats SET statut = 'expire', updated_at = NOW()
    WHERE statut = 'actif'
      AND date_fin IS NOT NULL
      AND date_fin < CURDATE()
  `);
  if (result.affectedRows > 0)
    console.log(`[CONTRATS cron] ${result.affectedRows} contrat(s) passé(s) en expire`);
}

/**
 * Génère les factures clients pour les échéances du jour (contrats clients actifs).
 * Ne génère que si la table factures_clients existe (Prompt 3).
 */
async function facturationEcheancesDuJour() {
  let tableOk = false;
  try {
    await db.queryOne('SELECT 1 FROM factures_clients LIMIT 1');
    tableOk = true;
  } catch (_) {}
  if (!tableOk) return;

  const echeances = await db.query(`
    SELECT ce.*, c.partie_id AS client_id, c.objet, c.commercial_id,
           c.numero AS contrat_numero
    FROM contrats_echeances ce
    JOIN contrats c ON c.id = ce.contrat_id
    WHERE ce.statut = 'a_facturer'
      AND ce.date_echeance = CURDATE()
      AND c.statut = 'actif'
      AND c.partie_type = 'client'
  `);

  for (const ech of echeances) {
    try {
      const annee = new Date().getFullYear();
      const lastFac = await db.queryOne(
        `SELECT numero FROM factures_clients WHERE numero LIKE 'FAC-${annee}-%' ORDER BY id DESC LIMIT 1`
      );
      const nFac = lastFac ? parseInt(lastFac.numero.split('-')[2], 10) + 1 : 1;
      const numeroFac = `FAC-${annee}-${String(nFac).padStart(4, '0')}`;

      const client = await db.queryOne('SELECT delai_paiement_autorise FROM clients WHERE id = ?', [ech.client_id]);
      const delai  = client?.delai_paiement_autorise || 30;
      const echeanceDate = new Date();
      echeanceDate.setDate(echeanceDate.getDate() + delai);

      await db.transaction(async (tx) => {
        const facResult = await tx.execute(`
          INSERT INTO factures_clients
            (numero, client_id, contrat_id, type, objet, date_facture, date_echeance,
             statut, montant_ht, montant_taxes, montant_ttc, montant_paye, reste_a_payer,
             created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'recurrente', ?, CURDATE(), ?,
                  'brouillon', ?, 0, ?, 0, ?,
                  1, NOW(), NOW())
        `, [
          numeroFac, ech.client_id, ech.contrat_id,
          `${ech.objet} — Échéance ${ech.date_echeance}`,
          echeanceDate.toISOString().split('T')[0],
          ech.montant, ech.montant, ech.montant
        ]);

        await tx.execute(`UPDATE contrats_echeances SET statut = 'facture', facture_id = ?, updated_at = NOW() WHERE id = ?`,
          [facResult.insertId, ech.id]);
      });

      console.log(`[CONTRATS cron] Facture ${numeroFac} générée pour contrat ${ech.contrat_numero} échéance ${ech.date_echeance}`);
    } catch (e) {
      console.error(`[CONTRATS cron] Erreur facturation échéance ${ech.id}:`, e.message);
    }
  }
}

/**
 * Alerte 30j avant expiration : log console.
 */
async function alerterContratsExpirants() {
  const row = await db.queryOne(`
    SELECT COUNT(*) AS n FROM contrats
    WHERE statut = 'actif'
      AND date_fin IS NOT NULL
      AND DATEDIFF(date_fin, CURDATE()) <= 30
  `);
  if (row.n > 0)
    console.log(`[CONTRATS cron] ${row.n} contrat(s) expirant dans 30 jours`);
}

module.exports = router;
module.exports.expireContratsEchus      = expireContratsEchus;
module.exports.facturationEcheancesDuJour = facturationEcheancesDuJour;
module.exports.alerterContratsExpirants = alerterContratsExpirants;
