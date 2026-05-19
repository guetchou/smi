-- Migration 011 : Grilles salariales, historique salaires, demandes de révision

CREATE TABLE grilles_salariales (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(100) NOT NULL UNIQUE,
  libelle     VARCHAR(255) NOT NULL,
  date_debut  DATE NOT NULL,
  date_fin    DATE,
  statut      ENUM('brouillon','soumis','valide','archive') NOT NULL DEFAULT 'brouillon',
  created_by  INT,
  approved_by INT,
  approved_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_gs_created  FOREIGN KEY (created_by)  REFERENCES users(id),
  CONSTRAINT fk_gs_approved FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE grille_categories (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grille_id       INT NOT NULL,
  code            VARCHAR(100) NOT NULL,
  libelle         VARCHAR(255) NOT NULL,
  salaire_min     DECIMAL(15,2) NOT NULL DEFAULT 0,
  salaire_max     DECIMAL(15,2),
  coefficient_min DECIMAL(8,4),
  coefficient_max DECIMAL(8,4),
  actif           TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_grille_cat (grille_id, code),
  CONSTRAINT fk_gc_grille FOREIGN KEY (grille_id) REFERENCES grilles_salariales(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_grille_cat_grille ON grille_categories(grille_id);

CREATE TABLE grille_echelons (
  id                 INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  categorie_id       INT NOT NULL,
  echelon            INT NOT NULL DEFAULT 1,
  salaire_reference  DECIMAL(15,2) NOT NULL DEFAULT 0,
  salaire_min        DECIMAL(15,2) NOT NULL DEFAULT 0,
  salaire_max        DECIMAL(15,2),
  prime_transport    DECIMAL(15,2) NOT NULL DEFAULT 0,
  prime_logement     DECIMAL(15,2) NOT NULL DEFAULT 0,
  anciennete_min_ans INT NOT NULL DEFAULT 0,
  actif              TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_grille_ech (categorie_id, echelon),
  CONSTRAINT fk_ge_cat FOREIGN KEY (categorie_id) REFERENCES grille_categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_grille_ech_cat ON grille_echelons(categorie_id);

CREATE TABLE demandes_revision_salaire (
  id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id            INT NOT NULL,
  type_revision         ENUM('augmentation','promotion','correction','indexation') NOT NULL DEFAULT 'augmentation',
  date_effet            DATE NOT NULL,
  salaire_actuel        DECIMAL(15,2),
  salaire_propose       DECIMAL(15,2) NOT NULL,
  transport_actuel      DECIMAL(15,2),
  transport_propose     DECIMAL(15,2),
  logement_actuel       DECIMAL(15,2),
  logement_propose      DECIMAL(15,2),
  nouvelle_categorie_id INT,
  nouvel_echelon_id     INT,
  motif                 TEXT NOT NULL,
  document_url          VARCHAR(255),
  statut                ENUM('brouillon','soumis_rh','soumis_dg','approuve','rejete','ajourne','annule','applique') NOT NULL DEFAULT 'brouillon',
  avis_rh               TEXT,
  valide_rh_by          INT,
  valide_rh_at          DATETIME,
  avis_dg               TEXT,
  valide_dg_by          INT,
  valide_dg_at          DATETIME,
  motif_rejet           TEXT,
  created_by            INT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_drs_employe   FOREIGN KEY (employe_id)            REFERENCES employes(id),
  CONSTRAINT fk_drs_cat       FOREIGN KEY (nouvelle_categorie_id) REFERENCES grille_categories(id),
  CONSTRAINT fk_drs_ech       FOREIGN KEY (nouvel_echelon_id)     REFERENCES grille_echelons(id),
  CONSTRAINT fk_drs_rh        FOREIGN KEY (valide_rh_by)          REFERENCES users(id),
  CONSTRAINT fk_drs_dg        FOREIGN KEY (valide_dg_by)          REFERENCES users(id),
  CONSTRAINT fk_drs_created   FOREIGN KEY (created_by)            REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rev_sal_employe ON demandes_revision_salaire(employe_id);
CREATE INDEX idx_rev_sal_statut  ON demandes_revision_salaire(statut);

CREATE TABLE historique_salaires (
  id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id            INT NOT NULL,
  date_effet            DATE NOT NULL,
  ancien_salaire        DECIMAL(15,2),
  nouveau_salaire       DECIMAL(15,2),
  ancien_transport      DECIMAL(15,2),
  nouveau_transport     DECIMAL(15,2),
  ancien_logement       DECIMAL(15,2),
  nouveau_logement      DECIMAL(15,2),
  ancienne_categorie_id INT,
  nouvelle_categorie_id INT,
  ancien_echelon_id     INT,
  nouvel_echelon_id     INT,
  motif                 TEXT NOT NULL,
  type_revision         ENUM('embauche','augmentation','correction','promotion','indexation','regularisation','sanction') NOT NULL DEFAULT 'correction',
  demande_revision_id   INT,
  approved_by           INT,
  approved_at           DATETIME,
  created_by            INT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hs_employe     FOREIGN KEY (employe_id)            REFERENCES employes(id),
  CONSTRAINT fk_hs_anc_cat     FOREIGN KEY (ancienne_categorie_id) REFERENCES grille_categories(id),
  CONSTRAINT fk_hs_new_cat     FOREIGN KEY (nouvelle_categorie_id) REFERENCES grille_categories(id),
  CONSTRAINT fk_hs_anc_ech     FOREIGN KEY (ancien_echelon_id)     REFERENCES grille_echelons(id),
  CONSTRAINT fk_hs_new_ech     FOREIGN KEY (nouvel_echelon_id)     REFERENCES grille_echelons(id),
  CONSTRAINT fk_hs_demande     FOREIGN KEY (demande_revision_id)   REFERENCES demandes_revision_salaire(id),
  CONSTRAINT fk_hs_approved    FOREIGN KEY (approved_by)           REFERENCES users(id),
  CONSTRAINT fk_hs_created     FOREIGN KEY (created_by)            REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_hist_sal_employe ON historique_salaires(employe_id);
CREATE INDEX idx_hist_sal_date    ON historique_salaires(date_effet DESC);
