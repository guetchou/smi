# Bilan financier — maquette validée

## (1) Synthèse et PRD
Objectif : intégrer la maquette Figma Mm38LUI6KP5iq9Nn521eSJ, écran 4:133, validée par l’utilisateur, avec graphique affiné de 584 px et libellé Bilan financier. Conserver toutes les données, droits, filtres et actions. Pas de mutation métier, de migration ni de dépendance.

## (2) Inventaire
Production propre sur main 59420f1 ; application caisse-topcenter, MySQL et staging partagés. Accès SSH administrateur disponible ; disque 6,7 Go libres. Travail dans un worktree isolé ; contrôles lourds dans GitHub Actions.

## (3) Plan
1. Remplacer la présentation du bilan, conserver ses identifiants et branchements. 2. Relier les onglets aux détails et garder les validations dans À traiter. 3. Affiner le graphique sans altérer les montants et vérifier les périodes vides. 4. Vérifier syntaxe, tests existants adaptés à la maquette validée, clavier, 320/768/1024/1440 px. 5. PR, CI complète, déploiement officiel et contrôle Chrome authentifié. Toutes les actions sont non destructives et autorisées par GO.

## (4) Sauvegarde
Aucune sauvegarde fichier séparée : rollback Git suffisant. Point de départ 59420f1e4cb0ed4f00f44e03ba2ec43de2b225c2. Le déploiement officiel conserve sa sauvegarde de production.

## (5) Vérifications
À compléter avec les résultats et les contrôles réels. Ne pas assimiler une maquette ou une injection de prévisualisation à la version publiée. Scénario : ouvrir le bilan, changer mois/année, actualiser, exporter, parcourir les quatre onglets au clavier, consulter les décaissements et les alertes, période vide puis retour au dernier mois renseigné. Comparaison : hiérarchie et sections de la maquette approuvée ; principes de lisibilité d’Editorial HTML5 UP.

## (6) Retour arrière
Créer un commit inverse du lot puis utiliser le workflow deploy.yml avec le SHA de main validé. Pas de retour arrière de base de données nécessaire.

## (7) Diff
Présentation et graphique du bilan dans frontend/dashboard.html ; tests de présentation mis à jour pour les choix validés. Backend, contrats API, calculs financiers et règles de validation inchangés.

Vérifications avant CI : 7 gardes ciblées existantes, tests numériques du graphique (chaînes MySQL, deux flux, période vide, doublons), syntaxe de tous les scripts inline et git diff --check réussis. Prévisualisation dans Chrome existant : 320 px sans débordement, onglets flèches clavier, données réelles en mai et octobre. Les captures candidat ne sont pas la version publiée. Audit dépendances sans changement des lockfiles ; vulnérabilités préexistantes documentées par npm audit.
