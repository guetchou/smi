-- Gestion versionnee des contrats de travail et des regles de remuneration.

CREATE TABLE payroll_rule_sets (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL,
  version INT NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  pays_code CHAR(2) NOT NULL DEFAULT 'CG',
  date_effet DATE NOT NULL,
  date_fin DATE,
  statut ENUM('brouillon','publie','archive') NOT NULL DEFAULT 'brouillon',
  social_rules JSON NOT NULL,
  tax_rules JSON NOT NULL,
  rounding_rules JSON NOT NULL,
  legal_references JSON,
  validated_by INT,
  validated_at DATETIME,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_rule_set_version (code, version),
  CONSTRAINT fk_prs_validated_by FOREIGN KEY (validated_by) REFERENCES users(id),
  CONSTRAINT fk_prs_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contract_templates (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  nom VARCHAR(255) NOT NULL,
  type_contrat VARCHAR(50) NOT NULL,
  actif TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  updated_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ect_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_ect_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contract_template_versions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  version INT NOT NULL,
  statut ENUM('brouillon','publie','archive') NOT NULL DEFAULT 'brouillon',
  titre VARCHAR(255) NOT NULL,
  content_json JSON NOT NULL,
  header_json JSON,
  footer_json JSON,
  variable_catalog_json JSON NOT NULL,
  source_docx_name VARCHAR(255),
  source_docx_sha256 CHAR(64),
  change_note TEXT,
  published_by INT,
  published_at DATETIME,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ectv_version (template_id, version),
  CONSTRAINT fk_ectv_template FOREIGN KEY (template_id) REFERENCES employment_contract_templates(id),
  CONSTRAINT fk_ectv_published_by FOREIGN KEY (published_by) REFERENCES users(id),
  CONSTRAINT fk_ectv_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contracts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(100) NOT NULL UNIQUE,
  employe_id INT NOT NULL,
  template_version_id INT NOT NULL,
  payroll_rule_set_id INT,
  parent_contract_id INT,
  legacy_contract_id INT,
  version INT NOT NULL DEFAULT 1,
  type_contrat VARCHAR(50) NOT NULL,
  intitule VARCHAR(255) NOT NULL,
  statut ENUM('brouillon','en_verification','valide','signe','archive','annule') NOT NULL DEFAULT 'brouillon',
  date_signature DATE,
  date_debut DATE NOT NULL,
  date_fin DATE,
  duree_valeur INT,
  duree_unite ENUM('jour','mois','annee'),
  periode_essai_valeur INT,
  periode_essai_unite ENUM('jour','mois'),
  fonction VARCHAR(255),
  classification VARCHAR(255),
  service VARCHAR(255),
  lieu_travail VARCHAR(255),
  temps_travail_hebdomadaire DECIMAL(6,2),
  horaires TEXT,
  tasks_json JSON,
  values_snapshot JSON NOT NULL,
  remuneration_snapshot JSON NOT NULL,
  rules_snapshot JSON,
  clauses_snapshot JSON NOT NULL,
  missing_variables_json JSON,
  validation_errors_json JSON,
  created_by INT NOT NULL,
  submitted_by INT,
  submitted_at DATETIME,
  validated_by INT,
  validated_at DATETIME,
  signed_at DATETIME,
  cancelled_by INT,
  cancelled_at DATETIME,
  cancellation_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employment_contract_lineage (parent_contract_id, version),
  KEY idx_employment_contract_employee (employe_id, statut),
  KEY idx_employment_contract_period (date_debut, date_fin),
  CONSTRAINT fk_ec_employee FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_ec_template_version FOREIGN KEY (template_version_id) REFERENCES employment_contract_template_versions(id),
  CONSTRAINT fk_ec_rule_set FOREIGN KEY (payroll_rule_set_id) REFERENCES payroll_rule_sets(id),
  CONSTRAINT fk_ec_parent FOREIGN KEY (parent_contract_id) REFERENCES employment_contracts(id),
  CONSTRAINT fk_ec_legacy FOREIGN KEY (legacy_contract_id) REFERENCES contrats(id),
  CONSTRAINT fk_ec_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_ec_submitted_by FOREIGN KEY (submitted_by) REFERENCES users(id),
  CONSTRAINT fk_ec_validated_by FOREIGN KEY (validated_by) REFERENCES users(id),
  CONSTRAINT fk_ec_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contract_components (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id INT NOT NULL,
  code VARCHAR(100) NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  category ENUM('salaire_base','indemnite','prime','avantage','retenue') NOT NULL,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  include_in_gross TINYINT(1) NOT NULL DEFAULT 1,
  social_subject TINYINT(1) NOT NULL DEFAULT 1,
  tax_subject TINYINT(1) NOT NULL DEFAULT 1,
  display_on_contract TINYINT(1) NOT NULL DEFAULT 1,
  calculation_mode ENUM('fixe','pourcentage','formule') NOT NULL DEFAULT 'fixe',
  calculation_config JSON,
  periodicity VARCHAR(30) NOT NULL DEFAULT 'mensuel',
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_ec_component (contract_id, code),
  CONSTRAINT fk_ecc_contract FOREIGN KEY (contract_id) REFERENCES employment_contracts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contract_documents (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id INT NOT NULL,
  contract_version INT NOT NULL,
  format ENUM('docx','pdf') NOT NULL,
  filename VARCHAR(255) NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  file_size BIGINT NOT NULL,
  generated_by INT NOT NULL,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ec_document (contract_id, contract_version, format),
  CONSTRAINT fk_ecd_contract FOREIGN KEY (contract_id) REFERENCES employment_contracts(id),
  CONSTRAINT fk_ecd_generated_by FOREIGN KEY (generated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employment_contract_events (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id INT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  details JSON,
  actor_user_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ec_event_contract (contract_id, created_at),
  CONSTRAINT fk_ece_contract FOREIGN KEY (contract_id) REFERENCES employment_contracts(id),
  CONSTRAINT fk_ece_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (code, module, action, libelle, description, `sensitive`, actif) VALUES
  ('employment_contract.view', 'hr_contracts', 'view', 'Consulter les contrats RH', 'Consulter les contrats autorises', 1, 1),
  ('employment_contract.create', 'hr_contracts', 'create', 'Creer un contrat RH', 'Creer et modifier les brouillons', 1, 1),
  ('employment_contract.submit', 'hr_contracts', 'submit', 'Soumettre un contrat RH', 'Soumettre a verification', 1, 1),
  ('employment_contract.validate', 'hr_contracts', 'validate', 'Valider un contrat RH', 'Valider ou rejeter un contrat', 1, 1),
  ('employment_contract.generate', 'hr_contracts', 'generate', 'Generer les documents RH', 'Generer DOCX et PDF', 1, 1),
  ('employment_contract.template.manage', 'hr_contracts', 'template_manage', 'Gerer les modeles RH', 'Gerer modeles, clauses et versions', 1, 1),
  ('employment_contract.rules.manage', 'hr_contracts', 'rules_manage', 'Gerer les regles de paie', 'Publier les taux et baremes dates', 1, 1);

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, pe.id, 1 FROM profiles pr JOIN permissions pe
WHERE pr.code IN ('admin') AND pe.module = 'hr_contracts';

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, pe.id, 1 FROM profiles pr JOIN permissions pe
WHERE pr.code IN ('rh') AND pe.code IN (
  'employment_contract.view','employment_contract.create','employment_contract.submit',
  'employment_contract.generate','employment_contract.template.manage'
);

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, pe.id, 1 FROM profiles pr JOIN permissions pe
WHERE pr.code IN ('dg') AND pe.code IN ('employment_contract.view','employment_contract.validate','employment_contract.generate');
