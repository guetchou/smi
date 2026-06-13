-- Migration neutralisee.
-- Le workflow de correction des bulletins payes utilise deja la table existante :
-- rectifications_bulletins
--
-- Cette migration avait tente de creer une table doublon
-- bulletins_salaire_corrections avec une contrainte FK incompatible
-- avec le type reel de bulletins_salaire.id en production.
--
-- Ne rien executer ici pour eviter un crash au demarrage.
SELECT 1;
