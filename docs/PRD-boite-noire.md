# Boite noire SMI

Objectif : relier erreurs navigateur, requetes, serveur et base aux actions concernees. Un refus est un fait a examiner, jamais une attribution automatique de faute.

Scenarios : action sans valeurs -> trace navigateur -> identifiant de requete genere par le serveur -> erreur SQL avec code et empreinte sans parametres -> consultation admin. Les principes des collecteurs industriels sont la correlation, la limitation de volume, la confidentialite, la retention et une collecte qui ne bloque pas le metier.

Plan : audit passif ; branche isolee ; collecte et consultation admin ; tests de confidentialite, droits, panne et correlation ; CI ; deploiement officiel autorise ; preuve sur version publiee.

Stockage : volume backend/data existant, maximum quatre fichiers de 1 Mo environ et un petit fichier pour le dernier arret fatal (un lot peut depasser legerement), conservation au plus trente jours, file limitee a 500 evenements, trente jours sous reserve du plafond de volume. Aucune video, valeur de formulaire, corps HTTP, parametre SQL, mot de passe ou jeton.

Limites : collecte navigateur authentifiee, best effort ; trace navigateur declaree par le client et donc non probante ; navigation/clics identifies par controles, pas leur texte ; defauts visuels detectes seulement par quelques signaux de debordement ; crash brutal ou reseau absent peut perdre la file ; aucun audit inviolable. Acces SQL async et historiques observes ; une connexion directe nouvelle devra etre branchee explicitement.

Retour arriere : aucune sauvegarde fichier separee : rollback Git suffisant. Deployer la version precedente par procedure officielle. Aucun schema ni donnees metier modifies, journaux conserves sur le volume.
