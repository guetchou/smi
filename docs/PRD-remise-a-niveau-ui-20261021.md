# PRD et plan - revue complete des ecrans SMI

Objectif : corriger les erreurs de presentation et de raccordement constatees dans chaque menu, sous-menu, page, bouton, carte et formulaire, sans modifier les donnees metier.

## Plan
1. Inventorier toutes les pages et commandes.
2. Lire chaque etat reel dans Chrome, ouvrir les formulaires sans enregistrer de donnees metier et relever les erreurs.
3. Corriger par lots coherents, conserver les contrats API et permissions.
4. Executer les gardes utiles, publier par la procedure officielle et comparer le resultat reel.

## Inventaire initial
| Page | Boutons et liens | Champs | Controle reel |
|---|---:|---:|---|
| page-dashboard | 6 | 0 | Premier passage Chrome ; controle final a faire |
| page-rh-overview | 1 | 2 | Premier passage Chrome ; controle final a faire |
| page-agents | 8 | 2 | Premier passage Chrome ; controle final a faire |
| page-employment-contracts | 0 | 0 | Premier passage Chrome ; controle final a faire |
| page-absences | 7 | 4 | Premier passage Chrome ; controle final a faire |
| page-organigramme | 15 | 2 | Premier passage Chrome ; controle final a faire |
| page-operations | 17 | 4 | Premier passage Chrome ; controle final a faire |
| page-salaires | 12 | 3 | Premier passage Chrome ; controle final a faire |
| page-cnss | 8 | 2 | Premier passage Chrome ; controle final a faire |
| page-dgi | 11 | 2 | Premier passage Chrome ; controle final a faire |
| page-calendrier-fiscal | 3 | 5 | Premier passage Chrome ; controle final a faire |
| page-budget | 3 | 1 | Premier passage Chrome ; controle final a faire |
| page-journal | 4 | 4 | Premier passage Chrome ; controle final a faire |
| page-comptabilite-dashboard | 2 | 0 | Premier passage Chrome ; controle final a faire |
| page-journal-comptable | 10 | 4 | Premier passage Chrome ; controle final a faire |
| page-audit | 5 | 6 | Premier passage Chrome ; controle final a faire |
| page-bilan | 18 | 2 | Premier passage Chrome ; controle final a faire |
| page-rapports | 14 | 5 | Premier passage Chrome ; controle final a faire |
| page-rapprochement | 8 | 9 | Premier passage Chrome ; controle final a faire |
| page-achats | 3 | 4 | Premier passage Chrome ; controle final a faire |
| page-clients | 1 | 3 | Premier passage Chrome ; controle final a faire |
| page-devis | 1 | 2 | Premier passage Chrome ; controle final a faire |
| page-factures-clients | 3 | 1 | Premier passage Chrome ; controle final a faire |
| page-produits | 6 | 3 | Premier passage Chrome ; controle final a faire |
| page-bons-commandes | 1 | 1 | Premier passage Chrome ; controle final a faire |
| page-receptions | 1 | 1 | Premier passage Chrome ; controle final a faire |
| page-factures-fournisseurs | 8 | 2 | Premier passage Chrome ; controle final a faire |
| page-contrats | 3 | 2 | Premier passage Chrome ; controle final a faire |
| page-sanctions | 1 | 3 | Premier passage Chrome ; controle final a faire |
| page-heures-sup | 0 | 4 | Premier passage Chrome ; controle final a faire |
| page-offboarding | 0 | 3 | Premier passage Chrome ; controle final a faire |
| page-periodes | 4 | 2 | Premier passage Chrome ; controle final a faire |
| page-revisions | 1 | 3 | Premier passage Chrome ; controle final a faire |
| page-grilles | 4 | 2 | Premier passage Chrome ; controle final a faire |
| page-pointeuse | 20 | 28 | Premier passage Chrome ; controle final a faire |
| page-parapheur | 8 | 10 | Premier passage Chrome ; controle final a faire |
| page-parametres | 33 | 85 | Premier passage Chrome ; controle final a faire |

## Limites et retour arriere
Session Chrome revenue a la connexion pendant le premier passage global : les autres pages ne sont pas declarees verifiees. Aucune sauvegarde fichier separee : rollback Git suffisant. Production initiale 19790fb9b3f94efae222b310459e46480aeb8692 ; donnees et services partages preserves.

## Journal d audit : defaut fonctionnel confirme
La route GET ignorait tous les filtres et la pagination et annoncait le nombre de lignes renvoyees comme total. Correction en lecture seule : requetes parametrees, limites bornees, dates valides, total filtre reel et metadonnees pour les listes. Le CSV reprend la meme recherche. Roles admin/DG preserves. Test sans base verifie injections, dates invalides, deux pages, metadonnees et SELECT uniquement.

## Rapport du lot
### 1. Synthese
Corrections communes des actions dupliquees, formulaires commerciaux, paie, droits et audit, plus commandes du calendrier et choix des tiers. Aucun enregistrement metier de test cree.
### 2. Inventaire
37 pages recensees ; session Chrome administrateur conservee, VPS partage, production 19790fb, branche fix/bilan-libelles-20261021.
### 3. Actions
Corrections reversibles de presentation et de lecture ; droits et ecritures metier inchanges.
### 4. Sauvegarde
Aucune sauvegarde fichier separee : rollback Git suffisant. Base 19790fb9b3f94efae222b310459e46480aeb8692. Sauvegarde de deploiement geree par la procedure officielle.
### 5. Verifications
Gardes statiques et tests de lecture audit et commandes fiscales passes. Apercu temporaire Chrome : nom requis et email invalide bloquent Continuer ; retour conserve la saisie ; contrat propose les noms de tiers ; fenetre de 640 px et absence de debordement a 320 px ; bouton Modifier ouvre une echeance. Apercu retire. Tests de base non executables dans le worktree sans mysql2/better-sqlite3 : suite complete deleguee a CI, aucune installation sur Windows.
Audits de dependances : {".":{"info":0,"low":0,"moderate":1,"high":8,"critical":0,"total":9},"backend":{"info":0,"low":1,"moderate":2,"high":3,"critical":1,"total":7}} (etat preexistant, aucune dependance ajoutee).
### 6. Retour arriere
Inverser le commit de ce lot et publier via deploy.yml. Aucun retour arriere de base necessaire : aucune migration ni modification de donnees.
### 7. Diff et limites
frontend/dashboard.html, navigation.js, pointeuse-v3.js, route de consultation audit et service audit_read.js, gardes et tests navigateur. Toutes les validations financieres, paiements et changements de permissions reels restent non executes en production lors de cette revue. Les autres roles sont couverts par les parcours isoles de CI ; seule la session administrateur est observee en direct. Controle final de la version publiee requis.
