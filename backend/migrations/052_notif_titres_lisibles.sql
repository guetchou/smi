-- Rappels : réécrire les titres restés sous leur code technique.
--
-- _titreRappel portait un dictionnaire codé en dur de 8 libellés, alors que
-- notif_regles en compte 13 pour la famille rappel, toutes renseignées. Les
-- cinq échéances fiscales manquaient à la copie, donc leur code brut
-- s'affichait : RAP_DGI_MENSUEL, [ESCALADE] RAP_IS_ACOMPTE, RAP_CNSS_TRIMESTRE.
--
-- Le code lit désormais notif_regles.libelle, mais les 97 messages déjà en base
-- gardent le titre qui leur a été donné à l'émission. Ils sont réécrits ici
-- depuis la même source.
--
-- La condition est volontairement étroite : seul un titre strictement égal au
-- code — ou au code préfixé par [ESCALADE] — est réécrit. Un titre déjà
-- lisible, ou modifié à la main, n'est pas touché.

-- Escalades : le préfixe est conservé, seul le code est remplacé.
UPDATE notif_messages m
JOIN notif_regles rg ON rg.type = m.type
SET m.titre = CONCAT('[ESCALADE] ', rg.libelle)
WHERE m.famille = 'rappel'
  AND m.titre = CONCAT('[ESCALADE] ', m.type)
  AND rg.libelle IS NOT NULL
  AND rg.libelle <> '';

-- Rappels initiaux.
UPDATE notif_messages m
JOIN notif_regles rg ON rg.type = m.type
SET m.titre = rg.libelle
WHERE m.famille = 'rappel'
  AND m.titre = m.type
  AND rg.libelle IS NOT NULL
  AND rg.libelle <> '';
