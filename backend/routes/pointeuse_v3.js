'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const engine = require('../services/pointeuse_v3_engine');
const daily = require('../services/pointeuse_v3_daily_service');
const policy = require('../services/pointeuse_v3_policy');

const router = express.Router();
const MANAGER_ROLES = ['admin', 'dg', 'rh'];

function canManage(user) { return hasRole(user, ...MANAGER_ROLES); }

async function selfEmployeId(userId) {
  const row = await db.queryOne(
    `SELECT e.id AS employe_id
     FROM users u
     JOIN employes e ON e.id = u.employe_id
     WHERE u.id = ? AND e.actif = 1 AND e.statut_dossier <> 'sorti'
     LIMIT 1`,
    [userId]
  );
  return row?.employe_id ? Number(row.employe_id) : null;
}

function clientIp(req) { return req.ip || req.socket?.remoteAddress || null; }

function errorResponse(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[pointeuse-v3]', error);
  return res.status(status).json({
    error: status >= 500 ? 'Erreur interne de la pointeuse' : error.message,
    code: error.code || (status >= 500 ? 'ATTENDANCE_INTERNAL_ERROR' : 'ATTENDANCE_REQUEST_REJECTED'),
    details: status < 500 ? error.details || undefined : undefined,
  });
}

async function latestEvent(employeId) {
  return db.queryOne(
    `SELECT id, event_type, occurred_at_utc, local_date, work_date, local_time,
            timezone_name, source, mode, site_code, hors_perimetre
     FROM pointeuse_events WHERE employe_id = ?
     ORDER BY occurred_at_utc DESC, id DESC LIMIT 1`,
    [employeId]
  );
}

router.get('/capabilities', async (_req, res) => {
  try {
    const [mode, timezone] = await Promise.all([policy.getRuntimeMode(), policy.getTimezone()]);
    res.json({ version: 'v3.3', mode, timezone, event_model: 'append-only', corrections: 'non-destructive' });
  } catch (error) { errorResponse(res, error); }
});

router.get('/me/status', async (req, res) => {
  try {
    const employeId = await selfEmployeId(req.user.id);
    if (!employeId) return res.status(409).json({ error: 'Compte non lié à une fiche agent active', code: 'USER_NOT_LINKED_TO_EMPLOYE' });
    const timezone = await policy.getTimezone();
    const parts = engine.utcParts(new Date(), timezone);
    const latest = await latestEvent(employeId);
    const workDate = latest && latest.event_type !== 'clock_out' ? latest.work_date : parts.localDate;
    const events = await db.query(
      `SELECT id, event_type, occurred_at_utc, local_date, work_date, local_time,
              timezone_name, source, mode, site_code, hors_perimetre
       FROM pointeuse_events WHERE employe_id = ? AND work_date = ?
       ORDER BY occurred_at_utc, id`,
      [employeId, workDate]
    );
    const last = events[events.length - 1] || null;
    const allowed = engine.TRANSITIONS[last && last.event_type !== 'clock_out' ? last.event_type : 'empty'] || [];
    const assignment = await policy.activeAssignment(db, employeId, workDate);
    const calendar = await policy.calendarDay(db, assignment, workDate);
    const persistedSummary = await db.queryOne(
      'SELECT * FROM pointeuse_daily_summaries WHERE employe_id = ? AND work_date = ?',
      [employeId, workDate]
    );
    res.json({
      employe_id: employeId,
      work_date: workDate,
      local_date: parts.localDate,
      last_event: last,
      allowed_events: allowed,
      summary: persistedSummary || engine.calculateDay(events),
      assignment,
      calendar,
    });
  } catch (error) { errorResponse(res, error); }
});

