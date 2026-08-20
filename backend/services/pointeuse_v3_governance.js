'use strict';

const crypto = require('crypto');
const db = require('../db');

function attendanceError(message, code, status = 400, details) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function appendAudit(tx, { aggregateType, aggregateId, action, actorUserId, correlationId, before = null, after = null, metadata = null }) {
  const previous = await tx.queryOne(
    `SELECT event_hash FROM pointeuse_audit_events
     WHERE aggregate_type = ? AND aggregate_id = ?
     ORDER BY id DESC LIMIT 1`,
    [aggregateType, String(aggregateId)]
  );
  const payload = {
    aggregate_type: aggregateType,
    aggregate_id: String(aggregateId),
    action,
    actor_user_id: actorUserId || null,
    correlation_id: correlationId,
    before,
    after,
    metadata,
    previous_hash: previous?.event_hash || null,
  };
  const eventHash = sha256(stableJson(payload));
  const r = await tx.execute(
    `INSERT INTO pointeuse_audit_events
     (aggregate_type, aggregate_id, action, actor_user_id, correlation_id,
      before_json, after_json, metadata_json, previous_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      aggregateType,
      String(aggregateId),
      action,
      actorUserId || null,
      correlationId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      metadata ? JSON.stringify(metadata) : null,
      previous?.event_hash || null,
      eventHash,
    ]
  );
  return { id: r.insertId, event_hash: eventHash, previous_hash: previous?.event_hash || null };
}

function deriveAdjustment(request) {
  const target = request.event_id ? Number(request.event_id) : null;
  const hasReplacement = Boolean(request.requested_event_type && request.requested_at_utc);
  if (target && hasReplacement) return 'replace';
  if (target && !hasReplacement) return 'void';
  if (!target && hasReplacement) return 'add';
  throw attendanceError(
    'Correction incomplète : fournir un événement cible à annuler ou un type+horaire corrigé',
    'INVALID_CORRECTION_SHAPE',
    409
  );
}

async function reviewCorrection({ requestId, reviewerUserId, decision, reviewReason, correlationId }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw attendanceError('Décision de correction invalide', 'INVALID_CORRECTION_DECISION', 400);
  }
  if (!reviewReason || String(reviewReason).trim().length < 5) {
    throw attendanceError('Motif de revue requis', 'CORRECTION_REVIEW_REASON_REQUIRED', 400);
  }
  const cid = correlationId || crypto.randomUUID();
  return db.transaction(async tx => {
    const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
    const request = await tx.queryOne(`SELECT * FROM pointeuse_correction_requests WHERE id = ?${forUpdate}`, [requestId]);
    if (!request) throw attendanceError('Demande de correction introuvable', 'CORRECTION_NOT_FOUND', 404);
    if (request.status !== 'submitted') throw attendanceError('Cette correction a déjà été traitée', 'CORRECTION_ALREADY_REVIEWED', 409);
    if (Number(request.requested_by) === Number(reviewerUserId)) {
      throw attendanceError('Le demandeur ne peut pas approuver sa propre correction', 'CORRECTION_SELF_APPROVAL_FORBIDDEN', 403);
    }

    const before = { status: request.status, reviewed_by: request.reviewed_by || null };
    if (decision === 'rejected') {
      const r = await tx.execute(
        `UPDATE pointeuse_correction_requests
         SET status='rejected', reviewed_by=?, review_reason=?, reviewed_at=NOW(), correlation_id=?
         WHERE id=? AND status='submitted'`,
        [reviewerUserId, String(reviewReason).trim(), cid, request.id]
      );
      if (Number(r.affectedRows || 0) !== 1) throw attendanceError('Conflit de revue concurrente', 'CORRECTION_REVIEW_RACE', 409);
      await appendAudit(tx, {
        aggregateType: 'correction_request', aggregateId: request.id, action: 'correction.rejected',
        actorUserId: reviewerUserId, correlationId: cid, before, after: { status: 'rejected' },
        metadata: { review_reason: String(reviewReason).trim() },
      });
      return { id: request.id, status: 'rejected', correlation_id: cid };
    }

    const closedDay = await tx.queryOne(
      `SELECT id FROM pointeuse_daily_summaries
       WHERE employe_id = ? AND work_date = ? AND status = 'closed'${forUpdate}`,
      [request.employe_id, request.work_date]
    );
    if (closedDay) {
      throw attendanceError('Journée clôturée : correction interdite sans réouverture formelle', 'DAY_CLOSED', 409);
    }
    const closedPeriod = await tx.queryOne(
      `SELECT id FROM pointeuse_periods
       WHERE ? BETWEEN date_debut AND date_fin AND status = 'closed'
       ORDER BY id DESC LIMIT 1${forUpdate}`,
      [request.work_date]
    );
    if (closedPeriod) {
      throw attendanceError('Période clôturée : correction interdite sans réouverture formelle', 'PERIOD_CLOSED', 409);
    }

    const operation = deriveAdjustment(request);
    const adjustment = await tx.execute(
      `INSERT INTO pointeuse_adjustments
       (employe_id, work_date, correction_request_id, operation, target_event_id,
        effective_event_type, effective_at_utc, timezone_name, reason, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Africa/Brazzaville', ?, ?)`,
      [
        request.employe_id,
        request.work_date,
        request.id,
        operation,
        request.event_id || null,
        request.requested_event_type || null,
        request.requested_at_utc || null,
        String(reviewReason).trim(),
        reviewerUserId,
      ]
    );
    const upd = await tx.execute(
      `UPDATE pointeuse_correction_requests
       SET status='applied', reviewed_by=?, review_reason=?, reviewed_at=NOW(),
           applied_adjustment_id=?, correlation_id=?
       WHERE id=? AND status='submitted'`,
      [reviewerUserId, String(reviewReason).trim(), adjustment.insertId, cid, request.id]
    );
    if (Number(upd.affectedRows || 0) !== 1) throw attendanceError('Conflit de revue concurrente', 'CORRECTION_REVIEW_RACE', 409);

    await appendAudit(tx, {
      aggregateType: 'correction_request', aggregateId: request.id, action: 'correction.applied',
      actorUserId: reviewerUserId, correlationId: cid, before,
      after: { status: 'applied', adjustment_id: adjustment.insertId, operation },
      metadata: { work_date: request.work_date, employe_id: request.employe_id },
    });
    return { id: request.id, status: 'applied', adjustment_id: adjustment.insertId, operation, correlation_id: cid };
  });
}

