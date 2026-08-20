'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hasRole } = require('./auth');
const daily = require('../services/pointeuse_v3_daily_service');
const governance = require('../services/pointeuse_v3_governance');

const router = express.Router();
const MANAGER = ['admin', 'dg', 'rh'];

function allowed(user) { return hasRole(user, ...MANAGER); }
function deny(res) { return res.status(403).json({ error: 'Accès RH/DG/admin requis' }); }
function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[pointeuse-v3-admin]', error);
  return res.status(status).json({ error: status >= 500 ? 'Erreur interne de la pointeuse' : error.message, code: error.code });
}
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function validTime(v) { return /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(v || '')); }
function isoDateDaysAgo(days, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - Math.max(0, Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
function maxDate(a, b) { return String(a) >= String(b) ? String(a) : String(b); }
function minDate(a, b) { return String(a) <= String(b) ? String(a) : String(b); }

router.get('/admin/config', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const calendarCutoff = isoDateDaysAgo(60);
    const [schedules, assignments, sites, calendars, calendarDays, periods] = await Promise.all([
      db.query('SELECT * FROM pointeuse_work_schedules ORDER BY actif DESC, code'),
      db.query(`SELECT a.*, e.matricule, e.nom, e.prenom, s.code AS schedule_code, c.code AS calendar_code
                FROM pointeuse_schedule_assignments a JOIN employes e ON e.id=a.employe_id
                JOIN pointeuse_work_schedules s ON s.id=a.schedule_id
                LEFT JOIN pointeuse_work_calendars c ON c.id=a.calendar_id
                ORDER BY a.date_debut DESC, a.id DESC LIMIT 1000`),
      db.query('SELECT * FROM pointeuse_sites ORDER BY actif DESC, code'),
      db.query('SELECT * FROM pointeuse_work_calendars ORDER BY actif DESC, code'),
      db.query(`SELECT d.*, c.code AS calendar_code FROM pointeuse_calendar_days d
                JOIN pointeuse_work_calendars c ON c.id=d.calendar_id
                WHERE d.work_date >= ?
                ORDER BY d.work_date, d.id LIMIT 1000`, [calendarCutoff]),
      db.query('SELECT * FROM pointeuse_periods ORDER BY date_debut DESC, id DESC LIMIT 100'),
    ]);
    const mode = await db.queryOne("SELECT valeur FROM parametres WHERE cle='pointeuse_v3_mode'");
    res.json({ schedules, assignments, sites, calendars, calendar_days: calendarDays, periods, mode: mode?.valeur || 'shadow' });
  } catch (error) { fail(res, error); }
});

router.post('/admin/sites', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const { code, libelle, latitude, longitude, rayon_m = 300, gps_requis = false } = req.body || {};
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(String(code || ''))) return res.status(400).json({ error: 'Code site invalide' });
    if (!String(libelle || '').trim()) return res.status(400).json({ error: 'Libellé requis' });
    const r = await db.execute(
      `INSERT INTO pointeuse_sites (code,libelle,latitude,longitude,rayon_m,gps_requis,created_by)
       VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE libelle=VALUES(libelle), latitude=VALUES(latitude),
       longitude=VALUES(longitude), rayon_m=VALUES(rayon_m), gps_requis=VALUES(gps_requis), actif=1`,
      [String(code).trim(), String(libelle).trim(), latitude ?? null, longitude ?? null, Math.max(10, Number(rayon_m) || 300), gps_requis ? 1 : 0, req.user.id]
    );
    res.status(201).json({ id: r.insertId || null, code: String(code).trim() });
  } catch (error) { fail(res, error); }
});

router.post('/admin/calendars', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const { code, libelle, timezone_name = 'Africa/Brazzaville', jours_ouvres = '1,2,3,4,5' } = req.body || {};
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(String(code || ''))) return res.status(400).json({ error: 'Code calendrier invalide' });
    const r = await db.execute(
      `INSERT INTO pointeuse_work_calendars (code,libelle,timezone_name,jours_ouvres,created_by)
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE libelle=VALUES(libelle),timezone_name=VALUES(timezone_name),jours_ouvres=VALUES(jours_ouvres),actif=1`,
      [String(code).trim(), String(libelle || code).trim(), String(timezone_name), String(jours_ouvres), req.user.id]
    );
    res.status(201).json({ id: r.insertId || null, code: String(code).trim() });
  } catch (error) { fail(res, error); }
});

