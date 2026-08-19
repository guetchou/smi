'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const governance = require('../services/pointeuse_v3_governance');

const router = express.Router();

function managerOnly(req, res, next) {
  if (!hasRole(req.user, 'admin', 'dg', 'rh')) return res.status(403).json({ error: 'Accès RH/DG/admin requis', code: 'ATTENDANCE_MANAGER_REQUIRED' });
  next();
}

function payrollOnly(req, res, next) {
  if (!hasRole(req.user, 'admin', 'dg', 'rh', 'finance')) return res.status(403).json({ error: 'Accès paie/finance requis', code: 'ATTENDANCE_PAYROLL_ROLE_REQUIRED' });
  next();
}

function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[pointeuse-v3-governance]', error);
  return res.status(status).json({
    error: status >= 500 ? 'Erreur interne de gouvernance des temps' : error.message,
    code: error.code || (status >= 500 ? 'ATTENDANCE_GOVERNANCE_INTERNAL_ERROR' : 'ATTENDANCE_GOVERNANCE_REJECTED'),
    details: status < 500 ? error.details || undefined : undefined,
  });
}

router.get('/corrections', managerOnly, async (req, res) => {
  try {
    const status = req.query.status || 'submitted';
    const rows = await db.query(
      `SELECT c.*, e.matricule, e.nom, e.prenom,
              u.nom AS requested_by_name, r.nom AS reviewed_by_name
       FROM pointeuse_correction_requests c
       JOIN employes e ON e.id=c.employe_id
       LEFT JOIN users u ON u.id=c.requested_by
       LEFT JOIN users r ON r.id=c.reviewed_by
       WHERE (? = 'all' OR c.status = ?)
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT 500`,
      [status, status]
    );
    res.json({ status, corrections: rows });
  } catch (error) { fail(res, error); }
});

router.post('/corrections/:id/review', managerOnly, async (req, res) => {
  try {
    const result = await governance.reviewCorrection({
      requestId: Number(req.params.id),
      reviewerUserId: req.user.id,
      decision: req.body?.decision,
      reviewReason: req.body?.reason,
      correlationId: req.get('X-Correlation-Id') || undefined,
    });
    res.json(result);
  } catch (error) { fail(res, error); }
});

router.post('/periods/:id/payroll-snapshot', payrollOnly, async (req, res) => {
  try {
    const result = await governance.preparePayrollSnapshot({
      periodId: Number(req.params.id),
      preparedBy: req.user.id,
      correlationId: req.get('X-Correlation-Id') || undefined,
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) { fail(res, error); }
});

router.get('/payroll-snapshots/:id', payrollOnly, async (req, res) => {
  try {
    const row = await db.queryOne(
      `SELECT id, period_id, calc_version, snapshot_sha256, payload_json, employee_count,
              total_worked_minutes, total_overtime_minutes, total_night_minutes,
              status, prepared_by, prepared_at, consumed_by, consumed_at
       FROM pointeuse_payroll_snapshots WHERE id=?`,
      [Number(req.params.id)]
    );
    if (!row) return res.status(404).json({ error: 'Snapshot paie introuvable', code: 'PAYROLL_SNAPSHOT_NOT_FOUND' });
    let payload = row.payload_json;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) {}
    }
    res.json({ ...row, payload_json: payload });
  } catch (error) { fail(res, error); }
});

router.post('/payroll-snapshots/:id/consume', payrollOnly, async (req, res) => {
  try {
    const result = await governance.consumePayrollSnapshot({
      snapshotId: Number(req.params.id),
      consumedBy: req.user.id,
      correlationId: req.get('X-Correlation-Id') || undefined,
    });
    res.json(result);
  } catch (error) { fail(res, error); }
});

router.get('/audit', managerOnly, async (req, res) => {
  try {
    const aggregateType = req.query.aggregate_type || null;
    const aggregateId = req.query.aggregate_id || null;
    const params = [];
    let where = '1=1';
    if (aggregateType) { where += ' AND a.aggregate_type=?'; params.push(aggregateType); }
    if (aggregateId) { where += ' AND a.aggregate_id=?'; params.push(String(aggregateId)); }
    const rows = await db.query(
      `SELECT a.id, a.aggregate_type, a.aggregate_id, a.action, a.actor_user_id,
              a.correlation_id, a.previous_hash, a.event_hash, a.created_at,
              u.nom AS actor_name, u.email AS actor_email
       FROM pointeuse_audit_events a
       LEFT JOIN users u ON u.id=a.actor_user_id
       WHERE ${where}
       ORDER BY a.id DESC
       LIMIT 1000`,
      params
    );
    res.json({ audit: rows });
  } catch (error) { fail(res, error); }
});

module.exports = router;