async function effectiveEvents(executor, employeId, workDate) {
  const physical = await executor.query(
    `SELECT id, employe_id, event_type, occurred_at_utc, work_date, timezone_name, source, mode
     FROM pointeuse_events
     WHERE employe_id = ? AND work_date = ?
     ORDER BY occurred_at_utc, id`,
    [employeId, workDate]
  );
  const adjustments = await executor.query(
    `SELECT id, operation, target_event_id, effective_event_type, effective_at_utc, timezone_name
     FROM pointeuse_adjustments
     WHERE employe_id = ? AND work_date = ?
     ORDER BY id`,
    [employeId, workDate]
  );
  const byId = new Map(physical.map(e => [Number(e.id), { ...e }]));
  const added = [];
  for (const a of adjustments) {
    if (a.operation === 'void') byId.delete(Number(a.target_event_id));
    if (a.operation === 'replace') {
      byId.delete(Number(a.target_event_id));
      added.push({
        id: `adj-${a.id}`,
        employe_id: employeId,
        event_type: a.effective_event_type,
        occurred_at_utc: a.effective_at_utc,
        work_date: workDate,
        timezone_name: a.timezone_name,
        source: 'rh',
        mode: 'bureau',
        adjustment_id: a.id,
      });
    }
    if (a.operation === 'add') {
      added.push({
        id: `adj-${a.id}`,
        employe_id: employeId,
        event_type: a.effective_event_type,
        occurred_at_utc: a.effective_at_utc,
        work_date: workDate,
        timezone_name: a.timezone_name,
        source: 'rh',
        mode: 'bureau',
        adjustment_id: a.id,
      });
    }
  }
  return [...byId.values(), ...added].sort((a, b) => String(a.occurred_at_utc).localeCompare(String(b.occurred_at_utc)) || String(a.id).localeCompare(String(b.id)));
}

