-- Gouvernance stricte des délégations

ALTER TABLE permissions
  ADD COLUMN delegable TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE delegations
  ADD COLUMN parent_delegation_id INT NULL;

CREATE INDEX idx_delegations_parent
  ON delegations(parent_delegation_id);

-- Les permissions sensibles sont non délégables par défaut.
-- Une réactivation devra être une décision explicite d'administration.
UPDATE permissions
SET delegable=0
WHERE sensitive=1;
