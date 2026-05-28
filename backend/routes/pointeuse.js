'use strict';

/**
 * MODULE POINTEUSE — TOP CENTER v2
 * Sécurités : PIN personnel, géolocalisation GPS, IP enregistrée, périmètre configurable
 * Statuts   : en_cours | present | retard | absent | teletravail | terrain
 * Automatisations : absence auto, heures supp auto, avertissement auto
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const router  = express.Router();
const { hasRole } = require('./auth');

const WRITE_ROLES = ['admin','dg','rh'];
const SELF_ROLES  = ['delegue','caissier','assistante_direction','lecteur'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }

// ── Helpers calcul ────────────────────────────────────────────────────────────

function minutesToHHMM(minutes) {
  if (!minutes && minutes !== 0) return '—';
  const abs = Math.abs(minutes);
  const h   = Math.floor(abs / 60);
  const m   = abs % 60;
  return (minutes < 0 ? '-' : '') + h + 'h' + String(m).padStart(2, '0');
}

function calcDuree(entree, sortie) {
  if (!entree || !sortie) return null;
  const [he, me] = entree.split(':').map(Number);
  const [hs, ms] = sortie.split(':').map(Number);
  const mins = (hs * 60 + ms) - (he * 60 + me);
  return mins > 0 ? mins : null;
}

function statutFromData(heure_entree, heure_sortie, heure_theorique, mode) {
  if (mode === 'teletravail') return 'teletravail';
  if (mode === 'terrain')     return 'terrain';
  if (!heure_entree) return 'absent';
  if (!heure_sortie) return 'en_cours';
  if (heure_theorique) {
    const [hh, mm] = heure_theorique.split(':').map(Number);
    const [he, me] = heure_entree.split(':').map(Number);
    if ((he * 60 + me) > (hh * 60 + mm + 15)) return 'retard';
  }
  return 'present';
}

// Distance GPS en mètres (formule Haversine)
function gpsDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function getGlobalParams() {
  const rows = await db.query("SELECT cle, valeur FROM parametres WHERE cle LIKE 'pointeuse_%'");
  const p = {};
  rows.forEach(r => { p[r.cle] = r.valeur; });
  return {
    latitude:        parseFloat(p.pointeuse_latitude)  || null,
    longitude:       parseFloat(p.pointeuse_longitude) || null,
    rayon_m:         parseInt(p.pointeuse_rayon_m)     || 300,
    heure_arrivee:   p.pointeuse_heure_arrivee         || '08:00',
    heure_limite_absence: p.pointeuse_heure_limite_absence || '10:00',
    seuil_heures_supp:    parseFloat(p.pointeuse_seuil_heures_supp) || 9,
    absences_avant_avertissement: parseInt(p.pointeuse_absences_avert) || 3,
    pin_requis:      p.pointeuse_pin_requis === '1',
    gps_requis:      p.pointeuse_gps_requis === '1',
  };
}

async function auditLog(action, details, userId) {
  try {
    await db.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
      ['pointages', details?.id || 0, action, details ? JSON.stringify(details) : null, userId || null]
    );
  } catch (_) {}
}

// ── GET /pointeuse/params — config GPS/PIN ────────────────────────────────────
router.get('/params', async (req, res) => {
  try {
    const p = await getGlobalParams();
    // Ne jamais exposer les PIN agents
    res.json({
      latitude:       p.latitude,
      longitude:      p.longitude,
      rayon_m:        p.rayon_m,
      heure_arrivee:  p.heure_arrivee,
      pin_requis:     p.pin_requis,
      gps_requis:     p.gps_requis,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/params — mise à jour config (admin/dg) ───────────────────
router.post('/params', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin/DG requis' });
    const fields = ['latitude','longitude','rayon_m','heure_arrivee','heure_limite_absence',
                    'seuil_heures_supp','absences_avant_avertissement','pin_requis','gps_requis'];
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        const cle = `pointeuse_${key}`;
        const val = String(req.body[key]);
        const existing = await db.queryOne('SELECT id FROM parametres WHERE cle = ?', [cle]);
        if (existing) {
          await db.execute('UPDATE parametres SET valeur = ? WHERE cle = ?', [val, cle]);
        } else {
          await db.execute(
            "INSERT INTO parametres (cle, valeur, description, modifiable) VALUES (?, ?, ?, 1)",
            [cle, val, `Pointeuse — ${key}`]
          );
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/pin — définir/changer son PIN (auto-service) ─────────────
router.post('/pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin))
      return res.status(400).json({ error: 'PIN doit être 4 à 6 chiffres' });
    const userRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
    if (!userRow?.employe_id)
      return res.status(400).json({ error: 'Compte non lié à une fiche agent' });
    const hash = bcrypt.hashSync(pin, 10);
    await db.execute('UPDATE employes SET pin_pointage = ? WHERE id = ?', [hash, userRow.employe_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/pin/rh — définir PIN d'un agent (RH) ─────────────────────
router.post('/pin/rh', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { employe_id, pin } = req.body;
    if (!employe_id) return res.status(400).json({ error: 'employe_id requis' });
    if (!pin || !/^\d{4,6}$/.test(pin))
      return res.status(400).json({ error: 'PIN doit être 4 à 6 chiffres' });
    const hash = bcrypt.hashSync(pin, 10);
    await db.execute('UPDATE employes SET pin_pointage = ? WHERE id = ?', [hash, employe_id]);
    await auditLog('pin_rh_set', { employe_id }, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse/pin/check — vérifier si l'agent a un PIN ──────────────────
router.get('/pin/check', async (req, res) => {
  try {
    const userRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
    if (!userRow?.employe_id) return res.json({ has_pin: false });
    const emp = await db.queryOne('SELECT pin_pointage FROM employes WHERE id = ?', [userRow.employe_id]);
    res.json({ has_pin: !!(emp?.pin_pointage) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse — liste paginée ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const restrictToSelf = !canWrite(user);
    const selfRow = restrictToSelf
      ? await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [user.id])
      : null;
    if (restrictToSelf && !selfRow?.employe_id)
      return res.status(403).json({ error: 'Accès refusé' });

    const { debut, fin, q, statut, page = 1, limit = 30 } = req.query;
    const lim    = Math.min(parseInt(limit) || 30, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * lim;

    let where = ['1=1'];
    const params = [];
    if (restrictToSelf) { where.push('p.employe_id = ?'); params.push(selfRow.employe_id); }
    if (debut)  { where.push('p.date >= ?'); params.push(debut); }
    if (fin)    { where.push('p.date <= ?'); params.push(fin); }
    if (statut) { where.push('p.statut = ?'); params.push(statut); }
    if (q)      {
      where.push('(e.nom LIKE ? OR e.prenom LIKE ? OR e.matricule LIKE ?)');
      const pat = `%${q}%`; params.push(pat, pat, pat);
    }
    const wClause = where.join(' AND ');
    const total = (await db.queryOne(
      `SELECT COUNT(*) AS n FROM pointages p JOIN employes e ON e.id = p.employe_id WHERE ${wClause}`, params
    ))?.n || 0;

    const pointages = await db.query(
      `SELECT p.id, p.employe_id, p.date, p.heure_entree, p.heure_sortie,
              p.heure_theorique, p.duree_minutes, p.statut, p.mode,
              p.hors_perimetre, p.ip_entree, p.latitude, p.longitude, p.note, p.created_at,
              e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p JOIN employes e ON e.id = p.employe_id
       WHERE ${wClause} ORDER BY p.date DESC, p.heure_entree DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    res.json({ pointages, total, page: parseInt(page), limit: lim });
  } catch (e) { console.error('[pointeuse GET /]', e); res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse/stats ──────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const restrictToSelf = !canWrite(req.user);
    const selfRow = restrictToSelf
      ? await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id])
      : null;
    if (restrictToSelf && !selfRow?.employe_id)
      return res.status(403).json({ error: 'Aucun agent associé à ce compte' });

    const { date, debut, fin, employe_id } = req.query;
    const eid = restrictToSelf ? selfRow.employe_id : (employe_id || null);
    let where = ['1=1'];
    const params = [];
    if (eid) { where.push('employe_id = ?'); params.push(eid); }
    const d = date || (debut || fin ? null : new Date().toISOString().slice(0, 10));
    if (d)    { where.push('date = ?'); params.push(d); }
    else {
      if (debut) { where.push('date >= ?'); params.push(debut); }
      if (fin)   { where.push('date <= ?'); params.push(fin); }
    }
    const w = where.join(' AND ');
    const [total, presents, absents, retards, encours, teletravailleurs, terrain_, sumMins] = await Promise.all([
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w}`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='present'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='absent'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='retard'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='en_cours'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='teletravail'`, params),
      db.queryOne(`SELECT COUNT(*) n FROM pointages WHERE ${w} AND statut='terrain'`, params),
      db.queryOne(`SELECT SUM(duree_minutes) n FROM pointages WHERE ${w}`, params),
    ]);
    res.json({
      total:         total?.n       || 0,
      presents:      presents?.n    || 0,
      absents:       absents?.n     || 0,
      retards:       retards?.n     || 0,
      en_cours:      encours?.n     || 0,
      teletravail:   teletravailleurs?.n || 0,
      terrain:       terrain_?.n    || 0,
      total_minutes: sumMins?.n     || 0,
      total_hhmm:    minutesToHHMM(sumMins?.n || 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse/today ──────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const restrictToSelf = !canWrite(req.user);
    let where = 'p.date = ?';
    const params = [date];
    if (restrictToSelf) {
      const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
      if (!selfRow?.employe_id) return res.json({ pointages: [], date, total: 0 });
      where += ' AND p.employe_id = ?'; params.push(selfRow.employe_id);
    }
    const pointages = await db.query(
      `SELECT p.id, p.employe_id, p.date, p.heure_entree, p.heure_sortie,
              p.heure_theorique, p.duree_minutes, p.statut, p.mode,
              p.hors_perimetre, p.ip_entree, p.note,
              e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p JOIN employes e ON e.id = p.employe_id
       WHERE ${where} ORDER BY e.nom, e.prenom`, params
    );
    res.json({ pointages, date, total: pointages.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse/export/csv ─────────────────────────────────────────────────
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
              p.heure_entree, p.heure_sortie, p.duree_minutes, p.statut, p.mode,
              p.hors_perimetre, p.ip_entree, p.note
       FROM pointages p JOIN employes e ON e.id = p.employe_id
       WHERE ${where.join(' AND ')} ORDER BY p.date, e.nom`, params
    );
    const header = ['Date','Matricule','Nom','Prénom','Poste','Entrée','Sortie','Durée (min)','Statut','Mode','Hors périmètre','IP','Note'];
    const lines  = rows.map(r => [
      r.date, r.matricule || '', r.nom, r.prenom, r.poste || '',
      r.heure_entree || '', r.heure_sortie || '',
      r.duree_minutes ?? '', r.statut, r.mode || 'manuel',
      r.hors_perimetre ? 'Oui' : 'Non',
      r.ip_entree || '', r.note || ''
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));

    const csv = '﻿' + [header.join(';'), ...lines].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pointages_${debut||'debut'}_${fin||'fin'}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pointeuse/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await db.queryOne(
      `SELECT p.*, e.nom, e.prenom, e.matricule, e.poste
       FROM pointages p JOIN employes e ON e.id = p.employe_id WHERE p.id = ?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Pointage introuvable' });
    if (!canWrite(req.user)) {
      const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
      if (!selfRow || selfRow.employe_id !== row.employe_id)
        return res.status(403).json({ error: 'Accès refusé' });
    }
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse — pointer entrée ─────────────────────────────────────────
// Corps : { employe_id, date?, heure_entree?, pin?, latitude?, longitude?, precision_gps?, mode?, note? }
router.post('/', async (req, res) => {
  try {
    const user = req.user;
    const { employe_id, date, heure_entree, pin, latitude, longitude, precision_gps, mode, note } = req.body;

    // Déterminer l'agent ciblé
    let targetEmployeId = employe_id ? parseInt(employe_id) : null;

    // Non-RH : peut seulement pointer pour soi-même
    if (!canWrite(user)) {
      const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [user.id]);
      if (!selfRow?.employe_id)
        return res.status(403).json({ error: 'Compte non lié à une fiche agent' });
      if (targetEmployeId && targetEmployeId !== selfRow.employe_id)
        return res.status(403).json({ error: 'Vous ne pouvez pointer que pour vous-même' });
      targetEmployeId = selfRow.employe_id;
    }

    if (!targetEmployeId) return res.status(400).json({ error: 'employe_id requis' });

    const emp = await db.queryOne(
      'SELECT id, nom, prenom, pin_pointage, heure_arrivee, gps_rayon_m FROM employes WHERE id = ?',
      [targetEmployeId]
    );
    if (!emp) return res.status(404).json({ error: 'Agent introuvable' });

    const params = await getGlobalParams();

    // ── Vérification PIN ──────────────────────────────────────────────────────
    if (params.pin_requis || emp.pin_pointage) {
      if (!pin)
        return res.status(400).json({ error: 'PIN requis pour pointer', pin_requis: true });
      if (!emp.pin_pointage)
        return res.status(400).json({ error: 'Aucun PIN configuré — contactez le RH', pin_requis: true });
      if (!bcrypt.compareSync(String(pin), emp.pin_pointage))
        return res.status(400).json({ error: 'PIN incorrect', pin_incorrect: true });
    }

    // ── Vérification GPS ──────────────────────────────────────────────────────
    let hors_perimetre = 0;
    const pointMode = mode || 'manuel';
    if (pointMode !== 'teletravail' && pointMode !== 'terrain') {
      if (params.gps_requis && (latitude == null || longitude == null))
        return res.status(400).json({ error: 'Géolocalisation requise', gps_requis: true });

      if (latitude != null && longitude != null && params.latitude && params.longitude) {
        const rayon = emp.gps_rayon_m || params.rayon_m;
        const dist  = gpsDistance(parseFloat(latitude), parseFloat(longitude), params.latitude, params.longitude);
        if (dist > rayon) {
          if (params.gps_requis)
            return res.status(400).json({
              error: `Hors périmètre autorisé (${Math.round(dist)}m du bureau, max ${rayon}m)`,
              hors_perimetre: true, distance_m: Math.round(dist)
            });
          hors_perimetre = 1; // enregistré mais non bloqué
        }
      }
    }

    const d      = date || new Date().toISOString().slice(0, 10);
    const entree = heure_entree || new Date().toTimeString().slice(0, 5);
    const hTheor = emp.heure_arrivee || params.heure_arrivee || '08:00';

    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [targetEmployeId, d]
    );
    if (existing)
      return res.status(409).json({ error: `Pointage déjà enregistré pour ce jour (id: ${existing.id})` });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;

    const r = await db.execute(
      `INSERT INTO pointages
         (employe_id, date, heure_entree, heure_theorique, statut, mode,
          ip_entree, latitude, longitude, precision_gps, hors_perimetre, note, cree_par, updated_at)
       VALUES (?, ?, ?, ?, 'en_cours', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [targetEmployeId, d, entree, hTheor, pointMode,
       ip, latitude ?? null, longitude ?? null, precision_gps ?? null,
       hors_perimetre, note || null, user.id]
    );

    await auditLog('entree', { id: r.insertId, employe_id: targetEmployeId, date: d, heure_entree: entree, mode: pointMode, hors_perimetre }, user.id);

    const resp = { id: r.insertId, employe_id: targetEmployeId, date: d, heure_entree: entree, statut: 'en_cours', mode: pointMode };
    if (hors_perimetre) resp.avertissement = 'Pointage enregistré mais vous êtes hors du périmètre autorisé';
    res.status(201).json(resp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /pointeuse/:id/sortie ───────────────────────────────────────────────
router.patch('/:id/sortie', async (req, res) => {
  try {
    const p = await db.queryOne('SELECT * FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });

    // Vérifier que c'est bien son propre pointage pour un non-RH
    if (!canWrite(req.user)) {
      const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
      if (!selfRow || selfRow.employe_id !== p.employe_id)
        return res.status(403).json({ error: 'Accès refusé' });
    }

    if (p.heure_sortie) return res.status(409).json({ error: 'Sortie déjà enregistrée' });

    const { pin, heure_sortie, note } = req.body;

    // Vérification PIN à la sortie (même règle)
    if (!canWrite(req.user)) {
      const params = await getGlobalParams();
      const emp = await db.queryOne('SELECT pin_pointage FROM employes WHERE id = ?', [p.employe_id]);
      if (params.pin_requis || emp?.pin_pointage) {
        if (!pin) return res.status(400).json({ error: 'PIN requis pour pointer la sortie', pin_requis: true });
        if (!emp.pin_pointage) return res.status(400).json({ error: 'Aucun PIN configuré' });
        if (!bcrypt.compareSync(String(pin), emp.pin_pointage))
          return res.status(400).json({ error: 'PIN incorrect', pin_incorrect: true });
      }
    }

    const sortie = heure_sortie || new Date().toTimeString().slice(0, 5);
    const duree  = calcDuree(p.heure_entree, sortie);
    const statut = statutFromData(p.heure_entree, sortie, p.heure_theorique, p.mode);
    const newNote = note !== undefined ? note : p.note;

    await db.execute(
      `UPDATE pointages SET heure_sortie=?, duree_minutes=?, statut=?, note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
      [sortie, duree, statut, newNote, req.user.id, p.id]
    );
    await auditLog('sortie', { id: p.id, sortie, duree, statut }, req.user.id);

    // Génération automatique heures supplémentaires
    const globalParams = await getGlobalParams();
    if (duree && duree > globalParams.seuil_heures_supp * 60) {
      await _genererHeuresSupp(p.employe_id, p.date, duree, globalParams.seuil_heures_supp, req.user.id);
    }

    res.json({ id: p.id, heure_sortie: sortie, duree_minutes: duree, duree_hhmm: minutesToHHMM(duree), statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /pointeuse/:id — correction RH ─────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const p = await db.queryOne('SELECT * FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });

    const entree = req.body.heure_entree !== undefined ? req.body.heure_entree : p.heure_entree;
    const sortie = req.body.heure_sortie !== undefined ? req.body.heure_sortie : p.heure_sortie;
    const duree  = calcDuree(entree, sortie);
    const mode   = req.body.mode   || p.mode   || 'manuel';
    const statut = req.body.statut || statutFromData(entree, sortie, p.heure_theorique, mode);
    const note   = req.body.note   !== undefined ? req.body.note : p.note;

    await db.execute(
      `UPDATE pointages SET heure_entree=?, heure_sortie=?, duree_minutes=?, statut=?, mode=?, note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
      [entree, sortie, duree, statut, mode, note, req.user.id, p.id]
    );
    await auditLog('correction', { id: p.id, before: { heure_entree: p.heure_entree, heure_sortie: p.heure_sortie, statut: p.statut }, after: { entree, sortie, statut, mode } }, req.user.id);
    res.json({ id: p.id, heure_entree: entree, heure_sortie: sortie, duree_minutes: duree, duree_hhmm: minutesToHHMM(duree), statut, mode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/absent — marquer absent (RH) ─────────────────────────────
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
        `UPDATE pointages SET statut='absent', mode='manuel', note=?, modifie_par=?, updated_at=datetime('now') WHERE id=?`,
        [note || null, req.user.id, existing.id]
      );
      return res.json({ id: existing.id, statut: 'absent' });
    }
    const r = await db.execute(
      `INSERT INTO pointages (employe_id, date, statut, mode, note, cree_par, updated_at)
       VALUES (?, ?, 'absent', 'manuel', ?, ?, datetime('now'))`,
      [employe_id, d, note || null, req.user.id]
    );
    await auditLog('absent', { employe_id, date: d }, req.user.id);
    res.status(201).json({ id: r.insertId, statut: 'absent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /pointeuse/:id ─────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin uniquement' });
    const p = await db.queryOne('SELECT id FROM pointages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pointage introuvable' });
    await db.execute('DELETE FROM pointages WHERE id = ?', [req.params.id]);
    await auditLog('suppression', { id: req.params.id }, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/auto/absences — cron nightly RH ──────────────────────────
// Génère automatiquement les absences pour les agents qui n'ont pas pointé avant l'heure limite
router.post('/auto/absences', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'rh')) return res.status(403).json({ error: 'Accès refusé' });
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const result = await _genererAbsencesAuto(date, req.user.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/auto/avertissements — cron mensuel RH ────────────────────
router.post('/auto/avertissements', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'rh')) return res.status(403).json({ error: 'Accès refusé' });
    const result = await _genererAvertissementsAuto(req.user.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Automatisations internes ──────────────────────────────────────────────────

async function _genererAbsencesAuto(date, userId) {
  const created = [];
  const agents = await db.query(
    "SELECT id, nom, prenom FROM employes WHERE statut = 'actif'", []
  );
  for (const emp of agents) {
    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [emp.id, date]
    );
    if (!existing) {
      try {
        const r = await db.execute(
          `INSERT INTO pointages (employe_id, date, statut, mode, note, cree_par, updated_at)
           VALUES (?, ?, 'absent', 'auto_absent', 'Absence automatique — non pointé', ?, datetime('now'))`,
          [emp.id, date, userId]
        );
        created.push({ id: r.insertId, employe_id: emp.id, nom: emp.nom, prenom: emp.prenom });
        await auditLog('auto_absent', { id: r.insertId, employe_id: emp.id, date }, userId);
      } catch (_) {}
    }
  }
  return { date, absences_generees: created.length, agents: created };
}

async function _genererHeuresSupp(employe_id, date, duree_minutes, seuil_heures, userId) {
  try {
    const emp = await db.queryOne(
      'SELECT salaire_base FROM employes WHERE id = ?', [employe_id]
    );
    const heures_base = seuil_heures * 60;
    const heures_supp = duree_minutes - heures_base;
    if (heures_supp <= 0) return;

    const nb_heures = Math.round(heures_supp / 60 * 100) / 100;
    const salaire_horaire = ((emp?.salaire_base || 0) / (26 * 8));
    const montant_brut    = Math.round(nb_heures * salaire_horaire * 1.25);

    const d = new Date(date);
    await db.execute(
      `INSERT INTO employes_heures_sup
         (employe_id, mois, annee, date_heures, nb_heures, type, taux_majoration, montant_brut, statut, motif, created_by)
       VALUES (?, ?, ?, ?, ?, 'normal', 1.25, ?, 'saisi', 'Généré automatiquement par la pointeuse', ?)`,
      [employe_id, d.getMonth() + 1, d.getFullYear(), date, nb_heures, montant_brut, userId]
    );
  } catch (_) {}
}

async function _genererAvertissementsAuto(userId) {
  const params = await getGlobalParams();
  const seuil  = params.absences_avant_avertissement;
  const depuis = new Date();
  depuis.setDate(depuis.getDate() - 30);
  const dateDebut = depuis.toISOString().slice(0, 10);

  const agents = await db.query(
    `SELECT employe_id, COUNT(*) as nb_absences
     FROM pointages
     WHERE statut = 'absent' AND date >= ? AND mode != 'auto_absent'
     GROUP BY employe_id HAVING nb_absences >= ?`,
    [dateDebut, seuil]
  );

  const created = [];
  for (const a of agents) {
    // Vérifier qu'un avertissement n'existe pas déjà ce mois
    const moisActuel = new Date().toISOString().slice(0, 7);
    const existing = await db.queryOne(
      `SELECT id FROM employes_sanctions
       WHERE employe_id = ? AND type = 'avertissement_ecrit'
         AND date_sanction >= ? AND motif_detaille LIKE '%absences répétées%'`,
      [a.employe_id, moisActuel + '-01']
    );
    if (!existing) {
      try {
        const r = await db.execute(
          `INSERT INTO employes_sanctions
             (employe_id, type, date_sanction, motif_detaille, nb_jours_mise_a_pied, retenue_calculee, statut, created_by)
           VALUES (?, 'avertissement_ecrit', date('now'), ?, 0, 0, 'projet', ?)`,
          [a.employe_id, `Absences répétées non justifiées : ${a.nb_absences} absences en 30 jours (seuil : ${seuil})`, userId]
        );
        created.push({ id: r.insertId, employe_id: a.employe_id, nb_absences: a.nb_absences });
      } catch (_) {}
    }
  }
  return { avertissements_generes: created.length, agents: created };
}

// ── GET /pointeuse/agent/:id/resume — résumé mensuel d'un agent ──────────────
router.get('/agent/:id/resume', async (req, res) => {
  try {
    if (!canWrite(req.user)) {
      const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [req.user.id]);
      if (!selfRow || selfRow.employe_id !== parseInt(req.params.id))
        return res.status(403).json({ error: 'Accès refusé' });
    }
    const { mois, annee } = req.query;
    const m = mois  || String(new Date().getMonth() + 1).padStart(2, '0');
    const y = annee || String(new Date().getFullYear());
    const prefix = `${y}-${m}`;

    const rows = await db.query(
      `SELECT date, heure_entree, heure_sortie, duree_minutes, statut, mode, hors_perimetre, note
       FROM pointages WHERE employe_id = ? AND date LIKE ?
       ORDER BY date`, [req.params.id, prefix + '%']
    );

    const resume = {
      employe_id:     parseInt(req.params.id),
      mois: m, annee: y,
      jours_travailles: rows.filter(r => ['present','retard','teletravail','terrain'].includes(r.statut)).length,
      jours_absents:    rows.filter(r => r.statut === 'absent').length,
      jours_retard:     rows.filter(r => r.statut === 'retard').length,
      jours_teletravail:rows.filter(r => r.statut === 'teletravail').length,
      total_minutes:    rows.reduce((s, r) => s + (r.duree_minutes || 0), 0),
      hors_perimetre:   rows.filter(r => r.hors_perimetre).length,
      pointages:        rows,
    };
    resume.total_hhmm = minutesToHHMM(resume.total_minutes);
    res.json(resume);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
