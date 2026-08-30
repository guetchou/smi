'use strict';

const db = require('../db');
const engine = require('./pointeuse_v3_engine');
const governance = require('./pointeuse_v3_governance');
const policy = require('./pointeuse_v3_policy');

const DEFAULT_PAUSE_SEUIL_MINUTES = 360;

function hhmmMinutes(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function localEventMinutes(event) { return hhmmMinutes(event?.local_time); }
function localMinuteFromUtc(utcText, offsetMinutes) {
  const t = new Date(`${String(utcText).replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + Number(offsetMinutes || 0) * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}
function minutesInNightWindow(startUtc, endUtc, offsetMinutes, nightStart = '22:00', nightEnd = '05:00') {
  const startMs = new Date(`${String(startUtc).replace(' ', 'T')}Z`).getTime();
  const endMs = new Date(`${String(endUtc).replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const ns = hhmmMinutes(nightStart), ne = hhmmMinutes(nightEnd);
  if (ns === null || ne === null) return 0;
  let count = 0;
  for (let t = startMs; t < endMs; t += 60000) {
    const d = new Date(t + Number(offsetMinutes || 0) * 60000);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const inNight = ns <= ne ? (m >= ns && m < ne) : (m >= ns || m < ne);
    if (inNight) count++;
  }
  return count;
}
function workedSegments(events) {
  const ordered = [...events].sort((a, b) => String(a.occurred_at_utc).localeCompare(String(b.occurred_at_utc)) || String(a.id).localeCompare(String(b.id)));
  let active = null; const segments = [];
  for (const event of ordered) {
    if (event.event_type === 'clock_in' || event.event_type === 'break_end') active = event;
    if ((event.event_type === 'break_start' || event.event_type === 'clock_out') && active) { segments.push([active, event]); active = null; }
  }
  return segments;
}
function nightMinutes(events, schedule) {
  if (!schedule) return 0;
  return workedSegments(events).reduce((sum, [a, b]) => sum + minutesInNightWindow(a.occurred_at_utc, b.occurred_at_utc, a.utc_offset_minutes ?? 60, schedule.nuit_debut || '22:00', schedule.nuit_fin || '05:00'), 0);
}
function autoDeductedBreakMinutes(schedule, summary, isWorkingDay) {
  if (!schedule || !isWorkingDay) return 0;
  if (Number(schedule.pause_auto_deduction ?? 1) !== 1) return 0;
  const pause = Number(schedule.pause_minutes || 0);
  if (pause <= 0) return 0;
  const seuil = Number(schedule.pause_seuil_minutes ?? DEFAULT_PAUSE_SEUIL_MINUTES);
  const worked = Number(summary.workedMinutes || 0);
  if (worked <= seuil) return 0;
  const declared = Number(summary.breakMinutes || 0);
  return Math.max(0, Math.min(pause - declared, worked));
}

function scheduleMetrics(events, schedule, summary, calendar, leave = null) {
  const anomalies = [...summary.anomalies];
  let lateMinutes = 0, earlyLeaveMinutes = 0, overtimeMinutes = 0;
  const onLeave = !!leave;
  const isWorkingDay = !onLeave && (!calendar || ['workday', 'exception'].includes(calendar.day_type));
  const breakAutoMinutes = autoDeductedBreakMinutes(schedule, summary, isWorkingDay);
  const workedNetMinutes = Math.max(0, Number(summary.workedMinutes || 0) - breakAutoMinutes);
  if (!isWorkingDay && events.length) {
    anomalies.push({
      type: 'outside_schedule',
      day_type: onLeave ? 'conge' : calendar?.day_type ?? null,
      label: onLeave ? (leave.type_conge || null) : (calendar?.libelle || null),
    });
  }
  if (schedule && isWorkingDay && events.length === 0) anomalies.push({ type: 'missing_in', reason: 'no_attendance_on_scheduled_day' });
  if (schedule && events.length && isWorkingDay) {
    const firstIn = events.find(e => e.event_type === 'clock_in');
    const lastOut = [...events].reverse().find(e => e.event_type === 'clock_out');
    const start = hhmmMinutes(schedule.heure_debut), end = hhmmMinutes(schedule.heure_fin);
    const inMin = firstIn?.local_time ? localEventMinutes(firstIn) : localMinuteFromUtc(firstIn?.occurred_at_utc, firstIn?.utc_offset_minutes ?? 60);
    const outMinRaw = lastOut?.local_time ? localEventMinutes(lastOut) : localMinuteFromUtc(lastOut?.occurred_at_utc, lastOut?.utc_offset_minutes ?? 60);
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
    const nominalDefault = start !== null && expectedEnd !== null ? Math.max(0, expectedEnd - start - Number(schedule.pause_minutes || 0)) : 0;
    const nominal = calendar?.scheduled_minutes_override !== null && calendar?.scheduled_minutes_override !== undefined ? Number(calendar.scheduled_minutes_override) : nominalDefault;
    overtimeMinutes = Math.max(0, workedNetMinutes - Math.max(0, nominal));
  }
  const maxDuration = Number(schedule?.max_duree_minutes || 960);
  const minDuration = schedule?.min_duree_minutes == null ? null : Number(schedule.min_duree_minutes);
  if (workedNetMinutes > maxDuration) anomalies.push({ type: 'excessive_duration', minutes: workedNetMinutes, max_minutes: maxDuration });
  if (minDuration !== null && summary.lastOutUtc && workedNetMinutes < minDuration && isWorkingDay) anomalies.push({ type: 'insufficient_duration', minutes: workedNetMinutes, min_minutes: minDuration });
  return { lateMinutes, earlyLeaveMinutes, overtimeMinutes, anomalies, isWorkingDay, breakAutoMinutes, workedNetMinutes };
}
function severityFor(type) {
  if (['missing_in','missing_out','overlap','remote_not_authorized','missing_assignment'].includes(type)) return 'critical';
  if (['late','early_leave','missing_break_end','outside_geofence','outside_schedule','excessive_duration','insufficient_duration'].includes(type)) return 'warning';
  return 'info';
}
async function recalculateDay(employeId, workDate) {
  return db.transaction(async tx => {
    const existing = await tx.queryOne('SELECT id, status FROM pointeuse_daily_summaries WHERE employe_id = ? AND work_date = ?', [employeId, workDate]);
    if (existing?.status === 'closed') { const err = new Error('Journée clôturée : recalcul interdit'); err.code = 'DAY_CLOSED'; err.status = 409; throw err; }
    const events = await governance.effectiveEvents(tx, employeId, workDate);
    const schedule = await policy.activeAssignment(tx, employeId, workDate);
    const calendar = await policy.calendarDay(tx, schedule, workDate);
    const leave = await policy.activeLeave(tx, employeId, workDate);
    const base = engine.calculateDay(events);
    const metrics = scheduleMetrics(events, schedule, base, calendar, leave);
    const night = nightMinutes(events, schedule);
    for (const event of events) {
      if (Number(event.hors_perimetre || 0) === 1) metrics.anomalies.push({ type: 'outside_geofence', event_id: event.id });
      if (schedule && event.mode && !policy.modeAllowed(schedule, event.mode)) metrics.anomalies.push({ type: 'remote_not_authorized', event_id: event.id, mode: event.mode });
    }
    if (!schedule && events.length) metrics.anomalies.push({ type: 'missing_assignment' });
    const status = metrics.anomalies.length ? 'exception' : 'calculated';
    await tx.execute(
      `INSERT INTO pointeuse_daily_summaries
       (employe_id, work_date, schedule_id, first_in_utc, last_out_utc, worked_minutes, break_minutes, break_auto_minutes, late_minutes,
        early_leave_minutes, overtime_minutes, night_minutes, status, anomaly_count, calc_version, calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v3.3', NOW())
       ON DUPLICATE KEY UPDATE schedule_id=VALUES(schedule_id),first_in_utc=VALUES(first_in_utc),last_out_utc=VALUES(last_out_utc),
         worked_minutes=VALUES(worked_minutes),break_minutes=VALUES(break_minutes),break_auto_minutes=VALUES(break_auto_minutes),late_minutes=VALUES(late_minutes),
         early_leave_minutes=VALUES(early_leave_minutes),overtime_minutes=VALUES(overtime_minutes),night_minutes=VALUES(night_minutes),
         status=VALUES(status),anomaly_count=VALUES(anomaly_count),calc_version='v3.3',calculated_at=NOW()`,
      [employeId, workDate, schedule?.schedule_id || schedule?.id || null, base.firstInUtc, base.lastOutUtc,
       metrics.workedNetMinutes ?? base.workedMinutes, base.breakMinutes, metrics.breakAutoMinutes || 0,
       metrics.lateMinutes, metrics.earlyLeaveMinutes, metrics.overtimeMinutes, night, status, metrics.anomalies.length]
    );
    const daily = await tx.queryOne('SELECT id FROM pointeuse_daily_summaries WHERE employe_id = ? AND work_date = ?', [employeId, workDate]);
    await tx.execute(`DELETE FROM pointeuse_anomalies WHERE employe_id = ? AND work_date = ? AND status IN ('detected','to_justify')`, [employeId, workDate]);
    for (const anomaly of metrics.anomalies) {
      await tx.execute(
        `INSERT INTO pointeuse_anomalies (employe_id, work_date, daily_summary_id, anomaly_type, severity, status, details_json)
         VALUES (?, ?, ?, ?, ?, 'detected', ?)`,
        [employeId, workDate, daily?.id || null, anomaly.type, severityFor(anomaly.type), JSON.stringify(anomaly)]
      );
    }
    return { employe_id: employeId, work_date: workDate, status, summary: { ...base, ...metrics, nightMinutes: night }, schedule_id: schedule?.schedule_id || schedule?.id || null, calendar, leave };
  });
}
module.exports = { DEFAULT_PAUSE_SEUIL_MINUTES, hhmmMinutes, localMinuteFromUtc, minutesInNightWindow, workedSegments, nightMinutes, autoDeductedBreakMinutes, scheduleMetrics, severityFor, recalculateDay };
