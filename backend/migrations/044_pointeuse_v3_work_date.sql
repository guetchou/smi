-- Pointeuse V3 : distinguer la date civile de l'événement de la journée de travail.
-- Nécessaire pour les horaires de nuit qui traversent minuit.

ALTER TABLE pointeuse_events
  ADD COLUMN work_date DATE NULL AFTER local_date;

UPDATE pointeuse_events
SET work_date = local_date
WHERE work_date IS NULL;

ALTER TABLE pointeuse_events
  MODIFY COLUMN work_date DATE NOT NULL;

CREATE INDEX idx_pointeuse_events_work_date
  ON pointeuse_events(employe_id, work_date, occurred_at_utc);
