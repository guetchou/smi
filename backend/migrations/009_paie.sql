-- Migration 009 : Paie avancée — periodes_paie, rectifications, bulletin_envois

CREATE TABLE periodes_paie (
  id                   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mois                 TINYINT(2) NOT NULL,
  annee                YEAR NOT NULL,
  statut               ENUM('ouverte','preparation','controle_rh','controle_finance','soumis_dg','validee_dg','paiement_en_cours','payee_partielle','payee','cloturee','rouverte_exception') NOT NULL DEFAULT 'ouverte',
  nb_bulletins_generes INT NOT NULL DEFAULT 0,
  nb_bulletins_valides INT NOT NULL DEFAULT 0,
  nb_bulletins_payes   INT NOT NULL DEFAULT 0,
  total_brut           DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_net            DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_charges        DECIMAL(15,2) NOT NULL DEFAULT 0,
  soumis_dg_by         INT,
  soumis_dg_at         DATETIME,
  valide_dg_by         INT,
  valide_dg_at         DATETIME,
  cloture_by           INT,
  cloture_at           DATETIME,
  notes                TEXT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_pp_mois CHECK (mois BETWEEN 1 AND 12),
  UNIQUE KEY uq_periode_paie (mois, annee),
  CONSTRAINT fk_pp_soumis  FOREIGN KEY (soumis_dg_by) REFERENCES users(id),
  CONSTRAINT fk_pp_valide  FOREIGN KEY (valide_dg_by) REFERENCES users(id),
  CONSTRAINT fk_pp_cloture FOREIGN KEY (cloture_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_periodes_paie_periode ON periodes_paie(annee DESC, mois DESC);

-- FK periode_id sur bulletins_salaire (periodes_paie maintenant créée)
ALTER TABLE bulletins_salaire
  ADD CONSTRAINT fk_bul_periode FOREIGN KEY (periode_id) REFERENCES periodes_paie(id);

CREATE TABLE rectifications_bulletins (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bulletin_id         INT NOT NULL,
  employe_id          INT NOT NULL,
  periode_id          INT,
  type                ENUM('trop_percu','moins_percu','erreur_prime','erreur_retenue','autre') NOT NULL DEFAULT 'erreur_prime',
  sens                ENUM('debit_agent','credit_agent') NOT NULL DEFAULT 'debit_agent',
  montant             DECIMAL(15,2) NOT NULL,
  motif               TEXT NOT NULL,
  statut              ENUM('brouillon','soumis','approuve','rejete','applique') NOT NULL DEFAULT 'brouillon',
  approuve_par        INT,
  approuve_at         DATETIME,
  applied_bulletin_id INT,
  created_by          INT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_rectif_montant CHECK (montant > 0),
  CONSTRAINT fk_rectif_bulletin FOREIGN KEY (bulletin_id)         REFERENCES bulletins_salaire(id),
  CONSTRAINT fk_rectif_employe  FOREIGN KEY (employe_id)          REFERENCES employes(id),
  CONSTRAINT fk_rectif_periode  FOREIGN KEY (periode_id)          REFERENCES periodes_paie(id),
  CONSTRAINT fk_rectif_approuve FOREIGN KEY (approuve_par)        REFERENCES users(id),
  CONSTRAINT fk_rectif_applied  FOREIGN KEY (applied_bulletin_id) REFERENCES bulletins_salaire(id),
  CONSTRAINT fk_rectif_created  FOREIGN KEY (created_by)          REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rectif_bul_bulletin ON rectifications_bulletins(bulletin_id);
CREATE INDEX idx_rectif_bul_employe  ON rectifications_bulletins(employe_id);
CREATE INDEX idx_rectif_bul_statut   ON rectifications_bulletins(statut);

CREATE TABLE bulletin_envois (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bulletin_id  INT NOT NULL,
  employe_id   INT NOT NULL,
  mois         TINYINT(2) NOT NULL,
  annee        YEAR NOT NULL,
  canal        ENUM('email','pdf_download','impression') NOT NULL DEFAULT 'email',
  destinataire VARCHAR(255),
  statut       ENUM('envoye','echec','en_attente') NOT NULL DEFAULT 'envoye',
  erreur       TEXT,
  avec_pdf     TINYINT(1) NOT NULL DEFAULT 0,
  groupe       TINYINT(1) NOT NULL DEFAULT 0,
  envoye_par   INT,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_be_bulletin FOREIGN KEY (bulletin_id) REFERENCES bulletins_salaire(id),
  CONSTRAINT fk_be_employe  FOREIGN KEY (employe_id)  REFERENCES employes(id),
  CONSTRAINT fk_be_envoye   FOREIGN KEY (envoye_par)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_bul_envois_bulletin ON bulletin_envois(bulletin_id, created_at DESC);
CREATE INDEX idx_bul_envois_mois     ON bulletin_envois(mois, annee, statut);
CREATE INDEX idx_bul_envois_employe  ON bulletin_envois(employe_id, created_at DESC);
