-- Migration 024 : statuts de synchronisation des flux financiers

ALTER TABLE operations
  ADD COLUMN treasury_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE operations
  ADD COLUMN accounting_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE operations
  ADD COLUMN budget_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE operations
  ADD COLUMN allocation_status VARCHAR(30) NOT NULL DEFAULT 'pending';

UPDATE operations
SET treasury_status = CASE
    WHEN statut = 'valide' THEN 'synced'
    WHEN statut = 'annule' THEN 'cancelled'
    ELSE 'pending'
  END,
  accounting_status = COALESCE(NULLIF(accounting_status, ''), 'pending'),
  budget_status = COALESCE(NULLIF(budget_status, ''), 'pending'),
  allocation_status = COALESCE(NULLIF(allocation_status, ''), 'pending');

CREATE INDEX idx_operations_treasury_status ON operations(treasury_status);

CREATE INDEX idx_operations_accounting_status ON operations(accounting_status);

CREATE INDEX idx_operations_budget_status ON operations(budget_status);

CREATE TABLE IF NOT EXISTS sync_errors (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_module     VARCHAR(100) NOT NULL,
  source_record_id  INT NOT NULL,
  error_type        VARCHAR(100) NOT NULL,
  error_message     TEXT NOT NULL,
  technical_details TEXT,
  status            ENUM('open','resolved','ignored') NOT NULL DEFAULT 'open',
  resolved_by       INT,
  resolved_at       DATETIME,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sync_errors_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_sync_errors_source ON sync_errors(source_module, source_record_id);

CREATE INDEX idx_sync_errors_status ON sync_errors(status, created_at);
