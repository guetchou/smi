-- Migration 034 : workflow complet, concurrence, audit, notifications et documents

ALTER TABLE org_departement_fonctions ADD COLUMN entreprise_id INT NULL AFTER id;
ALTER TABLE org_departement_fonctions ADD COLUMN statut ENUM('brouillon','soumis','approuve','refuse','actif','a_corriger','annule','cloture') NOT NULL DEFAULT 'actif' AFTER fonction_type;
ALTER TABLE org_departement_fonctions ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER statut;
ALTER TABLE org_departement_fonctions ADD COLUMN motif TEXT NULL AFTER perimetre;
ALTER TABLE org_departement_fonctions ADD COLUMN motif_refus TEXT NULL AFTER decision_reference;
ALTER TABLE org_departement_fonctions ADD COLUMN document_nom VARCHAR(255) NULL AFTER motif_refus;
ALTER TABLE org_departement_fonctions ADD COLUMN document_url VARCHAR(700) NULL AFTER document_nom;
ALTER TABLE org_departement_fonctions ADD COLUMN document_hash VARCHAR(128) NULL AFTER document_url;
ALTER TABLE org_departement_fonctions ADD COLUMN submitted_by INT NULL AFTER created_by;
ALTER TABLE org_departement_fonctions ADD COLUMN submitted_at DATETIME NULL AFTER submitted_by;
ALTER TABLE org_departement_fonctions ADD COLUMN approved_at DATETIME NULL AFTER approved_by;
ALTER TABLE org_departement_fonctions ADD COLUMN refused_by INT NULL AFTER approved_at;
ALTER TABLE org_departement_fonctions ADD COLUMN refused_at DATETIME NULL AFTER refused_by;
ALTER TABLE org_departement_fonctions ADD COLUMN cancelled_by INT NULL AFTER refused_at;
ALTER TABLE org_departement_fonctions ADD COLUMN cancelled_at DATETIME NULL AFTER cancelled_by;
ALTER TABLE org_departement_fonctions ADD COLUMN effective_at DATETIME NULL AFTER cancelled_at;
ALTER TABLE org_departement_fonctions ADD COLUMN closed_by INT NULL AFTER effective_at;
ALTER TABLE org_departement_fonctions ADD COLUMN closed_at DATETIME NULL AFTER closed_by;
ALTER TABLE org_departement_fonctions ADD COLUMN singleton_key VARCHAR(40)
  GENERATED ALWAYS AS (
    CASE
      WHEN actif = 1 AND fonction_type IN ('chef','premier_adjoint','interimaire') THEN fonction_type
      ELSE NULL
    END
  ) STORED;

UPDATE org_departement_fonctions
SET entreprise_id = (SELECT id FROM entreprise WHERE actif = 1 ORDER BY id LIMIT 1),
    statut = CASE WHEN actif = 1 THEN 'actif' ELSE 'cloture' END,
    effective_at = CASE WHEN actif = 1 THEN COALESCE(updated_at, created_at) ELSE effective_at END,
    version = COALESCE(version, 1);

ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_entreprise FOREIGN KEY (entreprise_id) REFERENCES entreprise(id);
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_submitted_by FOREIGN KEY (submitted_by) REFERENCES users(id);
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_refused_by FOREIGN KEY (refused_by) REFERENCES users(id);
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id);
ALTER TABLE org_departement_fonctions ADD CONSTRAINT fk_org_df_closed_by FOREIGN KEY (closed_by) REFERENCES users(id);
ALTER TABLE org_departement_fonctions ADD UNIQUE KEY uq_org_df_singleton_active (departement_id, singleton_key);
ALTER TABLE org_departement_fonctions ADD INDEX idx_org_df_workflow (statut, date_debut, date_fin);
ALTER TABLE org_departement_fonctions ADD INDEX idx_org_df_entreprise (entreprise_id, departement_id, actif);

