-- Migration 037 — Contrôles du ledger canonique de trésorerie
-- Additive uniquement. Aucun backfill et aucune activation automatique.

ALTER TABLE positions
  ADD COLUMN ledger_status ENUM('legacy','ready') NOT NULL DEFAULT 'legacy';

ALTER TABLE positions
  ADD COLUMN ledger_ready_at DATETIME NULL;

ALTER TABLE positions
  ADD COLUMN ledger_ready_by INT NULL;

ALTER TABLE cash_ledger
  ADD COLUMN leg_code VARCHAR(40) NULL;

ALTER TABLE cash_ledger
  ADD COLUMN reversal_of_ledger_id INT NULL;

CREATE UNIQUE INDEX uq_cash_ledger_operation_leg
  ON cash_ledger(operation_id, leg_code);

CREATE INDEX idx_cash_ledger_position_created
  ON cash_ledger(caisse_id, created_at, id);

CREATE INDEX idx_positions_ledger_status
  ON positions(ledger_status, actif);
