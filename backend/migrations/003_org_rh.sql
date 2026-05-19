-- Migration 003 : Organigramme RH — postes, départements, sites, mutations, sorties, sanctions, heures_sup

CREATE TABLE org_postes (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  libelle     VARCHAR(255) NOT NULL,
  description TEXT,
  actif       TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_poste_libelle (libelle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_departements (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  libelle        VARCHAR(255) NOT NULL,
  code           VARCHAR(50),
  responsable_id INT,
  description    TEXT,
  actif          TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_dept_libelle (libelle),
  CONSTRAINT fk_dept_responsable FOREIGN KEY (responsable_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_sites (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  libelle    VARCHAR(255) NOT NULL,
  ville      VARCHAR(100),
  adresse    TEXT,
  actif      TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_site_libelle (libelle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes_mutations (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id      INT NOT NULL,
  date_effet      DATE NOT NULL,
  ancien_poste    VARCHAR(255),
  ancien_dept     VARCHAR(255),
  ancien_site     VARCHAR(255),
  ancien_sup_id   INT,
  ancien_sup_nom  VARCHAR(255),
  nouveau_poste   VARCHAR(255),
  nouveau_dept    VARCHAR(255),
  nouveau_site    VARCHAR(255),
  nouveau_sup_id  INT,
  nouveau_sup_nom VARCHAR(255),
  type_mutation   ENUM('embauche','promotion','transfert','modification','reintegration','sortie') NOT NULL DEFAULT 'modification',
  motif           TEXT,
  valide_par      INT,
  created_by      INT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  statut          VARCHAR(50) DEFAULT 'propose',
  approuve_par    INT,
  approuve_at     DATETIME,
  date_effective  DATE,
  avenant_pdf     VARCHAR(255),
  motif_refus     TEXT,
  CONSTRAINT fk_mutations_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_mutations_employe ON employes_mutations(employe_id, date_effet DESC);
CREATE INDEX idx_mutations_date    ON employes_mutations(date_effet DESC);

CREATE TABLE employes_sortie (
  id                      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id              INT NOT NULL,
  type_sortie             ENUM('demission','licenciement','retraite','fin_contrat','deces','rupture_conventionnelle') NOT NULL DEFAULT 'demission',
  date_annonce            DATE,
  date_fin_preavis        DATE,
  date_depart_effectif    DATE,
  anciennete_annees       DECIMAL(5,2) NOT NULL DEFAULT 0,
  indemnite_licenciement  DECIMAL(15,2) NOT NULL DEFAULT 0,
  indemnite_preavis       DECIMAL(15,2) NOT NULL DEFAULT 0,
  conges_payes_restants   DECIMAL(10,2) NOT NULL DEFAULT 0,
  conges_payes_montant    DECIMAL(15,2) NOT NULL DEFAULT 0,
  autres_indemnites       DECIMAL(15,2) NOT NULL DEFAULT 0,
  solde_tout_compte_total DECIMAL(15,2) NOT NULL DEFAULT 0,
  statut                  ENUM('initie','calcule','valide','solde') NOT NULL DEFAULT 'initie',
  checklist_materiel      TEXT,
  checklist_acces         TEXT,
  notes                   TEXT,
  created_by              INT,
  validated_by            INT,
  validated_at            DATETIME,
  created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sortie_emp      FOREIGN KEY (employe_id)   REFERENCES employes(id),
  CONSTRAINT fk_sortie_created  FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_sortie_valid    FOREIGN KEY (validated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_sortie_employe ON employes_sortie(employe_id);

CREATE TABLE employes_sanctions (
  id                   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id           INT NOT NULL,
  type                 ENUM('avertissement_verbal','avertissement_ecrit','mise_a_pied','licenciement_cause_reelle','autre') NOT NULL DEFAULT 'avertissement_ecrit',
  date_sanction        DATE NOT NULL,
  motif_detaille       TEXT NOT NULL,
  nb_jours_mise_a_pied INT DEFAULT 0,
  retenue_calculee     DECIMAL(15,2) DEFAULT 0,
  document_url         VARCHAR(255),
  statut               ENUM('projet','notifie','conteste','clos') DEFAULT 'projet',
  conteste_motif       TEXT,
  annule_at            DATETIME,
  annule_by            INT,
  annule_motif         TEXT,
  created_by           INT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sanctions_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_sanction_employe ON employes_sanctions(employe_id);
CREATE INDEX idx_sanction_statut  ON employes_sanctions(statut);

CREATE TABLE employes_heures_sup (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id      INT NOT NULL,
  mois            TINYINT(2) NOT NULL,
  annee           YEAR NOT NULL,
  date_heures     DATE NOT NULL,
  nb_heures       DECIMAL(6,2) NOT NULL,
  type            ENUM('normal','dimanche','ferie') NOT NULL DEFAULT 'normal',
  taux_majoration DECIMAL(4,2) NOT NULL DEFAULT 1.25,
  montant_brut    DECIMAL(15,2) NOT NULL DEFAULT 0,
  statut          ENUM('saisi','valide','integre_bulletin') NOT NULL DEFAULT 'saisi',
  valide_par      INT,
  bulletin_id     INT,
  motif           TEXT,
  created_by      INT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_hsup_mois CHECK (mois BETWEEN 1 AND 12),
  CONSTRAINT fk_hsup_emp FOREIGN KEY (employe_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_heures_sup_employe ON employes_heures_sup(employe_id);
CREATE INDEX idx_heures_sup_periode ON employes_heures_sup(annee DESC, mois DESC);
