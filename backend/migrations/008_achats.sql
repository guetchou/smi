-- Migration 008 : Module achats — demandes_achat, BC, réceptions, factures fournisseurs

CREATE TABLE demandes_achat (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero            VARCHAR(100) UNIQUE,
  date_demande      DATE NOT NULL DEFAULT (CURRENT_DATE),
  service_demandeur VARCHAR(255) NOT NULL,
  demandeur_id      INT,
  demandeur_nom     VARCHAR(255) NOT NULL,
  statut            VARCHAR(50) NOT NULL DEFAULT 'brouillon',
  commentaires      TEXT,
  transport         DECIMAL(15,2) DEFAULT 0,
  total_articles    DECIMAL(15,2) DEFAULT 0,
  total_general     DECIMAL(15,2) DEFAULT 0,
  approuve_par_id   INT,
  approuve_par_nom  VARCHAR(255),
  date_approbation  DATETIME,
  motif_rejet       TEXT,
  decaissement_id   INT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_da_demandeur FOREIGN KEY (demandeur_id)   REFERENCES users(id),
  CONSTRAINT fk_da_approuve  FOREIGN KEY (approuve_par_id) REFERENCES users(id),
  CONSTRAINT fk_da_decaiss   FOREIGN KEY (decaissement_id) REFERENCES operations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_demandes_achat_statut    ON demandes_achat(statut);
CREATE INDEX idx_demandes_achat_demandeur ON demandes_achat(demandeur_id);

CREATE TABLE demandes_achat_lignes (
  id                     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  demande_id             INT NOT NULL,
  designation            VARCHAR(255) NOT NULL,
  quantite               VARCHAR(100) NOT NULL,
  montant                DECIMAL(15,2) NOT NULL DEFAULT 0,
  fournisseur_recommande VARCHAR(255),
  ordre                  INT DEFAULT 0,
  CONSTRAINT fk_dal_demande FOREIGN KEY (demande_id) REFERENCES demandes_achat(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delegations_approbation (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  delegant_id INT NOT NULL,
  delegue_id  INT NOT NULL,
  date_debut  DATE NOT NULL,
  date_fin    DATE,
  motif       TEXT,
  actif       TINYINT(1) DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_delappr_delegant FOREIGN KEY (delegant_id) REFERENCES users(id),
  CONSTRAINT fk_delappr_delegue  FOREIGN KEY (delegue_id)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bons_commandes_fournisseurs (
  id                   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero               VARCHAR(100) UNIQUE NOT NULL,
  demande_achat_id     INT,
  fournisseur_id       INT,
  statut               ENUM('brouillon','soumis','valide','envoye','accepte_fournisseur','partiellement_livre','livre','annule','cloture') NOT NULL DEFAULT 'brouillon',
  montant_ht           DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_taxes        DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc          DECIMAL(15,2) NOT NULL DEFAULT 0,
  delai_livraison      VARCHAR(100),
  lieu_livraison       VARCHAR(255),
  conditions_paiement  TEXT,
  responsable_achat_id INT,
  motif_annulation     TEXT,
  notes                TEXT,
  created_by           INT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bc_da          FOREIGN KEY (demande_achat_id)     REFERENCES demandes_achat(id),
  CONSTRAINT fk_bc_fournisseur FOREIGN KEY (fournisseur_id)       REFERENCES fournisseurs(id),
  CONSTRAINT fk_bc_responsable FOREIGN KEY (responsable_achat_id) REFERENCES users(id),
  CONSTRAINT fk_bc_created     FOREIGN KEY (created_by)           REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_bc_fournisseur ON bons_commandes_fournisseurs(fournisseur_id);
CREATE INDEX idx_bc_statut      ON bons_commandes_fournisseurs(statut);
CREATE INDEX idx_bc_numero      ON bons_commandes_fournisseurs(numero);
CREATE INDEX idx_bc_da          ON bons_commandes_fournisseurs(demande_achat_id);

CREATE TABLE bons_commandes_lignes (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bc_id          INT NOT NULL,
  produit_id     INT,
  designation    VARCHAR(255) NOT NULL,
  quantite       DECIMAL(10,3) NOT NULL DEFAULT 1,
  quantite_recue DECIMAL(10,3) NOT NULL DEFAULT 0,
  prix_unitaire  DECIMAL(15,2) NOT NULL DEFAULT 0,
  taux_taxe      DECIMAL(5,2) NOT NULL DEFAULT 0,
  montant_ht     DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc    DECIMAL(15,2) NOT NULL DEFAULT 0,
  ordre          INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_bcl_bc      FOREIGN KEY (bc_id)      REFERENCES bons_commandes_fournisseurs(id) ON DELETE CASCADE,
  CONSTRAINT fk_bcl_produit FOREIGN KEY (produit_id) REFERENCES produits(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_bc_lignes_bc ON bons_commandes_lignes(bc_id);

CREATE TABLE receptions (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero         VARCHAR(100) UNIQUE NOT NULL,
  bc_id          INT NOT NULL,
  statut         ENUM('en_cours','reception_partielle','reception_totale','ecart_quantite','non_conforme','retourne','accepte') NOT NULL DEFAULT 'en_cours',
  date_reception DATE NOT NULL,
  notes          TEXT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rec_bc      FOREIGN KEY (bc_id)      REFERENCES bons_commandes_fournisseurs(id),
  CONSTRAINT fk_rec_created FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_receptions_bc     ON receptions(bc_id);
CREATE INDEX idx_receptions_statut ON receptions(statut);

CREATE TABLE receptions_lignes (
  id                 INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reception_id       INT NOT NULL,
  bc_ligne_id        INT NOT NULL,
  quantite_commandee DECIMAL(10,3) NOT NULL DEFAULT 0,
  quantite_recue     DECIMAL(10,3) NOT NULL DEFAULT 0,
  quantite_conforme  DECIMAL(10,3) NOT NULL DEFAULT 0,
  ecart              DECIMAL(10,3) NOT NULL DEFAULT 0,
  motif_ecart        TEXT,
  statut_ligne       ENUM('conforme','ecart','non_conforme','retourne') NOT NULL DEFAULT 'conforme',
  CONSTRAINT fk_rl_reception FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rl_bc_ligne  FOREIGN KEY (bc_ligne_id)  REFERENCES bons_commandes_lignes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rec_lignes_rec ON receptions_lignes(reception_id);
CREATE INDEX idx_rec_lignes_bc  ON receptions_lignes(bc_ligne_id);

CREATE TABLE factures_fournisseurs (
  id                          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero_facture_fournisseur  VARCHAR(255) NOT NULL,
  fournisseur_id              INT NOT NULL,
  bc_id                       INT,
  reception_id                INT,
  statut                      ENUM('recue','a_verifier','validee','contestee','partiellement_payee','payee','annulee') NOT NULL DEFAULT 'recue',
  montant_ht                  DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc                 DECIMAL(15,2) NOT NULL DEFAULT 0,
  date_facture                DATE NOT NULL,
  date_echeance               DATE,
  montant_paye                DECIMAL(15,2) NOT NULL DEFAULT 0,
  reste_a_payer               DECIMAL(15,2) NOT NULL DEFAULT 0,
  motif_contestation          TEXT,
  notes                       TEXT,
  operation_id                INT,
  rapprochement_statut        ENUM('non_rapproche','conforme','ecart_acceptable','ecart_bloquant','conteste') DEFAULT 'non_rapproche',
  rapprochement_at            DATETIME,
  rapprochement_by            INT,
  ecart_montant               DECIMAL(15,2) DEFAULT 0,
  ecart_quantite              DECIMAL(10,3) DEFAULT 0,
  ecart_motif                 TEXT,
  created_by                  INT,
  created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ff (numero_facture_fournisseur, fournisseur_id),
  CONSTRAINT fk_ff_fourn    FOREIGN KEY (fournisseur_id) REFERENCES fournisseurs(id),
  CONSTRAINT fk_ff_bc       FOREIGN KEY (bc_id)          REFERENCES bons_commandes_fournisseurs(id),
  CONSTRAINT fk_ff_rec      FOREIGN KEY (reception_id)   REFERENCES receptions(id),
  CONSTRAINT fk_ff_op       FOREIGN KEY (operation_id)   REFERENCES operations(id),
  CONSTRAINT fk_ff_rapp_by  FOREIGN KEY (rapprochement_by) REFERENCES users(id),
  CONSTRAINT fk_ff_created  FOREIGN KEY (created_by)     REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_ff_fournisseur ON factures_fournisseurs(fournisseur_id);
CREATE INDEX idx_ff_statut      ON factures_fournisseurs(statut);
CREATE INDEX idx_ff_bc          ON factures_fournisseurs(bc_id);
CREATE INDEX idx_ff_echeance    ON factures_fournisseurs(date_echeance);