CREATE TABLE org_departement_fonction_events (
  id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entreprise_id   INT NULL,
  fonction_id     INT NOT NULL,
  event_type      VARCHAR(80) NOT NULL,
  statut_avant    VARCHAR(40) NULL,
  statut_apres    VARCHAR(40) NULL,
  version_avant   INT NULL,
  version_apres   INT NULL,
  details         JSON NULL,
  actor_user_id   INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_org_dfe_entreprise FOREIGN KEY (entreprise_id) REFERENCES entreprise(id),
  CONSTRAINT fk_org_dfe_fonction FOREIGN KEY (fonction_id) REFERENCES org_departement_fonctions(id),
  CONSTRAINT fk_org_dfe_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  INDEX idx_org_dfe_fonction (fonction_id, created_at),
  INDEX idx_org_dfe_event (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (code, module, action, libelle, description, `sensitive`, actif)
VALUES
  ('hr.department_function.view', 'hr', 'department_function_view', 'Consulter les fonctions départementales', 'Consulter les fonctions actives et leur historique', 0, 1),
  ('hr.department_function.create', 'hr', 'department_function_create', 'Créer une fonction départementale', 'Créer et corriger un brouillon de fonction départementale', 0, 1),
  ('hr.department_function.submit', 'hr', 'department_function_submit', 'Soumettre une fonction départementale', 'Soumettre une fonction départementale à approbation', 0, 1),
  ('hr.department_function.approve', 'hr', 'department_function_approve', 'Approuver une fonction départementale', 'Approuver ou refuser une nomination départementale', 1, 1),
  ('hr.department_function.activate', 'hr', 'department_function_activate', 'Activer une fonction départementale', 'Rendre effective une fonction arrivée à sa date de début', 1, 1),
  ('hr.department_function.close', 'hr', 'department_function_close', 'Clôturer une fonction départementale', 'Clôturer une fonction active ou annuler une demande', 1, 1),
  ('hr.department_function.attach_document', 'hr', 'department_function_attach_document', 'Joindre une décision de nomination', 'Associer une décision ou note de service à une fonction', 1, 1),
  ('hr.department_function.report', 'hr', 'department_function_report', 'Consulter les rapports des fonctions', 'Consulter les anomalies, échéances et indicateurs des fonctions départementales', 0, 1)
ON DUPLICATE KEY UPDATE
  libelle=VALUES(libelle), description=VALUES(description), `sensitive`=VALUES(`sensitive`), actif=1;

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, p.id, 1
FROM profiles pr
JOIN permissions p ON p.code IN (
  'hr.department_function.view',
  'hr.department_function.create',
  'hr.department_function.submit',
  'hr.department_function.close',
  'hr.department_function.attach_document',
  'hr.department_function.report'
)
WHERE pr.code IN ('admin','rh','dg');

INSERT IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
SELECT pr.id, p.id, 1
FROM profiles pr
JOIN permissions p ON p.code IN (
  'hr.department_function.approve',
  'hr.department_function.activate'
)
WHERE pr.code IN ('admin','dg');

INSERT INTO notif_regles
  (type, famille, priorite_defaut, libelle, actif, canal_inapp, canal_email, canal_push, canal_son, roles_dest, escalade_delai_h, escalade_roles, grace_h, params)
VALUES
  ('ORG_FUNCTION_SUBMITTED', 'notification', 'avertissement', 'Fonction départementale soumise', 1, 1, 1, 0, 0, '["admin","dg"]', 24, '["admin","dg"]', 24, '{}'),
  ('ORG_FUNCTION_APPROVED', 'notification', 'info', 'Fonction départementale approuvée', 1, 1, 0, 0, 0, '["admin","rh","dg"]', NULL, NULL, 24, '{}'),
  ('ORG_FUNCTION_REFUSED', 'notification', 'avertissement', 'Fonction départementale refusée', 1, 1, 0, 0, 0, '["admin","rh","dg"]', NULL, NULL, 24, '{}'),
  ('ORG_FUNCTION_EFFECTIVE', 'notification', 'info', 'Fonction départementale effective', 1, 1, 0, 0, 0, '["admin","rh","dg"]', NULL, NULL, 24, '{}'),
  ('ORG_FUNCTION_EXPIRING', 'rappel', 'avertissement', 'Fonction départementale bientôt expirée', 1, 1, 1, 0, 0, '["admin","rh","dg"]', 24, '["admin","dg"]', 24, '{"jours":7}'),
  ('ORG_FUNCTION_ENDED', 'notification', 'info', 'Fonction départementale clôturée', 1, 1, 0, 0, 0, '["admin","rh","dg"]', NULL, NULL, 24, '{}')
ON DUPLICATE KEY UPDATE
  famille=VALUES(famille), priorite_defaut=VALUES(priorite_defaut), libelle=VALUES(libelle),
  actif=1, canal_inapp=VALUES(canal_inapp), canal_email=VALUES(canal_email),
  roles_dest=VALUES(roles_dest), escalade_delai_h=VALUES(escalade_delai_h),
  escalade_roles=VALUES(escalade_roles), grace_h=VALUES(grace_h), params=VALUES(params);

INSERT INTO org_departement_fonction_events
  (entreprise_id, fonction_id, event_type, statut_avant, statut_apres, version_avant, version_apres, details, actor_user_id)
SELECT entreprise_id, id, 'legacy_import', NULL, statut, NULL, version,
       JSON_OBJECT('source', 'responsable_historique', 'decision_reference', decision_reference), created_by
FROM org_departement_fonctions;
