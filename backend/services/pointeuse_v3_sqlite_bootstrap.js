'use strict';

/**
 * SQLite compatibility bootstrap for isolated/browser test databases.
 * Production Pointeuse V3 remains governed by the MySQL migrations 043-046.
 *
 * Keep this schema deliberately limited to the configuration tables queried
 * globally by the frontend. The E2E employment-contract harness starts the
 * complete application with DB_DRIVER=sqlite, so those reads must remain safe
 * even when the test itself does not exercise Pointeuse.
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
  `);
}

module.exports = { ensurePointeuseV3SqliteSchema };
