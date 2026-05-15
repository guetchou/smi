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
const { creerNotification } = require('../services/notif');
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

// ─── Notifications budget ─────────────────────────────────────────────────────
function notifBudget(type, service, annee, details, createdBy) {
  try {
    creerNotification({
      type,
      titre:    details.titre,
      message:  details.message,
      srcTable: 'budgets_achats',
      srcId:    details.budgetId || null,
      createdBy,
    });
  } catch (_) {}
}

// Vérifie après toute modification si seuil ou dépassement atteint, envoie notif
function checkEtNotifApresModif(budgetId, userId) {
  try {
    const b = db.prepare('SELECT * FROM budgets_achats WHERE id = ?').get(budgetId);
    if (!b) return;
    const exec  = executionBudget(b.annee, b.service);
    const pct   = b.montant_prevu > 0 ? (exec.engage / b.montant_prevu) * 100 : 0;
    const solde = b.montant_prevu - exec.engage;
    const fmt   = v => Math.round(v).toLocaleString('fr-CG') + ' XAF';
    const seuil = parseInt(
      db.prepare("SELECT valeur FROM parametres WHERE cle='budget_achats_seuil_alerte_pct'")
        .get()?.valeur || '80', 10
    );

    if (solde < 0) {
      notifBudget('NOTIF_BUDGET_DEPASSE', b.service, b.annee, {
        titre:    `Budget dépassé — ${b.service} ${b.annee}`,
        message:  `Le budget "${b.service}" est dépassé de ${fmt(Math.abs(solde))}. Prévu : ${fmt(b.montant_prevu)}, engagé : ${fmt(exec.engage)}.`,
        budgetId: b.id,
      }, userId);
    } else if (pct >= seuil) {
      notifBudget('NOTIF_BUDGET_SEUIL', b.service, b.annee, {
        titre:    `Seuil budget atteint — ${b.service} ${b.annee}`,
        message:  `${Math.round(pct)}% du budget "${b.service}" est consommé (${fmt(exec.engage)} / ${fmt(b.montant_prevu)}). Solde restant : ${fmt(solde)}.`,
        budgetId: b.id,
      }, userId);
    }
  } catch (_) {}
}

