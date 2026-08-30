'use strict';

const db = require('../db');

const EVENT_TYPES = ['clock_in', 'break_start', 'break_end', 'clock_out'];
const SOURCES = ['web', 'mobile', 'kiosk', 'badge', 'import', 'rh'];
const MODES = ['bureau', 'teletravail', 'terrain'];
const DEFAULT_DAY_CUTOFF_MINUTES = 960;
const TRANSITIONS = {
  empty: ['clock_in'],
  clock_in: ['break_start', 'clock_out'],
  break_start: ['break_end'],
  break_end: ['break_start', 'clock_out'],
  clock_out: [],
};

function attendanceError(message, code, status = 400, details) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw attendanceError(`${label} invalide`, 'INVALID_ENUM', 400);
}

function utcParts(date = new Date(), timezone = 'Africa/Brazzaville') {
  const occurredAtUtc = date.toISOString().slice(0, 23).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    occurredAtUtc,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function normalizeIdempotencyKey(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    throw attendanceError('Idempotency-Key invalide (8 à 128 caractères sûrs)', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  return raw;
}

async function getLatestEvent(executor, employeId) {
  return executor.queryOne(
    `SELECT id, employe_id, event_type, occurred_at_utc, local_date, work_date, local_time,
            timezone_name, source, mode, site_code, hors_perimetre
     FROM pointeuse_events
     WHERE employe_id = ?
     ORDER BY occurred_at_utc DESC, id DESC
     LIMIT 1`,
    [employeId]
  );
}

function elapsedMinutesSince(utcText, now) {
  if (!utcText || !(now instanceof Date)) return null;
  const started = new Date(`${String(utcText).replace(' ', 'T')}Z`).getTime();
  const current = now.getTime();
  if (!Number.isFinite(started) || !Number.isFinite(current)) return null;
  return Math.floor((current - started) / 60000);
}

function openWorkDate(previous, currentLocalDate) {
  return previous.work_date || previous.local_date || currentLocalDate;
}

function resolveWorkDate(previous, currentLocalDate, options = {}) {
  if (!previous || previous.event_type === 'clock_out') return currentLocalDate;
  const cutoff = Number(options.cutoffMinutes ?? DEFAULT_DAY_CUTOFF_MINUTES);
  const elapsed = elapsedMinutesSince(previous.occurred_at_utc, options.now);
  if (Number.isFinite(cutoff) && cutoff > 0 && elapsed !== null && elapsed > cutoff) return currentLocalDate;
  return openWorkDate(previous, currentLocalDate);
}

function assertTransition(previousType, nextType) {
  const state = previousType || 'empty';
  const allowed = TRANSITIONS[state] || [];
  if (!allowed.includes(nextType)) {
    throw attendanceError(
      `Transition interdite: ${state} -> ${nextType}`,
      'INVALID_ATTENDANCE_TRANSITION',
      409,
      { previous: state, requested: nextType, allowed }
    );
  }
}

async function eventByIdempotency(executor, employeId, key) {
  return executor.queryOne(
    `SELECT id, employe_id, event_type, occurred_at_utc, local_date, work_date, local_time,
            timezone_name, source, mode, site_code, hors_perimetre
     FROM pointeuse_events
     WHERE employe_id = ? AND idempotency_key = ?`,
    [employeId, key]
  );
}

async function lockEmployee(executor, employeId) {
  const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
  const row = await executor.queryOne(`SELECT id FROM employes WHERE id = ?${forUpdate}`, [employeId]);
  if (!row) throw attendanceError('Agent introuvable', 'EMPLOYEE_NOT_FOUND', 404);
}

async function assertWorkDateOpen(executor, employeId, workDate) {
  const forUpdate = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? ' FOR UPDATE' : '';
  const day = await executor.queryOne(
    `SELECT id FROM pointeuse_daily_summaries
     WHERE employe_id = ? AND work_date = ? AND status = 'closed'${forUpdate}`,
    [employeId, workDate]
  );
  if (day) throw attendanceError('Journée clôturée : nouveau pointage interdit', 'DAY_CLOSED', 409);
  const period = await executor.queryOne(
    `SELECT id FROM pointeuse_periods
     WHERE ? BETWEEN date_debut AND date_fin AND status = 'closed'
     ORDER BY id DESC LIMIT 1${forUpdate}`,
    [workDate]
  );
  if (period) throw attendanceError('Période clôturée : nouveau pointage interdit', 'PERIOD_CLOSED', 409);
}

async function recordEvent({
  employeId,
  eventType,
  source = 'web',
  mode = 'bureau',
  timezone = 'Africa/Brazzaville',
  utcOffsetMinutes = 60,
  siteCode = null,
  deviceId = null,
  sessionId = null,
  idempotencyKey,
  ipAddress = null,
  latitude = null,
  longitude = null,
  precisionGps = null,
  horsPerimetre = 0,
  payload = null,
  createdBy = null,
  dayCutoffMinutes = DEFAULT_DAY_CUTOFF_MINUTES,
  now = new Date(),
}) {
  assertEnum(eventType, EVENT_TYPES, 'event_type');
  assertEnum(source, SOURCES, 'source');
  assertEnum(mode, MODES, 'mode');
  const key = normalizeIdempotencyKey(idempotencyKey);
  const time = utcParts(now, timezone);

  return db.transaction(async tx => {
    await lockEmployee(tx, employeId);

    const existing = await eventByIdempotency(tx, employeId, key);
    if (existing) return { event: existing, idempotentReplay: true };

    const previous = await getLatestEvent(tx, employeId);
    const openPrevious = previous?.event_type === 'clock_out' ? null : previous;
    const workDate = resolveWorkDate(openPrevious, time.localDate, { now, cutoffMinutes: dayCutoffMinutes });
    const sameDayPrevious = openPrevious && openWorkDate(openPrevious, time.localDate) === workDate ? openPrevious : null;
    assertTransition(sameDayPrevious?.event_type, eventType);
    await assertWorkDateOpen(tx, employeId, workDate);

    try {
      const result = await tx.execute(
        `INSERT INTO pointeuse_events
          (employe_id, event_type, occurred_at_utc, local_date, work_date, local_time,
           timezone_name, utc_offset_minutes, source, mode, site_code, device_id,
           session_id, idempotency_key, ip_address, latitude, longitude, precision_gps,
           hors_perimetre, payload_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          employeId, eventType, time.occurredAtUtc, time.localDate, workDate, time.localTime,
          timezone, utcOffsetMinutes, source, mode, siteCode, deviceId,
          sessionId, key, ipAddress, latitude, longitude, precisionGps,
          horsPerimetre ? 1 : 0, payload ? JSON.stringify(payload) : null, createdBy,
        ]
      );

      return {
        event: {
          id: result.insertId,
          employe_id: employeId,
          event_type: eventType,
          occurred_at_utc: time.occurredAtUtc,
          local_date: time.localDate,
          work_date: workDate,
          local_time: time.localTime,
          timezone_name: timezone,
          source,
          mode,
          site_code: siteCode,
          hors_perimetre: horsPerimetre ? 1 : 0,
        },
        idempotentReplay: false,
      };
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' || error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const replay = await eventByIdempotency(tx, employeId, key);
        if (replay) return { event: replay, idempotentReplay: true };
      }
      throw error;
    }
  });
}

function minutesBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((new Date(`${b}Z`) - new Date(`${a}Z`)) / 60000));
}

function calculateDay(events) {
  const ordered = [...events].sort((a, b) => {
    const ta = String(a.occurred_at_utc);
    const tb = String(b.occurred_at_utc);
    return ta.localeCompare(tb) || Number(a.id || 0) - Number(b.id || 0);
  });
  let activeStart = null;
  let breakStart = null;
  let workedMinutes = 0;
  let breakMinutes = 0;
  let firstInUtc = null;
  let lastOutUtc = null;
  const anomalies = [];

  for (const event of ordered) {
    if (event.event_type === 'clock_in') {
      if (activeStart || breakStart) anomalies.push({ type: 'overlap', event_id: event.id });
      activeStart = event.occurred_at_utc;
      firstInUtc ||= event.occurred_at_utc;
    } else if (event.event_type === 'break_start') {
      if (!activeStart || breakStart) anomalies.push({ type: 'overlap', event_id: event.id });
      if (activeStart) workedMinutes += minutesBetween(activeStart, event.occurred_at_utc);
      activeStart = null;
      breakStart = event.occurred_at_utc;
    } else if (event.event_type === 'break_end') {
      if (!breakStart) anomalies.push({ type: 'missing_break_end', event_id: event.id });
      if (breakStart) breakMinutes += minutesBetween(breakStart, event.occurred_at_utc);
      breakStart = null;
      activeStart = event.occurred_at_utc;
    } else if (event.event_type === 'clock_out') {
      if (breakStart) {
        anomalies.push({ type: 'missing_break_end', event_id: event.id });
        breakStart = null;
      }
      if (!activeStart) anomalies.push({ type: 'missing_in', event_id: event.id });
      if (activeStart) workedMinutes += minutesBetween(activeStart, event.occurred_at_utc);
      activeStart = null;
      lastOutUtc = event.occurred_at_utc;
    }
  }

  if (activeStart) anomalies.push({ type: 'missing_out' });
  if (breakStart) anomalies.push({ type: 'missing_break_end' });

  return { firstInUtc, lastOutUtc, workedMinutes, breakMinutes, anomalies };
}

module.exports = {
  EVENT_TYPES,
  SOURCES,
  MODES,
  TRANSITIONS,
  DEFAULT_DAY_CUTOFF_MINUTES,
  elapsedMinutesSince,
  openWorkDate,
  utcParts,
  normalizeIdempotencyKey,
  resolveWorkDate,
  assertTransition,
  calculateDay,
  recordEvent,
  assertWorkDateOpen,
};
