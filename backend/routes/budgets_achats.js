/**
 * ROUTES BUDGET ACHATS PAR SERVICE — Tala SMI
 * Préfixe : /api/budgets-achats
 *
 * Suivi de l'enveloppe budgétaire par service :
 *   montant_prevu → engagé → commandé → facturé → payé → solde
 */
'use strict';

const express   = require('express');
const db        = require('../database');
const { hasRole } = require('./auth');
const router    = express.Router();

// ─── RBAC ─────────────────────────────────────────────────────────────────────
function canRead(user)  { return hasRole(user, 'admin','dg','finance','assistante_direction'); }
function canWrite(user) { return hasRole(user, 'admin','dg','finance'); }
function canOverride(user) { return hasRole(user, 'admin','dg'); }

// ─── Audit ────────────────────────────────────────────────────────────────────
function auditBudget(userId, action, budgetId, details) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)'
    ).run('budgets_achats', budgetId, action, details ? JSON.stringify(details) : null, userId);
  } catch (_) {}
}

// ─── Vue calculée : exécution budgétaire pour un service et une année ─────────
function executionBudget(annee, service) {
  const filtre = service ? 'AND da.service_demandeur = ?' : '';
  const params = service ? [annee, annee, annee, annee, service, service] : [annee, annee, annee, annee];

  // Engagé = DA approuvées (statut approuve) dont le montant n'est pas encore en BC
  const engageRow = db.prepare(`
    SELECT COALESCE(SUM(da.total_general), 0) AS total
    FROM demandes_achat da
    WHERE strftime('%Y', da.date_demande) = ?
      AND da.statut = 'approuve'
      ${filtre}
  `).get(service ? annee.toString() : annee.toString(), ...(service ? [service] : []));

  // Commandé = montant TTC des BC validés/envoyés/livrés
  const commandeRow = db.prepare(`
    SELECT COALESCE(SUM(bc.montant_ttc), 0) AS total
    FROM bons_commandes_fournisseurs bc
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', bc.created_at) = ?
      AND bc.statut NOT IN ('brouillon','annule')
      ${filtre ? 'AND da.service_demandeur = ?' : ''}
  `).get(annee.toString(), ...(service ? [service] : []));

  // Facturé = montant TTC des factures fournisseurs reçues/validées
  const factureRow = db.prepare(`
    SELECT COALESCE(SUM(ff.montant_ttc), 0) AS total
    FROM factures_fournisseurs ff
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = ff.bc_id
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', ff.date_facture) = ?
      AND ff.statut NOT IN ('annulee')
      ${filtre ? 'AND da.service_demandeur = ?' : ''}
  `).get(annee.toString(), ...(service ? [service] : []));

  // Payé = montant effectivement payé
  const payeRow = db.prepare(`
    SELECT COALESCE(SUM(ff.montant_paye), 0) AS total
    FROM factures_fournisseurs ff
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = ff.bc_id
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', ff.date_facture) = ?
      AND ff.statut NOT IN ('annulee')
      ${filtre ? 'AND da.service_demandeur = ?' : ''}
  `).get(annee.toString(), ...(service ? [service] : []));

  return {
    engage:   Math.round(engageRow.total   * 100) / 100,
    commande: Math.round(commandeRow.total * 100) / 100,
    facture:  Math.round(factureRow.total  * 100) / 100,
    paye:     Math.round(payeRow.total     * 100) / 100,
  };
}

