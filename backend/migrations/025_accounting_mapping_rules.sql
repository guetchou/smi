-- Migration 025 : socle parametrable de comptabilisation OHADA

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(30) NOT NULL UNIQUE,
  label       VARCHAR(255) NOT NULL,
  account_class VARCHAR(10),
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounting_mapping_rules (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operation_type      ENUM('encaissement','decaissement','virement') NOT NULL,
  operation_nature    VARCHAR(100) NOT NULL DEFAULT '*',
  payment_method      VARCHAR(50) NOT NULL DEFAULT '*',
  position_type       VARCHAR(50) NOT NULL DEFAULT '*',
  third_party_type    VARCHAR(50) NOT NULL DEFAULT '*',
  debit_account_id    INT NOT NULL,
  credit_account_id   INT NOT NULL,
  journal_code        VARCHAR(30) NOT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_acct_map_debit  FOREIGN KEY (debit_account_id)  REFERENCES accounting_accounts(id),
  CONSTRAINT fk_acct_map_credit FOREIGN KEY (credit_account_id) REFERENCES accounting_accounts(id),
  CONSTRAINT chk_acct_map_distinct_accounts CHECK (debit_account_id <> credit_account_id),
  UNIQUE KEY uq_accounting_mapping_rule (
    operation_type, operation_nature, payment_method, position_type, third_party_type
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO accounting_accounts (code, label, account_class) VALUES
  ('101', 'Capital social', '1'),
  ('401', 'Fournisseurs', '4'),
  ('409', 'Fournisseurs débiteurs', '4'),
  ('411', 'Clients', '4'),
  ('419', 'Clients créditeurs', '4'),
  ('462', 'Associés - comptes courants', '4'),
  ('521', 'Banques', '5'),
  ('571', 'Caisse', '5'),
  ('627', 'Services bancaires et assimilés', '6'),
  ('631', 'Frais bancaires', '6');

CREATE INDEX idx_accounting_mapping_lookup
  ON accounting_mapping_rules(operation_type, operation_nature, payment_method, position_type, third_party_type, is_active);