router.post('/admin/calendars/:id/days', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const { work_date, day_type, libelle, scheduled_minutes_override } = req.body || {};
    if (!validDate(work_date) || !['workday','holiday','rest','exception'].includes(day_type)) return res.status(400).json({ error: 'Jour calendrier invalide' });
    await db.execute(
      `INSERT INTO pointeuse_calendar_days (calendar_id,work_date,day_type,libelle,scheduled_minutes_override,created_by)
       VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE day_type=VALUES(day_type),libelle=VALUES(libelle),scheduled_minutes_override=VALUES(scheduled_minutes_override)`,
      [Number(req.params.id), work_date, day_type, libelle || null, scheduled_minutes_override ?? null, req.user.id]
    );
    res.status(201).json({ calendar_id: Number(req.params.id), work_date, day_type });
  } catch (error) { fail(res, error); }
});

router.post('/admin/schedules', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const b = req.body || {};
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(String(b.code || '')) || !validTime(b.heure_debut) || !validTime(b.heure_fin)) {
      return res.status(400).json({ error: 'Planning invalide' });
    }
    await db.execute(
      `INSERT INTO pointeuse_work_schedules
       (code,libelle,timezone_name,heure_debut,heure_fin,pause_minutes,tolerance_retard_minutes,tolerance_depart_minutes,
        nuit_traverse_minuit,nuit_debut,nuit_fin,max_duree_minutes,min_duree_minutes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE libelle=VALUES(libelle),timezone_name=VALUES(timezone_name),heure_debut=VALUES(heure_debut),
       heure_fin=VALUES(heure_fin),pause_minutes=VALUES(pause_minutes),tolerance_retard_minutes=VALUES(tolerance_retard_minutes),
       tolerance_depart_minutes=VALUES(tolerance_depart_minutes),nuit_traverse_minuit=VALUES(nuit_traverse_minuit),
       nuit_debut=VALUES(nuit_debut),nuit_fin=VALUES(nuit_fin),max_duree_minutes=VALUES(max_duree_minutes),
       min_duree_minutes=VALUES(min_duree_minutes),actif=1`,
      [b.code, b.libelle || b.code, b.timezone_name || 'Africa/Brazzaville', b.heure_debut, b.heure_fin,
       Math.max(0, Number(b.pause_minutes) || 0), Math.max(0, Number(b.tolerance_retard_minutes) || 0),
       Math.max(0, Number(b.tolerance_depart_minutes) || 0), b.nuit_traverse_minuit ? 1 : 0,
       b.nuit_debut || '22:00', b.nuit_fin || '05:00', Math.max(60, Number(b.max_duree_minutes) || 960),
       b.min_duree_minutes == null ? null : Math.max(0, Number(b.min_duree_minutes)), req.user.id]
    );
    res.status(201).json({ code: b.code });
  } catch (error) { fail(res, error); }
});

