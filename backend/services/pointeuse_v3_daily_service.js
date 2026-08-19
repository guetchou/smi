'use strict';

const db = require('../db');
const engine = require('./pointeuse_v3_engine');

function hhmmMinutes(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localEventMinutes(event) {
  return hhmmMinutes(event?.local_time);
}

function scheduleMetrics(events, schedule, summary) {
  const anomalies = [...summary.anomalies];
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  let overtimeMinutes = 0;

  if (schedule && events.length) {
    const firstIn = events.find(e => e.event_type === 'clock_in');
    const lastOut = [...events].reverse().find(e => e.event_type === 'clock_out');
    const start = hhmmMinutes(schedule.heure_debut);
    const end = hhmmMinutes(schedule.heure_fin);
    const inMin = localEventMinutes(firstIn);
    const outMinRaw = localEventMinutes(lastOut);
    const overnight = Number(schedule.nuit_traverse_minuit || 0) === 1;
    const expectedEnd = overnight && end !== null && start !== null && end <= start ? end + 1440 : end;
    let outMin = outMinRaw;
    if (overnight && outMin !== null && start !== null && outMin < start) outMin += 1440;

    if (start !== null && inMin !== null) {
      lateMinutes = Math.max(0, inMin - start - Number(schedule.tolerance_retard_minutes || 0));
      if (lateMinutes > 0) anomalies.push({ type: 'late', minutes: lateMinutes });
    }
    if (expectedEnd !== null && outMin !== null) {
      earlyLeaveMinutes = Math.max(0, expectedEnd - outMin - Number(schedule.tolerance_depart_minutes || 0));
      if (earlyLeaveMinutes > 0) anomalies.push({ type: 'early_leave', minutes: earlyLeaveMinutes });
    }

    const nominal = start !== null && expectedEnd !== null
      ? Math.max(0, expectedEnd - start - Number(schedule.pause_minutes || 0))
      : 0;
    overtimeMinutes = Math.max(0, summary.workedMinutes - nominal);
  }

  if (summary.workedMinutes > 16 * 60) anomalies.push({ type: 'excessive_duration', minutes: summary.workedMinutes });

  return { lateMinutes, earlyLeaveMinutes, overtimeMinutes, anomalies };
}

function severityFor(type) {
  if (['missing_in','missing_out','overlap','remote_not_authorized'].includes(type)) return 'critical';
  if (['late','early_leave','missing_break_end','outside_geofence','excessive_duration','insufficient_duration'].includes(type)) return 'warning';
  return 'info';
}

async function activeSchedule(tx, employeId, workDate) {
  return tx.queryOne(
    `SELECT s.*, a.id AS assignment_id, a.site_code, a.mode_autorise
     FROM pointeuse_schedule_assignments a
     JOIN pointeuse_work_schedules s ON s.id = a.schedule_id AND s.actif = 1
     WHERE a.employe_id = ? AND a.date_debut <= ?
       AND (a.date_fin IS NULL OR a.date_fin >= ?)
     ORDER BY a.date_debut DESC, a.id DESC LIMIT 1`,
    [employeId, workDate, workDate]
  );
}

async function recalculateDay(employeId, workDate) {
  return db.transaction(async tx => {
    const events = await tx.query(
      `SELECT id, employe_id, event_type, occurred_at_utc, local_date, work_date, local_time,
              timezone_name, source, mode, site_code, hors_perimetre
       FROM pointeuse_events
       WHERE employe_id = ? AND work_date = ?
       ORDER BY occurred_at_utc, id`,
      [employeId, workDate]
    );
    const schedule = await activeSchedule(tx, employeId, workDate);
    const base = engine.calculateDay(events);
    const metrics = scheduleMetrics(events, schedule, base);

    const existing = await tx.queryOne(
      'SELECT id, status FROM pointeuse_daily_summaries WHERE employe_id = ? AND work_date = ?',
      [employeId, workDate]
    );
    if (existing?.status === 'closed') {
      const err = new Error('Journée clôturée : recalcul interdit');
      err.code = 'DAY_CLOSED';
      err.status = 409;
      throw err;
    }

    const status = metrics.anomalies.length ? 'exception' : 'calculated';
    await tx.execute(
      `INSERT INTO pointeuse_daily_summaries
       (employe_id, work_date, schedule_id, first_in_utc, last_out_utc, worked_minutes,
        break_minutes, late_minutes, early_leave_minutes, overtime_minutes, night_minutes,
        status, anomaly_count, calc_version, calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'v3.2', NOW())
       ON DUPLICATE KEY UPDATE
         schedule_id=VALUES(schedule_id), first_in_utc=VALUES(first_in_utc), last_out_utc=VALUES(last_out_utc),
         worked_minutes=VALUES(worked_minutes), break_minutes=VALUES(break_minutes), late_minutes=VALUES(late_minutes),
         early_leave_minutes=VALUES(early_leave_minutes), overtime_minutes=VALUES(overtime_minutes),
         status=VALUES(status), anomaly_count=VALUES(anomaly_count), calc_version='v3.2', calculated_at=NOW()`,
      [employeId, workDate, schedule?.id || null, base.firstInUtc, base.lastOutUtc, base.workedMinutes,
       base.breakMinutes, metrics.lateMinutes, metrics.earlyLeaveMinutes, metrics.overtimeMinutes,
       status, metrics.anomalies.length]
    );

    const daily = await tx.queryOne(
      'SELECT id FROM pointeuse_daily_summaries WHERE employe_id = ? AND work_date = ?',
      [employeId, workDate]
    );
    await tx.execute(
      `DELETE FROM pointeuse_anomalies
       WHERE employe_id = ? AND work_date = ? AND status IN ('detected','to_justify')`,
      [employeId, workDate]
    );
    for (const anomaly of metrics.anomalies) {
      await tx.execute(
        `INSERT INTO pointeuse_anomalies
         (employe_id, work_date, daily_summary_id, anomaly_type, severity, status, details_json)
         VALUES (?, ?, ?, ?, ?, 'detected', ?)`,
        [employeId, workDate, daily?.id || null, anomaly.type, severityFor(anomaly.type), JSON.stringify(anomaly)]
      );
    }

    return {
      employe_id: employeId,
      work_date: workDate,
      status,
      summary: { ...base, ...metrics },
      schedule_id: schedule?.id || null,
    };
  });
}

module.exports = { hhmmMinutes, scheduleMetrics, severityFor, recalculateDay };
