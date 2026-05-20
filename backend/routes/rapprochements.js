/**
 * MODULE RAPPROCHEMENT BANCAIRE & CLÔTURE DE CAISSE — Prompt 7
 * Rapprochement : session par compte + période, cochage ligne à ligne, validation.
 * Clôture caisse : déclaration solde physique, calcul écart, historique.
 */
const express = require('express');
const db      = require('../db');
const { requireAuth, hasRole } = require('./auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function auditLog(userId, action, table, recordId, details = '') {
  try {
    await db.execute(`INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())`, [userId, action, table, recordId,
        typeof details === 'object' ? JSON.stringify(details) : details]);
  } catch (_) {}
}

/**
 * Calcule le solde du système pour un compte et une période donnée.
 */
async function calcSoldeSysteme(compteId, periodeFin) {
  const position = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [compteId]);
  if (!position) return 0;

  const mouvements = await db.queryOne(`
    SELECT SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE -montant END) AS net
    FROM operations
    WHERE position_id = ?
      AND statut = 'valide'
      AND date <= ?
  `, [compteId, periodeFin]);

  return (position.solde_initial || 0) + (mouvements?.net || 0);
}

/**
 * Calcule le solde logiciel d'une caisse à une date donnée.
 */
async function calcSoldeLogicielCaisse(positionId, date) {
  const position = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [positionId]);
  if (!position) return 0;

  const mouvements = await db.queryOne(`
    SELECT SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE -montant END) AS net
    FROM operations
    WHERE position_id = ?
      AND statut = 'valide'
      AND date <= ?
  `, [positionId, date]);

  return (position.solde_initial || 0) + (mouvements?.net || 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAPPROCHEMENT BANCAIRE
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/rapprochements/bancaire ─────────────────────────────────────────
router.post('/bancaire', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const { compte_id, periode_debut, periode_fin, solde_releve_bancaire, notes_ecart } = req.body;
  if (!compte_id)       return res.status(400).json({ error: 'compte_id requis' });
  if (!periode_debut)   return res.status(400).json({ error: 'periode_debut requise' });
  if (!periode_fin)     return res.status(400).json({ error: 'periode_fin requise' });
  if (solde_releve_bancaire == null) return res.status(400).json({ error: 'solde_releve_bancaire requis' });

  const compte = await db.queryOne('SELECT * FROM positions WHERE id = ?', [compte_id]);
  if (!compte) return res.status(404).json({ error: 'Compte introuvable' });

  // Vérifier qu'il n'existe pas déjà un rapprochement validé sur cette période
  const existant = await db.queryOne(`
    SELECT id FROM rapprochements_bancaires
    WHERE compte_id = ? AND date_validation IS NOT NULL
      AND periode_debut = ? AND periode_fin = ?
  `, [compte_id, periode_debut, periode_fin]);
  if (existant) return res.status(409).json({ error: 'Un rapprochement validé existe déjà pour cette période et ce compte' });

  const soldeSys = await calcSoldeSysteme(compte_id, periode_fin);
  const ecart    = Number(solde_releve_bancaire) - soldeSys;
  const statutInit = Math.abs(ecart) < 0.01 ? 'conforme'
    : ecart > 0 ? 'ecart_positif' : 'ecart_negatif';

  const result = await db.execute(`
    INSERT INTO rapprochements_bancaires
      (compte_id, periode_debut, periode_fin, solde_releve_bancaire, solde_systeme,
       ecart, statut, notes_ecart, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `, [compte_id, periode_debut, periode_fin,
    Number(solde_releve_bancaire), soldeSys, ecart,
    statutInit, notes_ecart || null, req.user.id]);

  const lastInsertRowid = result.insertId;

  // Charger automatiquement les opérations de la période comme lignes à rapprocher
  const ops = await db.query(`
    SELECT id, date, libelle, montant, type_op
    FROM operations
    WHERE position_id = ? AND statut = 'valide'
      AND date BETWEEN ? AND ?
    ORDER BY date ASC
  `, [compte_id, periode_debut, periode_fin]);

  for (const op of ops) {
    await db.execute(`
      INSERT INTO rapprochements_lignes
        (rapprochement_id, operation_id, description, montant, type, rapproche, created_at)
      VALUES (?, ?, ?, ?, ?, 0, NOW())
    `, [lastInsertRowid, op.id,
      op.libelle, op.montant,
      op.type_op === 'encaissement' ? 'encaissement' : 'decaissement']);
  }

  await auditLog(req.user.id, 'CREATE', 'rapprochements_bancaires', lastInsertRowid, {
    compte_id, periode_debut, periode_fin, ecart, nbLignes: ops.length
  });

  const created = await db.queryOne('SELECT * FROM rapprochements_bancaires WHERE id = ?', [lastInsertRowid]);
  const lignes  = await db.query('SELECT * FROM rapprochements_lignes WHERE rapprochement_id = ?', [lastInsertRowid]);
  res.status(201).json({ ...created, compte_libelle: compte.libelle, lignes });
});

