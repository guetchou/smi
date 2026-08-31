-- Rappels : poser la contrainte d'unicité que le code assume depuis l'origine.
--
-- planifierRappel() se dit « idempotent sur type × src × J » et s'appuie pour
-- cela sur une erreur de doublon :
--
--   catch (e) { if (e.message.includes('Duplicate')) return null; }
--
-- Mais aucun index unique n'a jamais existé sur notif_rappels. L'erreur n'était
-- donc jamais levée, et chaque passage du planificateur réinsérait le même
-- rappel. Constaté en production le 31/08/2026 : 95 rappels identiques pour la
-- seule échéance DGI du 10/06, 400 lignes au total pour 97 rappels réels.
--
-- Chaque rappel se déclenchant une fois et écrivant un message par destinataire,
-- notif_messages comptait 2 123 messages de rappel pour 97 distincts. D'où le
-- badge « 99+ » et les « 883 restants » à l'écran.
--
-- La clé naturelle est (type, src_table, src_id, declenchement_j) : un rappel
-- par échéance et par palier d'avance. declenche_a en découle, il n'a pas à
-- figurer dans la clé. Aucune de ces colonnes n'est nulle sur les 400 lignes.

-- 1. Dédupliquer les rappels, en gardant le plus ancien de chaque groupe.
DELETE r FROM notif_rappels r
JOIN (
  SELECT MIN(id) AS garde, type, src_table, src_id, declenchement_j
  FROM notif_rappels
  GROUP BY type, src_table, src_id, declenchement_j
) g
  ON  g.type            = r.type
  AND g.src_table       = r.src_table
  AND g.src_id          = r.src_id
  AND g.declenchement_j = r.declenchement_j
WHERE r.id <> g.garde;

-- 2. Poser la contrainte. À partir d'ici, le catch de planifierRappel a un sens.
ALTER TABLE notif_rappels
  ADD UNIQUE KEY uk_notif_rappel (type, src_table, src_id, declenchement_j);

-- 3. Purger les messages déjà émis en double, en gardant le premier reçu.
--    Le texte du message porte le palier d'avance (« dans 7 jours »), il fait
--    donc partie de la clé : une escalade reste distincte du rappel initial.
--    Les familles « alerte » et « notification » ne sont pas concernées.
DELETE m FROM notif_messages m
JOIN (
  SELECT MIN(id) AS garde, type, user_id, src_table, src_id, message
  FROM notif_messages
  WHERE famille = 'rappel'
  GROUP BY type, user_id, src_table, src_id, message
) g
  ON  g.type      = m.type
  AND g.user_id   = m.user_id
  AND g.src_table = m.src_table
  AND g.src_id    = m.src_id
  AND g.message   = m.message
WHERE m.famille = 'rappel' AND m.id <> g.garde;
