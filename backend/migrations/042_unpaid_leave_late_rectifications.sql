ALTER TABLE rectifications_bulletins
  ADD COLUMN source_type VARCHAR(50) NULL,
  ADD COLUMN source_id INT NULL,
  ADD COLUMN source_period VARCHAR(7) NULL;

ALTER TABLE rectifications_bulletins
  ADD UNIQUE KEY uq_rectification_source_period
    (source_type, source_id, source_period);
