# Audit P0 — Maîtrise comptable des flux

Date : 23 juin 2026  
Périmètre : encaissements, décaissements, virements internes, soldes, clôtures, rapprochements et écritures comptables.

## 1. Conclusion exécutive

Le module Finance contient déjà des éléments sérieux : workflow de décaissement, écritures équilibrées débit/crédit, contre-écritures, périodes mensuelles clôturées, rapprochement bancaire, clôture de caisse et audit.

Cependant, la maîtrise des flux n'est pas encore garantie car plusieurs modèles coexistent :

- `operations` sert à la fois de demande métier, paiement, mouvement de trésorerie et façade comptable ;
- les soldes sont calculés dynamiquement depuis `operations` ;
- `operations.solde_position` conserve une photographie recalculable ;
- `cash_ledger` se présente comme append-only ;
- `cashbox_balances` conserve un solde courant ;
- les écritures générales sont stockées séparément dans `accounting_entries`.

Ces représentations ne sont pas alimentées par les mêmes événements et peuvent diverger.

**Décision d'architecture recommandée :**

1. `cash_ledger` devient la source canonique de trésorerie ;
2. `cashbox_balances` devient un cache contrôlé et reconstructible ;
3. `operations` représente le workflow métier et référence les mouvements du ledger ;
4. `accounting_entries` représente la comptabilité générale ;
5. aucune opération effective n'est modifiable ; toute correction crée un mouvement inverse lié.

## 2. Matrice actuelle des flux

| Flux | Création actuelle | Prise d'effet trésorerie | Comptabilisation | Correction actuelle | Risque |
|---|---|---|---|---|---|
| Encaissement | directement `valide` | immédiate dans les calculs `operations` | brouillon comptable automatique si mapping disponible | modification/annulation directe possible avant posting | critique |
| Décaissement | `en_attente` + `brouillon` | au passage `paye` | brouillon comptable après paiement | annulation avant paiement ; après paiement aucune contre-opération métier automatisée | haute |
| Virement interne | une seule ligne `valide` source + destination | immédiate | une écriture débit/crédit possible | modification/annulation directe avant posting | critique |
| Paiement fournisseur | opération `valide/paye` | immédiate | mapping opération | facture et opération désormais atomiques | mieux maîtrisé |
| Clôture caisse | enregistrement séparé | aucun verrou direct | aucun effet comptable automatique | pas de réouverture formalisée | critique |
| Rapprochement bancaire | en-tête puis lignes | aucun verrou des opérations | aucun effet comptable automatique | modification interdite après validation | haute |

## 3. Constats critiques

### C1 — Quatre sources de vérité pour les soldes

Le code utilise simultanément :

- `getSoldePosition()` depuis `operations` ;
- `recalculateSoldes()` qui réécrit `operations.solde_position` ;
- `cash_ledger` ;
- `cashbox_balances`.

Or `cash_ledger` et `cashbox_balances` ne sont alimentés que dans le paiement des décaissements. Les encaissements et virements n'y sont pas écrits.

Le bloc ledger du paiement est entouré d'un `try/catch` qui ignore l'erreur. Un paiement peut donc réussir sans mise à jour du ledger annoncé comme canonique.

**Impact :** soldes différents selon l'écran, la route ou le moment du recalcul.

### C2 — Photographie `solde_position` non fiable

`recalculateSoldes()` parcourt toutes les positions et réécrit `solde_position` sur les opérations.

Pour un virement, une seule opération appartient à la source et à la destination. Un seul champ `solde_position` ne peut représenter les deux soldes après mouvement. La dernière position parcourue écrase la valeur précédente.

Le recalcul est souvent lancé en arrière-plan sans attente. Les réponses API peuvent donc exposer un ancien solde.

### C3 — Contrôle du solde avant paiement fondé sur l'identifiant

Le paiement d'un décaissement appelle `getSoldePosition(position_id, operation.id)`, qui filtre `id < operation.id`.

L'identifiant n'est pas un ordre chronologique :

- une opération peut être rétrodatée ;
- une opération créée après le décaissement peut avoir une date antérieure au paiement ;
- les opérations de plus grand identifiant sont exclues même si elles ont déjà pris effet.

**Impact :** paiement refusé à tort ou autorisé malgré un solde réel insuffisant.

### C4 — Encaissements sans workflow

Les encaissements sont créés directement avec `statut='valide'`.

Ils impactent immédiatement le solde alors qu'il n'existe pas de distinction entre :

- saisie ;
- validation administrative ;
- confirmation de réception des fonds ;
- litige ;
- annulation ;
- correction.

Un encaissement reste modifiable tant que son écriture comptable n'est pas `posted`.

