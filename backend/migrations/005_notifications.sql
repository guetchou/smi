-- Migration 005 : Module notifications — règles, messages, rappels, alertes, canaux, envois, préférences, push

CREATE TABLE notif_regles (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type             VARCHAR(100) NOT NULL UNIQUE,
  famille          ENUM('notification','rappel','alerte') NOT NULL,
  priorite_defaut  ENUM('info','avertissement','critique','bloquant') NOT NULL DEFAULT 'info',
  libelle          VARCHAR(255) NOT NULL,
  actif            TINYINT(1) NOT NULL DEFAULT 1,
  canal_inapp      TINYINT(1) NOT NULL DEFAULT 1,
  canal_email      TINYINT(1) NOT NULL DEFAULT 0,
  canal_push       TINYINT(1) NOT NULL DEFAULT 0,
  canal_son        TINYINT(1) NOT NULL DEFAULT 0,
  roles_dest       TEXT NOT NULL DEFAULT '["admin"]',
  escalade_delai_h INT,
  escalade_roles   TEXT,
  grace_h          INT DEFAULT 24,
  params           TEXT NOT NULL DEFAULT '{}',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifregles_famille ON notif_regles(famille, actif);

CREATE TABLE notif_messages (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type         VARCHAR(100) NOT NULL,
  famille      ENUM('notification','rappel','alerte') NOT NULL DEFAULT 'notification',
  priorite     ENUM('info','avertissement','critique','bloquant') NOT NULL DEFAULT 'info',
  titre        VARCHAR(255) NOT NULL,
  message      TEXT NOT NULL,
  user_id      INT NOT NULL,
  src_table    VARCHAR(100),
  src_id       INT,
  statut       ENUM('non_lue','lue','archivee') NOT NULL DEFAULT 'non_lue',
  acquitte_at  DATETIME,
  acquitte_par INT,
  expires_at   DATETIME,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_nm_user    FOREIGN KEY (user_id)      REFERENCES users(id),
  CONSTRAINT fk_nm_acquit  FOREIGN KEY (acquitte_par) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifmsg_user_statut ON notif_messages(user_id, statut, created_at);
CREATE INDEX idx_notifmsg_user_nonlue ON notif_messages((IF(statut = 'non_lue', user_id, NULL)));
CREATE INDEX idx_notifmsg_src         ON notif_messages((IF(src_table IS NOT NULL, src_table, NULL)), (IF(src_table IS NOT NULL, src_id, NULL)));

CREATE TABLE notif_rappels (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type            VARCHAR(100) NOT NULL,
  src_table       VARCHAR(100) NOT NULL,
  src_id          INT NOT NULL,
  declenchement_j INT,
  declenchement_h INT,
  declenche_a     DATETIME NOT NULL,
  statut          ENUM('planifie','declenche','acquitte','retarde','escalade','annule') NOT NULL DEFAULT 'planifie',
  acquitte_par    INT,
  acquitte_at     DATETIME,
  annule_motif    TEXT,
  escalade_at     DATETIME,
  escalade_vers   VARCHAR(255),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_nrap_acquit FOREIGN KEY (acquitte_par) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifrap_cron ON notif_rappels(statut, declenche_a);
CREATE INDEX idx_notifrap_src  ON notif_rappels(src_table, src_id);

CREATE TABLE alertes_actives (
  id                 INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type               VARCHAR(100) NOT NULL,
  priorite           ENUM('info','avertissement','critique','bloquant') NOT NULL,
  bloquant           TINYINT(1) NOT NULL DEFAULT 0,
  src_table          VARCHAR(100),
  src_id             INT,
  position_id        INT,
  titre              VARCHAR(255) NOT NULL,
  message            TEXT NOT NULL,
  details            TEXT,
  statut             ENUM('active','acquittee','resolue','retardee','escaladee') NOT NULL DEFAULT 'active',
  acquitte_par       INT,
  acquitte_at        DATETIME,
  resolu_at          DATETIME,
  resolu_auto        TINYINT(1) NOT NULL DEFAULT 0,
  escalade_at        DATETIME,
  escalade_vers      VARCHAR(255),
  override_par       INT,
  override_at        DATETIME,
  override_motif     TEXT,
  derniere_detection DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_alerte_pos     FOREIGN KEY (position_id)  REFERENCES positions(id),
  CONSTRAINT fk_alerte_acquit  FOREIGN KEY (acquitte_par) REFERENCES users(id),
  CONSTRAINT fk_alerte_override FOREIGN KEY (override_par) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_alerte_statut   ON alertes_actives(statut, priorite);
CREATE INDEX idx_alerte_bloquant ON alertes_actives(bloquant, position_id, statut);
CREATE UNIQUE INDEX idx_alerte_unique_active ON alertes_actives(type, COALESCE(src_table,''), COALESCE(CAST(src_id AS CHAR),''), COALESCE(CAST(position_id AS CHAR),''));

CREATE TABLE notif_canaux (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  type       VARCHAR(100) NOT NULL,
  canal      ENUM('inapp','email','push','son') NOT NULL,
  actif      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notifcanaux (user_id, type, canal),
  CONSTRAINT fk_nc_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifcanaux_user ON notif_canaux(user_id, type);

CREATE TABLE notif_envois (
  id                 INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notif_id           INT,
  alerte_id          INT,
  rappel_id          INT,
  canal              ENUM('email','push','sms') NOT NULL,
  destinataire       VARCHAR(255) NOT NULL,
  user_id            INT,
  statut             ENUM('en_attente','envoye','echec','ignore') NOT NULL DEFAULT 'en_attente',
  tentatives         INT NOT NULL DEFAULT 0,
  derniere_tentative DATETIME,
  erreur             TEXT,
  dedup_key          VARCHAR(500) UNIQUE,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at            DATETIME,
  CONSTRAINT fk_ne_notif  FOREIGN KEY (notif_id)  REFERENCES notif_messages(id),
  CONSTRAINT fk_ne_alerte FOREIGN KEY (alerte_id) REFERENCES alertes_actives(id),
  CONSTRAINT fk_ne_rappel FOREIGN KEY (rappel_id) REFERENCES notif_rappels(id),
  CONSTRAINT fk_ne_user   FOREIGN KEY (user_id)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifenvois_attente ON notif_envois(statut, created_at);
CREATE INDEX idx_notifenvois_notif   ON notif_envois((IF(notif_id IS NOT NULL, notif_id, NULL)));
CREATE INDEX idx_notifenvois_alerte  ON notif_envois((IF(alerte_id IS NOT NULL, alerte_id, NULL)));

CREATE TABLE user_preferences (
  user_id            INT NOT NULL PRIMARY KEY,
  son_actif          TINYINT(1) NOT NULL DEFAULT 1,
  son_info_actif     TINYINT(1) NOT NULL DEFAULT 0,
  son_avert_actif    TINYINT(1) NOT NULL DEFAULT 1,
  son_critique_actif TINYINT(1) NOT NULL DEFAULT 1,
  son_volume         DECIMAL(3,2) NOT NULL DEFAULT 0.50,
  son_plage_debut    VARCHAR(5) NOT NULL DEFAULT '07:00',
  son_plage_fin      VARCHAR(5) NOT NULL DEFAULT '21:00',
  notif_digest       TINYINT(1) NOT NULL DEFAULT 0,
  push_actif         TINYINT(1) NOT NULL DEFAULT 0,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_upref_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE push_souscriptions (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  endpoint      TEXT NOT NULL,
  key_p256dh    TEXT NOT NULL,
  key_auth      TEXT NOT NULL,
  user_agent    VARCHAR(255),
  actif         TINYINT(1) NOT NULL DEFAULT 1,
  erreur_410_at DATETIME,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  DATETIME,
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_pushsub_user_actif ON push_souscriptions(user_id, actif);
