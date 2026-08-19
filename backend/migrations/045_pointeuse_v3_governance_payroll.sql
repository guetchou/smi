-- Gouvernance Pointeuse V3 : corrections non destructives, audit append-only, snapshots paie.

CREATE TABLE pointeuse_adjustments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id INT NOT NULL,
  work_date DATE NOT NULL,
  correction_request_id BIGINT NOT NULL,
  operation ENUM('add','void','replace') NOT NULL,
  target_event_id BIGINT NULL,
  effective_event_type ENUM('clock_in','break_start','break_end','clock_out') NULL,
  effective_at_utc DATETIME(3) NULL,
  timezone_name VARCHAR(64) NOT NULL DEFAULT 'Africa/Brazzaville',
  reason TEXT NOT NULL,
  approved_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_pointeuse_adjustment_request (correction_request_id),
  KEY idx_pointeuse_adjustment_employee_date (employe_id, work_date),
  CONSTRAINT fk_pointeuse_adjustment_employee FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_pointeuse_adjustment_request FOREIGN KEY (correction_request_id) REFERENCES pointeuse_correction_requests(id),
  CONSTRAINT fk_pointeuse_adjustment_target FOREIGN KEY (target_event_id) REFERENCES pointeuse_events(id),
  CONSTRAINT fk_pointeuse_adjustment_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pointeuse_audit_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  action VARCHAR(96) NOT NULL,
  actor_user_id INT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  metadata_json JSON NULL,
  previous_hash CHAR(64) NULL,
  event_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_pointeuse_audit_hash (event_hash),
  KEY idx_pointeuse_audit_aggregate (aggregate_type, aggregate_id, id),
  KEY idx_pointeuse_audit_correlation (correlation_id),
  CONSTRAINT fk_pointeuse_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pointeuse_payroll_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  period_id INT NOT NULL,
  calc_version VARCHAR(32) NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  employee_count INT NOT NULL DEFAULT 0,
  total_worked_minutes BIGINT NOT NULL DEFAULT 0,
  total_overtime_minutes BIGINT NOT NULL DEFAULT 0,
  total_night_minutes BIGINT NOT NULL DEFAULT 0,
  status ENUM('prepared','consumed','superseded') NOT NULL DEFAULT 'prepared',
  prepared_by INT NOT NULL,
  prepared_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_by INT NULL,
  consumed_at DATETIME(3) NULL,
  UNIQUE KEY uq_pointeuse_payroll_snapshot_hash (period_id, snapshot_sha256),
  KEY idx_pointeuse_payroll_snapshot_status (period_id, status),
  CONSTRAINT fk_pointeuse_payroll_snapshot_period FOREIGN KEY (period_id) REFERENCES pointeuse_periods(id),
  CONSTRAINT fk_pointeuse_payroll_snapshot_preparer FOREIGN KEY (prepared_by) REFERENCES users(id),
  CONSTRAINT fk_pointeuse_payroll_snapshot_consumer FOREIGN KEY (consumed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE pointeuse_correction_requests
  ADD COLUMN applied_adjustment_id BIGINT NULL,
  ADD COLUMN correlation_id VARCHAR(128) NULL,
  ADD KEY idx_pointeuse_correction_correlation (correlation_id),
  ADD CONSTRAINT fk_pointeuse_correction_adjustment FOREIGN KEY (applied_adjustment_id) REFERENCES pointeuse_adjustments(id);