router.post('/admin/assignments', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const b = req.body || {};
    const employeId = Number(b.employe_id);
    const scheduleId = Number(b.schedule_id);
    if (!Number.isInteger(employeId) || !Number.isInteger(scheduleId) || !validDate(b.date_debut)) return res.status(400).json({ error: 'Affectation invalide' });
    if (b.date_fin && (!validDate(b.date_fin) || b.date_fin < b.date_debut)) return res.status(400).json({ error: 'Fin d’affectation invalide', code: 'INVALID_ASSIGNMENT_END_DATE' });
    if (!['bureau','teletravail','terrain','hybride'].includes(b.mode_autorise || 'bureau')) return res.status(400).json({ error: 'Mode invalide' });
    const id = await db.transaction(async tx => {
      const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
      const employee = await tx.queryOne(`SELECT id FROM employes WHERE id=?${forUpdate}`, [employeId]);
      if (!employee) { const e = new Error('Agent introuvable'); e.code = 'EMPLOYEE_NOT_FOUND'; e.status = 404; throw e; }
      const overlap = await tx.queryOne(
        `SELECT id FROM pointeuse_schedule_assignments
         WHERE employe_id=? AND date_debut <= ? AND (date_fin IS NULL OR date_fin >= ?)
         ORDER BY id DESC LIMIT 1`,
        [employeId, b.date_fin || '9999-12-31', b.date_debut]
      );
      if (overlap) { const e = new Error('Une affectation de planning chevauche déjà cette période'); e.code = 'ASSIGNMENT_DATE_OVERLAP'; e.status = 409; throw e; }
      const r = await tx.execute(
        `INSERT INTO pointeuse_schedule_assignments
         (employe_id,schedule_id,calendar_id,date_debut,date_fin,jours_semaine,site_code,mode_autorise,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [employeId, scheduleId, b.calendar_id ? Number(b.calendar_id) : null, b.date_debut, b.date_fin || null,
         b.jours_semaine || '1,2,3,4,5', b.site_code || null, b.mode_autorise || 'bureau', req.user.id]
      );
      return r.insertId;
    });
    res.status(201).json({ id });
  } catch (error) { fail(res, error); }
});

router.post('/admin/anomalies/:id/resolve', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const status = req.body?.status;
    if (!['approved','regularized','dismissed','rejected'].includes(status)) return res.status(400).json({ error: 'Statut de résolution invalide' });
    const justification = String(req.body?.justification || '').trim();
    if (justification.length < 5) return res.status(400).json({ error: 'Justification requise' });
    const r = await db.execute(
      `UPDATE pointeuse_anomalies SET status=?, justification=?, resolved_by=?, resolved_at=NOW()
       WHERE id=? AND status IN ('detected','to_justify','submitted','rejected')`,
      [status, justification, req.user.id, Number(req.params.id)]
    );
    if (!r.affectedRows) return res.status(409).json({ error: 'Anomalie déjà traitée ou introuvable', code: 'ANOMALY_STATE_RACE' });
    res.json({ id: Number(req.params.id), status });
  } catch (error) { fail(res, error); }
});

router.post('/admin/days/:id/approve', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const day = await db.queryOne('SELECT * FROM pointeuse_daily_summaries WHERE id=?', [Number(req.params.id)]);
    if (!day) return res.status(404).json({ error: 'Journée introuvable' });
    if (day.status === 'closed') return res.status(409).json({ error: 'Journée clôturée' });
    const unresolved = await db.queryOne(`SELECT COUNT(*) AS n FROM pointeuse_anomalies WHERE daily_summary_id=? AND status NOT IN ('approved','regularized','dismissed')`, [day.id]);
    if (Number(unresolved?.n || 0) > 0) return res.status(409).json({ error: 'Anomalies non résolues', code: 'UNRESOLVED_ANOMALIES', count: Number(unresolved.n) });
    const r = await db.execute(`UPDATE pointeuse_daily_summaries SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND status IN ('calculated','exception')`, [req.user.id, day.id]);
    if (!r.affectedRows) return res.status(409).json({ error: 'État de journée modifié concurremment', code: 'DAY_STATE_RACE' });
    res.json({ id: day.id, status: 'approved' });
  } catch (error) { fail(res, error); }
});

router.post('/admin/periods', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const { date_debut, date_fin } = req.body || {};
    if (!validDate(date_debut) || !validDate(date_fin) || date_fin < date_debut) return res.status(400).json({ error: 'Période invalide' });
    const r = await db.execute(`INSERT INTO pointeuse_periods (date_debut,date_fin,status,calc_version,created_by) VALUES (?,?,'open','v3.3',?)`, [date_debut, date_fin, req.user.id]);
    res.status(201).json({ id: r.insertId, status: 'open' });
  } catch (error) { fail(res, error); }
});

router.post('/admin/periods/:id/calculate', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const period = await db.queryOne('SELECT * FROM pointeuse_periods WHERE id=?', [Number(req.params.id)]);
    if (!period || !['open','reopened','calculated'].includes(period.status)) return res.status(409).json({ error: 'Période non calculable', code: 'PERIOD_NOT_CALCULABLE' });
    const assignments = await db.query(
      `SELECT employe_id,date_debut,date_fin FROM pointeuse_schedule_assignments
       WHERE date_debut<=? AND (date_fin IS NULL OR date_fin>=?)
       ORDER BY employe_id,date_debut,id`,
      [period.date_fin, period.date_debut]
    );
    const employeeIds = new Set();
    const workDates = new Set();
    for (const a of assignments) {
      const employeId = Number(a.employe_id);
      employeeIds.add(employeId);
      const startText = maxDate(period.date_debut, a.date_debut);
      const endText = minDate(period.date_fin, a.date_fin || period.date_fin);
      let cursor = new Date(`${startText}T12:00:00Z`);
      const end = new Date(`${endText}T12:00:00Z`);
      while (cursor <= end) {
        const d = cursor.toISOString().slice(0,10);
        workDates.add(`${employeId}:${d}`);
        cursor = new Date(cursor.getTime() + 86400000);
      }
    }
    for (const item of workDates) {
      const separator = item.indexOf(':');
      const employeId = Number(item.slice(0, separator));
      const d = item.slice(separator + 1);
      try { await daily.recalculateDay(employeId, d); } catch (err) { if (err.code !== 'DAY_CLOSED') throw err; }
    }
    await db.execute(`UPDATE pointeuse_periods SET status='calculated',calculated_at=NOW(),calc_version='v3.3' WHERE id=? AND status IN ('open','reopened','calculated')`, [period.id]);
    res.json({ id: period.id, status: 'calculated', employees: employeeIds.size, days: workDates.size });
  } catch (error) { fail(res, error); }
});

router.post('/admin/periods/:id/review', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const r = await db.execute(`UPDATE pointeuse_periods SET status='review',reviewed_by=?,reviewed_at=NOW() WHERE id=? AND status='calculated'`, [req.user.id, Number(req.params.id)]);
    if (!r.affectedRows) return res.status(409).json({ error: 'Période non prête pour revue', code: 'PERIOD_NOT_CALCULATED' });
    res.json({ id: Number(req.params.id), status: 'review' });
  } catch (error) { fail(res, error); }
});

router.post('/admin/periods/:id/approve', async (req, res) => {
  try {
    if (!allowed(req.user)) return deny(res);
    const p = await db.queryOne('SELECT * FROM pointeuse_periods WHERE id=?', [Number(req.params.id)]);
    if (!p || p.status !== 'review') return res.status(409).json({ error: 'Période non revue', code: 'PERIOD_NOT_REVIEWED' });
    if (Number(p.reviewed_by) === Number(req.user.id)) return res.status(403).json({ error: 'Le réviseur ne peut pas approuver la même période', code: 'PERIOD_SELF_APPROVAL_FORBIDDEN' });
    const unresolved = await db.queryOne(`SELECT COUNT(*) AS n FROM pointeuse_anomalies WHERE work_date BETWEEN ? AND ? AND status NOT IN ('approved','regularized','dismissed')`, [p.date_debut,p.date_fin]);
    if (Number(unresolved?.n || 0) > 0) return res.status(409).json({ error: 'Anomalies non résolues', code: 'UNRESOLVED_ANOMALIES', count:Number(unresolved.n) });
    const unapproved = await db.queryOne(`SELECT COUNT(*) AS n FROM pointeuse_daily_summaries WHERE work_date BETWEEN ? AND ? AND status<>'approved'`, [p.date_debut,p.date_fin]);
    if (Number(unapproved?.n || 0) > 0) return res.status(409).json({ error: 'Toutes les journées doivent être approuvées', code: 'UNAPPROVED_DAYS', count:Number(unapproved.n) });
    const r = await db.execute(`UPDATE pointeuse_periods SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND status='review'`, [req.user.id,p.id]);
    if (!r.affectedRows) return res.status(409).json({ error: 'État de période modifié concurremment', code: 'PERIOD_STATE_RACE' });
    res.json({ id:p.id,status:'approved' });
  } catch (error) { fail(res,error); }
});

router.post('/admin/periods/:id/reopen', async (req, res) => {
  try {
    if (!hasRole(req.user,'admin','dg')) return res.status(403).json({ error:'Admin/DG requis' });
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ error:'Motif de réouverture requis (10 caractères minimum)' });
    const p = await db.queryOne('SELECT * FROM pointeuse_periods WHERE id=?',[Number(req.params.id)]);
    if (!p || p.status !== 'closed') return res.status(409).json({ error:'Seule une période clôturée peut être réouverte', code:'PERIOD_NOT_CLOSED' });
    const consumed = await db.queryOne(`SELECT COUNT(*) AS n FROM pointeuse_payroll_snapshots WHERE period_id=? AND status='consumed'`,[p.id]);
    if (Number(consumed?.n||0)>0) return res.status(409).json({ error:'Snapshot déjà consommé par la paie : réouverture interdite', code:'PAYROLL_ALREADY_CONSUMED' });
    await db.transaction(async tx=>{
      const r=await tx.execute(`UPDATE pointeuse_periods SET status='reopened',reopened_by=?,reopened_at=NOW(),reopen_reason=?,closed_by=NULL,closed_at=NULL WHERE id=? AND status='closed'`,[req.user.id,reason,p.id]);
      if(!r.affectedRows){const e=new Error('Conflit de réouverture');e.code='PERIOD_STATE_RACE';e.status=409;throw e;}
      await tx.execute(`UPDATE pointeuse_daily_summaries SET status='approved',closed_at=NULL WHERE work_date BETWEEN ? AND ? AND status='closed'`,[p.date_debut,p.date_fin]);
      await governance.appendAudit(tx,{aggregateType:'pointeuse_period',aggregateId:p.id,action:'period.reopened',actorUserId:req.user.id,correlationId:crypto.randomUUID(),before:{status:'closed'},after:{status:'reopened'},metadata:{reason}});
    });
    res.json({id:p.id,status:'reopened'});
  } catch(error){fail(res,error);}
});

router.post('/admin/runtime-mode', async (req,res)=>{
  try{
    if(!hasRole(req.user,'admin','dg')) return res.status(403).json({error:'Admin/DG requis'});
    const mode=String(req.body?.mode||'');
    if(!['disabled','shadow','active'].includes(mode)) return res.status(400).json({error:'Mode invalide'});
    await db.execute("UPDATE parametres SET valeur=? WHERE cle='pointeuse_v3_mode'",[mode]);
    res.json({mode});
  }catch(error){fail(res,error);}
});

module.exports = router;
