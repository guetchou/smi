'use strict';

/**
 * SQLite compatibility bootstrap for isolated/browser test databases.
 * Production Pointeuse V3 remains governed by the MySQL migrations 043-046.
 *
 * The isolated browser harness starts the complete application with
 * DB_DRIVER=sqlite. Keep a coherent V3 read-model here so globally loaded
 * Pointeuse screens cannot emit unrelated 500 responses while another module
 * is under E2E test.
 */
function ensurePointeuseV3SqliteSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pointeuse_work_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      libelle TEXT NOT NULL,
      timezone_name TEXT NOT NULL DEFAULT 'Africa/Brazzaville',
      heure_debut TEXT NOT NULL,
      heure_fin TEXT NOT NULL,
      pause_minutes INTEGER NOT NULL DEFAULT 0,
      pause_auto_deduction INTEGER NOT NULL DEFAULT 1,
      pause_seuil_minutes INTEGER NOT NULL DEFAULT 360,
      tolerance_retard_minutes INTEGER NOT NULL DEFAULT 15,
      tolerance_depart_minutes INTEGER NOT NULL DEFAULT 0,
      nuit_traverse_minuit INTEGER NOT NULL DEFAULT 0,
      nuit_debut TEXT NOT NULL DEFAULT '22:00:00',
      nuit_fin TEXT NOT NULL DEFAULT '05:00:00',
      max_duree_minutes INTEGER NOT NULL DEFAULT 960,
      min_duree_minutes INTEGER,
      actif INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_work_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      libelle TEXT NOT NULL,
      timezone_name TEXT NOT NULL DEFAULT 'Africa/Brazzaville',
      jours_ouvres TEXT NOT NULL DEFAULT '1,2,3,4,5',
      actif INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      libelle TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      rayon_m INTEGER NOT NULL DEFAULT 300,
      gps_requis INTEGER NOT NULL DEFAULT 0,
      actif INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_schedule_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      schedule_id INTEGER NOT NULL,
      calendar_id INTEGER,
      date_debut TEXT NOT NULL,
      date_fin TEXT,
      jours_semaine TEXT NOT NULL DEFAULT '1,2,3,4,5',
      site_code TEXT,
      mode_autorise TEXT NOT NULL DEFAULT 'bureau',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_calendar_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      day_type TEXT NOT NULL,
      libelle TEXT,
      scheduled_minutes_override INTEGER,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(calendar_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS pointeuse_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at_utc TEXT NOT NULL,
      local_date TEXT NOT NULL,
      work_date TEXT,
      local_time TEXT NOT NULL,
      timezone_name TEXT NOT NULL DEFAULT 'Africa/Brazzaville',
      utc_offset_minutes INTEGER NOT NULL DEFAULT 60,
      source TEXT NOT NULL DEFAULT 'web',
      mode TEXT NOT NULL DEFAULT 'bureau',
      site_code TEXT,
      device_id TEXT,
      session_id TEXT,
      idempotency_key TEXT NOT NULL,
      ip_address TEXT,
      latitude REAL,
      longitude REAL,
      precision_gps REAL,
      hors_perimetre INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(employe_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS pointeuse_daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      schedule_id INTEGER,
      first_in_utc TEXT,
      last_out_utc TEXT,
      worked_minutes INTEGER NOT NULL DEFAULT 0,
      break_minutes INTEGER NOT NULL DEFAULT 0,
      late_minutes INTEGER NOT NULL DEFAULT 0,
      early_leave_minutes INTEGER NOT NULL DEFAULT 0,
      overtime_minutes INTEGER NOT NULL DEFAULT 0,
      night_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      calc_version TEXT NOT NULL DEFAULT 'v3.1',
      calculated_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      closed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(employe_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS pointeuse_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      daily_summary_id INTEGER,
      anomaly_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      status TEXT NOT NULL DEFAULT 'detected',
      details_json TEXT,
      justification TEXT,
      resolved_by INTEGER,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_correction_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      event_id INTEGER,
      requested_event_type TEXT,
      requested_at_utc TEXT,
      reason TEXT NOT NULL,
      evidence_url TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      requested_by INTEGER NOT NULL,
      reviewed_by INTEGER,
      review_reason TEXT,
      reviewed_at TEXT,
      applied_event_id INTEGER,
      applied_adjustment_id INTEGER,
      correlation_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      correction_request_id INTEGER NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      target_event_id INTEGER,
      effective_event_type TEXT,
      effective_at_utc TEXT,
      timezone_name TEXT NOT NULL DEFAULT 'Africa/Brazzaville',
      reason TEXT NOT NULL,
      approved_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_user_id INTEGER,
      correlation_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT,
      previous_hash TEXT,
      event_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pointeuse_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_debut TEXT NOT NULL,
      date_fin TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      calc_version TEXT NOT NULL DEFAULT 'v3.1',
      created_by INTEGER,
      calculated_at TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      closed_by INTEGER,
      closed_at TEXT,
      reopened_by INTEGER,
      reopened_at TEXT,
      reopen_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date_debut, date_fin)
    );

    CREATE TABLE IF NOT EXISTS pointeuse_payroll_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER NOT NULL,
      calc_version TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      employee_count INTEGER NOT NULL DEFAULT 0,
      total_worked_minutes INTEGER NOT NULL DEFAULT 0,
      total_overtime_minutes INTEGER NOT NULL DEFAULT 0,
      total_night_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'prepared',
      prepared_by INTEGER NOT NULL,
      prepared_at TEXT DEFAULT (datetime('now')),
      consumed_by INTEGER,
      consumed_at TEXT,
      UNIQUE(period_id, snapshot_sha256)
    );
  `);
}

module.exports = { ensurePointeuseV3SqliteSchema };
