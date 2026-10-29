# Rapport — Totaux du tableau de bord

## 1. Synthèse
Les vues par profil additionnaient les brouillons et annulations. Alignement sur statut=valide, comme /kpis/summary ; virements hors compteur des opérations de caisse.

## 2. Inventaire
Worktree dédié propre avant modification, branche fix/dashboard-totaux-20261029 depuis origin/main c39cae4. MySQL de production inchangé. Test SQL exécuté dans une base SQLite :memory: séparée, sans connexion à la base métier.

## 3. Actions
Priorité haute, correction réversible de cinq agrégations ; risque limité au calcul des résumés. Publication autorisée par l’utilisateur. Aucun changement des listes historiques ni des actions en attente.

## 4. Sauvegarde
Aucune sauvegarde fichier séparée : rollback Git suffisant. Base c39cae42470706915ca2e03a1f532cb7abe64755.

## 5. Vérifications
Neuf tests de requêtes réelles réussis : six profils et flux jour/semaine/mois. Jeu : encaissement validé 1200,50, décaissement validé 300,25, encaissement annulé 900000, brouillon 200000, décaissement soumis en brouillon 70000 et virement 150. Résultat attendu : net 900,25 et deux opérations. Contrôles graphiques/filtres, 19 gardes tableau de bord et 8 gardes par rôle passés. CI complète obligatoire avant fusion. Contrôle visuel en production restant à effectuer : MCP Chrome en délai de connexion, aucun écran annoncé validé.

## 6. Retour arrière
Commit inverse du présent lot puis procédure officielle de déploiement. Aucun retour arrière de données nécessaire.

## 7. Diff
backend/routes/dashboard.js : filtres des agrégations et compteurs. tests/dashboard_flux_valides_test.js : SQL réels avec adaptateur SELECT en mémoire. package.json : intégration dans npm test. Documentation PRD et rapport.
