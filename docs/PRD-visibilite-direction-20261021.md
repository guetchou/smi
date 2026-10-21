# PRD
Rétablir la consultation des décaissements, du parapheur administratif et des chiffres mensuels. Deux brouillons de décaissement (930 075 XAF) et une demande en attente de l'assistante existent. Les encaissements récents ont des dates métier de janvier à avril, pas octobre. Ne modifier aucune date, aucun montant et aucune validation.

# Plan
1. Permettre à l'administrateur de consulter tous les décaissements non payés et tous les dossiers non terminés du parapheur. Préserver les affectations aux caisses et les droits des actions.
2. Donner un résultat visible au bouton Décaissements, y compris sans résultat ou en cas d'erreur. Clarifier le lien Achats à approuver.
3. Afficher la période du bilan et un accès au dernier mois actif quand la période est vide. Préserver les chiffres à zéro du mois sélectionné. Réduire les cartes et retirer le graphique vide.
4. Tester les rôles, états vides et erreurs ; CI officielle, retour arrière Git, déploiement officiel et contrôle des quatre écrans dans Chrome.

# Retour arrière et limites
Aucune sauvegarde fichier séparée : rollback Git suffisant. Retour à edb312fd0ef7ce2793aa81f0631ba07b65d4a7be par le déploiement officiel. Aucune migration ni écriture de données métier. Conserver les travaux de paie non publiés du 8 octobre dans leur branche existante. Les sept Go libres imposent de garder les tests lourds en CI et de ne pas dupliquer les dépendances sur le VPS.

Contrôle complémentaire : le seul dossier en attente du parapheur est lié au décaissement de test 36, déjà annulé. Masquer ces dossiers dans les files actives, les conserver dans l'historique avec le libellé Décaissement annulé et sans actions de décision. Aucun changement des données. Corriger aussi le masquage CSS du bouton du dernier mois : la classe btn annulait l'effet de hidden. Avril doit être calculé au 30 et non au 31.

Preuves avant publication : huit contrôles ciblés réussis et syntaxe des scripts HTML vérifiée. Le gestionnaire corrigé du bilan, exécuté en lecture seule sur MySQL, rend 6 encaissements / 4 140 000 XAF en avril 2026 (fin 30/04). Le dossier parapheur 24 pointe vers le décaissement 36 annulé : absent de la file active et conservé dans l historique. Aperçu Chrome à 1366 px : deux brouillons visibles et cartes réduites ; les chiffres définitifs restent à vérifier après publication. Aucune mutation métier exécutée.
