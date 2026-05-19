-- Migration 007 : Stock et produits — categories_produits, produits (GENERATED VIRTUAL), stock_mouvements

CREATE TABLE categories_produits (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nom         VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  actif       TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE produits (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code_produit     VARCHAR(100) UNIQUE NOT NULL,
  designation      VARCHAR(255) NOT NULL,
  categorie_id     INT,
  unite            ENUM('piece','boite','kg','litre','paquet','carton','autre') NOT NULL DEFAULT 'piece',
  prix_achat       DECIMAL(15,2) NOT NULL DEFAULT 0,
  prix_vente       DECIMAL(15,2) NOT NULL DEFAULT 0,
  marge            DECIMAL(10,2) GENERATED ALWAYS AS (
                     CASE WHEN prix_achat > 0
                     THEN ROUND((prix_vente - prix_achat) * 100.0 / prix_achat, 2)
                     ELSE 0 END
                   ) VIRTUAL,
  taux_taxe        DECIMAL(5,2) NOT NULL DEFAULT 0,
  stock_disponible DECIMAL(10,3) NOT NULL DEFAULT 0,
  stock_reserve    DECIMAL(10,3) NOT NULL DEFAULT 0,
  stock_minimum    DECIMAL(10,3) NOT NULL DEFAULT 0,
  emplacement      VARCHAR(255),
  date_expiration  DATE,
  numero_lot       VARCHAR(100),
  code_barres      VARCHAR(100),
  statut           ENUM('actif','archive') NOT NULL DEFAULT 'actif',
  notes            TEXT,
  created_by       INT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prod_cat     FOREIGN KEY (categorie_id) REFERENCES categories_produits(id),
  CONSTRAINT fk_prod_created FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_produits_code      ON produits(code_produit);
CREATE INDEX idx_produits_statut    ON produits(statut);
CREATE INDEX idx_produits_categorie ON produits(categorie_id);
CREATE INDEX idx_produits_stock_bas ON produits(stock_disponible, stock_minimum);

CREATE TABLE stock_mouvements (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  produit_id     INT NOT NULL,
  type           ENUM('entree','sortie','reservation','liberation','retour','perte','transfert','inventaire','ajustement') NOT NULL,
  quantite       DECIMAL(10,3) NOT NULL,
  quantite_avant DECIMAL(10,3) NOT NULL DEFAULT 0,
  quantite_apres DECIMAL(10,3) NOT NULL DEFAULT 0,
  reference_id   INT,
  reference_type ENUM('facture_client','bon_commande','reception','inventaire','retour','perte','ajustement','autre'),
  motif          TEXT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_smv_produit  FOREIGN KEY (produit_id) REFERENCES produits(id),
  CONSTRAINT fk_smv_created  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_stock_mv_produit ON stock_mouvements(produit_id);
CREATE INDEX idx_stock_mv_type    ON stock_mouvements(type);
CREATE INDEX idx_stock_mv_date    ON stock_mouvements(created_at DESC);
