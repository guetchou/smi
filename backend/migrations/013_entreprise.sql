-- Migration 013 : Entreprise — référentiel central + historique modifications

CREATE TABLE entreprise (
  id                      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  raison_sociale          VARCHAR(255) NOT NULL DEFAULT '',
  nom_commercial          VARCHAR(255) DEFAULT '',
  forme_juridique         VARCHAR(100) DEFAULT '',
  rccm                    VARCHAR(100) DEFAULT '',
  nif                     VARCHAR(100) DEFAULT '',
  secteur_activite        VARCHAR(255) DEFAULT '',
  date_creation           VARCHAR(50) DEFAULT '',
  capital_social          VARCHAR(100) DEFAULT '',
  regime_fiscal           VARCHAR(100) DEFAULT '',
  adresse                 TEXT DEFAULT (''),
  ville                   VARCHAR(100) DEFAULT 'Brazzaville',
  pays                    VARCHAR(100) DEFAULT 'Congo-Brazzaville',
  telephone               VARCHAR(50) DEFAULT '',
  email                   VARCHAR(255) DEFAULT '',
  site_web                VARCHAR(255) DEFAULT '',
  directeur_general       VARCHAR(255) DEFAULT '',
  responsable_rh          VARCHAR(255) DEFAULT '',
  responsable_finance     VARCHAR(255) DEFAULT '',
  signataire_paie         VARCHAR(255) DEFAULT '',
  signataire_decaissement VARCHAR(255) DEFAULT '',
  devise                  VARCHAR(10) DEFAULT 'XAF',
  exercice_debut          VARCHAR(10) DEFAULT '01-01',
  exercice_fin            VARCHAR(10) DEFAULT '12-31',
  fuseau_horaire          VARCHAR(50) DEFAULT 'Africa/Brazzaville',
  logo_path               VARCHAR(500) DEFAULT '',
  cachet_path             VARCHAR(500) DEFAULT '',
  signature_path          VARCHAR(500) DEFAULT '',
  actif                   TINYINT(1) DEFAULT 1,
  created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by              INT,
  updated_by              INT,
  CONSTRAINT fk_ent_created FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_ent_updated FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE entreprise_historique (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entreprise_id INT NOT NULL,
  snapshot      TEXT NOT NULL,
  modifie_par   INT,
  modifie_le    DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_eh_entreprise FOREIGN KEY (entreprise_id) REFERENCES entreprise(id),
  CONSTRAINT fk_eh_modifie    FOREIGN KEY (modifie_par)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_entreprise_hist ON entreprise_historique(entreprise_id);