// ─── GET /api/budgets-achats?annee=2026 ───────────────────────────────────────
// Liste tous les budgets avec exécution calculée
router.get('/', (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const annee = parseInt(req.query.annee || new Date().getFullYear(), 10);

  const lignes = db.prepare(`
    SELECT id, annee, service, montant_prevu, notes, created_at, updated_at
    FROM budgets_achats
    WHERE annee = ?
    ORDER BY service ASC
  `).all(annee);

  // Enrichir chaque ligne avec l'exécution réelle
  const result = lignes.map(b => {
    const exec = executionBudget(annee, b.service);
    const solde = b.montant_prevu - exec.engage;
    const pct   = b.montant_prevu > 0
      ? Math.round((exec.engage / b.montant_prevu) * 100)
      : null;
    return {
      ...b,
      ...exec,
      solde_disponible: Math.round(solde * 100) / 100,
      pct_consomme:     pct,
      alerte: pct !== null && pct >= 80,
      depasse: solde < 0,
    };
  });

  // Total consolidé toutes lignes
  const totaux = result.reduce((acc, r) => {
    acc.montant_prevu    += r.montant_prevu;
    acc.engage           += r.engage;
    acc.commande         += r.commande;
    acc.facture          += r.facture;
    acc.paye             += r.paye;
    acc.solde_disponible += r.solde_disponible;
    return acc;
  }, { montant_prevu:0, engage:0, commande:0, facture:0, paye:0, solde_disponible:0 });

  res.json({ annee, lignes: result, totaux });
});

// ─── GET /api/budgets-achats/services ─────────────────────────────────────────
// Liste les services distincts avec ou sans budget défini
router.get('/services', (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const annee = parseInt(req.query.annee || new Date().getFullYear(), 10);

  // Services ayant des demandes d'achat
  const avecDA = db.prepare(`
    SELECT DISTINCT service_demandeur AS service
    FROM demandes_achat
    WHERE strftime('%Y', date_demande) = ?
    ORDER BY service_demandeur
  `).all(annee.toString());

  // Services ayant un budget défini
  const avecBudget = new Set(
    db.prepare('SELECT service FROM budgets_achats WHERE annee = ?').all(annee).map(r => r.service)
  );

  const services = avecDA.map(r => ({
    service:     r.service,
    a_budget:    avecBudget.has(r.service),
  }));

  res.json({ annee, services });
});

// ─── GET /api/budgets-achats/annees ───────────────────────────────────────────
router.get('/annees', (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const rows = db.prepare(`
    SELECT DISTINCT annee FROM budgets_achats
    UNION
    SELECT DISTINCT CAST(strftime('%Y', date_demande) AS INTEGER) FROM demandes_achat
    ORDER BY annee DESC
  `).all();
  res.json(rows.map(r => r.annee));
});

// ─── GET /api/budgets-achats/:id ──────────────────────────────────────────────
router.get('/:id', (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const b = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Budget introuvable' });
  const exec = executionBudget(b.annee, b.service);
  res.json({ ...b, ...exec, solde_disponible: b.montant_prevu - exec.engage });
});

// ─── POST /api/budgets-achats ─────────────────────────────────────────────────
router.post('/', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const { annee, service, montant_prevu, notes } = req.body;
  if (!annee || !service?.trim())
    return res.status(400).json({ error: 'annee et service obligatoires' });
  if (montant_prevu === undefined || Number(montant_prevu) < 0)
    return res.status(400).json({ error: 'montant_prevu doit être ≥ 0' });

  const anneeNum   = parseInt(annee, 10);
  const montantNum = Math.round(Number(montant_prevu) * 100) / 100;

  try {
    const result = db.prepare(`
      INSERT INTO budgets_achats (annee, service, montant_prevu, notes, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(anneeNum, service.trim(), montantNum, notes || null, req.user.id);

    const created = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(result.lastInsertRowid);
    auditBudget(req.user.id, 'CREATION', created.id, { annee: anneeNum, service: service.trim(), montant_prevu: montantNum });
    res.status(201).json(created);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Un budget existe déjà pour ${service} en ${annee}. Utilisez PUT pour le modifier.` });
    }
    throw e;
  }
});

