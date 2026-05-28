'use strict';

/**
 * MODULE POINTEUSE — TOP CENTER
 * Table : pointages (date, heure_entree, heure_sortie, heure_theorique, duree_minutes, statut, note, cree_par, modifie_par)
 * Rôles écriture : admin, dg, rh
 * Rôles admin : admin, dg
 * Non-RH : ne voit que sa propre fiche
 */

const express   = require('express');
const db        = require('../db');
const router    = express.Router();
const { hasRole } = require('./auth');

const WRITE_ROLES = ['admin','dg','rh'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }

function minutesToHHMM(minutes) {
  if (!minutes && minutes !== 0) return '—';
  const abs = Math.abs(minutes);
  const h   = Math.floor(abs / 60);
  const m   = abs % 60;
  return (minutes < 0 ? '-' : '') + h + 'h' + String(m).padStart(2, '0');
}

function calcDuree(entree, sortie) {
  // Entrée et sortie sont au format HH:MM
  if (!entree || !sortie) return null;
  const [he, me] = entree.split(':').map(Number);
  const [hs, ms] = sortie.split(':').map(Number);
  const mins = (hs * 60 + ms) - (he * 60 + me);
  return mins > 0 ? mins : null;
}

function statutPointage(heure_entree, heure_sortie, heure_theorique) {
  if (!heure_entree) return 'absent';
  if (!heure_sortie) return 'en_cours';
  if (heure_theorique && heure_entree) {
    const [hh, mm] = heure_theorique.split(':').map(Number);
    const [he, me] = heure_entree.split(':').map(Number);
    if ((he * 60 + me) > (hh * 60 + mm + 15)) return 'retard';
  }
  return 'present';
}

async function auditLog(action, details, userId) {
  try {
    const recordId = details?.id || 0;
    await db.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
      ['pointages', recordId, action, details ? JSON.stringify(details) : null, userId || null]
    );
  } catch (_) {}
}