// ── GET /api/rapprochements/bancaire ──────────────────────────────────────────
router.get('/bancaire', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const { compte_id, statut, limit = 20, offset = 0 } = req.query;
  const where = ['1=1']; const params = [];
  if (compte_id) { where.push('r.compte_id = ?'); params.push(compte_id); }
  if (statut)    { where.push('r.statut = ?');    params.push(statut); }

  const rows = await db.query(`
    SELECT r.*, p.libelle AS compte_libelle, u.nom AS created_by_nom
    FROM rapprochements_bancaires r
    LEFT JOIN positions p ON p.id = r.compte_id
    LEFT JOIN users u ON u.id = r.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_at DESC LIMIT ? OFFSET ?
  `, [...params, Number(limit), Number(offset)]);

  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM rapprochements_bancaires r WHERE ${where.join(' AND ')}`,
    params
  )).n;

  res.json({ rapprochements: rows, total });
});

// ── GET /api/rapprochements/bancaire/:id ──────────────────────────────────────
router.get('/bancaire/:id', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const r = await db.queryOne(`
    SELECT r.*, p.libelle AS compte_libelle
    FROM rapprochements_bancaires r
    LEFT JOIN positions p ON p.id = r.compte_id
    WHERE r.id = ?
  `, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Rapprochement introuvable' });

  const lignes = await db.query(`
    SELECT rl.*, o.libelle AS op_libelle, o.date AS op_date
    FROM rapprochements_lignes rl
    LEFT JOIN operations o ON o.id = rl.operation_id
    WHERE rl.rapprochement_id = ?
    ORDER BY rl.id ASC
  `, [r.id]);

  const stats = {
    total_lignes:      lignes.length,
    lignes_rapprochees: lignes.filter(l => l.rapproche).length,
    lignes_restantes:  lignes.filter(l => !l.rapproche).length,
  };

  res.json({ ...r, lignes, stats });
});

// ── POST /api/rapprochements/bancaire/:id/ligne ───────────────────────────────
// Ajouter une ligne manuelle (frais bancaire, chèque en attente, etc.)
router.post('/bancaire/:id/ligne', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const r = await db.queryOne('SELECT * FROM rapprochements_bancaires WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Rapprochement introuvable' });
  if (r.date_validation) return res.status(400).json({ error: 'Rapprochement déjà validé — modification impossible' });

  const { description, montant, type = 'autre', operation_id } = req.body;
  if (!description?.trim()) return res.status(400).json({ error: 'description requise' });
  if (montant == null || Number(montant) <= 0) return res.status(400).json({ error: 'montant invalide' });

  const TYPES_VALIDES = ['encaissement','decaissement','frais_bancaire','cheque_en_attente','depot_non_credite','erreur','autre'];
  if (!TYPES_VALIDES.includes(type)) return res.status(400).json({ error: `type invalide. Valeurs : ${TYPES_VALIDES.join(', ')}` });

  const result = await db.execute(`
    INSERT INTO rapprochements_lignes
      (rapprochement_id, operation_id, description, montant, type, rapproche, created_at)
    VALUES (?, ?, ?, ?, ?, 0, NOW())
  `, [r.id, operation_id || null, description.trim(), Number(montant), type]);

  res.status(201).json(await db.queryOne('SELECT * FROM rapprochements_lignes WHERE id = ?', [result.insertId]));
});

// ── PUT /api/rapprochements/bancaire/:id/ligne/:ligneId/rapprocher ────────────
// Cocher/décocher une ligne comme rapprochée
router.put('/bancaire/:id/ligne/:ligneId/rapprocher', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const r = await db.queryOne('SELECT * FROM rapprochements_bancaires WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Rapprochement introuvable' });
  if (r.date_validation) return res.status(400).json({ error: 'Rapprochement déjà validé' });

  const ligne = await db.queryOne('SELECT * FROM rapprochements_lignes WHERE id = ? AND rapprochement_id = ?',
    [req.params.ligneId, r.id]);
  if (!ligne) return res.status(404).json({ error: 'Ligne introuvable' });

  const newVal = ligne.rapproche ? 0 : 1;
  await db.execute('UPDATE rapprochements_lignes SET rapproche = ? WHERE id = ?', [newVal, ligne.id]);

  res.json({ ok: true, rapproche: !!newVal, ligne_id: ligne.id });
});

// ── POST /api/rapprochements/bancaire/:id/valider ─────────────────────────────
router.post('/bancaire/:id/valider', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const r = await db.queryOne('SELECT * FROM rapprochements_bancaires WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Rapprochement introuvable' });
  if (r.date_validation) return res.status(400).json({ error: 'Rapprochement déjà validé' });

  const { notes_ecart } = req.body;

  // Recalculer l'écart final
  const lignes   = await db.query('SELECT * FROM rapprochements_lignes WHERE rapprochement_id = ?', [r.id]);
  const soldeSys = await calcSoldeSysteme(r.compte_id, r.periode_fin);
  const ecart    = r.solde_releve_bancaire - soldeSys;
  const statut   = Math.abs(ecart) < 0.01 ? 'valide'
    : ecart > 0 ? 'ecart_positif' : 'ecart_negatif';

  await db.execute(`
    UPDATE rapprochements_bancaires SET
      statut = ?, solde_systeme = ?, ecart = ?,
      notes_ecart = COALESCE(?, notes_ecart),
      validateur_id = ?, date_validation = NOW(),
      updated_at = NOW()
    WHERE id = ?
  `, [statut, soldeSys, ecart, notes_ecart || null, req.user.id, r.id]);

  await auditLog(req.user.id, 'VALIDER', 'rapprochements_bancaires', r.id, {
    statut, ecart,
    lignesRapprochees: lignes.filter(l => l.rapproche).length,
    totalLignes: lignes.length
  });

  const updated = await db.queryOne('SELECT * FROM rapprochements_bancaires WHERE id = ?', [r.id]);
  res.json({ ok: true, rapprochement: updated });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLÔTURE DE CAISSE
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/rapprochements/caisse/cloture ───────────────────────────────────
router.post('/caisse/cloture', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg', 'caissier'))
    return res.status(403).json({ error: 'Permission insuffisante pour clôturer la caisse' });
  const { position_id, date_cloture, solde_physique_declare, notes } = req.body;
  if (!position_id)             return res.status(400).json({ error: 'position_id requis' });
  if (!date_cloture)            return res.status(400).json({ error: 'date_cloture requise' });
  if (solde_physique_declare == null) return res.status(400).json({ error: 'solde_physique_declare requis' });

  const position = await db.queryOne("SELECT * FROM positions WHERE id = ? AND type = 'caisse'", [position_id]);
  if (!position) return res.status(404).json({ error: 'Caisse introuvable (type=caisse requis)' });

  // Solde logiciel à la date de clôture
  const soldeCloture   = await calcSoldeLogicielCaisse(position_id, date_cloture);

  // Solde d'ouverture = solde logiciel de la dernière clôture validée, sinon solde_initial
  const derniereCloture = await db.queryOne(`
    SELECT solde_logiciel_cloture FROM caisses_clotures
    WHERE position_id = ? AND statut = 'valide'
    ORDER BY date_cloture DESC LIMIT 1
  `, [position_id]);
  const soldeOuverture = derniereCloture?.solde_logiciel_cloture ?? position.solde_initial ?? 0;

  const physique = Number(solde_physique_declare);
  const ecart    = physique - soldeCloture;
  const statut   = Math.abs(ecart) < 0.01 ? 'conforme'
    : ecart > 0 ? 'ecart_positif' : 'ecart_negatif';

  const result = await db.execute(`
    INSERT INTO caisses_clotures
      (position_id, date_cloture, caissier_id,
       solde_logiciel_ouverture, solde_logiciel_cloture,
       solde_physique_declare, ecart, statut, notes,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `, [position_id, date_cloture, req.user.id,
    soldeOuverture, soldeCloture, physique, ecart, statut, notes || null]);

  await auditLog(req.user.id, 'CLOTURE_CAISSE', 'caisses_clotures', result.insertId, {
    position_id, date_cloture, soldeCloture, physique, ecart, statut
  });

  const created = await db.queryOne('SELECT * FROM caisses_clotures WHERE id = ?', [result.insertId]);
  res.status(201).json({ ...created, position_libelle: position.libelle });
});

// ── GET /api/rapprochements/caisse/historique ─────────────────────────────────
router.get('/caisse/historique', requireAuth, async (req, res) => {
  const { position_id, statut, limit = 30, offset = 0 } = req.query;
  const where = ['1=1']; const params = [];
  if (position_id) { where.push('c.position_id = ?'); params.push(position_id); }
  if (statut)      { where.push('c.statut = ?');      params.push(statut); }

  const rows = await db.query(`
    SELECT c.*, p.libelle AS position_libelle, u.nom AS caissier_nom, v.nom AS validateur_nom
    FROM caisses_clotures c
    LEFT JOIN positions p ON p.id = c.position_id
    LEFT JOIN users u ON u.id = c.caissier_id
    LEFT JOIN users v ON v.id = c.validateur_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.date_cloture DESC, c.created_at DESC LIMIT ? OFFSET ?
  `, [...params, Number(limit), Number(offset)]);

  const total = (await db.queryOne(
    `SELECT COUNT(*) AS n FROM caisses_clotures c WHERE ${where.join(' AND ')}`,
    params
  )).n;

  res.json({ clotures: rows, total });
});

// ── GET /api/rapprochements/caisse/:id ────────────────────────────────────────
router.get('/caisse/:id', requireAuth, async (req, res) => {
  const c = await db.queryOne(`
    SELECT c.*, p.libelle AS position_libelle, u.nom AS caissier_nom, v.nom AS validateur_nom
    FROM caisses_clotures c
    LEFT JOIN positions p ON p.id = c.position_id
    LEFT JOIN users u ON u.id = c.caissier_id
    LEFT JOIN users v ON v.id = c.validateur_id
    WHERE c.id = ?
  `, [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Clôture introuvable' });

  // Opérations de la journée pour cette caisse
  const operations = await db.query(`
    SELECT id, date, libelle, montant, type_op, mode_reglement
    FROM operations
    WHERE position_id = ? AND statut = 'valide' AND date = ?
    ORDER BY id ASC
  `, [c.position_id, c.date_cloture]);

  res.json({ ...c, operations });
});

// ── POST /api/rapprochements/caisse/:id/valider ───────────────────────────────
router.post('/caisse/:id/valider', requireAuth, async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const c = await db.queryOne('SELECT * FROM caisses_clotures WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Clôture introuvable' });
  if (c.statut === 'valide') return res.status(400).json({ error: 'Clôture déjà validée' });

  await db.execute(`
    UPDATE caisses_clotures SET
      statut = 'valide', validateur_id = ?, updated_at = NOW()
    WHERE id = ?
  `, [req.user.id, c.id]);

  await auditLog(req.user.id, 'VALIDER', 'caisses_clotures', c.id, { ecart: c.ecart });
  const updated = await db.queryOne('SELECT * FROM caisses_clotures WHERE id = ?', [c.id]);
  res.json({ ok: true, cloture: updated });
});

module.exports = router;
