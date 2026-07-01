-- Migration 043 : durcissement du moteur canonique de délégation

ALTER TABLE delegations
  ADD COLUMN delegation_type VARCHAR(30) NOT NULL DEFAULT 'permission';

ALTER TABLE delegations
  ADD COLUMN allow_redelegation TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE delegations
  ADD COLUMN accepted_at DATETIME NULL;

ALTER TABLE delegations
  ADD COLUMN accepted_by INT NULL;

ALTER TABLE delegations
  ADD COLUMN revoked_at DATETIME NULL;

ALTER TABLE delegations
  ADD COLUMN revoked_by INT NULL;

ALTER TABLE delegations
  ADD COLUMN revoke_reason TEXT NULL;

ALTER TABLE delegations
  ADD COLUMN source_type VARCHAR(50) NOT NULL DEFAULT 'manual';

ALTER TABLE delegations
  ADD COLUMN source_id INT NULL;

CREATE INDEX idx_delegations_delegate_active_dates
  ON delegations(delegate_id, active, starts_at, expires_at);

CREATE INDEX idx_delegations_delegator_active
  ON delegations(delegator_id, active);

CREATE INDEX idx_delegations_permission
  ON delegations(permission_id, active);

CREATE INDEX idx_delegations_profile
  ON delegations(profile_id, active);

CREATE INDEX idx_delegations_source
  ON delegations(source_type, source_id);
