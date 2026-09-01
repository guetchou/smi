-- Jours fériés de la République du Congo — calendrier CG-STANDARD.
--
-- Le calendrier existait (Africa/Brazzaville, lundi-vendredi) mais aucun jour
-- n'y était déclaré. Chaque férié comptait donc comme un jour ouvré, et
-- produisait une anomalie « Entrée manquante » par agent — douze par férié.
--
-- Sources : deux publications concordantes donnent dix jours fériés pour la
-- République du Congo et les mêmes dates fixes. Leurs résumés se contredisant
-- sur les dates mobiles, celles-ci sont calculées depuis Pâques plutôt que
-- recopiées :
--
--   Pâques 2026 = 5 avril   -> lundi +1, Ascension +39, lundi de Pentecôte +50
--   Pâques 2027 = 28 mars   -> idem
--
-- Le texte qui fait foi est le décret congolais fixant la liste. Il n'a pas pu
-- être consulté : le site de l'ambassade présente un certificat expiré, et les
-- textes trouvés sur les portails juridiques concernent la RDC (Kinshasa), pas
-- la République du Congo. Ces dates sont donc à confirmer contre le décret,
-- notamment si une année ajoute un jour chômé exceptionnel.
--
-- INSERT IGNORE : la console d'administration permet de déclarer des jours à la
-- main. Une saisie humaine préexistante n'est jamais écrasée.

INSERT IGNORE INTO pointeuse_calendar_days
  (calendar_id, work_date, day_type, libelle, created_at, updated_at)
SELECT c.id, j.work_date, 'holiday', j.libelle, NOW(), NOW()
FROM pointeuse_work_calendars c
CROSS JOIN (
  -- 2026
  SELECT '2026-01-01' AS work_date, 'Jour de l''An'                  AS libelle
  UNION ALL SELECT '2026-04-06', 'Lundi de Pâques'
  UNION ALL SELECT '2026-05-01', 'Fête du Travail'
  UNION ALL SELECT '2026-05-14', 'Ascension'
  UNION ALL SELECT '2026-05-25', 'Lundi de Pentecôte'
  UNION ALL SELECT '2026-06-10', 'Journée de la Réconciliation'
  UNION ALL SELECT '2026-08-15', 'Fête nationale'
  UNION ALL SELECT '2026-11-01', 'Toussaint'
  UNION ALL SELECT '2026-11-28', 'Jour de la République'
  UNION ALL SELECT '2026-12-25', 'Noël'
  -- 2027
  UNION ALL SELECT '2027-01-01', 'Jour de l''An'
  UNION ALL SELECT '2027-03-29', 'Lundi de Pâques'
  UNION ALL SELECT '2027-05-01', 'Fête du Travail'
  UNION ALL SELECT '2027-05-06', 'Ascension'
  UNION ALL SELECT '2027-05-17', 'Lundi de Pentecôte'
  UNION ALL SELECT '2027-06-10', 'Journée de la Réconciliation'
  UNION ALL SELECT '2027-08-15', 'Fête nationale'
  UNION ALL SELECT '2027-11-01', 'Toussaint'
  UNION ALL SELECT '2027-11-28', 'Jour de la République'
  UNION ALL SELECT '2027-12-25', 'Noël'
) AS j
WHERE c.code = 'CG-STANDARD';

-- Les années suivantes doivent être ajoutées : les fêtes mobiles se calculent
-- depuis Pâques et ne peuvent pas être déduites en SQL. La console
-- d'administration permet de les saisir, onglet « Planning & règles ».
