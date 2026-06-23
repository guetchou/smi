-- Migration 033 : fonctions structurées dans les départements

CREATE TABLE org_departement_fonctions (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  departement_id      INT NOT NULL,
  employe_id          INT NOT NULL,
  fonction_type       VARCHAR(40) NOT NULL,
  rang                INT NOT NULL DEFAULT 0,
  perimetre           VARCHAR(255),
  date_debut          DATE NOT NULL,
  date_fin            DATE,
  titulaire           TINYINT(1) NOT NULL DEFAULT 1,
  actif               TINYINT(1) NOT NULL DEFAULT 1,
  decision_reference  VARCHAR(255),
  created_by          INT,
  approved_by         INT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_org_df_departement FOREIGN KEY (departement_id) REFERENCES org_departements(id),
  CONSTRAINT fk_org_df_employe FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_org_df_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_org_df_approved_by FOREIGN KEY (approved_by) REFERENCES users(id),
  UNIQUE KEY uq_org_df_assignment (departement_id, employe_id, fonction_type, date_debut)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_org_df_departement_actif ON org_departement_fonctions(departement_id, actif, fonction_type, rang);
CREATE INDEX idx_org_df_employe_actif ON org_departement_fonctions(employe_id, actif);
CREATE INDEX idx_org_df_dates ON org_departement_fonctions(date_debut, date_fin);

INSERT IGNORE INTO org_departement_fonctions
  (departement_id, employe_id, fonction_type, rang, perimetre, date_debut, titulaire, actif, decision_reference)
SELECT d.id, d.responsable_id, 'chef', 0, 'Ensemble du département',
       COALESCE(e.date_embauche, CURRENT_DATE), 1, 1, 'Reprise du responsable historique'
FROM org_departements d
JOIN employes e ON e.id = d.responsable_id
WHERE d.actif = 1 AND d.responsable_id IS NOT NULL;
