-- Migration 045 — Fondation d'integration Dolibarr
-- Additive uniquement : nouvelles tables de liens, jobs et tentatives.
-- Aucun backfill, aucune modification de table metier existante.

CREATE TABLE IF NOT EXISTS integration_links (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  provider VARCHAR(50) NOT NULL,
  local_type VARCHAR(80) NOT NULL,
  local_id BIGINT NOT NULL,
  remote_type VARCHAR(80) NOT NULL,
  remote_id VARCHAR(120) NOT NULL,
  remote_ref VARCHAR(160),
  idempotency_key VARCHAR(180) NOT NULL,
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_integration_links_provider_local (provider, local_type, local_id),
  UNIQUE KEY uq_integration_links_provider_idempotency (provider, idempotency_key),
  KEY idx_integration_links_remote (provider, remote_type, remote_id),
  KEY idx_integration_links_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integration_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  provider VARCHAR(50) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  local_type VARCHAR(80) NOT NULL,
  local_id BIGINT NOT NULL,
  status ENUM('pending','running','synced','failed','retrying','cancelled','blocked') NOT NULL DEFAULT 'pending',
  attempts_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME,
  last_error_code VARCHAR(120),
  last_error_message TEXT,
  created_by BIGINT,
  locked_at DATETIME,
  locked_by VARCHAR(120),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_integration_jobs_provider_object (provider, job_type, local_type, local_id),
  KEY idx_integration_jobs_status_retry (provider, status, next_retry_at),
  KEY idx_integration_jobs_local (local_type, local_id),
  KEY idx_integration_jobs_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integration_attempts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_id BIGINT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  method VARCHAR(10) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_hash VARCHAR(128),
  response_status INT,
  success TINYINT(1) NOT NULL DEFAULT 0,
  error_code VARCHAR(120),
  error_message TEXT,
  duration_ms INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_integration_attempts_job (job_id, created_at),
  KEY idx_integration_attempts_provider_success (provider, success, created_at),
  CONSTRAINT fk_integration_attempts_job
    FOREIGN KEY (job_id) REFERENCES integration_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
