# Plan et suivi

1. Identite/acces : fermer la transaction de creation RH, verifier activation/revocation et profils. EN COURS.
2. RH/pointeuse : verifier creation agent, contrat, conges, pointage et sortie, en separant les vues personnelles et supervision. A VERIFIER.
3. Finance/paie : verifier source des soldes, corrections, validations, rapprochement et transactions agents/salaires. A VERIFIER.
4. Achats/ventes/stock : verifier demande -> commande -> reception -> facture -> paiement et devis -> facture -> encaissement. A VERIFIER.
5. Interface/exploitation : relever seulement les defauts observes, garder les dimensions demandees, verifier retours utilisateur et incidents. A VERIFIER.

Reutiliser tests et documents existants; ne pas repeter un controle vert sans modification ou anomalie. Un lot couvre un parcours complet, pas un fichier isole. Mise a jour de ce tableau sur preuves; aucune affirmation de completion globale avant acceptance. Priorite aux risques de donnees et acces.

Lot identite : test MySQL isole reussi (creation, profil choisi, statut RH, doublon, concurrence creation/modification, agent inactif, quatre retours arriere). Aucune migration : verrouillage de la fiche agent dans la transaction. Suite npm locale arretee par absence du compilateur Tailwind dans cet espace ; suite complete confiee a la CI existante.

Audit dependances : racine 9 alertes (8 hautes, 1 moderee), backend 7 (1 critique, 3 hautes, 2 moderees, 1 faible). Preexistantes, fichiers de verrouillage inchanges; traiter dans un lot de compatibilite distinct du parcours RH.

Lecture des profils rattachee a la meme transaction : le test concurrent passe aussi avec deux connexions, sans recourir a une connexion hors transaction.
