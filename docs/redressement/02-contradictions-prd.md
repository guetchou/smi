# 02 — Contradictions entre PRD et nomenclature canonique

## Statut

Première passe de réconciliation documentaire. Aucun code ne doit être modifié sur la base d’un terme ambigu tant que la contradiction correspondante n’est pas tranchée.

## CONTRA-001 — Statuts de décaissement divergents

### Sources

- `PRD_industrialisation_redressement.md` : `draft → submitted → approved → paid → rejected/cancelled`.
- `docs/PRD_STABILISATION_MOTEURS_METIER.md` : `Brouillon → Soumis → Contrôle finance → Validation hiérarchique → Autorisé → Payé → Rapproché → Clôturé`.
- `PRD_operations_workflow.md` et le code historique utilisent également `en_attente`, `valide`, `paye`, `rejete`, `annule` et des colonnes parallèles comme `statut`, `dec_statut`, `business_status`, `approval_status`, `payment_status`, `reconciliation_status`.

### Risque

Une même opération peut être considérée validée dans une colonne, soumise dans une autre et payée dans une troisième. Les routes et l’UI peuvent autoriser des transitions incompatibles.

### Nomenclature canonique proposée

Le statut global ne doit plus masquer les dimensions indépendantes :

```text
business_status       : draft | submitted | rejected | cancelled
approval_status       : pending | finance_checked | hierarchy_approved | authorized | rejected
payment_status        : unpaid | processing | paid | reversed
reconciliation_status : unreconciled | partially_reconciled | reconciled
closure_status        : open | closed
```

Le workflow affiché à l’utilisateur est une projection de ces dimensions, jamais une seconde source de vérité.

### Décision

À valider avant tout nouveau correctif de décaissement.

## CONTRA-002 — Encaissement validé ou réellement encaissé

### Sources

- certains documents historiques et routes assimilent `valide` à l’effet financier immédiat ;
- le PRD Finance exige contrôle, validation, réception effective des fonds, rapprochement et audit ;
- l’audit Finance signale que les encaissements historiques sont créés directement `valide`.

### Risque

Une saisie administrative peut augmenter le solde avant réception réelle, notamment pour chèques, virements en attente ou Mobile Money non confirmé.

### Nomenclature canonique proposée

```text
business_status       : draft | submitted | rejected | cancelled
approval_status       : pending | approved | rejected
collection_status     : not_collected | pending_settlement | collected | bounced | reversed
reconciliation_status : unreconciled | reconciled
closure_status        : open | closed
```

`approved` n’est jamais synonyme de `collected`.

## CONTRA-003 — Position de trésorerie ou simple mode de paiement

### Sources

- le PRD Finance définit caisse, banque, Mobile Money, chèques à encaisser et espèces en transit comme positions ;
- des écrans et historiques utilisent parfois banque, espèces, chèque ou Mobile Money comme simples modes de paiement ;
- l’audit Finance relève que Mobile Money et chèques peuvent être traités sans position contrôlable.

### Risque

Impossible de connaître un solde par canal réel ni de suivre les fonds en transit.

### Nomenclature canonique proposée

- `payment_method` décrit le moyen utilisé : espèces, virement, chèque, Mobile Money.
- `treasury_position_id` décrit où les fonds sont réellement détenus.
- un chèque reçu non compensé crédite `cheques_a_encaisser`, pas directement la banque disponible.

## CONTRA-004 — Plusieurs sources de vérité pour les soldes

### Sources coexistantes

- agrégation dynamique de `operations` ;
- photographie `operations.solde_position` ;
- ledger append-only `cash_ledger` ;
- cache `cashbox_balances` ;
- vues ou agrégats de reporting.

### Risque

Soldes divergents, corrections rétroactives silencieuses, virements mal représentés et contrôles de disponibilité faux.

### Décision canonique proposée

```text
cash_ledger       = source de vérité append-only
cashbox_balances  = cache courant reconstructible et verrouillé
operations        = workflow métier, sans rôle de livre de trésorerie
accounting_entries = comptabilité générale, sans rôle de solde de caisse
```

`operations.solde_position` doit être classé comme donnée historique ou cache obsolète avant suppression éventuelle.

## CONTRA-005 — Virement interne assimilé à une recette ou une dépense

### Sources

- le modèle historique crée une opération unique avec source et destination ;
- certaines fonctions calculent tout type non encaissement comme une sortie ;
- le modèle cible exige deux jambes liées.

### Risque

La trésorerie consolidée peut être artificiellement augmentée ou diminuée ; la clôture et le rapprochement deviennent faux.

### Nomenclature canonique proposée

```text
transfer
  debit_leg  : position source, montant négatif
  credit_leg : position destination, montant positif
  transfer_id commun
```

