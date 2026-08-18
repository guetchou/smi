'use strict';

const crypto = require('crypto');
const db = require('../db');

const EVENT_TYPES = ['clock_in', 'break_start', 'break_end', 'clock_out'];
const SOURCES = ['web', 'mobile', 'kiosk', 'badge', 'import', 'rh'];
const MODES = ['bureau', 'teletravail', 'terrain'];
const TRANSITIONS = {
  empty: ['clock_in'],
  clock_in: ['break_start', 'clock_out'],
  break_start: ['break_end'],
  break_end: ['break_start', 'clock_out'],
  clock_out: [],
};

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    const err = new Error(`${label} invalide`);
    err.code = 'INVALID_ENUM';
    err.status = 400;
    throw err;
  }
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
  if (raw && /^[A-Za-z0-9._:-]{8,128}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

async function getLastEventForDay(employeId, localDate) {
  return db.queryOne(
    `SELECT id, event_type, occurred_at_utc, local_date, local_time, source, mode
     FROM pointeuse_events
     WHERE employe_id = ? AND local_date = ?
     ORDER BY occurred_at_utc DESC, id DESC
     LIMIT 1`,
    [employeId, localDate]
  );
}

function assertTransition(previousType, nextType) {
  const state = previousType || 'empty';
  const allowed = TRANSITIONS[state] || [];
  if (!allowed.includes(nextType)) {
    const err = new Error(`Transition interdite: ${state} -> ${nextType}`);
    err.code = 'INVALID_ATTENDANCE_TRANSITION';
    err.status = 409;
    err.details = { previous: state, requested: nextType, allowed };
    throw err;
  }
}

async function eventByIdempotency(employeId, key) {
  return db.queryOne(
    `SELECT id, employe_id, event_type, occurred_at_utc, local_date, local_time,
            timezone_name, source, mode, site_code, hors_perimetre
     FROM pointeuse_events
     WHERE employe_id = ? AND idempotency_key = ?`,
    [employeId, key]
  );
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
  now = new Date(),
}) {
  assertEnum(eventType, EVENT_TYPES, 'event_type');
  assertEnum(source, SOURCES, 'source');
  assertEnum(mode, MODES, 'mode');
  const key = normalizeIdempotencyKey(idempotencyKey);
  const existing = await eventByIdempotency(employeId, key);
  if (existing) return { event: existing, idempotentReplay: true };

  const time = utcParts(now, timezone);
  const previous = await getLastEventForDay(employeId, time.localDate);
  assertTransition(previous?.event_type, eventType);

  const result = await db.execute(
    `INSERT INTO pointeuse_events
      (employe_id, event_type, occurred_at_utc, local_date, local_time,
       timezone_name, utc_offset_minutes, source, mode, site_code, device_id,
       session_id, idempotency_key, ip_address, latitude, longitude, precision_gps,
       hors_perimetre, payload_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeId, eventType, time.occurredAtUtc, time.localDate, time.localTime,
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
      local_time: time.localTime,
      timezone_name: timezone,
      source,
      mode,
      site_code: siteCode,
      hors_perimetre: horsPerimetre ? 1 : 0,
    },
    idempotentReplay: false,
  };
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
      if (activeStart) anomalies.push({ type: 'overlap', event_id: event.id });
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
  utcParts,
  normalizeIdempotencyKey,
  assertTransition,
  calculateDay,
  recordEvent,
};
