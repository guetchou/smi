CREATE TABLE IF NOT EXISTS bulletins_salaire_corrections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bulletin_id INT NOT NULL,
  type_correction VARCHAR(50) NOT NULL,
  ancien_net DECIMAL(15,2) DEFAULT 0,
  nouveau_net DECIMAL(15,2) DEFAULT NULL,
  ecart DECIMAL(15,2) DEFAULT NULL,
  motif TEXT NOT NULL,
  commentaire TEXT NULL,
  statut VARCHAR(30) NOT NULL DEFAULT 'brouillon',
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  validated_by INT NULL,
  validated_at TIMESTAMP NULL,
  INDEX idx_bsc_bulletin (bulletin_id),
  INDEX idx_bsc_statut (statut),
  INDEX idx_bsc_created_at (created_at)
);
