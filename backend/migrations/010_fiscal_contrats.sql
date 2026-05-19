-- Migration 010 : Fiscal, contrats, rapprochements, clôtures, calendrier fiscal, périodes clôturées

CREATE TABLE cnss_declarations (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mois            TINYINT(2) NOT NULL,
  annee           YEAR NOT NULL,
  date_limite     DATE,
  date_depot      DATE,
  statut          ENUM('en_attente','deposee','payee','rejetee') NOT NULL DEFAULT 'en_attente',
  nb_employes     INT DEFAULT 0,
  masse_salariale DECIMAL(15,2) DEFAULT 0,
  cotis_employe   DECIMAL(15,2) DEFAULT 0,
  cotis_patronal  DECIMAL(15,2) DEFAULT 0,
  camu_employe    DECIMAL(15,2) DEFAULT 0,
  camu_patronal   DECIMAL(15,2) DEFAULT 0,
  total_du        DECIMAL(15,2) DEFAULT 0,
  ref_paiement    VARCHAR(255),
  mode_paiement   VARCHAR(50) DEFAULT 'virement_bancaire',
  montant_paye    DECIMAL(15,2) DEFAULT 0,
  date_paiement   DATE,
  notes           TEXT,
  created_by      INT,
  updated_by      INT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_cnss_mois CHECK (mois BETWEEN 1 AND 12),
  UNIQUE KEY uq_cnss_decl (mois, annee),
  CONSTRAINT fk_cnss_created FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_cnss_updated FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cnss_decl_periode ON cnss_declarations(annee DESC, mois DESC);
CREATE INDEX idx_cnss_decl_statut  ON cnss_declarations(statut);

CREATE TABLE cnss_paiements (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  declaration_id INT NOT NULL,
  montant        DECIMAL(15,2) NOT NULL,
  date_paiement  DATE NOT NULL,
  mode_paiement  ENUM('virement_bancaire','cheque','especes','autre') NOT NULL DEFAULT 'virement_bancaire',
  ref_paiement   VARCHAR(255),
  banque         VARCHAR(255),
  notes          TEXT,
  operation_id   INT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cnss_pmt_decl    FOREIGN KEY (declaration_id) REFERENCES cnss_declarations(id),
  CONSTRAINT fk_cnss_pmt_op      FOREIGN KEY (operation_id)   REFERENCES operations(id),
  CONSTRAINT fk_cnss_pmt_created FOREIGN KEY (created_by)     REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cnss_paiements_decl ON cnss_paiements(declaration_id);

CREATE TABLE dgi_declarations (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mois                TINYINT(2) NOT NULL,
  annee               YEAR NOT NULL,
  date_limite         DATE,
  date_depot          DATE,
  statut              ENUM('en_attente','deposee','payee','rejetee','archivee') NOT NULL DEFAULT 'en_attente',
  nb_employes         INT DEFAULT 0,
  masse_salariale     DECIMAL(15,2) DEFAULT 0,
  total_net_imposable DECIMAL(15,2) DEFAULT 0,
  total_irpp          DECIMAL(15,2) DEFAULT 0,
  ref_declaration     VARCHAR(255),
  ref_paiement        VARCHAR(255),
  mode_paiement       VARCHAR(50) DEFAULT 'virement_bancaire',
  montant_paye        DECIMAL(15,2) DEFAULT 0,
  date_paiement       DATE,
  archive_at          DATETIME,
  notes               TEXT,
  created_by          INT,
  updated_by          INT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_dgi_mois CHECK (mois BETWEEN 1 AND 12),
  UNIQUE KEY uq_dgi_decl (mois, annee),
  CONSTRAINT fk_dgi_created FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_dgi_updated FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_dgi_decl_periode ON dgi_declarations(annee DESC, mois DESC);
CREATE INDEX idx_dgi_decl_statut  ON dgi_declarations(statut);

CREATE TABLE dgi_paiements (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  declaration_id INT NOT NULL,
  montant        DECIMAL(15,2) NOT NULL,
  date_paiement  DATE NOT NULL,
  mode_paiement  ENUM('virement_bancaire','cheque','especes','autre') NOT NULL DEFAULT 'virement_bancaire',
  ref_paiement   VARCHAR(255),
  banque         VARCHAR(255),
  notes          TEXT,
  operation_id   INT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dgi_pmt_decl    FOREIGN KEY (declaration_id) REFERENCES dgi_declarations(id),
  CONSTRAINT fk_dgi_pmt_op      FOREIGN KEY (operation_id)   REFERENCES operations(id),
  CONSTRAINT fk_dgi_pmt_created FOREIGN KEY (created_by)     REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_dgi_paiements_decl ON dgi_paiements(declaration_id);

CREATE TABLE contrats (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero              VARCHAR(100) UNIQUE NOT NULL,
  partie_id           INT NOT NULL,
  partie_type         ENUM('client','fournisseur','employe') NOT NULL,
  type_contrat        ENUM('client','fournisseur','prestation','maintenance','abonnement','location','bail','salaire','cadre') NOT NULL,
  objet               VARCHAR(255) NOT NULL,
  date_debut          DATE NOT NULL,
  date_fin            DATE,
  duree_mois          INT,
  renouvellement_auto TINYINT(1) NOT NULL DEFAULT 0,
  montant             DECIMAL(15,2) NOT NULL DEFAULT 0,
  periodicite         ENUM('jour','semaine','mois','trimestre','semestre','annee') NOT NULL DEFAULT 'mois',
  conditions_paiement TEXT,
  penalites           TEXT,
  obligations         TEXT,
  statut              ENUM('brouillon','en_validation','signe','actif','suspendu','resilie','expire','renouvele','cloture','litige') NOT NULL DEFAULT 'brouillon',
  motif_suspension    TEXT,
  motif_resiliation   TEXT,
  date_resiliation    DATE,
  contrat_parent_id   INT,
  notes               TEXT,
  created_by          INT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_contrat_parent  FOREIGN KEY (contrat_parent_id) REFERENCES contrats(id),
  CONSTRAINT fk_contrat_created FOREIGN KEY (created_by)        REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_contrats_partie   ON contrats(partie_id, partie_type);
CREATE INDEX idx_contrats_statut   ON contrats(statut);
CREATE INDEX idx_contrats_numero   ON contrats(numero);
CREATE INDEX idx_contrats_date_fin ON contrats(date_fin);

CREATE TABLE contrats_echeances (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contrat_id    INT NOT NULL,
  date_echeance DATE NOT NULL,
  montant       DECIMAL(15,2) NOT NULL DEFAULT 0,
  statut        ENUM('a_facturer','facture','paye','en_retard','annule') NOT NULL DEFAULT 'a_facturer',
  facture_id    INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ech_contrat FOREIGN KEY (contrat_id) REFERENCES contrats(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_ech_contrat ON contrats_echeances(contrat_id);
CREATE INDEX idx_ech_date    ON contrats_echeances(date_echeance);
CREATE INDEX idx_ech_statut  ON contrats_echeances(statut);

CREATE TABLE rapprochements_bancaires (
  id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  compte_id             INT NOT NULL,
  periode_debut         DATE NOT NULL,
  periode_fin           DATE NOT NULL,
  solde_releve_bancaire DECIMAL(15,2) NOT NULL DEFAULT 0,
  solde_systeme         DECIMAL(15,2) NOT NULL DEFAULT 0,
  ecart                 DECIMAL(15,2) NOT NULL DEFAULT 0,
  statut                ENUM('en_cours','conforme','ecart_positif','ecart_negatif','a_expliquer','valide','corrige') NOT NULL DEFAULT 'en_cours',
  notes_ecart           TEXT,
  validateur_id         INT,
  date_validation       DATETIME,
  created_by            INT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rapp_compte     FOREIGN KEY (compte_id)     REFERENCES positions(id),
  CONSTRAINT fk_rapp_validateur FOREIGN KEY (validateur_id) REFERENCES users(id),
  CONSTRAINT fk_rapp_created    FOREIGN KEY (created_by)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rapproch_compte  ON rapprochements_bancaires(compte_id);
CREATE INDEX idx_rapproch_statut  ON rapprochements_bancaires(statut);
CREATE INDEX idx_rapproch_periode ON rapprochements_bancaires(periode_debut, periode_fin);

CREATE TABLE rapprochements_lignes (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rapprochement_id INT NOT NULL,
  operation_id     INT,
  description      VARCHAR(255) NOT NULL,
  montant          DECIMAL(15,2) NOT NULL DEFAULT 0,
  type             ENUM('encaissement','decaissement','frais_bancaire','cheque_en_attente','depot_non_credite','erreur','autre') NOT NULL DEFAULT 'autre',
  rapproche        TINYINT(1) NOT NULL DEFAULT 0,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rl_rapp FOREIGN KEY (rapprochement_id) REFERENCES rapprochements_bancaires(id) ON DELETE CASCADE,
  CONSTRAINT fk_rl_op   FOREIGN KEY (operation_id)     REFERENCES operations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rapl_rapproch ON rapprochements_lignes(rapprochement_id);
CREATE INDEX idx_rapl_op       ON rapprochements_lignes(operation_id);

CREATE TABLE caisses_clotures (
  id                       INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  position_id              INT NOT NULL,
  date_cloture             DATE NOT NULL,
  caissier_id              INT NOT NULL,
  solde_logiciel_ouverture DECIMAL(15,2) NOT NULL DEFAULT 0,
  solde_logiciel_cloture   DECIMAL(15,2) NOT NULL DEFAULT 0,
  solde_physique_declare   DECIMAL(15,2) NOT NULL DEFAULT 0,
  ecart                    DECIMAL(15,2) NOT NULL DEFAULT 0,
  statut                   ENUM('en_attente','conforme','ecart_positif','ecart_negatif','a_expliquer','valide') NOT NULL DEFAULT 'en_attente',
  validateur_id            INT,
  notes                    TEXT,
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ccl_pos     FOREIGN KEY (position_id)  REFERENCES positions(id),
  CONSTRAINT fk_ccl_caiss   FOREIGN KEY (caissier_id)  REFERENCES users(id),
  CONSTRAINT fk_ccl_valid   FOREIGN KEY (validateur_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cloture_position ON caisses_clotures(position_id);
CREATE INDEX idx_cloture_date     ON caisses_clotures(date_cloture DESC);
CREATE INDEX idx_cloture_statut   ON caisses_clotures(statut);

CREATE TABLE calendrier_fiscal (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  annee            INT NOT NULL,
  type_obligation  ENUM('CNSS_TRIMESTRE','DGI_MENSUEL','IS_ACOMPTE','DAS_ANNUELLE','DECLARATION_STAT') NOT NULL,
  periode_libelle  VARCHAR(100) NOT NULL,
  date_echeance    DATE NOT NULL,
  statut           ENUM('a_faire','en_cours','depose','paye','en_retard','non_applicable') NOT NULL DEFAULT 'a_faire',
  ref_cnss_id      INT,
  ref_dgi_id       INT,
  montant_du       DECIMAL(15,2) DEFAULT 0,
  notes            TEXT,
  rappels_ids      TEXT DEFAULT '[]',
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cal_fiscal (annee, type_obligation, periode_libelle),
  CONSTRAINT fk_cal_cnss FOREIGN KEY (ref_cnss_id) REFERENCES cnss_declarations(id),
  CONSTRAINT fk_cal_dgi  FOREIGN KEY (ref_dgi_id)  REFERENCES dgi_declarations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cal_fiscal_annee  ON calendrier_fiscal(annee DESC, date_echeance ASC);
CREATE INDEX idx_cal_fiscal_statut ON calendrier_fiscal(statut, date_echeance ASC);
CREATE INDEX idx_cal_fiscal_type   ON calendrier_fiscal(type_obligation, annee DESC);

-- periodes_cloturees : sans accent (periodes_clôturees illégal MySQL)
CREATE TABLE periodes_cloturees (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  annee      INT NOT NULL,
  mois       INT NOT NULL,
  cloture_by INT,
  cloture_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes      TEXT,
  UNIQUE KEY uq_periode_cloturee (annee, mois),
  CONSTRAINT fk_pclot_by FOREIGN KEY (cloture_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_periodes_cloturees ON periodes_cloturees(annee, mois);
