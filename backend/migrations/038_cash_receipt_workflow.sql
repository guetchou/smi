-- Migration 038 — Workflow contrôlé des encaissements
-- Additive uniquement. Aucun encaissement historique n'est modifié.

CREATE TABLE IF NOT EXISTS finance_workflow_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description VARCHAR(255),
  updated_by BIGINT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO finance_workflow_settings
  (setting_key, setting_value, description)
VALUES
  ('cash_receipt_attachment_threshold', '500000',
   'Montant XAF à partir duquel une pièce justificative est obligatoire pour un encaissement');

CREATE INDEX idx_finance_operation_events_status
  ON finance_operation_events(operation_id, next_status, created_at);
