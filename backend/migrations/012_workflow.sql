-- Migration 012 : Workflow — parapheur, cashboxes, ledger, clôtures quotidiennes

CREATE TABLE parapheur (
  id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type              VARCHAR(100) NOT NULL,
  titre             VARCHAR(255) NOT NULL,
  initiateur_id     INT NOT NULL,
  priorite          ENUM('normal','urgent','confidentiel') NOT NULL DEFAULT 'normal',
  statut            ENUM('brouillon','en_attente_assistante','transmis_dg','approuve','rejete','en_correction','delegue','en_avis') NOT NULL DEFAULT 'en_attente_assistante',
  note_assistante   TEXT,
  transmis_par_id   INT,
  transmis_par_role ENUM('titulaire','interim'),
  echeance_legale   DATE,
  montant           DECIMAL(15,2),
  pieces_jointes    TEXT,
  ref_source_table  VARCHAR(100),
  ref_source_id     INT,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_parapheur_statut     ON parapheur(statut);
CREATE INDEX idx_parapheur_initiateur ON parapheur(initiateur_id);

CREATE TABLE parapheur_actions (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  parapheur_id   INT NOT NULL,
  acteur_id      INT NOT NULL,
  acteur_role    VARCHAR(100) NOT NULL,
  action_type    ENUM('soumis','note_ajoutee','priorite_changee','transmis_dg','approuve','rejete','eclaircissement','correction','delegue','avis_demande','avis_donne','retour_correction') NOT NULL,
  commentaire    TEXT,
  destinataire_id INT,
  is_interim     TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pa_parapheur FOREIGN KEY (parapheur_id) REFERENCES parapheur(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_parapheur_actions_pid ON parapheur_actions(parapheur_id);

CREATE TABLE parapheur_interim (
  id                   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  absent_id            INT NOT NULL,
  remplacant_id        INT,
  declare_par_id       INT NOT NULL,
  date_debut           DATE NOT NULL,
  date_fin_prevue      DATE,
  date_retour_effectif DATE,
  valide_retour_par_id INT,
  valide_retour_at     DATETIME,
  actif                TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_parapheur_interim_actif ON parapheur_interim(actif);

CREATE TABLE user_cashboxes (
  user_id     INT NOT NULL,
  caisse_id   INT NOT NULL,
  can_read    TINYINT(1) NOT NULL DEFAULT 1,
  can_write   TINYINT(1) NOT NULL DEFAULT 0,
  affecte_par INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, caisse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE operation_attachments (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operation_id INT NOT NULL,
  filename     VARCHAR(255) NOT NULL,
  filepath     VARCHAR(500) NOT NULL,
  mimetype     VARCHAR(100) NOT NULL,
  size_bytes   INT,
  uploaded_by  INT NOT NULL,
  archived     TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_op_attachments ON operation_attachments(operation_id);

CREATE TABLE cash_ledger (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  caisse_id      INT NOT NULL,
  operation_id   INT,
  type_mouvement ENUM('debit','credit','ouverture','cloture','correction') NOT NULL,
  montant        DECIMAL(15,2) NOT NULL,
  solde_avant    DECIMAL(15,2) NOT NULL,
  solde_apres    DECIMAL(15,2) NOT NULL,
  reference      VARCHAR(255),
  created_by     INT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cash_ledger_caisse ON cash_ledger(caisse_id);
CREATE INDEX idx_cash_ledger_op     ON cash_ledger(operation_id);

CREATE TABLE cashbox_balances (
  caisse_id             INT NOT NULL PRIMARY KEY,
  solde_courant         DECIMAL(15,2) NOT NULL DEFAULT 0,
  derniere_operation_id INT,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE cashbox_closures (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  caisse_id           INT NOT NULL,
  date_cloture        DATE NOT NULL,
  solde_ouverture     DECIMAL(15,2) NOT NULL,
  solde_cloture       DECIMAL(15,2) NOT NULL,
  total_encaissements DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_decaissements DECIMAL(15,2) NOT NULL DEFAULT 0,
  ecart               DECIMAL(15,2) NOT NULL DEFAULT 0,
  cloture_par         INT NOT NULL,
  reouverture_par     INT,
  reouverture_motif   TEXT,
  statut              ENUM('cloturee','reopened') NOT NULL DEFAULT 'cloturee',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_closure (caisse_id, date_cloture)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cashbox_closures ON cashbox_closures(caisse_id, date_cloture);
