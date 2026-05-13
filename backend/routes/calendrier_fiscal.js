/**
 * ROUTES CALENDRIER FISCAL & CNSS
 * Préfixe : /api/calendrier-fiscal
 *
 * Gestion des échéances fiscales (CNSS, DGI, IS, DAS, stat) avec
 * suivi de statut, marquage manuel, et déclenchement immédiat des rappels.
 */
'use strict';

const express    = require('express');
const db         = require('../database');
const { hasRole } = require('./auth');
const { checkEcheancesFiscales, planifierRappel } = require('../services/notif');
const router = express.Router();

function canFiscal(user) {
  return hasRole(user, 'admin', 'dg', 'finance', 'rh');
}

// ─── GET /api/calendrier-fiscal ───────────────────────────────────────────────
// Liste des échéances avec filtres ?annee=2026&statut=a_faire&type=CNSS_TRIMESTRE
router.get('/', (req, res) => {
  if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const annee   = parseInt(req.query.annee ?? new Date().getFullYear(), 10);
  const statut  = req.query.statut  ?? null;
  const type    = req.query.type    ?? null;

  let sql = `
    SELECT cf.*,
           cd.statut AS cnss_statut, cd.total_du AS cnss_total_du,
           dd.statut AS dgi_statut,  dd.total_irpp AS dgi_total_irpp
    FROM calendrier_fiscal cf
    LEFT JOIN cnss_declarations cd ON cd.id = cf.ref_cnss_id
    LEFT JOIN dgi_declarations  dd ON dd.id = cf.ref_dgi_id
    WHERE cf.annee = ?
  `;
  const params = [annee];

  if (statut) { sql += ' AND cf.statut = ?'; params.push(statut); }
  if (type)   { sql += ' AND cf.type_obligation = ?'; params.push(type); }
  sql += ' ORDER BY cf.date_echeance ASC';

  const rows = db.prepare(sql).all(...params);

  // Grouper par type pour faciliter l'affichage calendrier
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.type_obligation]) grouped[r.type_obligation] = [];
    grouped[r.type_obligation].push(r);
  }

  // Statistiques rapides
  const stats = {
    total:         rows.length,
    a_faire:       rows.filter(r => r.statut === 'a_faire').length,
    en_cours:      rows.filter(r => r.statut === 'en_cours').length,
    en_retard:     rows.filter(r => r.statut === 'en_retard').length,
    paye:          rows.filter(r => r.statut === 'paye').length,
    prochains_7j:  rows.filter(r => {
      const d = new Date(r.date_echeance);
      const now = new Date();
      return d >= now && (d - now) / 86400000 <= 7 && r.statut !== 'paye';
    }).length,
  };

  res.json({ annee, grouped, list: rows, stats });
});

// ─── GET /api/calendrier-fiscal/annees ────────────────────────────────────────
// Années disponibles dans la base
router.get('/annees', (req, res) => {
  if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const annees = db.prepare('SELECT DISTINCT annee FROM calendrier_fiscal ORDER BY annee DESC').all();
  res.json(annees.map(r => r.annee));
});

// ─── GET /api/calendrier-fiscal/prochain ──────────────────────────────────────
// Prochaine échéance critique (widget dashboard)
router.get('/prochain', (req, res) => {
  if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const row = db.prepare(`
    SELECT * FROM calendrier_fiscal
    WHERE statut IN ('a_faire','en_cours')
      AND date_echeance >= date('now')
    ORDER BY date_echeance ASC
    LIMIT 1
  `).get();
  res.json(row ?? null);
});

// ─── POST /api/calendrier-fiscal/generer ─────────────────────────────────────
// Force la génération des échéances pour une année (admin/finance/dg seulement)
router.post('/generer', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Accès refusé' });

  try {
    checkEcheancesFiscales();
    res.json({ ok: true, message: 'Calendrier fiscal mis à jour et rappels planifiés.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/calendrier-fiscal/:id/statut ─────────────────────────────────
// Mise à jour manuelle du statut d'une échéance
router.patch('/:id/statut', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Accès refusé' });

  const { statut, notes, montant_du } = req.body;
  const STATUTS = ['a_faire','en_cours','depose','paye','en_retard','non_applicable'];
  if (!STATUTS.includes(statut))
    return res.status(400).json({ error: 'Statut invalide', valeurs: STATUTS });

  const ech = db.prepare('SELECT * FROM calendrier_fiscal WHERE id = ?').get(req.params.id);
  if (!ech) return res.status(404).json({ error: 'Échéance introuvable' });

  const updates = ['statut = ?', 'updated_at = datetime(\'now\')'];
  const vals    = [statut];

  if (notes !== undefined)      { updates.push('notes = ?');      vals.push(notes); }
  if (montant_du !== undefined) { updates.push('montant_du = ?'); vals.push(montant_du); }

  vals.push(req.params.id);
  db.prepare(`UPDATE calendrier_fiscal SET ${updates.join(', ')} WHERE id = ?`).run(...vals);

  const updated = db.prepare('SELECT * FROM calendrier_fiscal WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ─── PATCH /api/calendrier-fiscal/:id/lier-declaration ───────────────────────
// Lie une échéance à une déclaration CNSS ou DGI existante
router.patch('/:id/lier-declaration', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Accès refusé' });

  const { ref_cnss_id, ref_dgi_id } = req.body;
  const ech = db.prepare('SELECT * FROM calendrier_fiscal WHERE id = ?').get(req.params.id);
  if (!ech) return res.status(404).json({ error: 'Échéance introuvable' });

  db.prepare(`
    UPDATE calendrier_fiscal
    SET ref_cnss_id = COALESCE(?, ref_cnss_id),
        ref_dgi_id  = COALESCE(?, ref_dgi_id),
        updated_at  = datetime('now')
    WHERE id = ?
  `).run(ref_cnss_id ?? null, ref_dgi_id ?? null, req.params.id);

  res.json(db.prepare('SELECT * FROM calendrier_fiscal WHERE id = ?').get(req.params.id));
});

module.exports = router;
