# Diagnostic initial F0 + B0 — Finance, trésorerie, comptabilité et budget

## 1. Périmètre analysé

Cette première cartographie porte sur :

- `backend/routes/operations.js` ;
- `backend/routes/cash_receipt_workflow_router.js` ;
- `backend/routes/accounting.js` ;
- `backend/routes/rapprochements.js` ;
- les services financiers et comptables appelés par ces routes ;
- les statuts de synchronisation trésorerie, comptabilité, budget et affectation métier.

Elle doit être complétée par l’analyse des migrations, du frontend financier, des demandes d’achat, de la paie, des contrats, des factures clients et des données réelles MySQL.

## 2. Conclusion immédiate

Tala-SMI ne part pas de zéro.

Le dépôt contient déjà :

- une table centrale `operations` ;
- des positions de trésorerie ;
- un workflow d’encaissement contrôlé ;
- des décaissements avec rôles et validations ;
- des virements internes ;
- un ledger de trésorerie ;
- des statuts de synchronisation ;
- des écritures comptables ;
- des règles de mapping OHADA ;
- des rapprochements bancaires ;
- des clôtures de caisse ;
- des contre-écritures comptables.

Le problème n’est donc pas l’absence totale de fonctions.

Le problème est l’existence de plusieurs moteurs partiellement superposés, utilisant des modèles et des règles différentes.

## 3. Fragmentation actuelle

### 3.1 Route opérations monolithique

`backend/routes/operations.js` regroupe dans un même fichier :

- encaissements ;
- décaissements ;
- virements internes ;
- validation ;
- paiement ;
- calcul de soldes ;
- permissions ;
- références externes ;
- synchronisation comptable ;
- synchronisation budgétaire ;
- erreurs de synchronisation ;
- audit ;
- notifications ;
- compatibilité avec les anciens champs.

Cette concentration rend difficile la définition d’une source de vérité et favorise la coexistence de règles anciennes et nouvelles.

### 3.2 Deux workflows d’encaissement

Le dépôt contient :

- le workflow historique dans `operations.js` ;
- le workflow canonique dans `cash_receipt_workflow_router.js` et son service dédié.

Le routeur canonique n’intercepte que les encaissements considérés comme prêts par `canonicalReadinessForInput`.

Les autres opérations retombent dans le moteur historique.

Cela signifie qu’en production deux encaissements apparemment similaires peuvent suivre des règles différentes selon la qualité ou la complétude de leurs données.

### 3.3 Compatibilité ancienne toujours active

Les anciennes notions restent exposées :

```text
recette
depense
detail
n_piece
solde
mode_paiement
```

Elles sont traduites vers :

```text
type_op
montant
libelle
num_piece
solde_position
mode_reglement
```

Cette compatibilité est utile pour la migration, mais elle masque les incohérences de données et peut laisser entrer des opérations ambiguës.

## 4. Statuts financiers existants

Le système possède déjà quatre axes de synchronisation sur une opération :

```text
treasury_status
accounting_status
budget_status
allocation_status
```

Les statuts sont initialisés principalement à `pending`, `synced` ou `cancelled`.

### Constat budgétaire

Le champ `budget_status` existe et des erreurs `BUDGET_SYNC_PENDING` sont générées.

Mais aucun moteur budgétaire canonique complet n’a été identifié à ce stade pour :

- déterminer une ligne budgétaire ;
- réserver une enveloppe ;
- créer un engagement ;
- consommer le budget ;
- suivre le disponible ;
- gérer les révisions ;
- relier la dépense à une période budgétaire.

Le système connaît donc l’idée d’une synchronisation budgétaire, mais pas encore le moteur qui doit la réaliser.

## 5. Encaissement canonique existant

Le workflow contrôlé distingue déjà :

```text
Brouillon
→ Soumission
→ Validation administrative
→ Confirmation réelle des fonds
```

La validation administrative n’impacte pas immédiatement le solde.

La confirmation des fonds :

- écrit dans le ledger de trésorerie ;
- est conçue comme idempotente ;
- tente de générer l’écriture comptable ;
- interdit la modification ou la suppression après soumission ;
- permet rejet, litige et retour contrôlé au brouillon.

Ce workflow constitue une bonne base à généraliser.

## 6. Comptabilité existante

Le module comptable contient déjà :

- plan de comptes ;
- règles de mapping ;
- journal comptable ;
- écritures et lignes débit/crédit ;
- génération depuis une opération ;
- validation ;
- contrôle de l’équilibre ;
- anomalies de mapping ;
- contre-écritures ;
- verrouillage par période clôturée.

### Risque principal

La comptabilité dépend de la qualité de classification de l’opération source.

Si une opération est mal classée comme encaissement, décaissement ou virement, l’écriture générée peut être équilibrée techniquement tout en étant fausse économiquement.

L’équilibre débit/crédit ne suffit donc pas à garantir la justesse métier.

## 7. Rapprochement et clôture

Le module de rapprochement recalcule le solde avec une formule de type :

```text
encaissement = + montant
toute autre opération = - montant
```

Cette formule est insuffisante pour un modèle comportant :

