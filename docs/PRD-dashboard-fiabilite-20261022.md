# Tableau de bord et fiabilite SMI
## Objectif et scenario
Donner une lecture immediate des soldes signes, du seuil, et des flux de la periode. Comparaison aux usages des tableaux de tresorerie : courbes/barres avec axe commun, montants explicites, vide explicite ; pas de part positive pour un decouvert. Conserver identite SMI et donnees reelles.
## Plan
1. Audit passif des graphiques, signalements, droits et dependances.
2. Presentation compacte : positions signees, seuil lisible, evolution de periode.
3. Verifier les signalements comptables/budget/affectation ; corriger les causes confirmees sans valider les brouillons a la place du metier.
4. Parcourir onglets secondaires RH/stock et ecritures par profil en environnement isole.
5. Regrouper les actions de meme libelle dans l audit et corriger les dependances vulnerables avec verifications de compatibilite.
6. Tests requis, publication officielle, controle Chrome et rapport.
## Inventaire initial
Production d8d3dc5, depot propre, service sain ; VPS partage, application3337, staging3347, MySQL3307. Disque6.5Go libres. Session Chrome administrateur existante preservee. Modules : frontend (risque presentation/XSS), backend finance (integrite/droits), RH-stock (roles/transactions), audit (filtres), dependances (composants exposes).
## Reversibilite
Aucune sauvegarde fichier separee : rollback Git suffisant. Aucune modification de donnees/schema programmee. Tests d ecriture en environnement isole ; pas de paiement ou validation automatique en production.
## Defauts confirmes
Anneau positions en valeur absolue mal adapte au decouvert, montant superpose, jauge324304% illisible ; graphiques de periode peu informatifs sur mois vide. API signalements :153ouverts, premieres lignes ACCOUNTING_SYNC_PENDING avec ecritures brouillon. Ne pas les confondre avec echec.

## Rapport du lot
### 1. Synthese
Graphiques de l accueil rendus signes et compacts ; seuil exprime par un etat lisible. Filtres d audit regroupes sans perte des codes. Dependances corrigees ; aucun changement de donnees ni de droits.
### 2. Inventaire
Base d8d3dc5, branche fix/dashboard-fiabilite-20261022 ; VPS partage. Controles en lecture seule du moteur financier documentes dans diagnostic-finance-20261028.md.
### 3. Actions et risques
Presentation frontend et SELECT parametres : risque faible. Dependances verrouillees : risque de compatibilite couvert par tests tableur/email sans reseau et suite complete. Aucun paiement reel ni activation du registre canonique.
### 4. Retour arriere
Aucune sauvegarde fichier separee : rollback Git suffisant. Inverser le commit du lot puis deploiement officiel. Aucune migration ni reprise historique executee.
### 5. Verifications
Tests graphiques signes, echappement HTML, echelle commune, trous de calendrier, mois vide et filtres groupes passes. Controles accueil19/19 et audit visuel10/10 passes ; autres gardes ciblées passees. CSS compile et fraicheur verifies. Audits npm backend et racine :0signalement le28/10. Nouveau test navigateur sur4largeurs et sous-onglets ajoute au banc existant. Navigateurs absents du worktree : execution complete deleguee a CI.
### 6. Limites actuelles
Le controle financier canonique n est pas une preuve de perte d argent : les routeurs conservent explicitement le moteur historique pour les positions non activees. Ecritures comptables brouillon et attentes budget/affectation conservees. Reprise historique non autorisee par cette revue en lecture seule.
Chrome DevTools configure mais outils non exposes dans la session apres redemarrage ; reconnexion du meme Chrome en cours, controle visuel reel requis avant de declarer l ecran valide.
### 7. Perimetre
Frontend dashboard et module de graphique, service de lecture audit, packages/verrous et tests. Parcours RH et stock : extension du banc existant aux sous-onglets visibles et a la fiche agent en creation ; historique des dossiers existants a observer dans Chrome.