Un transfert n’est ni produit ni charge et n’affecte pas le total consolidé.

## CONTRA-006 — Validation, approbation, autorisation, paiement et comptabilisation

### Problème

Les documents utilisent parfois ces termes comme synonymes.

### Nomenclature canonique proposée

- **soumettre** : déclarer le document prêt au contrôle ;
- **contrôler** : vérifier conformité et pièces ;
- **approuver** : donner l’accord hiérarchique ;
- **autoriser** : rendre l’exécution financière permise ;
- **payer / encaisser** : constater le mouvement réel de fonds ;
- **comptabiliser** : poster l’écriture générale ;
- **rapprocher** : relier le mouvement au relevé ou au comptage réel ;
- **clôturer** : figer la période ou la journée.

Aucun de ces termes ne doit être remplacé silencieusement par un autre.

## CONTRA-007 — Rôles historiques contre permissions effectives

### Sources

- le PRD directeur impose les permissions effectives ;
- le code conserve de nombreux contrôles `hasRole(...)` ;
- plusieurs services `can(...)` sont asynchrones et certaines anciennes routes les traitaient comme synchrones ;
- la pointeuse est volontairement accessible par défaut, hors affectation des modules métier.

### Risque

Un écran peut être masqué mais une route rester accessible, ou l’inverse. Un rôle peut obtenir des droits non prévus par les profils.

### Nomenclature canonique proposée

- `role` : étiquette historique et contexte organisationnel ;
- `profile` : regroupement administrable de permissions ;
- `effective_permission` : seule base canonique d’autorisation métier ;
- exceptions : comptes d’urgence documentés et accès self-service pointeuse d’un agent actif lié.

## CONTRA-008 — États de paie divergents

### Sources

- PRD directeur : `generated → validated → submitted_to_dg → approved_by_dg → paid → cancelled` ;
- PRD stabilisation : `Période ouverte → Préparation → Simulation → Contrôle → Validation → Paiement → Clôture` ;
- code et UI contiennent bulletins, périodes, révisions, rectifications et statuts historiques distincts.

### Risque

Confusion entre état de la période, état du bulletin, approbation DG et état du paiement.

### Nomenclature canonique proposée

Séparer :

```text
payroll_period_status : open | preparation | simulation | control | validated | closed
payslip_status        : draft | calculated | validated | approved | cancelled
payment_status        : unpaid | processing | paid | reversed
rectification_status  : draft | submitted | approved | applied | rejected
```

## CONTRA-009 — Clôture de caisse en double modèle

### Sources

- `cashbox_closures` ;
- `caisses_clotures` ;
- clôture mensuelle `periodes_cloturees` ;
- le routeur et les PRD historiques ne désignent pas la même table canonique.

### Risque

Une journée dite clôturée par l’UI peut rester ouverte pour les routes d’opérations rétroactives.

### Décision requise

Choisir un modèle canonique de clôture par position et par date, avec version, réouverture motivée et blocage backend obligatoire.

## CONTRA-010 — SQLite de test, adaptateur de migration ou runtime parallèle

### Sources

- production déclarée MySQL ;
- `backend/db.js` et scripts MySQL existent ;
- `backend/database.js`, tests SQLite et syntaxes `ON CONFLICT` subsistent ;
- un test d’intégration exécuté avec `DB_DRIVER=mysql` a tenté une syntaxe SQLite `ON CONFLICT`.

### Risque

Un test peut être vert sous SQLite et échouer en production MySQL ; certains chemins peuvent avoir des comportements transactionnels différents.

### Nomenclature canonique proposée

- MySQL : seul contrat runtime de production ;
- SQLite : uniquement adaptateur de migration ou tests explicitement marqués non représentatifs ;
- aucun test nommé `integration` ou `mysql` ne doit exécuter une syntaxe SQLite.

## CONTRA-011 — “Module terminé” contre dette critique ouverte

### Sources

Plusieurs documents ou écrans présentent des modules comme complets, tandis que les audits signalent encore :

- quatre sources de soldes ;
- clôture journalière non bloquante ;
- rapprochement incomplet ;
- atomicité audit/comptabilité non garantie ;
- permissions par caisse non appliquées.

### Décision

Le mot **terminé** est interdit sauf satisfaction de la Definition of Done et preuve MySQL / production.

Statuts documentaires autorisés :

```text
conforme et prouvé
partiellement conforme
implémenté mais non relié
implémenté sans test
contradictoire
absent
obsolète
impossible à vérifier
```

## Prochaine étape de réconciliation

Pour chaque contradiction :

1. identifier les colonnes et statuts réellement écrits ;
2. identifier toutes les routes qui les modifient ;
3. identifier la projection UI ;
4. choisir le contrat canonique ;
5. écrire les tests de contrat ;
6. seulement ensuite corriger le code.
