-- Migration 028 : journal comptable OHADA append-only.
-- Le PRD impose des ecritures comptables equilibrees, auditees et distinctes
-- des flux metier. Cette migration cree le socle sans generer d'ecritures
-- automatiques tant que les mappings comptables restent inactifs.

CREATE TABLE IF NOT EXISTS accounting_entries (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entry_no          VARCHAR(60) NOT NULL UNIQUE,
  entry_date        DATE NOT NULL,
  journal_code      VARCHAR(30) NOT NULL,
  source_module     VARCHAR(60) NOT NULL,
  source_record_id  INT NOT NULL,
  label             VARCHAR(255) NOT NULL,
  status            ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  created_by        INT,
  validated_by      INT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_acct_entry_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_acct_entry_validated_by FOREIGN KEY (validated_by) REFERENCES users(id),
  UNIQUE KEY uq_accounting_entry_source (source_module, source_record_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounting_entry_lines (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entry_id        INT NOT NULL,
  account_id      INT NOT NULL,
  third_party_id  INT,
  debit           DECIMAL(15,2) NOT NULL DEFAULT 0,
  credit          DECIMAL(15,2) NOT NULL DEFAULT 0,
  label           VARCHAR(255),
  position_id     INT,
  budget_line_id  INT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_acct_line_entry FOREIGN KEY (entry_id) REFERENCES accounting_entries(id),
  CONSTRAINT fk_acct_line_account FOREIGN KEY (account_id) REFERENCES accounting_accounts(id),
  CONSTRAINT fk_acct_line_position FOREIGN KEY (position_id) REFERENCES positions(id),
  CONSTRAINT chk_acct_line_non_negative CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT chk_acct_line_one_side CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_accounting_entries_period
  ON accounting_entries(entry_date, journal_code, status);

CREATE INDEX idx_accounting_entries_source
  ON accounting_entries(source_module, source_record_id);

CREATE INDEX idx_accounting_entry_lines_entry
  ON accounting_entry_lines(entry_id);

CREATE INDEX idx_accounting_entry_lines_account
  ON accounting_entry_lines(account_id);
