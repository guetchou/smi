# PRD — Moteur budgétaire et gouvernance financière Tala-SMI

## 1. Finalité

Le moteur budgétaire doit permettre à l’entreprise de ne plus seulement constater les encaissements et décaissements après exécution, mais de prévoir, arbitrer, autoriser, engager, exécuter et contrôler les ressources financières.

Il couvre simultanément :

- les dépenses prévues ;
- les recettes prévues ;
- les charges fixes ;
- les charges variables ;
- les investissements ;
- la paie ;
- les loyers ;
- l’eau ;
- l’électricité ;
- internet et télécommunications ;
- les abonnements ;
- les assurances ;
- les impôts et taxes ;
- les achats récurrents ;
- les dépenses exceptionnelles ;
- les recettes commerciales ;
- les subventions ;
- les remboursements ;
- les autres produits attendus.

## 2. Principe directeur

Le budget n’est pas une simple liste de montants.

Il doit suivre le cycle complet :

```text
Hypothèses
→ Prévisions
→ Construction budgétaire
→ Arbitrage
→ Validation
→ Mise à disposition
→ Engagement
→ Consommation
→ Révision
→ Clôture
→ Analyse des écarts
```

Une dépense ne doit pas être évaluée uniquement au moment du paiement.

Le système doit distinguer :

- le budget prévu ;
- le budget validé ;
- le budget disponible ;
- le montant réservé ou provisionné ;
- le montant engagé ;
- le montant réalisé ;
- le montant payé ;
- le reliquat ;
- le dépassement ;
- la recette prévue ;
- la recette réalisée ;
- la recette encaissée ;
- l’écart de trésorerie.

## 3. Horizons budgétaires

Le moteur doit gérer plusieurs horizons cohérents et liés :

```text
Budget annuel
→ découpé en semestres
→ découpé en trimestres
→ découpé en mois
→ éventuellement ventilé par semaine ou échéance
```

Chaque niveau doit agréger automatiquement le niveau inférieur.

Une modification mensuelle doit pouvoir mesurer son impact sur le trimestre, le semestre et l’année.

Le système doit permettre :

- budget annuel initial ;
- budget semestriel ;
- budget trimestriel ;
- budget mensuel ;
- budget révisé ;
- budget glissant sur 12 mois ;
- scénario prudent ;
- scénario central ;
- scénario ambitieux.

## 4. Axes analytiques

Chaque ligne budgétaire doit pouvoir être ventilée selon :

- entreprise ;
- exercice ;
- site ;
- direction ;
- département ;
- service ;
- projet ;
- centre de coût ;
- activité ;
- nature de charge ou produit ;
- compte OHADA ;
- position de trésorerie prévue ;
- responsable budgétaire ;
- devise.

Le moteur doit fonctionner même si tous les axes ne sont pas utilisés au départ.

## 5. Typologie budgétaire

### 5.1 Dépenses

- charges fixes récurrentes ;
- charges variables ;
- paie et charges sociales ;
- achats ;
- frais généraux ;
- maintenance ;
- loyers ;
- énergie et eau ;
- télécommunications ;
- transport ;
- missions ;
- impôts et taxes ;
- investissements ;
- dettes à rembourser ;
- dépenses exceptionnelles.

### 5.2 Recettes

- ventes ;
- prestations ;
- contrats récurrents ;
- abonnements ;
- subventions ;
- remboursements ;
- produits financiers ;
- avances reçues ;
- recettes exceptionnelles.

## 6. Récurrence et échéanciers

Une ligne budgétaire doit pouvoir être :

- ponctuelle ;
- mensuelle ;
- bimensuelle ;
- trimestrielle ;
- semestrielle ;
- annuelle ;
- personnalisée selon un échéancier.

Exemples :

```text
Loyer : mensuel, montant fixe, échéance le 5
Internet : mensuel, montant fixe ou révisable
Eau : mensuel, montant estimatif variable
Paie : mensuelle, calculée depuis le moteur de paie
Assurance : annuelle ou trimestrielle
Impôt : selon échéancier fiscal
Maintenance : provision mensuelle avec réalisation irrégulière
```

Le système doit générer automatiquement les périodes futures à partir de la règle de récurrence, sans dupliquer manuellement les lignes.

## 7. Provision, réservation et engagement

Les notions suivantes doivent être distinctes :

### Provision

Montant anticipé pour une charge probable ou récurrente, sans engagement ferme envers un tiers.

### Réservation budgétaire

Montant bloqué temporairement pour une demande ou un besoin identifié.

### Engagement

Obligation réelle résultant d’une commande, d’un contrat, d’un bulletin de paie validé, d’une décision ou d’une dette reconnue.

### Réalisation

Constat de la charge ou du produit dans la période concernée.

### Paiement ou encaissement

Mouvement effectif de trésorerie.

