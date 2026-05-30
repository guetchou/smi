-- Migration 017 : neutraliser les comptes non système sans fiche agent.
-- Règle métier : tout compte opérationnel doit être rattaché à employes.id.
-- Les comptes système admin/DG peuvent rester sans fiche agent.

UPDATE users
SET actif = 0
WHERE actif = 1
  AND employe_id IS NULL
  AND role NOT IN ('admin', 'dg');
