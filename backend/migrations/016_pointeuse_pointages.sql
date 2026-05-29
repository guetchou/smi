-- Migration 016 : tables et colonnes MySQL nécessaires à la pointeuse.

ALTER TABLE employes
  ADD COLUMN pin_pointage VARCHAR(255) NULL;

ALTER TABLE employes
  ADD COLUMN heure_arrivee VARCHAR(5) NULL DEFAULT '08:00';

ALTER TABLE employes
  ADD COLUMN gps_rayon_m INT NULL;

CREATE TABLE pointages (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id       INT NOT NULL,
  date             DATE NOT NULL,
  heure_entree     VARCHAR(5),
  heure_sortie     VARCHAR(5),
  heure_theorique  VARCHAR(5) DEFAULT '08:00',
  duree_minutes    INT,
  statut           ENUM('en_cours','present','retard','absent','teletravail','terrain') NOT NULL DEFAULT 'en_cours',
  mode             ENUM('manuel','auto_absent','teletravail','terrain') NOT NULL DEFAULT 'manuel',
  ip_entree        VARCHAR(45),
  latitude         DECIMAL(10,7),
  longitude        DECIMAL(10,7),
  precision_gps    DECIMAL(10,2),
  hors_perimetre   TINYINT(1) NOT NULL DEFAULT 0,
  note             TEXT,
  cree_par         INT,
  modifie_par      INT,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pointage_employe_date (employe_id, date),
  CONSTRAINT fk_pointages_employe FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_pointages_cree_par FOREIGN KEY (cree_par) REFERENCES users(id),
  CONSTRAINT fk_pointages_modifie_par FOREIGN KEY (modifie_par) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_pointages_employe ON pointages(employe_id);
CREATE INDEX idx_pointages_date    ON pointages(date);
CREATE INDEX idx_pointages_statut  ON pointages(statut);
