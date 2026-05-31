-- Migration 022 : Colonnes de provisioning compte utilisateur

ALTER TABLE users
  ADD COLUMN temp_password_hash VARCHAR(255) NULL;

ALTER TABLE users
  ADD COLUMN provisioned_by INT NULL;

ALTER TABLE users
  ADD COLUMN provisioned_at DATETIME NULL;

ALTER TABLE users
  ADD COLUMN date_premier_login DATETIME NULL;

CREATE INDEX idx_users_provisioned_by ON users(provisioned_by);
CREATE INDEX idx_users_provisioned_at ON users(provisioned_at);