Le calcul standard doit être :

```text
Budget validé
- Réservations actives
- Engagements non payés
- Réalisations non décaissées selon la règle métier
= Budget disponible
```

## 8. Workflow budgétaire

```text
Brouillon
→ Préparé
→ Soumis
→ En arbitrage
→ Validé
→ Actif
→ Révisé
→ Clôturé
```

Branches :

- rejeté ;
- retourné pour correction ;
- suspendu ;
- annulé ;
- dépassé sous dérogation.

Les rôles doivent au minimum distinguer :

- préparateur ;
- responsable budgétaire ;
- Finance ;
- Direction générale ;
- lecteur ;
- contrôleur ou auditeur.

## 9. Construction budgétaire

Le budget doit pouvoir être construit de plusieurs façons :

- saisie manuelle ;
- reprise de l’exercice précédent ;
- moyenne historique ;
- indexation en pourcentage ;
- import Excel contrôlé ;
- alimentation automatique par un autre moteur ;
- duplication d’un scénario ;
- génération depuis contrats, paie, abonnements ou échéances fiscales.

Chaque hypothèse doit être tracée.

## 10. Sources automatiques

Le moteur budgétaire doit recevoir des prévisions depuis :

- paie : salaires, cotisations, retenues, avantages ;
- contrats fournisseurs : loyers, abonnements, maintenance ;
- achats : demandes et commandes validées ;
- fiscalité : échéances d’impôts et taxes ;
- projets : dépenses et recettes prévues ;
- contrats clients : recettes planifiées ;
- facturation : échéances de paiement ;
- trésorerie : contraintes de liquidité ;
- dettes et créances : échéanciers.

L’alimentation automatique ne doit pas écraser les arbitrages humains sans trace.

## 11. Contrôle avant dépense

Avant toute validation d’un décaissement, d’une demande d’achat ou d’un engagement, le moteur doit indiquer :

```text
Budget initial
Budget révisé
Déjà réservé
Déjà engagé
Déjà réalisé
Déjà payé
Disponible avant opération
Impact de la nouvelle opération
Disponible après opération
```

Selon les règles de l’entreprise, le système doit :

- autoriser ;
- avertir ;
- bloquer ;
- exiger une dérogation ;
- exiger une révision budgétaire.

## 12. Recettes et plan de trésorerie

Le moteur doit gérer les recettes en parallèle des dépenses.

Une recette prévue n’est pas encore une recette réalisée ni encaissée.

Le système doit distinguer :

- prévision de recette ;
- facture ou créance créée ;
- échéance ;
- encaissement attendu ;
- encaissement réalisé ;
- retard ;
- impayé ;
- écart entre prévu et encaissé.

Il doit produire un plan de trésorerie :

```text
Solde d’ouverture prévisionnel
+ Encaissements prévus
- Décaissements prévus
= Solde prévisionnel de clôture
```

Le plan doit être visible par jour, semaine et mois.

## 13. Révisions budgétaires

Un budget validé ne doit pas être modifié silencieusement.

Toute modification doit produire une version :

```text
Budget initial V1
→ Révision V2
→ Révision V3
```

Chaque révision doit préciser :

- motif ;
- auteur ;
- date ;
- lignes augmentées ;
- lignes réduites ;
- transferts entre enveloppes ;
- impact annuel ;
- validation requise.

## 14. Virements budgétaires

Le système doit permettre de transférer une enveloppe d’une ligne vers une autre sans créer de trésorerie.

Exemple :

```text
- 200 000 XAF sur Missions
+ 200 000 XAF sur Maintenance
```

Le virement budgétaire doit être équilibré, motivé, validé et audité.

Il ne doit pas être confondu avec un transfert de fonds entre caisses ou banques.

## 15. Dépassements et dérogations

Un dépassement budgétaire doit produire :

- une alerte ;
- un motif ;
- une autorité d’approbation ;
- une trace d’override ;
- l’impact sur l’exercice ;
- éventuellement une révision automatique à valider.

Les seuils doivent être paramétrables par montant, pourcentage, catégorie, service ou rôle.

## 16. Clôture budgétaire

À la fin d’une période, le moteur doit calculer :

- prévu ;
- validé ;
- engagé ;
- réalisé ;
- payé ou encaissé ;
- disponible ;
- écart en montant ;
- écart en pourcentage ;
- report éventuel ;
- annulation du reliquat ;
- justification des écarts.

La clôture mensuelle alimente automatiquement le trimestre, le semestre et l’année.

## 17. Report budgétaire

Le reliquat peut selon les règles :

- être annulé ;
- être reporté au mois suivant ;
- être reporté au trimestre suivant ;
- être reporté à l’exercice suivant ;
- nécessiter une validation.

Le report doit rester visible séparément du budget initial.

