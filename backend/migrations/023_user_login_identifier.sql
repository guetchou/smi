-- Migration 023 : identifiant utilisateur distinct de l'email

ALTER TABLE users
  ADD COLUMN login_identifier VARCHAR(100) NULL;

UPDATE users u
JOIN (
  SELECT
    id,
    CASE
      WHEN CHAR_LENGTH(LOWER(SUBSTRING_INDEX(email, '@', 1))) >= 3
      THEN LOWER(SUBSTRING_INDEX(email, '@', 1))
      ELSE CONCAT('user-', id)
    END AS base_login,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(SUBSTRING_INDEX(email, '@', 1))
      ORDER BY id
    ) AS rn
  FROM users
) x ON x.id = u.id
SET u.login_identifier = CASE
  WHEN x.rn = 1 THEN x.base_login
  ELSE CONCAT(x.base_login, '-', u.id)
END
WHERE u.login_identifier IS NULL OR u.login_identifier = '';

CREATE UNIQUE INDEX uq_users_login_identifier ON users(login_identifier);
