-- Migration 021 : Schéma onboarding employé manquant en MySQL

ALTER TABLE employes
  ADD COLUMN onboarding_status VARCHAR(30) NOT NULL DEFAULT 'incomplet';

ALTER TABLE employes
  ADD COLUMN besoin_acces_systeme TINYINT(1) NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id    INT NOT NULL,
  task_key      VARCHAR(100) NOT NULL,
  label         VARCHAR(255) NOT NULL,
  status        VARCHAR(30) NOT NULL DEFAULT 'todo',
  required      TINYINT(1) NOT NULL DEFAULT 0,
  assigned_role VARCHAR(50),
  due_date      DATE,
  completed_at  DATETIME,
  completed_by  INT,
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_onboarding_task UNIQUE (employe_id, task_key),
  CONSTRAINT fk_onboarding_tasks_emp FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_onboarding_tasks_user FOREIGN KEY (completed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_onboarding_tasks_employe ON onboarding_tasks(employe_id);
CREATE INDEX idx_onboarding_tasks_status  ON onboarding_tasks(status);

CREATE TABLE IF NOT EXISTS onboarding_events (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employe_id  INT NOT NULL,
  event_type  VARCHAR(100) NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  created_by  INT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address  VARCHAR(64),
  CONSTRAINT fk_onboarding_events_emp FOREIGN KEY (employe_id) REFERENCES employes(id),
  CONSTRAINT fk_onboarding_events_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_onboarding_events_employe ON onboarding_events(employe_id);
CREATE INDEX idx_onboarding_events_type    ON onboarding_events(event_type);
