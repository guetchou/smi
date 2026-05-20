'use strict';

/**
 * ROUTES CALENDRIER FISCAL & CNSS
 * Préfixe : /api/calendrier-fiscal
 */

const express    = require('express');
const db         = require('../db');
const { hasRole } = require('./auth');
const { checkEcheancesFiscales } = require('../services/notif');
const router = express.Router();

function canFiscal(user) {
  return hasRole(user, 'admin', 'dg', 'finance', 'rh');
}

// ─── GET /api/calendrier-fiscal ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });

    const annee  = parseInt(req.query.annee ?? new Date().getFullYear(), 10);
    const statut = req.query.statut ?? null;
    const type   = req.query.type   ?? null;

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

    const rows = await db.query(sql, params);

    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.type_obligation]) grouped[r.type_obligation] = [];
      grouped[r.type_obligation].push(r);
    }

    const now = new Date();
    const stats = {
      total:        rows.length,
      a_faire:      rows.filter(r => r.statut === 'a_faire').length,
      en_cours:     rows.filter(r => r.statut === 'en_cours').length,
      en_retard:    rows.filter(r => r.statut === 'en_retard').length,
      paye:         rows.filter(r => r.statut === 'paye').length,
      prochains_7j: rows.filter(r => {
        const d = new Date(r.date_echeance);
        return d >= now && (d - now) / 86400000 <= 7 && r.statut !== 'paye';
      }).length,
    };

    res.json({ annee, grouped, list: rows, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/calendrier-fiscal/annees ────────────────────────────────────────
router.get('/annees', async (req, res) => {
  try {
    if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const annees = await db.query('SELECT DISTINCT annee FROM calendrier_fiscal ORDER BY annee DESC');
    res.json(annees.map(r => r.annee));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/calendrier-fiscal/prochain ──────────────────────────────────────
router.get('/prochain', async (req, res) => {
  try {
    if (!canFiscal(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const row = await db.queryOne(`
      SELECT * FROM calendrier_fiscal
      WHERE statut IN ('a_faire','en_cours') AND date_echeance >= CURDATE()
      ORDER BY date_echeance ASC
      LIMIT 1
    `);
    res.json(row ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/calendrier-fiscal/generer ─────────────────────────────────────
router.post('/generer', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'finance'))
      return res.status(403).json({ error: 'Accès refusé' });
    await checkEcheancesFiscales();
    res.json({ ok: true, message: 'Calendrier fiscal mis à jour et rappels planifiés.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/calendrier-fiscal/:id/statut ─────────────────────────────────
router.patch('/:id/statut', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'finance'))
      return res.status(403).json({ error: 'Accès refusé' });

    const { statut, notes, montant_du } = req.body;
    const STATUTS = ['a_faire','en_cours','depose','paye','en_retard','non_applicable'];
    if (!STATUTS.includes(statut))
      return res.status(400).json({ error: 'Statut invalide', valeurs: STATUTS });

    const ech = await db.queryOne('SELECT * FROM calendrier_fiscal WHERE id = ?', [req.params.id]);
    if (!ech) return res.status(404).json({ error: 'Échéance introuvable' });

    const updates = ['statut = ?', "updated_at = NOW()"];
    const vals    = [statut];
    if (notes !== undefined)      { updates.push('notes = ?');      vals.push(notes); }
    if (montant_du !== undefined) { updates.push('montant_du = ?'); vals.push(montant_du); }
    vals.push(req.params.id);

    await db.execute(`UPDATE calendrier_fiscal SET ${updates.join(', ')} WHERE id = ?`, vals);
    const updated = await db.queryOne('SELECT * FROM calendrier_fiscal WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/calendrier-fiscal/:id/lier-declaration ───────────────────────
router.patch('/:id/lier-declaration', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'finance'))
      return res.status(403).json({ error: 'Accès refusé' });

    const { ref_cnss_id, ref_dgi_id } = req.body;
    const ech = await db.queryOne('SELECT * FROM calendrier_fiscal WHERE id = ?', [req.params.id]);
    if (!ech) return res.status(404).json({ error: 'Échéance introuvable' });

    await db.execute(`
      UPDATE calendrier_fiscal
      SET ref_cnss_id = COALESCE(?, ref_cnss_id),
          ref_dgi_id  = COALESCE(?, ref_dgi_id),
          updated_at  = NOW()
      WHERE id = ?
    `, [ref_cnss_id ?? null, ref_dgi_id ?? null, req.params.id]);

    res.json(await db.queryOne('SELECT * FROM calendrier_fiscal WHERE id = ?', [req.params.id]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
