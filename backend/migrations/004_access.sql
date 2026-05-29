-- Migration 004 : Accès ERP — profiles, permissions, délégations, organigramme ERP

CREATE TABLE profiles (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(100) UNIQUE NOT NULL,
  libelle     VARCHAR(255) NOT NULL,
  description TEXT,
  `system`    TINYINT(1) NOT NULL DEFAULT 1,
  actif       TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permissions (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(255) UNIQUE NOT NULL,
  module      VARCHAR(100) NOT NULL,
  action      VARCHAR(100) NOT NULL,
  libelle     VARCHAR(255) NOT NULL,
  description TEXT,
  sensitive   TINYINT(1) NOT NULL DEFAULT 0,
  actif       TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE profile_permissions (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  profile_id    INT NOT NULL,
  permission_id INT NOT NULL,
  allowed       TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_profile_perm (profile_id, permission_id),
  CONSTRAINT fk_pp_profile FOREIGN KEY (profile_id)    REFERENCES profiles(id),
  CONSTRAINT fk_pp_perm    FOREIGN KEY (permission_id) REFERENCES permissions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_profiles (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  profile_id INT NOT NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  source     VARCHAR(50) NOT NULL DEFAULT 'manual',
  expires_at DATETIME,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_profile (user_id, profile_id),
  CONSTRAINT fk_up_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_up_profile FOREIGN KEY (profile_id) REFERENCES profiles(id),
  CONSTRAINT fk_up_created FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_user_profiles_user ON user_profiles(user_id, active);

CREATE TABLE user_permissions (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  permission_id INT NOT NULL,
  allowed       TINYINT(1) NOT NULL DEFAULT 1,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  reason        TEXT,
  amount_limit  DECIMAL(15,2),
  expires_at    DATETIME,
  created_by    INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_perm (user_id, permission_id),
  CONSTRAINT fk_uperm_user    FOREIGN KEY (user_id)       REFERENCES users(id),
  CONSTRAINT fk_uperm_perm    FOREIGN KEY (permission_id) REFERENCES permissions(id),
  CONSTRAINT fk_uperm_created FOREIGN KEY (created_by)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_user_permissions_user ON user_permissions(user_id, active);

-- Table delegations — schéma fusionné (ERP v1 + workflow v2)
CREATE TABLE delegations (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Colonnes workflow v2 (principales)
  delegant_id    INT NOT NULL DEFAULT 0,
  delegataire_id INT NOT NULL DEFAULT 0,
  type           VARCHAR(50) DEFAULT 'ponctuelle',
  module         VARCHAR(100),
  action         VARCHAR(100),
  montant_max    DECIMAL(15,2),
  date_debut     DATE,
  date_fin       DATE,
  motif          TEXT,
  statut         VARCHAR(50) DEFAULT 'active',
  -- Colonnes ERP v1 (complémentaires)
  delegator_id   INT,
  delegate_id    INT,
  permission_id  INT,
  profile_id     INT,
  scope_module   VARCHAR(100),
  amount_limit   DECIMAL(15,2),
  starts_at      DATETIME,
  expires_at     DATETIME,
  active         TINYINT(1) DEFAULT 1,
  reason         TEXT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_deleg_created FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_delegations_statut ON delegations(statut);

CREATE TABLE permission_audit_logs (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id  INT,
  target_user_id INT,
  table_name     VARCHAR(100) NOT NULL,
  record_id      INT,
  action         VARCHAR(50) NOT NULL,
  details        TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pal_actor  FOREIGN KEY (actor_user_id)  REFERENCES users(id),
  CONSTRAINT fk_pal_target FOREIGN KEY (target_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE departments (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code                VARCHAR(100) UNIQUE NOT NULL,
  libelle             VARCHAR(255) NOT NULL,
  parent_id           INT,
  manager_employee_id INT,
  actif               TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_dept_parent   FOREIGN KEY (parent_id)           REFERENCES departments(id),
  CONSTRAINT fk_dept_manager  FOREIGN KEY (manager_employee_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE organization_units (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code                VARCHAR(100) UNIQUE NOT NULL,
  libelle             VARCHAR(255) NOT NULL,
  type                VARCHAR(50) NOT NULL DEFAULT 'department',
  parent_id           INT,
  department_id       INT,
  manager_employee_id INT,
  actif               TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ou_parent  FOREIGN KEY (parent_id)           REFERENCES organization_units(id),
  CONSTRAINT fk_ou_dept    FOREIGN KEY (department_id)       REFERENCES departments(id),
  CONSTRAINT fk_ou_manager FOREIGN KEY (manager_employee_id) REFERENCES employes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employee_assignments (
  id                      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id              INT NOT NULL,
  organization_unit_id    INT,
  department_id           INT,
  position_title          VARCHAR(255) NOT NULL,
  assignment_type         VARCHAR(50) NOT NULL DEFAULT 'primary',
  classification          VARCHAR(100),
  category                VARCHAR(100),
  level                   VARCHAR(50),
  manager_hierarchical_id INT,
  manager_functional_id   INT,
  interim_for_employee_id INT,
  starts_at               DATE NOT NULL DEFAULT (CURRENT_DATE),
  ends_at                 DATE,
  active                  TINYINT(1) NOT NULL DEFAULT 1,
  created_by              INT,
  created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ea_emp         FOREIGN KEY (employe_id)              REFERENCES employes(id),
  CONSTRAINT fk_ea_ou          FOREIGN KEY (organization_unit_id)    REFERENCES organization_units(id),
  CONSTRAINT fk_ea_dept        FOREIGN KEY (department_id)           REFERENCES departments(id),
  CONSTRAINT fk_ea_mgr_h       FOREIGN KEY (manager_hierarchical_id) REFERENCES employes(id),
  CONSTRAINT fk_ea_mgr_f       FOREIGN KEY (manager_functional_id)   REFERENCES employes(id),
  CONSTRAINT fk_ea_interim     FOREIGN KEY (interim_for_employee_id) REFERENCES employes(id),
  CONSTRAINT fk_ea_created     FOREIGN KEY (created_by)              REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_employee_assignments_emp ON employee_assignments(employe_id, active);
