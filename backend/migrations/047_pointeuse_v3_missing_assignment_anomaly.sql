-- Pointeuse V3 : l'absence d'affectation planning devient une anomalie à part entière.
-- Auparavant un pointage sans planning affecté était signalé remote_not_authorized,
-- ce qui décrivait une cause fausse. La nouvelle valeur doit exister dans l'ENUM
-- avant que le recalcul journalier ne puisse l'insérer.

ALTER TABLE pointeuse_anomalies
  MODIFY COLUMN anomaly_type ENUM(
    'late',
    'early_leave',
    'missing_in',
    'missing_out',
    'missing_break_end',
    'overlap',
    'outside_schedule',
    'outside_geofence',
    'remote_not_authorized',
    'excessive_duration',
    'insufficient_duration',
    'missing_assignment'
  ) NOT NULL;
