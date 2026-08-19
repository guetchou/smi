-- Pointeuse V3 — calendrier de travail, sites/géofences, politiques et pilotage de bascule.

CREATE TABLE pointeuse_sites (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  libelle VARCHAR(160) NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  rayon_m INT NOT NULL DEFAULT 300,
  gps_requis TINYINT(1) NOT NULL DEFAULT 0,
  actif TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pointeuse_site_code (code),
  CONSTRAINT fk_pointeuse_site_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pointeuse_work_calendars (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  libelle VARCHAR(160) NOT NULL,
  timezone_name VARCHAR(64) NOT NULL DEFAULT 'Africa/Brazzaville',
  jours_ouvres VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5',
  actif TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pointeuse_calendar_code (code),
  CONSTRAINT fk_pointeuse_calendar_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pointeuse_calendar_days (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  calendar_id INT NOT NULL,
  work_date DATE NOT NULL,
  day_type ENUM('workday','holiday','rest','exception') NOT NULL,
  libelle VARCHAR(200) NULL,
  scheduled_minutes_override INT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pointeuse_calendar_day (calendar_id, work_date),
  KEY idx_pointeuse_calendar_day_date (work_date, day_type),
  CONSTRAINT fk_pointeuse_calendar_day_calendar FOREIGN KEY (calendar_id) REFERENCES pointeuse_work_calendars(id),
  CONSTRAINT fk_pointeuse_calendar_day_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE pointeuse_schedule_assignments
  ADD COLUMN calendar_id INT NULL AFTER schedule_id,
  ADD CONSTRAINT fk_pointeuse_assignment_calendar FOREIGN KEY (calendar_id) REFERENCES pointeuse_work_calendars(id);

ALTER TABLE pointeuse_work_schedules
  ADD COLUMN nuit_debut TIME NOT NULL DEFAULT '22:00:00' AFTER nuit_traverse_minuit,
  ADD COLUMN nuit_fin TIME NOT NULL DEFAULT '05:00:00' AFTER nuit_debut,
  ADD COLUMN max_duree_minutes INT NOT NULL DEFAULT 960 AFTER nuit_fin,
  ADD COLUMN min_duree_minutes INT NULL AFTER max_duree_minutes;

ALTER TABLE pointeuse_periods
  ADD COLUMN created_by INT NULL AFTER calc_version,
  ADD COLUMN reviewed_by INT NULL AFTER calculated_at,
  ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by,
  ADD CONSTRAINT fk_pointeuse_period_creator FOREIGN KEY (created_by) REFERENCES users(id),
  ADD CONSTRAINT fk_pointeuse_period_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id);

INSERT INTO parametres (cle, valeur)
SELECT 'pointeuse_v3_mode', 'shadow'
WHERE NOT EXISTS (SELECT 1 FROM parametres WHERE cle = 'pointeuse_v3_mode');

INSERT INTO parametres (cle, valeur)
SELECT 'pointeuse_v3_timezone', 'Africa/Brazzaville'
WHERE NOT EXISTS (SELECT 1 FROM parametres WHERE cle = 'pointeuse_v3_timezone');
