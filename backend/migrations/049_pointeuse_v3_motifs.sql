-- Pointeuse V3 : référentiel des motifs de pause et de sortie.
--
-- Aucune liste normative n'existe : chaque système de gestion des temps définit
-- la sienne, contrainte par le droit local et la convention collective. Les
-- valeurs ci-dessous sont donc des défauts modifiables, appuyés sur :
--   - le Code du travail congolais (loi du 15 mars 1975 modifiée en 1996) :
--     durée légale 40 h/semaine et 8 h/jour, repos hebdomadaire d'au moins 24 h,
--     26 jours ouvrables de congé annuel, maternité de 15 semaines dont 9 après
--     l'accouchement ;
--   - l'article 119 alinéa 6 du même code, qui ouvre droit à des permissions
--     exceptionnelles pour événements familiaux, dont les cas et durées sont
--     précisés par les conventions collectives ;
--   - les catégories opérationnelles usuelles de la gestion des temps.
--
-- paye : la période compte-t-elle comme du temps de travail rémunéré.
-- validation_requise : le motif doit-il être approuvé par un responsable.
-- Les deux sont des décisions RH : à confirmer contre la convention collective
-- applicable, et modifiables depuis la console.

CREATE TABLE IF NOT EXISTS pointeuse_event_reasons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  libelle VARCHAR(128) NOT NULL,
  categorie ENUM('pause','sortie') NOT NULL,
  paye TINYINT(1) NOT NULL DEFAULT 0,
  validation_requise TINYINT(1) NOT NULL DEFAULT 0,
  actif TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_pointeuse_event_reason_code (code),
  KEY idx_pointeuse_event_reason_categorie (categorie, actif)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pauses : l'agent quitte son poste et revient dans la journée.
INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'PAUSE-REPAS', 'Pause repas', 'pause', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'PAUSE-REPAS');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'PAUSE-COURTE', 'Pause courte', 'pause', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'PAUSE-COURTE');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'REUNION', 'Réunion', 'pause', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'REUNION');

-- La formation obligatoire constitue un temps de travail effectif.
INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'FORMATION', 'Formation', 'pause', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'FORMATION');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'MISSION', 'Mission extérieure', 'pause', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'MISSION');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'INCIDENT-TECHNIQUE', 'Incident technique', 'pause', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'INCIDENT-TECHNIQUE');

-- Sorties : l'agent met fin à sa journée avant l'heure prévue.
INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'MALADIE', 'Maladie', 'sortie', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'MALADIE');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'ACCIDENT-TRAVAIL', 'Accident du travail', 'sortie', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'ACCIDENT-TRAVAIL');

-- Article 119 alinéa 6 : permissions exceptionnelles pour événements familiaux.
INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'PERMISSION-FAMILIALE', 'Permission exceptionnelle', 'sortie', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'PERMISSION-FAMILIALE');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'CONVOCATION', 'Convocation officielle', 'sortie', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'CONVOCATION');

INSERT INTO pointeuse_event_reasons (code, libelle, categorie, paye, validation_requise)
SELECT 'SORTIE-PERSONNELLE', 'Sortie personnelle', 'sortie', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM pointeuse_event_reasons WHERE code = 'SORTIE-PERSONNELLE');
