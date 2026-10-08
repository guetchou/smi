# Remise a niveau SMI

Objectif : stabiliser tous les modules existants selon PRD_industrialisation_redressement.md, sans ajouter de module ni refaire le frontend. Base verifiee : 70e05cedf690fe75a040cbe06261f8c194254fe4.

Perimetre : identite et acces; RH et pointeuse; finance et paie; achats, ventes et stock; interface et exploitation. Aucun correctif des donnees historiques sans decision metier explicite.

Acquis verifies dans le code : service identity_access central; profils choisis en RH; ledger, seuils, double approbation, cloture et perimetre caisse deja presents. Leur seule presence ne vaut pas acceptance de tous les parcours.

Ecarts confirmes : creation RH en deux transactions; recalcStatus non exporte; deux dependances runtime a database.js (agents et salaires); PLAN_IMPLEMENTATION.md annonce PROJET TERMINE avec une etape non cochee.

Lot initial : compte, profil choisi, tache, evenement et statut RH dans une seule transaction. Un echec doit tout annuler; une reussite doit rendre le compte et ses droits disponibles ensemble. Aucun changement de payload, role, schema, module ou mot de passe.

Acceptation : test comportemental de succes et echecs apres creation/profil/evenement/recalcul; preuve MySQL COMMIT/ROLLBACK; tests existants; validation Chrome du parcours accessible sans creation de compte de production; publication officielle. Retour arriere code : version precedente; aucune sauvegarde fichier separee, rollback Git suffisant.
