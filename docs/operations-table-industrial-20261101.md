# Tableau des mouvements

Objectif : recherche, filtres, tri, pagination, totaux, détail et export. Réutiliser les opérations validées et le périmètre autorisé. Aucune écriture financière.

Plan : module compact, tri serveur sur liste blanche, tests, CI, déploiement officiel et observation Chrome. Retour arrière : annuler le commit via Git puis déployer. Version initiale abe7cab6fec017a66d99e05c5b7b8cc524b6705c.

Aucune sauvegarde fichier separee : rollback Git suffisant. Comparaison fonctionnelle : grille de gestion avec tri serveur, recherche, filtres cumulatifs, pagination visible, totaux sur toute la selection, export et consultation sans edition. Aucun ajout de dependance, migration ou traitement financier. Export borne a 10 000 lignes avec refus explicite au-dela.

Tests unitaires reussis ; audits npm racine/backend : zero vulnerabilite. Runtime navigateur et dependances backend absents du worktree : execution complete confiee a la CI existante. Apercu temporaire observe dans Chrome authentifie, distingue de la version publiee.