// ─── Vue calculée : exécution budgétaire pour un service et une année ─────────
function executionBudget(annee, service) {
  const fS = service ? 'AND da.service_demandeur = ?' : '';
  const an = annee.toString();

  // Engagé ferme = DA approuvées
  const engageRow = db.prepare(`
    SELECT COALESCE(SUM(da.total_general), 0) AS total
    FROM demandes_achat da
    WHERE strftime('%Y', da.date_demande) = ?
      AND da.statut = 'approuve'
      ${fS}
  `).get(an, ...(service ? [service] : []));

  // Engagé prévisionnel = DA soumises (pas encore approuvées)
  const engagePrevisRow = db.prepare(`
    SELECT COALESCE(SUM(da.total_general), 0) AS total
    FROM demandes_achat da
    WHERE strftime('%Y', da.date_demande) = ?
      AND da.statut = 'soumis'
      ${fS}
  `).get(an, ...(service ? [service] : []));

  // Commandé = BC validés/envoyés/livrés
  const commandeRow = db.prepare(`
    SELECT COALESCE(SUM(bc.montant_ttc), 0) AS total
    FROM bons_commandes_fournisseurs bc
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', bc.created_at) = ?
      AND bc.statut NOT IN ('brouillon','annule')
      ${service ? 'AND da.service_demandeur = ?' : ''}
  `).get(an, ...(service ? [service] : []));

  // Facturé = FF non annulées
  const factureRow = db.prepare(`
    SELECT COALESCE(SUM(ff.montant_ttc), 0) AS total
    FROM factures_fournisseurs ff
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = ff.bc_id
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', ff.date_facture) = ?
      AND ff.statut NOT IN ('annulee')
      ${service ? 'AND da.service_demandeur = ?' : ''}
  `).get(an, ...(service ? [service] : []));

  // Payé = montant effectivement versé
  const payeRow = db.prepare(`
    SELECT COALESCE(SUM(ff.montant_paye), 0) AS total
    FROM factures_fournisseurs ff
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = ff.bc_id
    LEFT JOIN demandes_achat da ON da.id = bc.demande_achat_id
    WHERE strftime('%Y', ff.date_facture) = ?
      AND ff.statut NOT IN ('annulee')
      ${service ? 'AND da.service_demandeur = ?' : ''}
  `).get(an, ...(service ? [service] : []));

  const engage         = Math.round(engageRow.total        * 100) / 100;
  const engage_previsionnel = Math.round(engagePrevisRow.total * 100) / 100;
  return {
    engage,
    engage_previsionnel,          // DA soumises — pas encore approuvées
    engage_total: Math.round((engage + engage_previsionnel) * 100) / 100,
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

  // Paramètres configurables
  const seuilRow  = db.prepare("SELECT valeur FROM parametres WHERE cle='budget_achats_seuil_alerte_pct'").get();
  const seuil     = parseInt(seuilRow?.valeur || '80', 10);

  // Enrichir chaque ligne avec l'exécution réelle
  const result = lignes.map(b => {
    const exec = executionBudget(annee, b.service);
    const solde = b.montant_prevu - exec.engage;
    const pct   = b.montant_prevu > 0
      ? Math.round((exec.engage / b.montant_prevu) * 100)
      : null;
    const pct_previsionnel = b.montant_prevu > 0 && exec.engage_total !== undefined
      ? Math.round((exec.engage_total / b.montant_prevu) * 100)
      : null;
    return {
      ...b,
      ...exec,
      solde_disponible:     Math.round(solde * 100) / 100,
      solde_previsionnel:   Math.round((b.montant_prevu - exec.engage_total) * 100) / 100,
      pct_consomme:         pct,
      pct_consomme_previsionnel: pct_previsionnel,
      alerte:  pct !== null && pct >= seuil,
      depasse: solde < 0,
    };
  });

  // Total consolidé toutes lignes
  const totaux = result.reduce((acc, r) => {
    acc.montant_prevu    += r.montant_prevu;
    acc.engage           += r.engage;
    acc.engage_previsionnel += (r.engage_previsionnel || 0);
    acc.commande         += r.commande;
    acc.facture          += r.facture;
    acc.paye             += r.paye;
    acc.solde_disponible += r.solde_disponible;
    return acc;
  }, { montant_prevu:0, engage:0, engage_previsionnel:0, commande:0, facture:0, paye:0, solde_disponible:0 });

  res.json({ annee, lignes: result, totaux, seuil_alerte_pct: seuil });
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
    setImmediate(() => checkEtNotifApresModif(created.id, req.user.id));
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
  setImmediate(() => checkEtNotifApresModif(updated.id, req.user.id));
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

  const exec = executionBudget(b.annee, b.service);
  auditBudget(req.user.id, 'OVERRIDE_DEPASSEMENT', b.id, {
    motif:             motif.trim(),
    montant_demande:   montant_demande || null,
    demande_achat_id:  demande_achat_id || null,
    solde_avant:       b.montant_prevu - exec.engage,
  });

  // Notifier les finance/admin de l'override
  setImmediate(() => {
    try {
      const fmt = v => Math.round(v).toLocaleString('fr-CG') + ' XAF';
      notifBudget('NOTIF_BUDGET_OVERRIDE', b.service, b.annee, {
        titre:   `Override budget autorisé — ${b.service} ${b.annee}`,
        message: `${req.user.nom} a autorisé un dépassement du budget "${b.service}" (solde : ${fmt(b.montant_prevu - exec.engage)}). Motif : ${motif.trim()}`,
        budgetId: b.id,
      }, req.user.id);
    } catch (_) {}
  });

  res.json({
    ok:      true,
    message: 'Dépassement autorisé par ' + req.user.nom,
    motif:   motif.trim(),
  });
});

module.exports = router;
