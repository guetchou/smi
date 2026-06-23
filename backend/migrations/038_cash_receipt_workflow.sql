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

INSERT IGNORE INTO permissions
  (code, module, action, libelle, description, `sensitive`, actif)
VALUES
  ('cash.receipt.create', 'cash', 'receipt.create',
   'Créer un encaissement', 'Créer un encaissement en brouillon contrôlé', 0, 1),
  ('cash.receipt.submit', 'cash', 'receipt.submit',
   'Soumettre un encaissement', 'Soumettre un encaissement pour validation administrative', 0, 1),
  ('cash.receipt.approve', 'cash', 'receipt.approve',
   'Valider un encaissement', 'Valider administrativement un encaissement sans impact sur le solde', 1, 1),
  ('cash.receipt.confirm', 'cash', 'receipt.confirm',
   'Confirmer les fonds encaissés', 'Confirmer la réception réelle des fonds et déclencher le ledger', 1, 1),
  ('cash.receipt.dispute', 'cash', 'receipt.dispute',
   'Gérer un litige d’encaissement', 'Rejeter, placer en litige ou retourner un encaissement en brouillon', 1, 1),
  ('cash.receipt.override_self_control', 'cash', 'receipt.override_self_control',
   'Déroger à la séparation des fonctions', 'Autoriser exceptionnellement le créateur à valider ou confirmer avec motif obligatoire', 1, 1),
  ('cash.receipt.configure', 'cash', 'receipt.configure',
   'Configurer le workflow encaissement', 'Configurer les seuils et règles du workflow encaissement', 1, 1);

CREATE INDEX idx_finance_operation_events_status
  ON finance_operation_events(operation_id, next_status, created_at);
