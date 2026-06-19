-- Migration 031 — Fondation ERP du module Finance > Opérations
-- Objectif : séparer document métier, paiement, allocation, comptabilisation et trésorerie
-- Migration additive et non destructive.

CREATE TABLE IF NOT EXISTS finance_source_documents (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_module VARCHAR(64) NOT NULL,
  source_record_id BIGINT NOT NULL,
  document_type VARCHAR(64) NOT NULL,
  document_number VARCHAR(100),
  third_party_type VARCHAR(32),
  third_party_id BIGINT,
  third_party_label VARCHAR(255),
  currency VARCHAR(8) NOT NULL DEFAULT 'XAF',
  gross_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  open_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  due_date DATE,
  business_status VARCHAR(32) NOT NULL DEFAULT 'draft',
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_finance_source_document (source_module, source_record_id),
  KEY idx_finance_source_status (business_status, due_date),
  KEY idx_finance_source_third_party (third_party_type, third_party_id)
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  operation_id BIGINT NOT NULL,
  source_document_id BIGINT NOT NULL,
  allocated_amount DECIMAL(18,2) NOT NULL,
  discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  withholding_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  exchange_difference DECIMAL(18,2) NOT NULL DEFAULT 0,
  allocation_status VARCHAR(32) NOT NULL DEFAULT 'draft',
  allocated_by BIGINT,
  allocated_at DATETIME,
  reversed_by_allocation_id BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_payment_alloc_operation (operation_id),
  KEY idx_payment_alloc_document (source_document_id),
  KEY idx_payment_alloc_status (allocation_status),
  CONSTRAINT fk_payment_alloc_document
    FOREIGN KEY (source_document_id) REFERENCES finance_source_documents(id)
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  position_id BIGINT NOT NULL,
  operation_id BIGINT,
  movement_type VARCHAR(32) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  balance_before DECIMAL(18,2) NOT NULL,
  balance_after DECIMAL(18,2) NOT NULL,
  value_date DATE NOT NULL,
  reference VARCHAR(100),
  reversal_of_id BIGINT,
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cash_ledger_operation_direction (operation_id, position_id, direction),
  KEY idx_cash_ledger_position_date (position_id, value_date, id),
  KEY idx_cash_ledger_reference (reference)
);

CREATE TABLE IF NOT EXISTS cash_position_balances (
  position_id BIGINT PRIMARY KEY,
  current_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  last_ledger_id BIGINT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS finance_operation_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  operation_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  previous_status VARCHAR(32),
  next_status VARCHAR(32),
  reason TEXT,
  metadata_json JSON,
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_finance_event_operation (operation_id, created_at),
  KEY idx_finance_event_type (event_type)
);

-- Colonnes de transition : l'opération reste la façade, mais ne porte plus seule tout le sens métier.
ALTER TABLE operations ADD COLUMN source_document_id BIGINT NULL;
ALTER TABLE operations ADD COLUMN business_status VARCHAR(32) NULL;
ALTER TABLE operations ADD COLUMN approval_status VARCHAR(32) NULL;
ALTER TABLE operations ADD COLUMN payment_status VARCHAR(32) NULL;
ALTER TABLE operations ADD COLUMN reconciliation_status VARCHAR(32) NULL;
ALTER TABLE operations ADD COLUMN reversed_operation_id BIGINT NULL;
ALTER TABLE operations ADD COLUMN reversal_reason TEXT NULL;

CREATE INDEX idx_operations_source_document ON operations(source_document_id);
CREATE INDEX idx_operations_workflow_states ON operations(business_status, approval_status, payment_status);
CREATE INDEX idx_operations_reconciliation ON operations(reconciliation_status);
