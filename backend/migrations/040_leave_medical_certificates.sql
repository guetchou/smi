-- Certificats médicaux durables, versionnés et auditables.

CREATE TABLE employes_conges_documents (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conge_id INT NOT NULL,
  type_document VARCHAR(50) NOT NULL,
  nom_original VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  taille_octets BIGINT NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  statut VARCHAR(30) NOT NULL DEFAULT 'actif',
  depose_par INT NOT NULL,
  depose_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remplace_document_id INT NULL,
  supprime_logiquement_at DATETIME NULL,
  supprime_logiquement_par INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_conge_doc_conge FOREIGN KEY (conge_id) REFERENCES employes_conges(id),
  CONSTRAINT fk_conge_doc_depose FOREIGN KEY (depose_par) REFERENCES users(id),
  CONSTRAINT fk_conge_doc_remplace FOREIGN KEY (remplace_document_id) REFERENCES employes_conges_documents(id),
  CONSTRAINT fk_conge_doc_supprime FOREIGN KEY (supprime_logiquement_par) REFERENCES users(id),
  UNIQUE KEY uq_conge_doc_version (conge_id, type_document, version),
  UNIQUE KEY uq_conge_doc_storage (storage_key),
  INDEX idx_conge_doc_active (conge_id, type_document, statut),
  INDEX idx_conge_doc_sha256 (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO parametres (cle, valeur) VALUES
  ('conges_certificat_maladie_obligatoire', '1'),
  ('conges_certificat_maladie_seuil_jours', '1'),
  ('conges_certificat_types', 'application/pdf,image/jpeg,image/png'),
  ('conges_certificat_taille_max_mb', '10'),
  ('conges_certificat_stockage', 'local');
