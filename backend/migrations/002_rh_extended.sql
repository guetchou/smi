-- Migration 002 : RH étendu — fournisseurs, employes_*, audit_logs, employes_conges

CREATE TABLE fournisseurs (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nom        VARCHAR(255) NOT NULL,
  telephone  VARCHAR(50),
  reference  VARCHAR(100),
  nif_rccm   VARCHAR(100),
  adresse    TEXT,
  actif      TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_enfants (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id     INT NOT NULL,
  nom            VARCHAR(255),
  prenom         VARCHAR(255) NOT NULL,
  date_naissance DATE,
  sexe           VARCHAR(5) DEFAULT 'M',
  est_charge     TINYINT(1) DEFAULT 1,
  scolarise      TINYINT(1) DEFAULT 0,
  observation    TEXT,
  CONSTRAINT fk_enfants_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_documents (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id      INT NOT NULL,
  type_document   VARCHAR(100) NOT NULL,
  date_emission   DATE,
  date_expiration DATE,
  statut          VARCHAR(50) DEFAULT 'valide',
  observation     TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_docs_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL,
  record_id  INT NOT NULL,
  action     VARCHAR(50) NOT NULL,
  details    TEXT,
  user_id    INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_audit_table_record ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_user         ON audit_logs(user_id);

CREATE TABLE employes_diplomes (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id      INT NOT NULL,
  intitule        VARCHAR(255) NOT NULL,
  etablissement   VARCHAR(255),
  pays            VARCHAR(100) DEFAULT 'Congo-Brazzaville',
  annee_obtention INT,
  niveau          VARCHAR(50) DEFAULT 'autre',
  observation     TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_diplomes_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_experiences (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id   INT NOT NULL,
  poste        VARCHAR(255) NOT NULL,
  entreprise   VARCHAR(255),
  date_debut   DATE,
  date_fin     DATE,
  type_contrat VARCHAR(50),
  description  TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_exp_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_avances (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id        INT NOT NULL,
  date              DATE NOT NULL,
  montant           DECIMAL(15,2) NOT NULL DEFAULT 0,
  motif             TEXT,
  statut            ENUM('en_cours','rembourse','annule') DEFAULT 'en_cours',
  nb_echeances      INT DEFAULT 1,
  montant_echeance  DECIMAL(15,2) DEFAULT 0,
  montant_rembourse DECIMAL(15,2) DEFAULT 0,
  notes             TEXT,
  created_by        INT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  solde_restant     DECIMAL(15,2) DEFAULT 0,
  annule_at         DATETIME,
  annule_by         INT,
  annule_motif      TEXT,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  statut_workflow   VARCHAR(50) DEFAULT 'approuve',
  operation_id      INT,
  approuve_par      INT,
  approuve_at       DATETIME,
  rejete_par        INT,
  rejete_at         DATETIME,
  motif_rejet       TEXT,
  CONSTRAINT fk_avances_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_avances_employe ON employes_avances(employe_id);
CREATE INDEX idx_avances_statut  ON employes_avances(statut);

CREATE TABLE employes_avances_remboursements (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  avance_id  INT NOT NULL,
  date       DATE NOT NULL,
  montant    DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes      TEXT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rembours_avance FOREIGN KEY (avance_id) REFERENCES employes_avances(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_conges (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id       INT NOT NULL,
  type_conge       ENUM('annuel','maladie','maternite','paternite','sans_solde','autre') DEFAULT 'annuel',
  date_debut       DATE NOT NULL,
  date_fin         DATE NOT NULL,
  nb_jours         INT DEFAULT 0,
  motif            TEXT,
  statut           ENUM('demande','valide_sup','approuve','refuse','termine','annule') DEFAULT 'demande',
  notes            TEXT,
  created_by       INT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  annule_at        DATETIME,
  annule_by        INT,
  annule_motif     TEXT,
  updated_by       INT,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  approuve_par     INT,
  approuve_at      DATETIME,
  refuse_par       INT,
  refuse_at        DATETIME,
  refuse_motif     TEXT,
  annule_statut    VARCHAR(50),
  valide_sup_par   INT,
  valide_sup_at    DATETIME,
  valide_sup_notes TEXT,
  CONSTRAINT fk_conges_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_conges_employe_annee   ON employes_conges(employe_id, date_debut);
CREATE INDEX idx_conges_statut_date     ON employes_conges(statut, date_debut);
CREATE INDEX idx_conges_statut_valide_sup ON employes_conges(statut);

-- FK avance_id sur bulletins_salaire (employes_avances maintenant créée)
ALTER TABLE bulletins_salaire
  ADD CONSTRAINT fk_bul_avance FOREIGN KEY (avance_id) REFERENCES employes_avances(id);