router.post('/events', async (req, res) => {
  try {
    const runtimeMode = await policy.getRuntimeMode();
    if (runtimeMode === 'disabled') return res.status(503).json({ error: 'Pointeuse V3 désactivée', code: 'ATTENDANCE_V3_DISABLED' });
    if (runtimeMode !== 'active') return res.status(409).json({ error: 'Pointeuse V3 en mode observation', code: 'ATTENDANCE_V3_NOT_ACTIVE' });

    const employeId = await selfEmployeId(req.user.id);
    if (!employeId) return res.status(409).json({ error: 'Compte non lié à une fiche agent active', code: 'USER_NOT_LINKED_TO_EMPLOYE' });

    const eventType = req.body?.event_type;
    const mode = req.body?.mode || 'bureau';
    const timezone = await policy.getTimezone();
    const now = new Date();
    const nowParts = engine.utcParts(now, timezone);
    const previous = await latestEvent(employeId);
    const workDate = previous && previous.event_type !== 'clock_out' ? previous.work_date : nowParts.localDate;
    const assignment = await policy.activeAssignment(db, employeId, workDate);
    if (!policy.modeAllowed(assignment, mode)) {
      return res.status(403).json({ error: `Mode ${mode} non autorisé pour le planning actif`, code: 'ATTENDANCE_MODE_NOT_AUTHORIZED' });
    }

    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key;
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key requis', code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const location = await policy.evaluateLocation(db, {
      siteCode: assignment?.site_code || null,
      latitude: req.body?.latitude,
      longitude: req.body?.longitude,
      precisionGps: req.body?.precision_gps,
    });

    const result = await engine.recordEvent({
      employeId,
      eventType,
      source: 'web',
      mode,
      timezone,
      utcOffsetMinutes: policy.utcOffsetMinutes(now, timezone),
      siteCode: assignment?.site_code || null,
      deviceId: req.get('X-Device-Id') || null,
      sessionId: req.get('X-Session-Id') || null,
      idempotencyKey,
      ipAddress: clientIp(req),
      latitude: req.body?.latitude ?? null,
      longitude: req.body?.longitude ?? null,
      precisionGps: req.body?.precision_gps ?? null,
      horsPerimetre: location.outside ? 1 : 0,
      payload: {
        client_build: req.get('X-Client-Build') || null,
        geofence_distance_m: location.distance_m,
        runtime_mode: runtimeMode,
      },
      createdBy: req.user.id,
      now,
    });

    let calculated = null;
    if (!result.idempotentReplay) calculated = await daily.recalculateDay(employeId, result.event.work_date);
    res.status(result.idempotentReplay ? 200 : 201).json({
      ...result.event,
      idempotent_replay: result.idempotentReplay,
      geofence: { outside: location.outside, distance_m: location.distance_m },
      daily: calculated,
    });
  } catch (error) { errorResponse(res, error); }
});

router.get('/me/events', async (req, res) => {
  try {
    const employeId = await selfEmployeId(req.user.id);
    if (!employeId) return res.status(409).json({ error: 'Compte non lié à une fiche agent active', code: 'USER_NOT_LINKED_TO_EMPLOYE' });
    const debut = req.query.debut || new Date().toISOString().slice(0, 10);
    const fin = req.query.fin || debut;
    const rows = await db.query(
      `SELECT id, event_type, occurred_at_utc, local_date, work_date, local_time, timezone_name, source, mode, site_code, hors_perimetre
       FROM pointeuse_events WHERE employe_id = ? AND work_date BETWEEN ? AND ?
       ORDER BY occurred_at_utc, id`,
      [employeId, debut, fin]
    );
    res.json({ employe_id: employeId, debut, fin, events: rows });
  } catch (error) { errorResponse(res, error); }
});

