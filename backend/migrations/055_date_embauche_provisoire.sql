-- 055 — Date d'embauche : valeur provisoire pour débloquer les dossiers
--
-- Aucun des 18 agents n'avait de date d'embauche renseignée. Cette absence
-- bloque tout calcul d'ancienneté, donc l'offboarding et le solde de tout
-- compte, et rend les dossiers inexploitables devant un contrôle.
--
-- Décision du Directeur Général du 01/09/2026 : poser le 01/08/2026 pour tous,
-- charge aux agents habilités de corriger ensuite, le champ étant modifiable.
--
-- La valeur est POSÉE COMME PROVISOIRE, pas déclarée comme exacte. Un
-- événement d'onboarding est écrit pour chaque agent concerné AVANT la mise à
-- jour, de sorte que le correcteur et le commissaire aux comptes distinguent
-- ce qui est déclaré de ce qui reste à établir. L'ancienneté calculée sur
-- cette base n'est pas opposable tant que l'événement n'est pas levé par une
-- date réelle.
--
-- L'ordre compte : l'insertion des événements sélectionne les lignes encore
-- nulles ; la mise à jour vient après, sinon l'information « était nulle »
-- serait perdue.

INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at)
SELECT
  id,
  'date_embauche_provisoire',
  NULL,
  JSON_OBJECT(
    'date_embauche', '2026-08-01',
    'nature', 'provisoire',
    'motif', 'Aucune date d''embauche n''etait renseignee ; valeur posee en masse pour debloquer les dossiers',
    'a_corriger', TRUE
  ),
  NULL,
  NOW()
FROM employes
WHERE date_embauche IS NULL;

UPDATE employes
SET date_embauche = '2026-08-01',
    updated_at    = NOW()
WHERE date_embauche IS NULL;
