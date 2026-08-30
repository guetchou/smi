'use strict';

const db = require('../db');
const engine = require('./pointeuse_v3_engine');

function attendanceError(message, code, status = 400, details) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}
function haversineMeters(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number);
  if (values.some(v => !Number.isFinite(v))) return null;
  const [aLat, aLon, bLat, bLon] = values;
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function weekdayIso(dateText) {
  const d = new Date(`${dateText}T12:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}
function dayList(value) { return new Set(String(value || '').split(',').map(v => Number(v.trim())).filter(v => v >= 1 && v <= 7)); }
async function getRuntimeMode(executor = db) {
  const row = await executor.queryOne("SELECT valeur FROM parametres WHERE cle='pointeuse_v3_mode'");
  const mode = String(row?.valeur || 'shadow').toLowerCase();
  return ['disabled', 'shadow', 'active'].includes(mode) ? mode : 'shadow';
}
const DEFAULT_DAY_CUTOFF_MINUTES = engine.DEFAULT_DAY_CUTOFF_MINUTES;

async function getDayCutoffMinutes(executor = db) {
  const row = await executor.queryOne("SELECT valeur FROM parametres WHERE cle='pointeuse_v3_day_cutoff_minutes'");
  const value = Number(row?.valeur);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAY_CUTOFF_MINUTES;
}

async function getTimezone(executor = db) {
  const row = await executor.queryOne("SELECT valeur FROM parametres WHERE cle='pointeuse_v3_timezone'");
  return String(row?.valeur || 'Africa/Brazzaville');
}
async function activeAssignment(executor, employeId, workDate) {
  return executor.queryOne(
    `SELECT a.id, a.employe_id, a.schedule_id, a.calendar_id, a.site_code, a.mode_autorise, a.jours_semaine,
            s.code AS schedule_code, s.libelle AS schedule_libelle, s.timezone_name,
            s.heure_debut, s.heure_fin, s.pause_minutes, s.pause_auto_deduction, s.pause_seuil_minutes, s.tolerance_retard_minutes,
            s.tolerance_depart_minutes, s.nuit_traverse_minuit, s.nuit_debut, s.nuit_fin,
            s.max_duree_minutes, s.min_duree_minutes,
            c.code AS calendar_code, c.jours_ouvres AS calendar_jours_ouvres
     FROM pointeuse_schedule_assignments a
     JOIN pointeuse_work_schedules s ON s.id = a.schedule_id AND s.actif = 1
     LEFT JOIN pointeuse_work_calendars c ON c.id = a.calendar_id AND c.actif = 1
     WHERE a.employe_id = ? AND a.date_debut <= ? AND (a.date_fin IS NULL OR a.date_fin >= ?)
     ORDER BY a.date_debut DESC, a.id DESC LIMIT 1`,
    [employeId, workDate, workDate]
  );
}
// Même définition qu'en V2 (routes/pointeuse.js) : un congé approuvé ou terminé
// couvrant la date interdit le pointage. Le congé est individuel, il n'est donc
// pas modélisé comme un jour de calendrier, lequel est partagé entre agents.
async function activeLeave(executor, employeId, workDate) {
  return executor.queryOne(
    `SELECT id, type_conge, date_debut, date_fin, statut
     FROM employes_conges
     WHERE employe_id = ?
       AND statut IN ('approuve','termine')
       AND date_debut <= ?
       AND date_fin >= ?
     ORDER BY date_debut DESC
     LIMIT 1`,
    [employeId, workDate, workDate]
  );
}

async function calendarDay(executor, assignment, workDate) {
  if (assignment?.calendar_id) {
    const explicit = await executor.queryOne(
      `SELECT day_type, libelle, scheduled_minutes_override FROM pointeuse_calendar_days WHERE calendar_id = ? AND work_date = ?`,
      [assignment.calendar_id, workDate]
    );
    if (explicit) return { ...explicit, explicit: true };
  }
  const allowed = dayList(assignment?.calendar_jours_ouvres || assignment?.jours_semaine || '1,2,3,4,5');
  return { day_type: allowed.has(weekdayIso(workDate)) ? 'workday' : 'rest', libelle: null, scheduled_minutes_override: null, explicit: false };
}
async function sitePolicy(executor, siteCode) {
  if (!siteCode) return null;
  return executor.queryOne(`SELECT id, code, libelle, latitude, longitude, rayon_m, gps_requis FROM pointeuse_sites WHERE code = ? AND actif = 1 LIMIT 1`, [siteCode]);
}
async function evaluateLocation(executor, { siteCode, latitude, longitude, precisionGps }) {
  const site = await sitePolicy(executor, siteCode);
  if (!site) return { site: null, gps_required: false, outside: false, distance_m: null };
  const gpsRequired = Number(site.gps_requis || 0) === 1;
  const lat = Number(latitude), lon = Number(longitude);
  if (gpsRequired && (!Number.isFinite(lat) || !Number.isFinite(lon))) throw attendanceError('Position GPS requise pour ce site', 'ATTENDANCE_GPS_REQUIRED', 400);
  const distance = haversineMeters(lat, lon, site.latitude, site.longitude);
  const outside = distance !== null && distance > Number(site.rayon_m || 0);
  return { site, gps_required: gpsRequired, outside, distance_m: distance === null ? null : Math.round(distance), precision_gps: Number.isFinite(Number(precisionGps)) ? Number(precisionGps) : null };
}
function modeAllowed(assignment, mode) {
  if (!assignment) return false;
  if (assignment.mode_autorise === 'hybride') return ['bureau','teletravail','terrain'].includes(mode);
  return assignment.mode_autorise === mode;
}
function utcOffsetMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' })
    .formatToParts(date).reduce((a,p)=>{a[p.type]=p.value;return a;},{});
  const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((localAsUtc - date.getTime()) / 60000);
}
module.exports = { attendanceError, haversineMeters, weekdayIso, dayList, getRuntimeMode, getTimezone, getDayCutoffMinutes, DEFAULT_DAY_CUTOFF_MINUTES, activeAssignment, activeLeave, calendarDay, sitePolicy, evaluateLocation, modeAllowed, utcOffsetMinutes };