- virement interne ;
- position source ;
- position destination ;
- versement en banque ;
- retrait bancaire ;
- Mobile Money ;
- contre-passation ;
- régularisation.

### Anomalie structurelle majeure

Le calcul de rapprochement utilise uniquement `position_id`.

Or les transferts internes utilisent également `position_source_id`.

Un transfert doit produire :

- une sortie sur la source ;
- une entrée sur la destination ;
- zéro impact sur la trésorerie consolidée.

Le calcul actuel du rapprochement ne démontre pas explicitement cette symétrie.

Il existe donc un risque élevé de soldes faux ou incomplets sur les positions impliquées dans les transferts.

## 8. Solde et historique

Le calcul de solde actuel repose encore sur :

```text
solde_initial de la position
+ somme dynamique des opérations validées
```

Le champ `solde_position` est aussi utilisé comme photographie sur certaines opérations.

### Risques

- modification rétroactive ;
- insertion rétrodatée ;
- ordre d’exécution ambigu ;
- divergence entre solde recalculé et photographie ;
- impossibilité de garantir un solde historique figé ;
- divergence entre opérations, ledger et rapprochement.

Le futur journal journalier ne doit pas utiliser `solde_position` comme source de vérité autonome.

## 9. Positions de trésorerie

Les positions existent déjà avec notamment :

- identifiant ;
- code ;
- libellé ;
- type ;
- solde initial ;
- statut actif.

La refonte doit donc consolider cette table plutôt que créer immédiatement un second référentiel.

Points à vérifier dans les migrations et données :

- unicité du code ;
- devise ;
- site ;
- responsable ;
- type normalisé ;
- date d’ouverture ;
- gouvernance du solde initial ;
- modification du solde initial après mouvement ;
- positions confidentielles ;
- positions de transit.

## 10. Données ambiguës probables

Les données réelles doivent être contrôlées pour identifier :

- opérations sans position ;
- opérations utilisant la position par défaut `1` ;
- transferts sans source ;
- transferts avec source égale à destination ;
- opérations validées sans ledger ;
- ledger sans opération ;
- opérations validées sans écriture comptable ;
- écritures comptables sans opération source ;
- références externes dupliquées ;
- montants nuls ou négatifs ;
- anciennes valeurs `recette` et `depense` ;
- statuts métier et paiement incompatibles ;
- opérations annulées encore présentes dans les soldes ;
- soldes initiaux modifiés après démarrage ;
- rapprochements calculés sur une formule incomplète ;
- lignes manuelles de rapprochement sans opération source ;
- erreurs de synchronisation ouvertes non traitées ;
- opérations avec `budget_status = pending` sans moteur budgétaire.

## 11. Décision d’architecture

La source de vérité cible doit être organisée en couches :

```text
Document métier
→ Mouvement financier canonique
→ Ledger de trésorerie
→ Écriture comptable
→ Rapprochement
→ Clôture
```

Le budget intervient avant et pendant l’exécution :

```text
Prévision
→ Réservation
→ Engagement
→ Mouvement financier
→ Réalisation budgétaire
```

### Règle

Les soldes doivent provenir du ledger canonique de trésorerie, et non de plusieurs formules SQL reproduites dans différents modules.

Les rapprochements, clôtures, tableaux de bord et rapports doivent consommer le même service de solde.

## 12. Priorités techniques immédiates

### F0.1 — Diagnostic exécutable en lecture seule

Créer un service qui calcule les anomalies de données sans modifier la base.

Catégories :

- intégrité des positions ;
- intégrité des opérations ;
- intégrité des transferts ;
- intégrité du ledger ;
- intégrité comptable ;
- intégrité des rapprochements ;
- intégrité des clôtures ;
- synchronisation budgétaire absente.

### F0.2 — Endpoint diagnostic

```text
GET /api/finance/diagnostic
```

Réponse attendue :

```json
{
  "summary": {},
  "positions": {},
  "operations": {},
  "transfers": {},
  "ledger": {},
  "accounting": {},
  "reconciliations": {},
  "budget": {},
  "samples": []
}
```

### F0.3 — Interface diagnostic

Ajouter un écran en lecture seule avec :

- score de santé ;
- compteurs par gravité ;
- anomalies bloquantes ;
- exemples ;
- filtres ;
- export CSV ;
- aucune correction automatique.

### B0.1 — Diagnostic des sources budgétaires

Inventorier :

- charges récurrentes ;
- paie mensuelle ;
- contrats fournisseurs ;
- échéances fiscales ;
- demandes d’achat ;
- commandes ;
- factures fournisseurs ;
- contrats clients ;
- factures clients ;
- recettes récurrentes ;
- lignes pouvant générer des prévisions.

## 13. Première tranche verticale à implémenter

La prochaine tranche est :

```text
F0.1 + F0.2 + F0.3
Diagnostic financier en lecture seule
```

Elle ne modifie aucune donnée et réduit le risque avant la reconstruction.

Ensuite seulement :

```text
B0.1
Diagnostic des sources budgétaires
```

Les deux diagnostics seront réunis dans un cockpit unique de gouvernance financière.
