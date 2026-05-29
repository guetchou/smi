-- Migration 001 : Tables core — users, positions, categories, employes, operations, budgets, parametres, bulletins_salaire

CREATE TABLE users (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nom                 VARCHAR(255) NOT NULL,
  email               VARCHAR(255) UNIQUE NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  role                ENUM('admin','caissier','finance','rh','lecteur','dg','assistante_direction','delegue') NOT NULL DEFAULT 'caissier',
  actif               TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  sous_role           VARCHAR(255),
  photo_url           VARCHAR(255),
  must_change_password TINYINT(1) DEFAULT 0,
  employe_id          INT,
  last_seen_at        DATETIME,
  last_ip             VARCHAR(45),
  roles               TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_users_last_seen ON users(last_seen_at);

CREATE TABLE positions (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(50) UNIQUE NOT NULL,
  libelle       VARCHAR(255) NOT NULL,
  type          ENUM('caisse','banque','autre') NOT NULL DEFAULT 'caisse',
  solde_initial DECIMAL(15,2) DEFAULT 0,
  actif         TINYINT(1) DEFAULT 1,
  couleur       VARCHAR(20) DEFAULT '#6366f1',
  ordre         INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (
  id      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nom     VARCHAR(255) NOT NULL,
  type    ENUM('encaissement','decaissement','recette','depense') NOT NULL,
  couleur VARCHAR(20) DEFAULT '#6366f1',
  icone   VARCHAR(50) DEFAULT 'circle',
  actif   TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employes (
  id                        INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nom                       VARCHAR(255) NOT NULL,
  prenom                    VARCHAR(255) NOT NULL,
  poste                     VARCHAR(255),
  type                      ENUM('permanent','stagiaire') NOT NULL DEFAULT 'permanent',
  salaire_base              DECIMAL(15,2) DEFAULT 0,
  cnss                      VARCHAR(100),
  camu                      VARCHAR(100),
  email                     VARCHAR(255),
  telephone                 VARCHAR(50),
  actif                     TINYINT(1) DEFAULT 1,
  created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
  mode_paiement             VARCHAR(50) DEFAULT 'especes',
  banque                    VARCHAR(255),
  numero_compte             VARCHAR(100),
  matricule                 VARCHAR(50),
  sexe                      VARCHAR(5) DEFAULT 'M',
  date_naissance            DATE,
  lieu_naissance            VARCHAR(255),
  nationalite               VARCHAR(100) DEFAULT 'Congolaise',
  situation_matrimoniale    VARCHAR(50) DEFAULT 'celibataire',
  nb_enfants                INT DEFAULT 0,
  nb_enfants_charge         INT DEFAULT 0,
  telephone2                VARCHAR(50),
  adresse                   TEXT,
  num_piece_identite        VARCHAR(100),
  type_piece_identite       VARCHAR(50),
  date_expiration_identite  DATE,
  date_embauche             DATE,
  type_contrat              VARCHAR(20) DEFAULT 'cdi',
  date_debut_contrat        DATE,
  date_fin_contrat          DATE,
  periode_essai_mois        INT DEFAULT 0,
  date_fin_essai            DATE,
  departement               VARCHAR(255),
  superieur_hierarchique    VARCHAR(255),
  site                      VARCHAR(255),
  statut_dossier            VARCHAR(50) DEFAULT 'actif',
  motif_sortie              TEXT,
  date_sortie               DATE,
  prime_transport           DECIMAL(15,2) DEFAULT 0,
  prime_logement            DECIMAL(15,2) DEFAULT 0,
  photo_url                 VARCHAR(255),
  updated_at                DATETIME,
  conges_acquis_annuel      DECIMAL(10,2) DEFAULT 0,
  conges_pris_annuel        DECIMAL(10,2) DEFAULT 0,
  conges_solde_annuel       DECIMAL(10,2) DEFAULT 0,
  conges_report_n1          DECIMAL(10,2) DEFAULT 0,
  conges_maladie_droit      DECIMAL(10,2) DEFAULT 15,
  conges_maladie_pris       DECIMAL(10,2) DEFAULT 0,
  conges_maladie_solde      DECIMAL(10,2) DEFAULT 15,
  superieur_id              INT,
  grille_categorie_id       INT,
  grille_echelon_id         INT,
  contrat_id                INT,
  email_professionnel       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX idx_employes_matricule ON employes((IF(matricule IS NULL OR matricule = '', NULL, matricule)));
CREATE UNIQUE INDEX idx_employes_num_piece ON employes((IF(num_piece_identite IS NULL OR num_piece_identite = '', NULL, num_piece_identite)));

CREATE TABLE operations (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  date                DATE NOT NULL,
  num_piece           VARCHAR(100),
  libelle             VARCHAR(255) NOT NULL,
  tiers               VARCHAR(255),
  montant             DECIMAL(15,2) NOT NULL DEFAULT 0,
  type_op             ENUM('encaissement','decaissement','virement') NOT NULL DEFAULT 'decaissement',
  position_id         INT NOT NULL DEFAULT 1,
  position_source_id  INT,
  solde_position      DECIMAL(15,2) DEFAULT 0,
  categorie_id        INT,
  mode_reglement      ENUM('especes','cheque','virement_bancaire','mobile_money','compensation','autres') DEFAULT 'especes',
  ref_externe         VARCHAR(255),
  piece_justificative VARCHAR(500),
  decharge_signee     TINYINT(1) DEFAULT 0,
  employe_id          INT,
  statut              ENUM('valide','annule','en_attente') DEFAULT 'valide',
  dec_statut          VARCHAR(50),
  submitted_by        INT,
  submitted_at        DATETIME,
  validated_by        INT,
  validated_at        DATETIME,
  paid_by             INT,
  paid_at             DATETIME,
  annule_by           INT,
  annule_at           DATETIME,
  annule_motif        TEXT,
  bulletin_id         INT,
  motif_rejet         TEXT,
  rejete_par          INT,
  rejete_at           DATETIME,
  resoumis_depuis     INT,
  caisse_dest_id      INT,
  created_by          INT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_op_position    FOREIGN KEY (position_id)        REFERENCES positions(id),
  CONSTRAINT fk_op_pos_src     FOREIGN KEY (position_source_id) REFERENCES positions(id),
  CONSTRAINT fk_op_categorie   FOREIGN KEY (categorie_id)       REFERENCES categories(id),
  CONSTRAINT fk_op_employe     FOREIGN KEY (employe_id)         REFERENCES employes(id),
  CONSTRAINT fk_op_created_by  FOREIGN KEY (created_by)         REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_operations_date     ON operations(date DESC);
CREATE INDEX idx_operations_position ON operations(position_id, date DESC);
CREATE INDEX idx_operations_type     ON operations(type_op, date DESC);
CREATE INDEX idx_operations_statut   ON operations(statut);
CREATE INDEX idx_operations_dec_statut ON operations(dec_statut);

CREATE TABLE budgets (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mois          TINYINT(2) NOT NULL,
  annee         YEAR NOT NULL,
  categorie_id  INT NOT NULL,
  montant_prevu DECIMAL(15,2) DEFAULT 0,
  notes         TEXT,
  CONSTRAINT chk_budget_mois CHECK (mois BETWEEN 1 AND 12),
  UNIQUE KEY uq_budget_periode (mois, annee, categorie_id),
  CONSTRAINT fk_budget_cat FOREIGN KEY (categorie_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE parametres (
  cle    VARCHAR(100) NOT NULL PRIMARY KEY,
  valeur TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bulletins_salaire (
  id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id            INT NOT NULL,
  mois                  TINYINT(2) NOT NULL,
  annee                 YEAR NOT NULL,
  salaire_base          DECIMAL(15,2) DEFAULT 0,
  prime_transport       DECIMAL(15,2) DEFAULT 0,
  prime_logement        DECIMAL(15,2) DEFAULT 0,
  autres_primes         DECIMAL(15,2) DEFAULT 0,
  brut                  DECIMAL(15,2) DEFAULT 0,
  cnss_employe          DECIMAL(15,2) DEFAULT 0,
  camu_employe          DECIMAL(15,2) DEFAULT 0,
  irpp                  DECIMAL(15,2) DEFAULT 0,
  total_retenues        DECIMAL(15,2) DEFAULT 0,
  net_imposable         DECIMAL(15,2) DEFAULT 0,
  net_a_payer           DECIMAL(15,2) DEFAULT 0,
  cnss_patronal         DECIMAL(15,2) DEFAULT 0,
  camu_patronal         DECIMAL(15,2) DEFAULT 0,
  cout_total_employeur  DECIMAL(15,2) DEFAULT 0,
  statut                ENUM('brouillon','valide','paye') DEFAULT 'brouillon',
  operation_id          INT,
  notes                 TEXT,
  created_by            INT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  annule_at             DATETIME,
  annule_by             INT,
  annule_motif          TEXT,
  retenue_avance        DECIMAL(15,2) DEFAULT 0,
  avance_id             INT,
  net_a_verser          DECIMAL(15,2) DEFAULT 0,
  lignes_custom         TEXT,
  decharge_signee       TINYINT(1) DEFAULT 0,
  generated_by          INT,
  validated_by          INT,
  type                  VARCHAR(50) DEFAULT 'normal',
  reference_bulletin_id INT,
  periode_id            INT,
  dernier_envoi_at      DATETIME,
  dernier_envoi_dest    VARCHAR(255),
  nb_envois             INT DEFAULT 0,
  CONSTRAINT chk_bul_mois CHECK (mois BETWEEN 1 AND 12),
  UNIQUE KEY uq_bulletin_mois (employe_id, mois, annee),
  CONSTRAINT fk_bul_employe FOREIGN KEY (employe_id)   REFERENCES employes(id),
  CONSTRAINT fk_bul_op      FOREIGN KEY (operation_id) REFERENCES operations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_bulletins_employe ON bulletins_salaire(employe_id);
CREATE INDEX idx_bulletins_periode ON bulletins_salaire(annee, mois);
CREATE INDEX idx_bulletins_statut  ON bulletins_salaire(statut);
CREATE INDEX idx_bulletin_operation_id ON bulletins_salaire((IF(operation_id IS NULL, NULL, operation_id)));