## 18. Modèle de données cible

### Entités principales

```text
budget_exercises
budget_versions
budget_scenarios
budget_periods
budget_lines
budget_line_schedules
budget_allocations
budget_reservations
budget_commitments
budget_actuals
budget_revisions
budget_transfers
budget_overrides
budget_closures
budget_variance_comments
```

### Champs essentiels d’une ligne

```text
id
budget_version_id
parent_line_id
kind: expense | revenue
category
sub_category
accounting_account_id
cost_center_id
project_id
site_id
owner_user_id
frequency
start_date
end_date
planned_amount
revised_amount
reserved_amount
committed_amount
actual_amount
paid_or_collected_amount
available_amount
currency
status
source_type
source_id
created_at
updated_at
```

Les montants agrégés peuvent être recalculés ou matérialisés, mais une seule source de vérité doit être définie.

## 19. Interface cible

Le workspace Budget doit contenir :

- cockpit annuel ;
- vue semestrielle ;
- vue trimestrielle ;
- vue mensuelle ;
- dépenses ;
- recettes ;
- plan de trésorerie ;
- engagements ;
- écarts ;
- révisions ;
- virements budgétaires ;
- alertes ;
- clôtures ;
- scénarios.

Chaque vue doit permettre de descendre de l’agrégat annuel jusqu’à l’opération source.

## 20. Indicateurs clés

- budget annuel validé ;
- dépenses prévues ;
- recettes prévues ;
- budget consommé ;
- budget engagé ;
- budget disponible ;
- taux d’exécution ;
- dépassements ;
- économies ;
- recettes encaissées versus prévues ;
- marge budgétaire ;
- solde de trésorerie prévisionnel ;
- échéances à 7, 30 et 90 jours ;
- dépenses fixes versus variables.

## 21. Intégration à la gouvernance financière

Le moteur budgétaire devient un composant central entre :

```text
Planification stratégique
→ Budget
→ Achats et engagements
→ Encaissements et décaissements
→ Trésorerie
→ Comptabilité
→ Reporting de direction
```

Il ne remplace ni la trésorerie ni la comptabilité :

- le budget prévoit et autorise ;
- les achats et contrats engagent ;
- la trésorerie encaisse et paie ;
- la comptabilité constate et classe ;
- le reporting explique les écarts.

## 22. Tranches verticales d’implémentation

### B0 — Diagnostic budgétaire existant

Inventorier budgets, paramètres, demandes d’achat, charges récurrentes, paie, contrats et recettes prévisionnelles déjà présents.

### B1 — Exercice, versions et périodes

Créer exercice annuel, versions, scénarios et découpage semestre/trimestre/mois avec interface.

### B2 — Lignes de dépenses et recettes

Créer les lignes budgétaires, catégories, axes analytiques, récurrences et échéanciers.

### B3 — Cockpit mensuel

Afficher prévu, révisé, réservé, engagé, réalisé, payé, encaissé, disponible et écarts.

### B4 — Engagement budgétaire

Relier demandes d’achat, commandes, contrats, paie et décaissements au budget.

### B5 — Recettes prévisionnelles et plan de trésorerie

Relier contrats clients, factures, créances et encaissements aux prévisions.

### B6 — Révisions, virements et dérogations

Versionner les budgets, transférer les enveloppes et gérer les dépassements.

### B7 — Clôture et reporting

Clôturer mois, trimestre, semestre et année ; produire les analyses d’écarts.

## 23. Ordre révisé de la gouvernance financière

La gouvernance financière ne doit pas être traitée comme une suite strictement linéaire.

Deux chantiers doivent avancer de manière coordonnée :

```text
A. Assainissement de la trésorerie et de la comptabilité journalière
B. Construction du moteur budgétaire
```

Ordre recommandé :

```text
1. F0 — Diagnostic financier existant
2. B0 — Diagnostic budgétaire existant
3. F1 — Positions de trésorerie
4. B1 — Exercices, versions et périodes
5. F2 — Journal financier journalier
6. B2 — Lignes dépenses/recettes et récurrences
7. F3/F4 — Classification et corrections financières
8. B3/B4 — Cockpit mensuel et engagements
9. F5/F6 — Transferts, clôture et rapprochement
10. B5/B6/B7 — Trésorerie prévisionnelle, révisions et clôtures
11. F7 — Génération comptable
```

## 24. Point de départ immédiat

Le prochain travail doit cartographier ensemble :

- les dépenses récurrentes ;
- les recettes récurrentes ;
- les tables et écrans budgétaires éventuels ;
- les demandes d’achat ;
- les contrats ;
- la paie ;
- les opérations financières ;
- les positions de trésorerie ;
- les écritures comptables.

L’objectif est de produire un modèle unique reliant prévision, autorisation, engagement, paiement, encaissement et comptabilisation.
