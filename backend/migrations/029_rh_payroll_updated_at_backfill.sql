-- Migration 029 : colonnes updated_at manquantes sur tables RH/Paie historiques.
-- Certaines tables créées avant les workflows récents n'avaient pas updated_at,
-- alors que les routes modernes écrivent ou trient dessus.

ALTER TABLE grille_categories
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE grille_echelons
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE employes_heures_sup
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE historique_salaires
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