router.post('/corrections', async (req, res) => {
  try {
    const employeId = await selfEmployeId(req.user.id);
    if (!employeId) return res.status(409).json({ error: 'Compte non lié à une fiche agent active', code: 'USER_NOT_LINKED_TO_EMPLOYE' });
    const { work_date, event_id, requested_event_type, requested_at_utc, reason, evidence_url } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(work_date || ''))) return res.status(400).json({ error: 'work_date invalide', code: 'INVALID_WORK_DATE' });
    if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'Motif de correction requis (5 caractères minimum)', code: 'CORRECTION_REASON_REQUIRED' });
    if (requested_event_type && !engine.EVENT_TYPES.includes(requested_event_type)) return res.status(400).json({ error: 'requested_event_type invalide', code: 'INVALID_EVENT_TYPE' });
    const closed = await db.queryOne('SELECT id FROM pointeuse_daily_summaries WHERE employe_id=? AND work_date=? AND status=\'closed\'', [employeId, work_date]);
    if (closed) return res.status(409).json({ error: 'Journée clôturée : correction interdite sans réouverture formelle', code: 'DAY_CLOSED' });
    if (event_id) {
      const owned = await db.queryOne('SELECT id FROM pointeuse_events WHERE id = ? AND employe_id = ?', [event_id, employeId]);
      if (!owned) return res.status(404).json({ error: 'Événement introuvable', code: 'EVENT_NOT_FOUND' });
    }
    const r = await db.execute(
      `INSERT INTO pointeuse_correction_requests
       (employe_id, work_date, event_id, requested_event_type, requested_at_utc, reason, evidence_url, status, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`,
      [employeId, work_date, event_id || null, requested_event_type || null, requested_at_utc || null, String(reason).trim(), evidence_url || null, req.user.id]
    );
    res.status(201).json({ id: r.insertId, status: 'submitted' });
  } catch (error) { errorResponse(res, error); }
});

router.get('/anomalies', async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const status = req.query.status || null;
    const params = [];
    let where = '1=1';
    if (status) { where += ' AND a.status = ?'; params.push(status); }
    const rows = await db.query(
      `SELECT a.*, e.nom, e.prenom, e.matricule FROM pointeuse_anomalies a
       JOIN employes e ON e.id = a.employe_id WHERE ${where}
       ORDER BY FIELD(a.severity, 'critical','warning','info'), a.work_date DESC, a.id DESC LIMIT 500`, params
    );
    res.json({ anomalies: rows });
  } catch (error) { errorResponse(res, error); }
});

router.post('/days/:workDate/recalculate', async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const employeId = Number(req.body?.employe_id);
    if (!Number.isInteger(employeId) || employeId <= 0) return res.status(400).json({ error: 'employe_id invalide' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.workDate)) return res.status(400).json({ error: 'workDate invalide' });
    res.json(await daily.recalculateDay(employeId, req.params.workDate));
  } catch (error) { errorResponse(res, error); }
});

router.post('/periods/:id/close', async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const period = await db.queryOne('SELECT * FROM pointeuse_periods WHERE id = ?', [req.params.id]);
    if (!period) return res.status(404).json({ error: 'Période introuvable' });
    if (period.status !== 'approved') return res.status(409).json({ error: 'La période doit être approuvée avant clôture', code: 'PERIOD_NOT_APPROVED' });
    const unresolved = await db.queryOne(
      `SELECT COUNT(*) AS n FROM pointeuse_anomalies
       WHERE work_date BETWEEN ? AND ? AND status NOT IN ('approved','regularized','dismissed')`,
      [period.date_debut, period.date_fin]
    );
    if (Number(unresolved?.n || 0) > 0) return res.status(409).json({ error: 'Des anomalies non résolues empêchent la clôture', code: 'UNRESOLVED_ANOMALIES', count: Number(unresolved.n) });
    await db.transaction(async tx => {
      const r = await tx.execute(
        `UPDATE pointeuse_periods SET status='closed', closed_by=?, closed_at=NOW()
         WHERE id=? AND status='approved'`, [req.user.id, period.id]
      );
      if (!r.affectedRows) {
        const err = new Error('État de période modifié concurremment'); err.code = 'PERIOD_STATE_RACE'; err.status = 409; throw err;
      }
      await tx.execute(
        `UPDATE pointeuse_daily_summaries SET status='closed', closed_at=NOW()
         WHERE work_date BETWEEN ? AND ? AND status='approved'`,
        [period.date_debut, period.date_fin]
      );
    });
    res.json({ id: period.id, status: 'closed' });
  } catch (error) { errorResponse(res, error); }
});

module.exports = router;
