-- Migration 018 : resynchroniser les profils ERP depuis les roles utilisateurs.
-- Objectif : aucun compte operationnel actif ne doit rester sans profil module.

UPDATE user_profiles up
JOIN profiles p ON p.id = up.profile_id
JOIN users u ON u.id = up.user_id
SET up.active = 0,
    up.updated_at = NOW()
WHERE up.source = 'legacy_role'
  AND (
    u.actif = 0
    OR p.code = 'lecteur'
    OR (
      p.code <> u.role
      AND NOT (
        JSON_VALID(u.roles)
        AND JSON_CONTAINS(CAST(u.roles AS JSON), JSON_QUOTE(p.code), '$')
      )
    )
  );

INSERT INTO user_profiles (user_id, profile_id, active, source, created_by, updated_at)
SELECT DISTINCT u.id, p.id, 1, 'legacy_role', NULL, NOW()
FROM users u
JOIN JSON_TABLE(
  CASE
    WHEN JSON_VALID(u.roles) THEN CAST(u.roles AS JSON)
    ELSE JSON_ARRAY(u.role)
  END,
  '$[*]' COLUMNS(role_code VARCHAR(100) PATH '$')
) r
JOIN profiles p ON p.code = (r.role_code COLLATE utf8mb4_unicode_ci) AND p.actif = 1
WHERE u.actif = 1
  AND (r.role_code COLLATE utf8mb4_unicode_ci) <> 'lecteur'
ON DUPLICATE KEY UPDATE
  active = CASE WHEN source='manual' THEN active ELSE 1 END,
  source = CASE WHEN source='manual' THEN source ELSE 'legacy_role' END,
  updated_at = NOW();

INSERT INTO user_profiles (user_id, profile_id, active, source, created_by, updated_at)
SELECT DISTINCT u.id, p.id, 1, 'legacy_role', NULL, NOW()
FROM users u
JOIN profiles p ON p.code = u.role AND p.actif = 1
WHERE u.actif = 1
  AND u.role <> 'lecteur'
ON DUPLICATE KEY UPDATE
  active = CASE WHEN source='manual' THEN active ELSE 1 END,
  source = CASE WHEN source='manual' THEN source ELSE 'legacy_role' END,
  updated_at = NOW();
