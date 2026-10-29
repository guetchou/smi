# PRD
Aligner les flux des vues par profil sur les opérations validées, comme les indicateurs principaux. Exclure brouillons et annulations ; exclure les virements du compteur.

# Plan
Corriger les agrégations seules ; tester les SQL réels en mémoire avec statuts variés et décimales ; contrôles et CI ; déploiement officiel autorisé ; observation Chrome existant. Aucune écriture métier.

# Retour arrière
Aucune sauvegarde fichier séparée : rollback Git suffisant. Référence c39cae42470706915ca2e03a1f532cb7abe64755. Commit inverse et déploiement officiel.