async function preparePayrollSnapshot({ periodId, preparedBy, correlationId }) {
  const cid = correlationId || crypto.randomUUID();
  return db.transaction(async tx => {
    const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
    const period = await tx.queryOne(`SELECT * FROM pointeuse_periods WHERE id=?${forUpdate}`, [periodId]);
    if (!period) throw attendanceError('Période introuvable', 'PERIOD_NOT_FOUND', 404);
    if (period.status !== 'closed') throw attendanceError('La période doit être clôturée avant préparation paie', 'PERIOD_NOT_CLOSED', 409);
    const unresolved = await tx.queryOne(
      `SELECT COUNT(*) AS n FROM pointeuse_anomalies
       WHERE work_date BETWEEN ? AND ? AND status NOT IN ('approved','regularized','dismissed')`,
      [period.date_debut, period.date_fin]
    );
    if (Number(unresolved?.n || 0) > 0) throw attendanceError('Anomalies non résolues', 'UNRESOLVED_ANOMALIES', 409, { count: Number(unresolved.n) });

    const rows = await tx.query(
      `SELECT s.employe_id, e.matricule, e.nom, e.prenom,
              SUM(s.worked_minutes) AS worked_minutes,
              SUM(s.break_minutes) AS break_minutes,
              SUM(s.late_minutes) AS late_minutes,
              SUM(s.early_leave_minutes) AS early_leave_minutes,
              SUM(s.overtime_minutes) AS overtime_minutes,
              SUM(s.night_minutes) AS night_minutes,
              SUM(s.anomaly_count) AS anomaly_count
       FROM pointeuse_daily_summaries s
       JOIN employes e ON e.id=s.employe_id
       WHERE s.work_date BETWEEN ? AND ? AND s.status='closed'
       GROUP BY s.employe_id, e.matricule, e.nom, e.prenom
       ORDER BY e.matricule, s.employe_id`,
      [period.date_debut, period.date_fin]
    );
    const payload = {
      schema: 'tala.pointeuse.payroll-feed.v1',
      period: { id: period.id, date_debut: period.date_debut, date_fin: period.date_fin, calc_version: period.calc_version },
      employees: rows.map(r => ({
        employe_id: Number(r.employe_id), matricule: r.matricule, nom: r.nom, prenom: r.prenom,
        worked_minutes: Number(r.worked_minutes || 0), break_minutes: Number(r.break_minutes || 0),
        late_minutes: Number(r.late_minutes || 0), early_leave_minutes: Number(r.early_leave_minutes || 0),
        overtime_minutes: Number(r.overtime_minutes || 0), night_minutes: Number(r.night_minutes || 0),
        anomaly_count: Number(r.anomaly_count || 0),
      })),
    };
    const canonical = stableJson(payload);
    const digest = sha256(canonical);
    const totals = payload.employees.reduce((a, e) => {
      a.worked += e.worked_minutes; a.overtime += e.overtime_minutes; a.night += e.night_minutes; return a;
    }, { worked: 0, overtime: 0, night: 0 });

    const existing = await tx.queryOne(
      `SELECT id, status FROM pointeuse_payroll_snapshots WHERE period_id=? AND snapshot_sha256=?`,
      [period.id, digest]
    );
    if (existing) return { id: existing.id, status: existing.status, snapshot_sha256: digest, idempotent_replay: true, payload };

    await tx.execute(`UPDATE pointeuse_payroll_snapshots SET status='superseded' WHERE period_id=? AND status='prepared'`, [period.id]);
    const r = await tx.execute(
      `INSERT INTO pointeuse_payroll_snapshots
       (period_id, calc_version, snapshot_sha256, payload_json, employee_count,
        total_worked_minutes, total_overtime_minutes, total_night_minutes, status, prepared_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
      [period.id, period.calc_version || 'v3.1', digest, JSON.stringify(payload), payload.employees.length, totals.worked, totals.overtime, totals.night, preparedBy]
    );
    await appendAudit(tx, {
      aggregateType: 'pointeuse_period', aggregateId: period.id, action: 'payroll_snapshot.prepared',
      actorUserId: preparedBy, correlationId: cid, before: null,
      after: { snapshot_id: r.insertId, snapshot_sha256: digest, employee_count: payload.employees.length },
      metadata: totals,
    });
    return { id: r.insertId, status: 'prepared', snapshot_sha256: digest, idempotent_replay: false, payload };
  });
}

async function consumePayrollSnapshot({ snapshotId, consumedBy, correlationId }) {
  const cid = correlationId || crypto.randomUUID();
  return db.transaction(async tx => {
    const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
    const snap = await tx.queryOne(`SELECT * FROM pointeuse_payroll_snapshots WHERE id=?${forUpdate}`, [snapshotId]);
    if (!snap) throw attendanceError('Snapshot paie introuvable', 'PAYROLL_SNAPSHOT_NOT_FOUND', 404);
    if (snap.status === 'consumed') return { id: snap.id, status: 'consumed', idempotent_replay: true };
    if (snap.status !== 'prepared') throw attendanceError('Snapshot non consommable', 'PAYROLL_SNAPSHOT_NOT_PREPARED', 409);
    const r = await tx.execute(
      `UPDATE pointeuse_payroll_snapshots SET status='consumed', consumed_by=?, consumed_at=NOW()
       WHERE id=? AND status='prepared'`,
      [consumedBy, snap.id]
    );
    if (Number(r.affectedRows || 0) !== 1) throw attendanceError('Conflit de consommation paie', 'PAYROLL_SNAPSHOT_RACE', 409);
    await appendAudit(tx, {
      aggregateType: 'payroll_snapshot', aggregateId: snap.id, action: 'payroll_snapshot.consumed',
      actorUserId: consumedBy, correlationId: cid, before: { status: snap.status }, after: { status: 'consumed' },
      metadata: { period_id: snap.period_id, snapshot_sha256: snap.snapshot_sha256 },
    });
    return { id: snap.id, status: 'consumed', idempotent_replay: false };
  });
}

module.exports = {
  stableJson,
  sha256,
  deriveAdjustment,
  appendAudit,
  reviewCorrection,
  effectiveEvents,
  preparePayrollSnapshot,
  consumePayrollSnapshot,
};
