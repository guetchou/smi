-- Migration 014 : Agent par défaut sans module métier.
-- La pointeuse reste disponible sans permission via le garde applicatif.

UPDATE user_profiles up
JOIN profiles p ON p.id = up.profile_id
SET up.active = 0,
    up.updated_at = NOW()
WHERE p.code = 'lecteur'
  AND up.source = 'legacy_role';
