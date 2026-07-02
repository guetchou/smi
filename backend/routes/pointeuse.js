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
const {
  classifyAttendanceDay,
} = require('../services/attendance_daily_engine');

const WRITE_ROLES = ['admin','dg','rh'];
const SELF_ROLES  = ['delegue','caissier','assistante_direction','lecteur'];
const MODES_POINTAGE = ['manuel','teletravail','terrain'];
const STATUTS_POINTAGE = ['en_cours','present','retard','absent','teletravail','terrain'];

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

function hhmmToMinutes(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(String(value))) return null;
  const [h, m] = String(value).split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function statutFromData(heure_entree, heure_sortie, heure_theorique, mode) {
  if (mode === 'teletravail') return 'teletravail';
  if (mode === 'terrain')     return 'terrain';
  if (!heure_entree) return 'absent';
  if (heure_theorique) {
    const theor = hhmmToMinutes(heure_theorique);
    const entree = hhmmToMinutes(heure_entree);
    if (theor !== null && entree !== null && entree > theor + 15) return 'retard';
  }
  if (!heure_sortie) return 'en_cours';
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
    absences_avant_avertissement: parseInt(p.pointeuse_absences_avant_avertissement || p.pointeuse_absences_avert) || 3,
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

async function congeActifPourDate(employeId, date) {
  return db.queryOne(
    `SELECT id, type_conge, date_debut, date_fin, statut
     FROM employes_conges
     WHERE employe_id = ?
       AND statut IN ('approuve','termine')
       AND date_debut <= ?
       AND date_fin >= ?
     ORDER BY date_debut DESC
     LIMIT 1`,
    [employeId, date, date]
  );
}

async function getSelfEmploye(userId) {
  const userRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [userId]);
  if (!userRow?.employe_id) return null;
  return db.queryOne(
    `SELECT id, nom, prenom, matricule, poste, departement, site,
            CASE WHEN pin_pointage IS NULL OR pin_pointage = '' THEN 0 ELSE 1 END AS has_pin
     FROM employes
     WHERE id = ? AND actif = 1 AND statut_dossier <> 'sorti'`,
    [userRow.employe_id]
  );
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

// ── GET /pointeuse/me — contexte agent connecté ─────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const employe = await getSelfEmploye(req.user.id);
    if (!employe) {
      return res.status(409).json({
        error: 'Compte non lié à une fiche agent active',
        code: 'USER_NOT_LINKED_TO_EMPLOYE',
      });
    }

    const date = req.query.date || localDateISO();
    const pointage = await db.queryOne(
      `SELECT id, employe_id, date, heure_entree, heure_sortie, duree_minutes, statut, mode, note
       FROM pointages
       WHERE employe_id = ? AND date = ?
       LIMIT 1`,
      [employe.id, date]
    );
    const hasPin = !!employe.has_pin;
    delete employe.has_pin;
    res.json({ employe, pointage: pointage || null, date, has_pin: hasPin });
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
    const d = date || (debut || fin ? null : localDateISO());
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
    const date = req.query.date || localDateISO();
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


// ── GET /pointeuse/daily — vue journalière canonique ─────────────────────────
router.get('/daily', async (req, res) => {
  try {
    const date = req.query.date || localDateISO();
    const restrictToSelf = !canWrite(req.user);

    let selfEmployeId = null;

    if (restrictToSelf) {
      const selfRow = await db.queryOne(
        'SELECT employe_id FROM users WHERE id = ?',
        [req.user.id]
      );

      if (!selfRow?.employe_id) {
        return res.status(403).json({
          error: 'Aucun agent associé à ce compte',
          code: 'USER_NOT_LINKED_TO_EMPLOYE',
        });
      }

      selfEmployeId = selfRow.employe_id;
    }

    const employeeWhere = [
      'e.actif = 1',
      "COALESCE(e.statut_dossier, '') <> 'sorti'",
    ];
    const employeeParams = [];

    if (selfEmployeId) {
      employeeWhere.push('e.id = ?');
      employeeParams.push(selfEmployeId);
    }

    const employees = await db.query(
      `SELECT e.id, e.nom, e.prenom, e.matricule, e.poste,
              e.departement, e.site, e.heure_arrivee
       FROM employes e
       WHERE ${employeeWhere.join(' AND ')}
       ORDER BY e.nom, e.prenom`,
      employeeParams
    );

    const employeeIds = employees.map(employee => employee.id);

    if (!employeeIds.length) {
      return res.json({
        date,
        summary: {
          total_agents: 0,
          presents: 0,
          absents: 0,
          retards: 0,
          incomplets: 0,
          teletravail: 0,
          terrain: 0,
          anomalies: 0,
        },
        days: [],
      });
    }

    const placeholders = employeeIds.map(() => '?').join(',');

    const pointages = await db.query(
      `SELECT p.id, p.employe_id, p.date, p.heure_entree,
              p.heure_sortie, p.heure_theorique, p.duree_minutes,
              p.statut, p.mode, p.hors_perimetre, p.note
       FROM pointages p
       WHERE p.date = ?
         AND p.employe_id IN (${placeholders})`,
      [date, ...employeeIds]
    );

    const leaves = await db.query(
      `SELECT c.id, c.employe_id, c.type_conge, c.statut,
              c.date_debut, c.date_fin
       FROM employes_conges c
       WHERE c.employe_id IN (${placeholders})
         AND c.statut IN ('approuve', 'termine')
         AND c.date_debut <= ?
         AND c.date_fin >= ?`,
      [...employeeIds, date, date]
    );

    const params = await getGlobalParams();
    const pointageByEmployee = new Map(
      pointages.map(pointage => [Number(pointage.employe_id), pointage])
    );
    const leaveByEmployee = new Map(
      leaves.map(leave => [Number(leave.employe_id), leave])
    );

    function approvedEventFromLeave(leave) {
      if (!leave) return null;

      const type = String(leave.type_conge || '').toLowerCase();

      if (type.includes('sans_solde') || type.includes('non_paye')) {
        return { type: 'conge_non_paye', source_id: leave.id };
      }

      if (type.includes('maladie')) {
        return { type: 'maladie', source_id: leave.id };
      }

      return { type: 'conge_paye', source_id: leave.id };
    }

    const days = employees.map(employee => {
      const pointage = pointageByEmployee.get(Number(employee.id)) || null;
      const leave = leaveByEmployee.get(Number(employee.id)) || null;

      let approvedEvent = approvedEventFromLeave(leave);

      if (!approvedEvent && pointage?.mode === 'teletravail') {
        approvedEvent = { type: 'teletravail', source_id: pointage.id };
      }

      if (!approvedEvent && pointage?.mode === 'terrain') {
        approvedEvent = { type: 'mission', source_id: pointage.id };
      }

      const result = classifyAttendanceDay({
        scheduled: true,
        expectedStart:
          pointage?.heure_theorique
          || employee.heure_arrivee
          || params.heure_arrivee
          || '08:00',
        expectedEnd: params.heure_sortie || '17:00',
        lateToleranceMinutes: 15,
        earlyDepartureToleranceMinutes: 10,
        approvedEvent,
        punches: [
          ...(pointage?.heure_entree
            ? [{ type: 'entry', time: pointage.heure_entree }]
            : []),
          ...(pointage?.heure_sortie
            ? [{ type: 'exit', time: pointage.heure_sortie }]
            : []),
        ],
      });

      if (
        pointage?.statut === 'retard'
        && !result.anomalies.includes('late_arrival')
      ) {
        result.anomalies.push('late_arrival');
      }

      if (pointage?.hors_perimetre) {
        result.anomalies.push('outside_geofence');
      }

      return {
        id: pointage?.id || null,
        employe_id: employee.id,
        date,
        nom: employee.nom,
        prenom: employee.prenom,
        matricule: employee.matricule,
        poste: employee.poste,
        departement: employee.departement,
        site: employee.site,

        heure_theorique:
          pointage?.heure_theorique
          || employee.heure_arrivee
          || params.heure_arrivee
          || '08:00',

        heure_entree: pointage?.heure_entree || null,
        heure_sortie: pointage?.heure_sortie || null,
        duree_minutes:
          result.workedMinutes
          || pointage?.duree_minutes
          || 0,

        statut: result.status,
        statut_legacy: pointage?.statut || null,
        mode: pointage?.mode || null,
        note: pointage?.note || null,
        hors_perimetre: !!pointage?.hors_perimetre,

        retard_minutes: result.lateMinutes,
        depart_anticipe_minutes: result.earlyDepartureMinutes,
        anomalies: result.anomalies,
        conge_id: leave?.id || null,
      };
    });

    const summary = days.reduce(
      (accumulator, day) => {
        accumulator.total_agents += 1;

        if (day.statut === 'present') accumulator.presents += 1;

        if (
          day.statut === 'absent_injustifie'
          || day.statut === 'absent_justifie'
          || day.statut === 'conge_non_paye'
        ) {
          accumulator.absents += 1;
        }

        if (day.anomalies.includes('late_arrival')) {
          accumulator.retards += 1;
        }

        if (day.statut === 'pointage_incomplet') {
          accumulator.incomplets += 1;
        }

        if (day.statut === 'teletravail') {
          accumulator.teletravail += 1;
        }

        if (day.statut === 'mission') {
          accumulator.terrain += 1;
        }

        accumulator.anomalies += day.anomalies.length;

        return accumulator;
      },
      {
        total_agents: 0,
        presents: 0,
        absents: 0,
        retards: 0,
        incomplets: 0,
        teletravail: 0,
        terrain: 0,
        anomalies: 0,
      }
    );

    res.json({
      date,
      summary,
      days,
    });
  } catch (error) {
    console.error('[pointeuse GET /daily]', error);
    res.status(500).json({
      error: 'Impossible de calculer la journée de présence',
      details: error.message,
    });
  }
});


// ── PATCH /pointeuse/:id/correction — correction RH auditée ─────────────────
router.patch('/:id/correction', async (req, res) => {
  try {
    if (!canWrite(req.user)) {
      return res.status(403).json({
        error: 'Correction réservée à RH, DG ou administrateur',
        code: 'ATTENDANCE_CORRECTION_FORBIDDEN',
      });
    }

    const id = Number(req.params.id);
    const reason = String(req.body?.motif_correction || '').trim();

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: 'Identifiant invalide',
        code: 'INVALID_ATTENDANCE_ID',
      });
    }

    if (reason.length < 5) {
      return res.status(400).json({
        error: 'Le motif de correction est obligatoire',
        code: 'CORRECTION_REASON_REQUIRED',
      });
    }

    const existing = await db.queryOne(
      `SELECT id, employe_id, date, heure_entree, heure_sortie,
              heure_theorique, duree_minutes, statut, mode, note
       FROM pointages
       WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({
        error: 'Pointage introuvable',
        code: 'ATTENDANCE_NOT_FOUND',
      });
    }

    const closedPeriod = await db.queryOne(
      `SELECT id
       FROM periodes_paie
       WHERE date_debut <= ?
         AND date_fin >= ?
         AND statut IN ('validee', 'payee', 'cloturee')
       LIMIT 1`,
      [existing.date, existing.date]
    ).catch(() => null);

    if (closedPeriod) {
      return res.status(409).json({
        error: 'La période de paie est clôturée',
        code: 'ATTENDANCE_PERIOD_CLOSED',
      });
    }

    const nextEntry = req.body.heure_entree === undefined
      ? existing.heure_entree
      : req.body.heure_entree || null;

    const nextExit = req.body.heure_sortie === undefined
      ? existing.heure_sortie
      : req.body.heure_sortie || null;

    if (nextEntry && hhmmToMinutes(nextEntry) === null) {
      return res.status(400).json({
        error: "Heure d'entrée invalide",
        code: 'INVALID_ENTRY_TIME',
      });
    }

    if (nextExit && hhmmToMinutes(nextExit) === null) {
      return res.status(400).json({
        error: 'Heure de sortie invalide',
        code: 'INVALID_EXIT_TIME',
      });
    }

    const nextMode = req.body.mode || existing.mode || 'manuel';

    const nextStatus = req.body.statut || statutFromData(
      nextEntry,
      nextExit,
      existing.heure_theorique,
      nextMode
    );

    const before_state = {
      heure_entree: existing.heure_entree,
      heure_sortie: existing.heure_sortie,
      duree_minutes: existing.duree_minutes,
      statut: existing.statut,
      mode: existing.mode,
      note: existing.note,
    };

    const after_state = {
      heure_entree: nextEntry,
      heure_sortie: nextExit,
      duree_minutes: calcDuree(nextEntry, nextExit),
      statut: nextStatus,
      mode: nextMode,
      note: req.body.note === undefined
        ? existing.note
        : req.body.note || null,
    };

    if (JSON.stringify(before_state) === JSON.stringify(after_state)) {
      return res.status(409).json({
        error: 'Aucune modification détectée',
        code: 'ATTENDANCE_CORRECTION_NO_CHANGE',
      });
    }

    await db.execute(
      `UPDATE pointages
       SET heure_entree = ?,
           heure_sortie = ?,
           duree_minutes = ?,
           statut = ?,
           mode = ?,
           note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        after_state.heure_entree,
        after_state.heure_sortie,
        after_state.duree_minutes,
        after_state.statut,
        after_state.mode,
        after_state.note,
        id,
      ]
    );

    await auditLog(
      'attendance_correction',
      {
        id,
        action: 'attendance_correction',
        employe_id: existing.employe_id,
        date: existing.date,
        reason,
        before_state,
        after_state,
      },
      req.user.id
    );

    res.json({
      ok: true,
      pointage_id: id,
      reason,
      before_state,
      after_state,
    });
  } catch (error) {
    console.error('[pointeuse correction]', error);

    res.status(500).json({
      error: 'Échec de la correction du pointage',
      details: error.message,
    });
  }
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
// Corps : { employe_id?, date?, heure_entree?, pin?, latitude?, longitude?, precision_gps?, mode?, note? }
router.post('/', async (req, res) => {
  try {
    const user = req.user;
    const { employe_id, date, heure_entree, pin, latitude, longitude, precision_gps, mode, note } = req.body;

    // Le pointage d'entrée est strictement personnel. Les rôles RH/admin gardent
    // les corrections et absences, mais ne créent pas d'entrée pour un collègue.
    const selfRow = await db.queryOne('SELECT employe_id FROM users WHERE id = ?', [user.id]);
    if (!selfRow?.employe_id)
      return res.status(403).json({ error: 'Compte non lié à une fiche agent — pointage personnel impossible' });
    const selfEmployeId = parseInt(selfRow.employe_id, 10);
    const requestedEmployeId = employe_id ? parseInt(employe_id, 10) : selfEmployeId;
    if (!Number.isFinite(requestedEmployeId) || requestedEmployeId !== selfEmployeId)
      return res.status(403).json({ error: 'Vous ne pouvez pointer que pour vous-même' });
    const targetEmployeId = selfEmployeId;

    const emp = await db.queryOne(
      'SELECT id, nom, prenom, pin_pointage, heure_arrivee, gps_rayon_m FROM employes WHERE id = ?',
      [targetEmployeId]
    );
    if (!emp) return res.status(404).json({ error: 'Agent introuvable' });

    const params = await getGlobalParams();
    const pointMode = mode || 'manuel';
    if (!MODES_POINTAGE.includes(pointMode))
      return res.status(400).json({ error: `mode invalide. Valeurs : ${MODES_POINTAGE.join(', ')}` });

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

    const d      = date || localDateISO();
    const entree = heure_entree || new Date().toTimeString().slice(0, 5);
    const hTheor = emp.heure_arrivee || params.heure_arrivee || '08:00';
    const statutInitial = statutFromData(entree, null, hTheor, pointMode);

    const congeActif = await congeActifPourDate(targetEmployeId, d);
    if (congeActif) {
      return res.status(409).json({
        error: `Pointage refusé : agent en congé approuvé du ${congeActif.date_debut} au ${congeActif.date_fin}`,
        code: 'AGENT_EN_CONGE',
        conge: congeActif,
      });
    }

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [targetEmployeId, d, entree, hTheor, statutInitial, pointMode,
       ip, latitude ?? null, longitude ?? null, precision_gps ?? null,
       hors_perimetre, note || null, user.id]
    );

    await auditLog('entree', { id: r.insertId, employe_id: targetEmployeId, date: d, heure_entree: entree, mode: pointMode, statut: statutInitial, hors_perimetre }, user.id);

    const resp = { id: r.insertId, employe_id: targetEmployeId, date: d, heure_entree: entree, statut: statutInitial, mode: pointMode };
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
    if (p.mode === 'teletravail' || p.mode === 'terrain' || p.statut === 'absent')
      return res.status(400).json({ error: `Sortie non applicable pour un pointage ${p.statut}` });

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
      `UPDATE pointages SET heure_sortie=?, duree_minutes=?, statut=?, note=?, modifie_par=?, updated_at=NOW() WHERE id=?`,
      [sortie, duree, statut, newNote, req.user.id, p.id]
    );
    await auditLog('sortie', { id: p.id, sortie, duree, statut }, req.user.id);

    const globalParams = await getGlobalParams();
    await _syncHeuresSuppAuto(p.employe_id, p.date, duree, globalParams.seuil_heures_supp, req.user.id);

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
    if (!MODES_POINTAGE.includes(mode))
      return res.status(400).json({ error: `mode invalide. Valeurs : ${MODES_POINTAGE.join(', ')}` });
    if (req.body.statut && !STATUTS_POINTAGE.includes(req.body.statut))
      return res.status(400).json({ error: `statut invalide. Valeurs : ${STATUTS_POINTAGE.join(', ')}` });
    const statut = req.body.statut || statutFromData(entree, sortie, p.heure_theorique, mode);
    const note   = req.body.note   !== undefined ? req.body.note : p.note;

    await db.execute(
      `UPDATE pointages SET heure_entree=?, heure_sortie=?, duree_minutes=?, statut=?, mode=?, note=?, modifie_par=?, updated_at=NOW() WHERE id=?`,
      [entree, sortie, duree, statut, mode, note, req.user.id, p.id]
    );
    await auditLog('correction', { id: p.id, before: { heure_entree: p.heure_entree, heure_sortie: p.heure_sortie, statut: p.statut }, after: { entree, sortie, statut, mode } }, req.user.id);
    const globalParams = await getGlobalParams();
    await _syncHeuresSuppAuto(p.employe_id, p.date, duree, globalParams.seuil_heures_supp, req.user.id);
    res.json({ id: p.id, heure_entree: entree, heure_sortie: sortie, duree_minutes: duree, duree_hhmm: minutesToHHMM(duree), statut, mode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /pointeuse/absent — marquer absent (RH) ─────────────────────────────
router.post('/absent', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { employe_id, date, note } = req.body;
    if (!employe_id) return res.status(400).json({ error: 'employe_id requis' });
    const d = date || localDateISO();

    const congeActif = await congeActifPourDate(employe_id, d);
    if (congeActif) {
      return res.status(409).json({
        error: `Impossible de marquer absent : agent en congé approuvé du ${congeActif.date_debut} au ${congeActif.date_fin}`,
        code: 'AGENT_EN_CONGE',
        conge: congeActif,
      });
    }

    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [employe_id, d]
    );
    if (existing) {
      await db.execute(
        `UPDATE pointages
         SET heure_entree=NULL, heure_sortie=NULL, duree_minutes=NULL,
             statut='absent', mode='manuel', note=?, modifie_par=?, updated_at=NOW()
         WHERE id=?`,
        [note || null, req.user.id, existing.id]
      );
      return res.json({ id: existing.id, statut: 'absent' });
    }
    const r = await db.execute(
      `INSERT INTO pointages (employe_id, date, statut, mode, note, cree_par, updated_at)
       VALUES (?, ?, 'absent', 'manuel', ?, ?, NOW())`,
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
    const date = req.body.date || localDateISO();
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
  const params = await getGlobalParams();
  const today = localDateISO();
  if (date > today) {
    return { date, absences_generees: 0, agents: [], skipped: true, raison: 'Date future' };
  }
  if (date === today) {
    const nowMinutes = hhmmToMinutes(new Date().toTimeString().slice(0, 5));
    const limitMinutes = hhmmToMinutes(params.heure_limite_absence);
    if (limitMinutes !== null && nowMinutes !== null && nowMinutes < limitMinutes) {
      return {
        date,
        absences_generees: 0,
        agents: [],
        skipped: true,
        raison: `Heure limite non atteinte (${params.heure_limite_absence})`,
      };
    }
  }

  const created = [];
  const skippedConges = [];
  const agents = await db.query(
    "SELECT id, nom, prenom FROM employes WHERE actif = 1 AND statut_dossier = 'actif'", []
  );
  for (const emp of agents) {
    const congeActif = await congeActifPourDate(emp.id, date);
    if (congeActif) {
      skippedConges.push({
        employe_id: emp.id,
        nom: emp.nom,
        prenom: emp.prenom,
        conge_id: congeActif.id,
      });
      continue;
    }

    const existing = await db.queryOne(
      'SELECT id FROM pointages WHERE employe_id = ? AND date = ?', [emp.id, date]
    );
    if (!existing) {
      try {
        const r = await db.execute(
          `INSERT INTO pointages (employe_id, date, statut, mode, note, cree_par, updated_at)
           VALUES (?, ?, 'absent', 'auto_absent', 'Absence automatique — non pointé', ?, NOW())`,
          [emp.id, date, userId]
        );
        created.push({ id: r.insertId, employe_id: emp.id, nom: emp.nom, prenom: emp.prenom });
        await auditLog('auto_absent', { id: r.insertId, employe_id: emp.id, date }, userId);
      } catch (_) {}
    }
  }
  return { date, absences_generees: created.length, agents: created, conges_ignores: skippedConges.length, agents_en_conge: skippedConges };
}

async function _syncHeuresSuppAuto(employe_id, date, duree_minutes, seuil_heures, userId) {
  try {
    const emp = await db.queryOne(
      'SELECT salaire_base FROM employes WHERE id = ?', [employe_id]
    );
    const heures_base = seuil_heures * 60;
    const heures_supp = (duree_minutes || 0) - heures_base;
    const existing = await db.queryOne(
      `SELECT id, statut
       FROM employes_heures_sup
       WHERE employe_id = ?
         AND date_heures = ?
         AND motif = 'Généré automatiquement par la pointeuse'
       ORDER BY id DESC
       LIMIT 1`,
      [employe_id, date]
    );

    if (heures_supp <= 0) {
      if (existing && existing.statut !== 'integre_bulletin') {
        await db.execute('DELETE FROM employes_heures_sup WHERE id = ?', [existing.id]);
      }
      return;
    }

    const nb_heures = Math.round(heures_supp / 60 * 100) / 100;
    const salaire_horaire = ((emp?.salaire_base || 0) / (26 * 8));
    const montant_brut    = Math.round(nb_heures * salaire_horaire * 1.25);

    const d = new Date(date);
    if (existing && existing.statut !== 'integre_bulletin') {
      await db.execute(
        `UPDATE employes_heures_sup
         SET mois = ?, annee = ?, nb_heures = ?, taux_majoration = 1.25,
             montant_brut = ?, created_by = ?
         WHERE id = ?`,
        [d.getMonth() + 1, d.getFullYear(), nb_heures, montant_brut, userId, existing.id]
      );
    } else if (!existing) {
      await db.execute(
        `INSERT INTO employes_heures_sup
           (employe_id, mois, annee, date_heures, nb_heures, type, taux_majoration, montant_brut, statut, motif, created_by)
         VALUES (?, ?, ?, ?, ?, 'normal', 1.25, ?, 'saisi', 'Généré automatiquement par la pointeuse', ?)`,
        [employe_id, d.getMonth() + 1, d.getFullYear(), date, nb_heures, montant_brut, userId]
      );
    }
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
     WHERE statut = 'absent'
       AND date >= ?
       AND COALESCE(note, '') NOT LIKE '%justifi%'
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
           VALUES (?, 'avertissement_ecrit', CURDATE(), ?, 0, 0, 'projet', ?)`,
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
