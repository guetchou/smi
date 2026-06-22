-- Migration 032 : cycle de vie des mutations organisationnelles

ALTER TABLE employes_mutations ADD COLUMN submitted_by INT;
ALTER TABLE employes_mutations ADD COLUMN submitted_at DATETIME;
ALTER TABLE employes_mutations ADD COLUMN refused_by INT;
ALTER TABLE employes_mutations ADD COLUMN refused_at DATETIME;
ALTER TABLE employes_mutations ADD COLUMN cancelled_by INT;
ALTER TABLE employes_mutations ADD COLUMN cancelled_at DATETIME;
ALTER TABLE employes_mutations ADD COLUMN applied_by INT;
ALTER TABLE employes_mutations ADD COLUMN applied_at DATETIME;
ALTER TABLE employes_mutations ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE employes_mutations ADD COLUMN revision INT NOT NULL DEFAULT 1;

CREATE INDEX idx_mutations_workflow_status ON employes_mutations(statut, date_effective, date_effet);

UPDATE employes_mutations SET statut='soumis' WHERE statut='propose';
UPDATE employes_mutations SET statut='refuse', refused_at=COALESCE(refused_at, updated_at, created_at) WHERE statut='annule' AND motif_refus IS NOT NULL;
UPDATE employes_mutations SET date_effective=COALESCE(date_effective, date_effet) WHERE statut IN ('approuve','effectif');

INSERT INTO permissions (code, module, action, libelle, description, `sensitive`, actif)
VALUES
  ('hr.mutation.create', 'hr', 'mutation_create', 'Créer une mutation RH', 'Créer et modifier les brouillons de mutation organisationnelle', 0, 1),
  ('hr.mutation.submit', 'hr', 'mutation_submit', 'Soumettre une mutation RH', 'Soumettre une mutation organisationnelle à approbation', 0, 1),
  ('hr.mutation.approve', 'hr', 'mutation_approve', 'Approuver une mutation RH', 'Approuver ou refuser une mutation organisationnelle', 1, 1),
  ('hr.mutation.apply', 'hr', 'mutation_apply', 'Appliquer une mutation RH', 'Appliquer manuellement les mutations arrivées à date d’effet', 1, 1),
  ('hr.mutation.cancel', 'hr', 'mutation_cancel', 'Annuler une mutation RH', 'Annuler une mutation non encore effective', 0, 1)
ON DUPLICATE KEY UPDATE libelle=VALUES(libelle), description=VALUES(description), `sensitive`=VALUES(`sensitive`), actif=1;

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, p.id, 1
FROM profiles pr
JOIN permissions p ON p.code IN ('hr.mutation.create','hr.mutation.submit','hr.mutation.cancel')
WHERE pr.code IN ('admin','rh','dg');

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, p.id, 1
FROM profiles pr
JOIN permissions p ON p.code IN ('hr.mutation.approve','hr.mutation.apply')
WHERE pr.code IN ('admin','dg');
