-- Migration 035 : unités internes et liaison des postes au référentiel officiel

CREATE TABLE org_unites (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entreprise_id     INT NULL,
  departement_id    INT NOT NULL,
  parent_id         INT NULL,
  type_unite        ENUM('service','section','cellule','bureau','equipe') NOT NULL,
  code              VARCHAR(60) NULL,
  libelle           VARCHAR(255) NOT NULL,
  description       TEXT NULL,
  version           INT NOT NULL DEFAULT 1,
  actif             TINYINT(1) NOT NULL DEFAULT 1,
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_org_unite_entreprise FOREIGN KEY (entreprise_id) REFERENCES entreprise(id),
  CONSTRAINT fk_org_unite_departement FOREIGN KEY (departement_id) REFERENCES org_departements(id),
  CONSTRAINT fk_org_unite_parent FOREIGN KEY (parent_id) REFERENCES org_unites(id),
  CONSTRAINT fk_org_unite_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY uq_org_unite_dept_libelle (departement_id, libelle),
  UNIQUE KEY uq_org_unite_dept_code (departement_id, code),
  INDEX idx_org_unite_parent (parent_id, actif),
  INDEX idx_org_unite_departement (departement_id, actif, type_unite)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE employes ADD COLUMN poste_id INT NULL AFTER poste;
ALTER TABLE employes ADD CONSTRAINT fk_employe_poste_officiel FOREIGN KEY (poste_id) REFERENCES org_postes(id);
ALTER TABLE employes ADD INDEX idx_employe_poste_id (poste_id);

UPDATE employes e
JOIN org_postes p ON LOWER(TRIM(p.libelle))=LOWER(TRIM(e.poste))
SET e.poste_id=p.id
WHERE e.poste_id IS NULL AND COALESCE(e.poste,'')<>'';

ALTER TABLE org_departement_fonctions ADD COLUMN unite_id INT NULL AFTER departement_id;
ALTER TABLE org_departement_fonctions ADD COLUMN poste_id INT NULL AFTER employe_id;
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_unite FOREIGN KEY (unite_id) REFERENCES org_unites(id);
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_poste FOREIGN KEY (poste_id) REFERENCES org_postes(id);
ALTER TABLE org_departement_fonctions ADD INDEX idx_org_df_unite (unite_id, statut, actif);
ALTER TABLE org_departement_fonctions ADD INDEX idx_org_df_poste (poste_id);

UPDATE org_departement_fonctions f
JOIN employes e ON e.id=f.employe_id
SET f.poste_id=e.poste_id
WHERE f.poste_id IS NULL;
