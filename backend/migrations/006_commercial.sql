-- Migration 006 : Module commercial — clients, devis, factures clients, relances

CREATE TABLE clients (
  id                      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero_client           VARCHAR(100) UNIQUE NOT NULL,
  nom                     VARCHAR(255) NOT NULL,
  type                    ENUM('particulier','entreprise','administration','ong','association') NOT NULL DEFAULT 'particulier',
  telephone               VARCHAR(50),
  whatsapp                VARCHAR(50),
  email                   VARCHAR(255),
  adresse                 TEXT,
  ville                   VARCHAR(100),
  pays                    VARCHAR(100) DEFAULT 'Congo',
  rccm                    VARCHAR(100),
  nif                     VARCHAR(100),
  contact_principal       VARCHAR(255),
  categorie_client        VARCHAR(100),
  plafond_credit          DECIMAL(15,2) NOT NULL DEFAULT 0,
  delai_paiement_autorise INT NOT NULL DEFAULT 30,
  statut                  ENUM('actif','suspendu','mauvais_payeur','archive') NOT NULL DEFAULT 'actif',
  solde_crediteur         DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes                   TEXT,
  created_by              INT,
  created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cli_created FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_clients_statut ON clients(statut);
CREATE INDEX idx_clients_nom    ON clients(nom);
CREATE INDEX idx_clients_numero ON clients(numero_client);

CREATE TABLE devis (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero              VARCHAR(100) UNIQUE NOT NULL,
  client_id           INT NOT NULL,
  objet               VARCHAR(255) NOT NULL,
  date_devis          DATE NOT NULL,
  date_validite       DATE,
  statut              ENUM('brouillon','envoye','vu_par_client','en_negociation','accepte','refuse','expire','annule','converti') NOT NULL DEFAULT 'brouillon',
  montant_ht          DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_taxes       DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc         DECIMAL(15,2) NOT NULL DEFAULT 0,
  remise_globale      DECIMAL(15,2) NOT NULL DEFAULT 0,
  conditions_paiement TEXT,
  delai_livraison     VARCHAR(100),
  commercial_id       INT,
  motif_refus         TEXT,
  motif_annulation    TEXT,
  version             INT NOT NULL DEFAULT 1,
  devis_parent_id     INT,
  notes               TEXT,
  date_envoi          DATETIME,
  date_acceptation    DATETIME,
  preuve_acceptation  VARCHAR(255),
  created_by          INT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_devis_client   FOREIGN KEY (client_id)      REFERENCES clients(id),
  CONSTRAINT fk_devis_parent   FOREIGN KEY (devis_parent_id) REFERENCES devis(id),
  CONSTRAINT fk_devis_commer   FOREIGN KEY (commercial_id)  REFERENCES users(id),
  CONSTRAINT fk_devis_created  FOREIGN KEY (created_by)     REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_devis_client ON devis(client_id);
CREATE INDEX idx_devis_statut ON devis(statut);
CREATE INDEX idx_devis_numero ON devis(numero);
CREATE INDEX idx_devis_date   ON devis(date_devis DESC);

CREATE TABLE devis_lignes (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  devis_id      INT NOT NULL,
  type          ENUM('produit','service') NOT NULL DEFAULT 'service',
  designation   VARCHAR(255) NOT NULL,
  quantite      DECIMAL(10,3) NOT NULL DEFAULT 1,
  prix_unitaire DECIMAL(15,2) NOT NULL DEFAULT 0,
  remise        DECIMAL(5,2) NOT NULL DEFAULT 0,
  taux_taxe     DECIMAL(5,2) NOT NULL DEFAULT 0,
  montant_ht    DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc   DECIMAL(15,2) NOT NULL DEFAULT 0,
  ordre         INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_dl_devis FOREIGN KEY (devis_id) REFERENCES devis(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_devis_lignes_devis ON devis_lignes(devis_id);

CREATE TABLE factures_clients (
  id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  numero                VARCHAR(100) UNIQUE NOT NULL,
  client_id             INT NOT NULL,
  devis_id              INT,
  contrat_id            INT,
  type                  ENUM('proforma','definitive','acompte','solde','recurrente','avoir','corrective','partielle','mixte') NOT NULL DEFAULT 'definitive',
  objet                 VARCHAR(255) NOT NULL,
  date_facture          DATE NOT NULL,
  date_echeance         DATE,
  statut                ENUM('brouillon','emise','envoyee','partiellement_payee','payee','en_retard','contestee','annulee','avoir_emis','irrecouvrable') NOT NULL DEFAULT 'brouillon',
  montant_ht            DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_taxes         DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc           DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_paye          DECIMAL(15,2) NOT NULL DEFAULT 0,
  reste_a_payer         DECIMAL(15,2) NOT NULL DEFAULT 0,
  mode_paiement_attendu VARCHAR(50) DEFAULT 'especes',
  commercial_id         INT,
  motif_annulation      TEXT,
  notes                 TEXT,
  created_by            INT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_fc_client   FOREIGN KEY (client_id)    REFERENCES clients(id),
  CONSTRAINT fk_fc_devis    FOREIGN KEY (devis_id)     REFERENCES devis(id),
  CONSTRAINT fk_fc_commer   FOREIGN KEY (commercial_id) REFERENCES users(id),
  CONSTRAINT fk_fc_created  FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_fac_cli_client   ON factures_clients(client_id);
CREATE INDEX idx_fac_cli_statut   ON factures_clients(statut);
CREATE INDEX idx_fac_cli_numero   ON factures_clients(numero);
CREATE INDEX idx_fac_cli_echeance ON factures_clients(date_echeance);
CREATE INDEX idx_fac_cli_devis    ON factures_clients(devis_id);

CREATE TABLE factures_clients_lignes (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facture_id    INT NOT NULL,
  type          ENUM('produit','service') NOT NULL DEFAULT 'service',
  designation   VARCHAR(255) NOT NULL,
  quantite      DECIMAL(10,3) NOT NULL DEFAULT 1,
  prix_unitaire DECIMAL(15,2) NOT NULL DEFAULT 0,
  remise        DECIMAL(5,2) NOT NULL DEFAULT 0,
  taux_taxe     DECIMAL(5,2) NOT NULL DEFAULT 0,
  montant_ht    DECIMAL(15,2) NOT NULL DEFAULT 0,
  montant_ttc   DECIMAL(15,2) NOT NULL DEFAULT 0,
  ordre         INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_fcl_facture FOREIGN KEY (facture_id) REFERENCES factures_clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_fac_cli_lignes ON factures_clients_lignes(facture_id);

CREATE TABLE factures_clients_paiements (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  facture_id    INT NOT NULL,
  operation_id  INT,
  montant       DECIMAL(15,2) NOT NULL,
  date_paiement DATE NOT NULL,
  mode_paiement VARCHAR(50) NOT NULL DEFAULT 'especes',
  reference     VARCHAR(255),
  notes         TEXT,
  created_by    INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fcp_facture FOREIGN KEY (facture_id)   REFERENCES factures_clients(id),
  CONSTRAINT fk_fcp_op      FOREIGN KEY (operation_id) REFERENCES operations(id),
  CONSTRAINT fk_fcp_created FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_fac_paiements ON factures_clients_paiements(facture_id);

CREATE TABLE relances (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference_type ENUM('facture_client','devis') NOT NULL DEFAULT 'facture_client',
  reference_id   INT NOT NULL,
  client_id      INT NOT NULL,
  type_relance   ENUM('J1','J7','J15','J30') NOT NULL DEFAULT 'J7',
  date_relance   DATE NOT NULL,
  statut         ENUM('envoyee','echec','ignoree') NOT NULL DEFAULT 'envoyee',
  canal          ENUM('email','whatsapp','telephone') NOT NULL DEFAULT 'email',
  notes          TEXT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rel_client  FOREIGN KEY (client_id)  REFERENCES clients(id),
  CONSTRAINT fk_rel_created FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_relances_ref ON relances(reference_type, reference_id);
