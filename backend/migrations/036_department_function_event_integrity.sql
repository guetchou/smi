-- Migration 036 : journal d'événements idempotent

DELETE older
FROM org_departement_fonction_events older
JOIN org_departement_fonction_events newer
  ON newer.fonction_id=older.fonction_id
 AND newer.event_type=older.event_type
 AND newer.version_apres <=> older.version_apres
 AND newer.id<older.id;

ALTER TABLE org_departement_fonction_events
  ADD UNIQUE KEY uq_org_dfe_version_event (fonction_id, event_type, version_apres);