// ─── PUT /api/budgets-achats/:id ──────────────────────────────────────────────
router.put('/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const b = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Budget introuvable' });

  const { montant_prevu, notes } = req.body;
  if (montant_prevu === undefined || Number(montant_prevu) < 0)
    return res.status(400).json({ error: 'montant_prevu doit être ≥ 0' });

  const montantNum = Math.round(Number(montant_prevu) * 100) / 100;

  db.prepare(`
    UPDATE budgets_achats
    SET montant_prevu = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(montantNum, notes !== undefined ? notes : b.notes, req.params.id);

  const updated = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(req.params.id);
  auditBudget(req.user.id, 'MODIFICATION', updated.id, { ancien: b.montant_prevu, nouveau: montantNum, notes });
  const exec    = executionBudget(updated.annee, updated.service);
  res.json({ ...updated, ...exec, solde_disponible: updated.montant_prevu - exec.engage });
});

// ─── DELETE /api/budgets-achats/:id ──────────────────────────────────────────
// Pas de suppression si engagements existent
router.delete('/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const b = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Budget introuvable' });

  const exec = executionBudget(b.annee, b.service);
  if (exec.engage > 0)
    return res.status(400).json({
      error: `Impossible de supprimer : ${exec.engage.toLocaleString()} XAF engagés sur ce budget.`,
      engage: exec.engage,
    });

  db.prepare('DELETE FROM budgets_achats WHERE id = ?').run(req.params.id);
  auditBudget(req.user.id, 'SUPPRESSION', b.id, { service: b.service, annee: b.annee, montant_prevu: b.montant_prevu });
  res.json({ ok: true });
});

// ─── POST /api/budgets-achats/check-depassement ───────────────────────────────
// Vérifie si une demande dépasserait le budget du service.
// Appelé par achats.js avant approbation DA.
router.post('/check-depassement', (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const { service, annee, montant } = req.body;
  if (!service || !annee || montant === undefined)
    return res.status(400).json({ error: 'service, annee, montant obligatoires' });

  const budget = db.prepare(
    'SELECT * FROM budgets_achats WHERE annee = ? AND service = ?'
  ).get(parseInt(annee, 10), service);

  if (!budget) return res.json({ a_budget: false });

  const exec    = executionBudget(parseInt(annee, 10), service);
  const solde   = budget.montant_prevu - exec.engage;
  const depasse = Number(montant) > solde;
  const blocage = db.prepare("SELECT valeur FROM parametres WHERE cle='budget_achats_blocage_depassement'").get();

  res.json({
    a_budget:         true,
    budget_id:        budget.id,
    montant_prevu:    budget.montant_prevu,
    engage:           exec.engage,
    solde_disponible: Math.round(solde * 100) / 100,
    montant_demande:  Number(montant),
    depasse,
    bloquant:         depasse && blocage?.valeur === '1',
  });
});

// ─── POST /api/budgets-achats/:id/override-depassement ───────────────────────
// DG ou Admin peut autoriser un dépassement avec motif obligatoire.
// Enregistre l'override en audit et marque le budget comme ayant été dépassé
// avec accord explicite.
router.post('/:id/override-depassement', (req, res) => {
  if (!canOverride(req.user))
    return res.status(403).json({ error: 'Override réservé DG ou Admin' });

  const b = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Budget introuvable' });

  const { motif, montant_demande, demande_achat_id } = req.body;
  if (!motif?.trim())
    return res.status(400).json({ error: 'Motif obligatoire pour autoriser un dépassement', code: 'OVERRIDE_MOTIF_REQUIS' });

  auditBudget(req.user.id, 'OVERRIDE_DEPASSEMENT', b.id, {
    motif:             motif.trim(),
    montant_demande:   montant_demande || null,
    demande_achat_id:  demande_achat_id || null,
    solde_avant:       b.montant_prevu - executionBudget(b.annee, b.service).engage,
  });

  res.json({
    ok:      true,
    message: 'Dépassement autorisé par ' + req.user.nom,
    motif:   motif.trim(),
  });
});

module.exports = router;
