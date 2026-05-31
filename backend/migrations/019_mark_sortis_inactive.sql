-- Migration 019 : appliquer l'invariant RH statut sorti/archive => actif=0.
-- Objectif : un agent sorti ne doit plus apparaitre dans les flux actifs.

UPDATE employes
SET actif = 0,
    updated_at = NOW()
WHERE actif = 1
  AND statut_dossier IN ('sorti', 'archive');
