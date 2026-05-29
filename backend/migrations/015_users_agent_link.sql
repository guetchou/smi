-- Migration 015 : lier les comptes utilisateur aux fiches agents.
-- Un compte agent non lié ne peut pas pointer. Cette migration répare les cas
-- sûrs par correspondance email exacte et garde admin/DG libres pour secours.

ALTER TABLE users
  ADD COLUMN prenom VARCHAR(255) NULL AFTER nom;

UPDATE users u
JOIN (
  SELECT LOWER(TRIM(email)) AS email_key, MIN(id) AS employe_id, COUNT(*) AS n
  FROM employes
  WHERE email IS NOT NULL
    AND TRIM(email) <> ''
    AND actif = 1
    AND statut_dossier <> 'sorti'
  GROUP BY LOWER(TRIM(email))
  HAVING n = 1
) m ON LOWER(TRIM(u.email)) = m.email_key
LEFT JOIN users linked
  ON linked.employe_id = m.employe_id
 AND linked.id <> u.id
SET u.employe_id = m.employe_id
WHERE u.employe_id IS NULL
  AND u.actif = 1
  AND linked.id IS NULL;

UPDATE users u
JOIN (
  SELECT LOWER(TRIM(email_professionnel)) AS email_key, MIN(id) AS employe_id, COUNT(*) AS n
  FROM employes
  WHERE email_professionnel IS NOT NULL
    AND TRIM(email_professionnel) <> ''
    AND actif = 1
    AND statut_dossier <> 'sorti'
  GROUP BY LOWER(TRIM(email_professionnel))
  HAVING n = 1
) m ON LOWER(TRIM(u.email)) = m.email_key
LEFT JOIN users linked
  ON linked.employe_id = m.employe_id
 AND linked.id <> u.id
SET u.employe_id = m.employe_id
WHERE u.employe_id IS NULL
  AND u.actif = 1
  AND linked.id IS NULL;
