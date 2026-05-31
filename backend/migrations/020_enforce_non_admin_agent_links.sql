-- Migration 020 : finaliser le rattachement compte utilisateur -> fiche agent.
-- Regle industrielle : seul un compte systeme admin peut rester sans fiche agent.
-- DG/RH/finance/caissier/lecteur/delegue representent une personne physique et
-- doivent etre lies a employes.id pour la pointeuse, RH, paie et audit.

UPDATE users u
JOIN (
  SELECT LOWER(TRIM(email)) AS email_key, MIN(id) AS employe_id, COUNT(*) AS n
  FROM employes
  WHERE email IS NOT NULL
    AND TRIM(email) <> ''
    AND actif = 1
    AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
  GROUP BY LOWER(TRIM(email))
  HAVING n = 1
) m ON LOWER(TRIM(u.email)) = m.email_key
LEFT JOIN users linked
  ON linked.employe_id = m.employe_id
 AND linked.actif = 1
 AND linked.id <> u.id
SET u.employe_id = m.employe_id
WHERE u.employe_id IS NULL
  AND u.actif = 1
  AND u.role <> 'admin'
  AND linked.id IS NULL;

UPDATE users u
JOIN (
  SELECT LOWER(TRIM(email_professionnel)) AS email_key, MIN(id) AS employe_id, COUNT(*) AS n
  FROM employes
  WHERE email_professionnel IS NOT NULL
    AND TRIM(email_professionnel) <> ''
    AND actif = 1
    AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
  GROUP BY LOWER(TRIM(email_professionnel))
  HAVING n = 1
) m ON LOWER(TRIM(u.email)) = m.email_key
LEFT JOIN users linked
  ON linked.employe_id = m.employe_id
 AND linked.actif = 1
 AND linked.id <> u.id
SET u.employe_id = m.employe_id
WHERE u.employe_id IS NULL
  AND u.actif = 1
  AND u.role <> 'admin'
  AND linked.id IS NULL;

-- Rattrapage sur login email prenom.nom : exemple gess.nguie@... peut etre lie
-- a une fiche dont les noms contiennent les deux segments, uniquement si le
-- candidat est unique et non deja lie.
UPDATE users u
JOIN (
  SELECT candidates.user_id, MIN(candidates.employe_id) AS employe_id, COUNT(*) AS n
  FROM (
    SELECT u0.id AS user_id, e.id AS employe_id
    FROM users u0
    JOIN employes e
      ON e.actif = 1
     AND COALESCE(e.statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    LEFT JOIN users linked
      ON linked.employe_id = e.id
     AND linked.actif = 1
     AND linked.id <> u0.id
    WHERE u0.actif = 1
      AND u0.employe_id IS NULL
      AND u0.role <> 'admin'
      AND linked.id IS NULL
      AND LOCATE('.', SUBSTRING_INDEX(u0.email, '@', 1)) > 0
      AND LOWER(CONCAT_WS(' ', e.nom, e.prenom)) LIKE CONCAT('%', SUBSTRING_INDEX(LOWER(SUBSTRING_INDEX(u0.email, '@', 1)), '.', 1), '%')
      AND LOWER(CONCAT_WS(' ', e.nom, e.prenom)) LIKE CONCAT('%', SUBSTRING_INDEX(LOWER(SUBSTRING_INDEX(u0.email, '@', 1)), '.', -1), '%')
  ) candidates
  GROUP BY candidates.user_id
  HAVING n = 1
) m ON m.user_id = u.id
SET u.employe_id = m.employe_id
WHERE u.employe_id IS NULL
  AND u.actif = 1
  AND u.role <> 'admin';

-- Les comptes non-admin encore non lies restent inutilisables pour les flux
-- metier. On les desactive pour ne pas garder de sessions cassées.
UPDATE users
SET actif = 0
WHERE actif = 1
  AND employe_id IS NULL
  AND role <> 'admin';