### C5 — Virements internes incomplets

Le virement est une seule opération avec `position_source_id` et `position_id`.

Il n'existe pas :

- de double confirmation source/destination ;
- de statut de transit ;
- de litige ;
- de deux jambes de ledger liées ;
- de délai de confirmation.

Les fonctions de rapprochement et de clôture ne traitent que `position_id` et calculent tout type non `encaissement` comme une sortie. Elles ignorent la sortie de `position_source_id` et l'entrée correcte à destination.

### C6 — Modification et annulation post-effet

La route générique `PUT /operations/:id` permet de modifier une opération effective tant qu'aucune écriture comptable n'est comptabilisée.

La route générique `DELETE /operations/:id` marque l'opération `annule` sans créer de mouvement inverse.

**Règle cible :** dès qu'un mouvement a pris effet dans le ledger, les champs financiers deviennent immuables. La correction doit produire une contre-opération liée.

### C7 — Auto-validation des décaissements

Un utilisateur ayant le droit d'approuver peut soumettre son propre décaissement et le faire passer directement à `valide`.

Les seuils d'approbation décrits dans `PRD_operations_workflow.md` ne sont pas appliqués.

Il n'existe pas de séparation stricte entre :

- créateur ;
- soumetteur ;
- approbateur ;
- payeur.

### C8 — Audit non atomique

Plusieurs transitions mettent à jour `operations`, puis écrivent l'audit dans une requête séparée.

En cas d'échec de l'audit, l'état métier reste modifié. Certaines fonctions d'audit avalent explicitement les erreurs.

### C9 — Comptabilité générale non atomique avec le mouvement métier

La génération automatique des écritures est généralement déclenchée après la création ou le paiement de l'opération.

Elle produit un brouillon séparé. Si la génération échoue, l'opération peut déjà avoir pris effet en trésorerie.

Ce comportement est acceptable uniquement si :

- l'anomalie est bloquante et visible ;
- la période ne peut pas être clôturée avec des erreurs comptables ouvertes ;
- une procédure de reprise contrôlée existe.

Ces trois garanties ne sont pas encore complètes.

### C10 — Séparation des fonctions comptables insuffisante

Les rôles `admin`, `finance`, `dg` peuvent :

- créer ou activer des mappings ;
- générer des écritures ;
- valider les écritures ;
- créer des contre-écritures.

Une règle peut être créée directement active, alors que l'activation par endpoint séparé exige une confirmation.

### C11 — Deux modèles de clôture

Deux tables coexistent :

- `cashbox_closures` dans la migration 012 ;
- `caisses_clotures` dans la migration 010.

Le routeur utilise `caisses_clotures`, tandis que le PRD historique présente `cashbox_closures` comme modèle cible.

Cette duplication empêche de savoir quelle table gouverne le blocage des opérations.

### C12 — Clôture journalière non bloquante

La validation d'une clôture de caisse ne crée pas de verrou exploité par `operations.js`.

`operations.js` ne contrôle que `periodes_cloturees` au mois. Une opération rétroactive peut donc être ajoutée dans une journée déjà clôturée si le mois reste ouvert.

Il manque :

- unicité caisse + date ;
- clôture soumise puis validée ;
- réouverture avec motif ;
- double approbation ;
- version précédente conservée ;
- blocage serveur des opérations rétroactives.

### C13 — Rapprochement bancaire mathématiquement incomplet

`calcSoldeSysteme()` et `calcSoldeLogicielCaisse()` utilisent :

`encaissement = +montant`, tout autre type = `-montant`.

Ce calcul est incorrect pour les virements internes et ne tient pas compte de `position_source_id`.

La création d'un rapprochement n'est pas transactionnelle : l'en-tête est créé, puis les lignes sont insérées une par une.

La validation :

- n'exige pas que toutes les lignes soient rapprochées ;
- ne verrouille pas les opérations ;
- ne marque pas `operations.reconciliation_status` ;
- ne bloque pas les périodes qui se chevauchent ;
- accepte un écart sans justification obligatoire.

### C14 — Affectation des caisses non appliquée

La table `user_cashboxes` existe mais n'est pas utilisée dans `operations.js`.

Les soldes, listes, créations et exports ne sont pas filtrés par les caisses affectées à l'utilisateur.

### C15 — Tests incomplets

Les tests comptables actuels prouvent :

- génération idempotente ;
- équilibre débit/crédit ;
- posting ;
- contre-écriture ;
- période clôturée ;
- anomalies de mapping.

Mais le workflow comptable principal est testé sous SQLite, pas sous MySQL.

Il manque des tests MySQL pour :