// ── GET /pointeuse — liste paginée ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const restrictToSelf = !hasRole(user, ...WRITE_ROLES);
    const selfRow = restrictToSelf
      ? await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [user.id])
      : null;
    const selfEmployeId = selfRow?.employe_id || null;

    const { debut, fin, q, statut, page = 1, limit = 30 } = req.query;
    const lim    = Math.min(parseInt(limit) || 30, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * lim;

    let where = ['1=1'];
    const params = [];

    if (restrictToSelf && selfEmployeId) {
      where.push('p.employe_id = ?'); params.push(selfEmployeId);
    }
    if (debut)  { where.push('p.date >= ?');   params.push(debut); }
    if (fin)    { where.push('p.date <= ?');   params.push(fin); }
    if (statut) { where.push('p.statut = ?'); params.push(statut); }
    if (q) {
      where.push('(e.nom LIKE ? OR e.prenom LIKE ? OR e.matricule LIKE ?)');
      const pat = `%${q}%`;
      params.push(pat, pat, pat);
    }

    const wClause = where.join(' AND ');
    const total = (await db.queryOne(
      `SELECT COUNT(*) AS n FROM pointages p JOIN employes e ON e.id = p.employe_id WHERE ${wClause}`, params
    ))?.n || 0;

    const pointages = await db.query(
      `SELECT p.id, p.employe_id, p.date, p.heure_entree, p.heure_sortie,
              p.heure_theorique, p.duree_minutes, p.statut, p.note, p.created_at,
              e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p
       JOIN employes e ON e.id = p.employe_id
       WHERE ${wClause}
       ORDER BY p.date DESC, p.heure_entree DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    res.json({ pointages, total, page: parseInt(page), limit: lim });
  } catch (e) {
    console.error('[pointeuse GET /]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pointeuse/stats ─────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const user = req.user;
    const restrictToSelf = !hasRole(user, ...WRITE_ROLES);
    const selfRow = restrictToSelf
      ? await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [user.id])
      : null;

    const { date, debut, fin, employe_id } = req.query;
    const eid = restrictToSelf ? selfRow?.employe_id : (employe_id || null);

    let where = ['1=1'];
    const params = [];
    if (eid)    { where.push('employe_id = ?'); params.push(eid); }
    const d = date || (debut || fin ? null : new Date().toISOString().slice(0, 10));
    if (d)    { where.push('date = ?'); params.push(d); }
    else {
      if (debut) { where.push('date >= ?'); params.push(debut); }
      if (fin)   { where.push('date <= ?'); params.push(fin); }
    }
    const w = where.join(' AND ');

    const [total, presents, absents, retards, encours, sumMins] = await Promise.all([
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w}`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='present'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='absent'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='retard'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='en_cours'`, params),
      db.queryOne(`SELECT SUM(duree_minutes) n FROM pointages WHERE ${w}`, params),
    ]);

    res.json({
      total:         total?.n  || 0,
      presents:      presents?.n || 0,
      absents:       absents?.n  || 0,
      retards:       retards?.n  || 0,
      en_cours:      encours?.n  || 0,
      total_minutes: sumMins?.n  || 0,
      total_hhmm:    minutesToHHMM(sumMins?.n || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pointeuse/today ─────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const pointages = await db.query(
      `SELECT p.id, p.employe_id, p.date, p.heure_entree, p.heure_sortie,
              p.heure_theorique, p.duree_minutes, p.statut, p.note,
              e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p
       JOIN employes e ON e.id = p.employe_id
       WHERE p.date = ?
       ORDER BY e.nom, e.prenom`,
      [date]
    );
    res.json({ pointages, date, total: pointages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pointeuse/export/csv ────────────────────────────────
router.get('/export/csv', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { debut, fin, employe_id } = req.query;
    let where = ['1=1'];
    const params = [];
    if (employe_id) { where.push('p.employe_id = ?'); params.push(employe_id); }
    if (debut)      { where.push('p.date >= ?');      params.push(debut); }
    if (fin)        { where.push('p.date <= ?');      params.push(fin); }

    const rows = await db.query(
      `SELECT p.date, e.matricule, e.nom, e.prenom, e.poste,
              p.heure_entree, p.heure_sortie, p.duree_minutes, p.statut, p.note
       FROM pointages p JOIN employes e ON e.id = p.employe_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.date, e.nom`,
      params
    );

    const header = ['Date','Matricule','Nom','Prénom','Poste','Entrée','Sortie','Durée (min)','Statut','Note'];
    const lines  = rows.map(r => [
      r.date, r.matricule || '', r.nom, r.prenom, r.poste || '',
      r.heure_entree || '', r.heure_sortie || '',
      r.duree_minutes ?? '', r.statut, r.note || ''
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));

    const csv = '﻿' + [header.join(';'), ...lines].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="pointages_${debut||'debut'}_${fin||'fin'}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pointeuse/:id ───────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await db.queryOne(
      `SELECT p.*, e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p JOIN employes e ON e.id = p.employe_id
       WHERE p.id = ?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Pointage introuvable' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /pointeuse — pointer entrée ────────────────────────
router.post('/', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { employe_id, date, heure_entree, heure_theorique, note } = req.body;
    if (!employe_id) return res.status(400).json({ error: 'employe_id requis' });

    const d      = date || new Date().toISOString().slice(0, 10);
    const entree = heure_entree || new Date().toTimeString().slice(0, 5);

    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [employe_id, d]
    );
    if (existing) {
      return res.status(409).json({ error: `Pointage déjà enregistré pour ce jour (id: ${existing.id})` });
    }

    const r = await db.execute(
      `INSERT INTO pointages (employe_id, date, heure_entree, heure_theorique, statut, note, cree_par, updated_at)
       VALUES (?, ?, ?, ?, 'en_cours', ?, ?, datetime('now'))`,
      [employe_id, d, entree, heure_theorique || '08:00', note || null, req.user.id]
    );
    await auditLog('entree', { employe_id, date: d, heure_entree: entree }, req.user.id);
    res.status(201).json({ id: r.insertId, employe_id, date: d, heure_entree: entree, statut: 'en_cours' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /pointeuse/:id/sortie ──────────────────────────────
router.patch('/:id/sortie', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const p = await db.queryOne('SELECT * FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });
    if (p.heure_sortie) return res.status(409).json({ error: 'Sortie déjà enregistrée' });

    const sortie = req.body.heure_sortie || new Date().toTimeString().slice(0, 5);
    const duree  = calcDuree(p.heure_entree, sortie);
    const statut = statutPointage(p.heure_entree, sortie, p.heure_theorique);
    const note   = req.body.note !== undefined ? req.body.note : p.note;

    await db.execute(
      `UPDATE pointages SET heure_sortie=?, duree_minutes=?, statut=?, note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
      [sortie, duree, statut, note, req.user.id, p.id]
    );
    await auditLog('sortie', { id: p.id, sortie, duree, statut }, req.user.id);
    res.json({ id: p.id, heure_sortie: sortie, duree_minutes: duree, duree_hhmm: minutesToHHMM(duree), statut });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /pointeuse/:id — correction RH ────────────────────
router.patch('/:id', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const p = await db.queryOne('SELECT * FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });

    const entree = req.body.heure_entree !== undefined ? req.body.heure_entree : p.heure_entree;
    const sortie = req.body.heure_sortie !== undefined ? req.body.heure_sortie : p.heure_sortie;
    const duree  = calcDuree(entree, sortie);
    const statut = req.body.statut || statutPointage(entree, sortie, p.heure_theorique);
    const note   = req.body.note   !== undefined ? req.body.note : p.note;

    await db.execute(
      `UPDATE pointages SET heure_entree=?, heure_sortie=?, duree_minutes=?, statut=?, note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
      [entree, sortie, duree, statut, note, req.user.id, p.id]
    );
    await auditLog('correction', { id: p.id, before: { heure_entree: p.heure_entree, heure_sortie: p.heure_sortie, statut: p.statut }, after: { entree, sortie, statut } }, req.user.id);
    res.json({ id: p.id, heure_entree: entree, heure_sortie: sortie, duree_minutes: duree, duree_hhmm: minutesToHHMM(duree), statut });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /pointeuse/absent ───────────────────────────────────
router.post('/absent', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { employe_id, date, note } = req.body;
    if (!employe_id) return res.status(400).json({ error: 'employe_id requis' });

    const d = date || new Date().toISOString().slice(0, 10);
    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [employe_id, d]
    );
    if (existing) {
      await db.execute(
        `UPDATE pointages SET statut='absent', note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
        [note || null, req.user.id, existing.id]
      );
      return res.json({ id: existing.id, statut: 'absent' });
    }
    const r = await db.execute(
      `INSERT INTO pointages (employe_id, date, statut, note, cree_par, updated_at)
       VALUES (?, ?, 'absent', ?, ?, datetime('now'))`,
      [employe_id, d, note || null, req.user.id]
    );
    await auditLog('absent', { employe_id, date: d }, req.user.id);
    res.status(201).json({ id: r.insertId, statut: 'absent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /pointeuse/:id ────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin uniquement' });
    const p = await db.queryOne('SELECT id FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });
    await db.execute('DELETE FROM pointages WHERE id = ?', [req.params.id]);
    await auditLog('suppression', { id: req.params.id }, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
