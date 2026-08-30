-- Pointeuse V3 : auto-déduction de la pause non prise.
--
-- Sans cette règle, la pause n'est retirée du temps travaillé que si l'agent la
-- déclare, alors qu'elle est toujours retirée de la journée théorique. Une pause
-- non déclarée produit donc mécaniquement des heures supplémentaires : sur un
-- planning 08h00-17h00 avec 60 min de pause, l'agent absent de 12h à 13h sans
-- le déclarer était crédité de 60 min d'heures supplémentaires.
--
-- pause_seuil_minutes : durée travaillée à partir de laquelle la déduction
-- s'applique, pour ne pas amputer une demi-journée. 360 min = 6 h.

ALTER TABLE pointeuse_work_schedules
  ADD COLUMN pause_auto_deduction TINYINT(1) NOT NULL DEFAULT 1 AFTER pause_minutes,
  ADD COLUMN pause_seuil_minutes INT NOT NULL DEFAULT 360 AFTER pause_auto_deduction;

-- Le montant réellement déduit reste visible et auditable, séparé de la pause
-- physiquement déclarée par l'agent.
ALTER TABLE pointeuse_daily_summaries
  ADD COLUMN break_auto_minutes INT NOT NULL DEFAULT 0 AFTER break_minutes;