- concurrence de paiement ;
- double encaissement ;
- solde historique ;
- virements source/destination ;
- clôture journalière ;
- réouverture ;
- rapprochement ;
- permissions par caisse ;
- rollback entre opération, ledger et audit.

## 4. Architecture cible

### 4.1 Document métier

Une créance, dette, paie, avance ou dépense est portée par `finance_source_documents`.

### 4.2 Paiement

`operations` porte le workflow du paiement :

- `business_status` ;
- `approval_status` ;
- `payment_status` ;
- `reconciliation_status`.

Les anciens couples `statut` / `dec_statut` restent temporairement compatibles puis sont dépréciés.

### 4.3 Ledger de trésorerie

Chaque prise d'effet produit une ou plusieurs lignes append-only :

- encaissement : une ligne crédit de caisse ;
- décaissement : une ligne débit de caisse ;
- virement : deux lignes liées, débit source et crédit destination ;
- correction : lignes inverses liées au mouvement original ;
- ouverture et clôture : événements dédiés.

### 4.4 Solde courant

`cashbox_balances` est mis à jour dans la même transaction que le ledger et verrouillé avec `FOR UPDATE`.

Il doit être reconstructible à partir du ledger et vérifié périodiquement.

### 4.5 Comptabilité générale

La prise d'effet peut générer une écriture comptable brouillon, mais la clôture d'une période est interdite si :

- une opération effective n'a pas d'écriture ;
- une écriture est déséquilibrée ;
- une anomalie de mapping reste ouverte ;
- une allocation reste incomplète selon les règles métier.

## 5. Tranches verticales prioritaires

### P0.1 — Invariants et diagnostic en lecture seule

- commande de contrôle comparant `operations`, `cash_ledger`, `cashbox_balances` et écritures comptables ;
- rapport des divergences par position ;
- aucun correctif automatique ;
- test MySQL avec données contrôlées.

### P0.2 — Ledger canonique complet

- service unique de posting trésorerie ;
- encaissement, décaissement et virement ;
- verrou `cashbox_balances FOR UPDATE` ;
- audit dans la transaction ;
- suppression des erreurs ledger ignorées.

### P0.3 — Encaissement contrôlé

- `brouillon → soumis → confirmé` ;
- distinction validation / fonds reçus ;
- doublons et pièces ;
- immutabilité après posting ;
- correction par contre-opération.

### P0.4 — Décaissement et séparation des fonctions

- aucun auto-contrôle par défaut ;
- seuils paramétrables ;
- créateur ≠ approbateur ≠ payeur ;
- exceptions explicites et auditées ;
- paiement atomique opération + ledger + audit.

### P0.5 — Virement à deux jambes

- objet de transfert ;
- débit source et crédit destination atomiques ;
- statuts source/destination ;
- litige et délai ;
- rapprochement correct des deux positions.

### P0.6 — Corrections et contrepassations métier

- interdiction de modifier une opération effective ;
- relation `reversed_operation_id` ;
- motif obligatoire ;
- ledger inverse ;
- écriture comptable inverse ;
- conservation de l'original.

### P0.7 — Clôture journalière bloquante

- unifier les deux modèles de clôture ;
- unicité caisse/date/version ;
- blocage serveur ;
- réouverture doublement approuvée ;
- snapshots de contrôle.

### P0.8 — Rapprochement fiable

- calcul commun des mouvements ;
- création transactionnelle ;
- périodes sans chevauchement ;
- justification obligatoire ;
- verrouillage et statut des opérations rapprochées.

### P0.9 — Permissions par caisse

- appliquer `user_cashboxes` à toutes les lectures et écritures ;
- caisses confidentielles ;
- consolidation réservée Finance/DG/Admin ;
- tests anti-fuite.

### P0.10 — Gouvernance comptable

- permission distincte pour mapping, génération, posting, reversal et clôture ;
- maker-checker ;
- activation des mappings avec confirmation ;
- audit atomique.

## 6. Ordre recommandé

1. P0.1 diagnostic et invariants ;
2. P0.2 ledger canonique ;
3. P0.3 encaissements ;
4. P0.4 décaissements ;
5. P0.5 virements ;
6. P0.6 contrepassations ;
7. P0.7 clôtures ;
8. P0.8 rapprochements ;
9. P0.9 permissions ;
10. P0.10 gouvernance comptable.

## 7. Conditions avant GRH

Le chantier GRH peut reprendre lorsque :

- les avances, salaires et soldes de tout compte peuvent produire des flux financiers via l'API canonique ;
- les flux sont atomiques et contrepassables ;
- les périodes clôturées sont réellement verrouillées ;
- le diagnostic d'intégrité ne remonte plus d'écart critique.
