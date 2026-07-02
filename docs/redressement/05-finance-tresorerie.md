# 05 — Audit finance et trésorerie

Référence : `PRD_flux_encaissement_decaissement_tresorerie_comptabilite_budget.md` + audit `docs/audits/accounting-flow-control-2026-06-23.md` (C1→C15). Cette passe vérifie ce qui a changé depuis le 23 juin et ce qui reste ouvert.

## 1. Architecture réelle : deux moteurs, un seul actif

- **Moteur canonique** (`treasury-ledger.js`, `finance-operation-canonical.js`, `cash-receipt-workflow.js` + routeurs d'interception montés avant `operations.js`) : conforme au PRD — jambes append-only idempotentes (`uq_cash_ledger_operation_leg`), `FOR UPDATE` positions + balances + dernière ligne ledger, détection de divergence cache/ledger, refus solde négatif, virement 2 jambes, audit dans la transaction, workflow encaissement en 4 étapes avec immutabilité post-soumission. Tests contrat + scénarios MySQL présents.
- **Moteur legacy** (`operations.js`, 2 364 lignes) : gouverne **toutes** les positions tant que `positions.ledger_status='ready'` n'est pas posé. Migration 037 : « Aucun backfill et aucune activation automatique ». **Aucune activation trouvée hors fixtures de test.**

### ANO-FIN-03 — Moteur canonique non relié — **CRITIQUE (classement : implémenté mais non relié)**
- **Conséquence** : en production, les garanties du PRD (brouillon sans impact, fonds ≠ validation, ledger canonique, virement 2 jambes) ne s'appliquent à aucune opération réelle.
- **Correction minimale** : exécuter le plan d'activation (`scripts/plan_treasury_ledger_backfill_mysql.js`) position par position : initialiser `cashbox_balances` depuis le legacy, poser `ledger_status='ready'`, vérifier avec `check_finance_integrity_mysql.js`. Commencer par une caisse pilote.
- **Risque** : bascule des soldes affichés de la source legacy vers `cashbox_balances` (le routeur d'interception l'affiche déjà : `balance_source`).
- **Statut** : ouvert — décision d'exploitation, pas de code manquant.

## 2. Chemin legacy : état des constats C1→C15 du 23 juin

| Constat | État au 2026-07-02 | Preuve |
|---|---|---|
| C1 — 4 sources de vérité des soldes | **Toujours ouvert** (encaissements/virements n'écrivent jamais cash_ledger ; seul le paiement décaissement écrit) | `operations.js` : unique `INSERT INTO cash_ledger` à `:1509` |
| C1bis — erreur ledger avalée au paiement | **Corrigé** : ledger + balance dans la transaction du paiement | `operations.js:1469-1518` |
| C2 — `solde_position` non fiable (virements écrasés, recalcul asynchrone) | **Toujours ouvert** (assumé en commentaire `:345`) | `recalculateSoldes()` + appels `.catch(()=>{})` `:373,745,777,1538` |
| C3 — contrôle de solde par `id <` | **Partiellement corrigé** : le paiement lit `cashbox_balances FOR UPDATE`, mais **fallback** `getSoldePosition(op.position_id, op.id)` si la ligne balance n'existe pas | `operations.js:1477` |
| C4 — encaissements sans workflow (créés `valide`) | **Toujours ouvert en legacy** ; corrigé seulement dans le moteur canonique dormant | commentaire `operations.js:600` |
| C5 — virement une seule ligne, pas de 2 jambes/statuts | **Toujours ouvert en legacy** | `getSoldePosition` somme ± sur `position_source_id` |
| C6 — modification/annulation post-effet | **Toujours ouvert** → ANO-FIN-01/02 ci-dessous | `operations.js:682-779` |
| C7 — auto-validation décaissements | **Corrigé** (séparation des fonctions 23/06 + tests) | `cash-out-separation.js`, middleware monté avant legacy |
| C8 — audit non atomique | **Partiellement** : atomique sur les chemins durcis ; `auditDec` post-tx au paiement ; `auditPermission` avale les erreurs | `operations.js:1539`, `permissions.js:149` |
| C9 — comptabilité post-effet | **Encadré** : `ensureOperationSyncErrors` + anomalie bloquante + clôture bloquée | acceptable au sens de l'audit |
| C11 — deux modèles de clôture | **Toujours ouvert** (CONTRA-04) | migrations 010 vs 012 |
| C12 — clôture journalière non bloquante | **Toujours ouvert** | `operations.js` ne teste que `periodes_cloturees` (mois) |
| C13 — rapprochement incomplet | **Toujours ouvert** | `rapprochements.js` non retraité |
| C14 — `user_cashboxes` non appliqué | **Toujours ouvert** | aucune lecture de la table dans operations.js |
| C15 — tests MySQL manquants (concurrence, virements, clôtures) | **Partiellement** : ajouts ledger canonique/receipt/supplier/stock ; rien sur legacy | `scripts/test_*_mysql.js` |

## 3. Anomalies critiques nouvelles ou précisées

### ANO-FIN-01 — Annulation destructive d'un décaissement payé — **CRITIQUE**
- **Preuve** : `operations.js:753-779`. `DELETE /:id` (admin) vérifie uniquement : écriture comptable postée ? période mensuelle clôturée ? Il ne vérifie **ni `dec_statut='paye'` ni l'existence de lignes `cash_ledger`**.
- **Reproduction** : payer un décaissement (ledger débité, `cashbox_balances` diminué) → avant génération/posting comptable, appeler DELETE → `statut='annule'`. Résultat : `getSoldePosition` (base `statut='valide'`) ré-augmente le solde legacy, mais `cash_ledger`/`cashbox_balances` gardent le débit. Divergence permanente entre les 4 sources ; l'argent « réapparaît » dans une vue et pas dans l'autre.
- **Conséquence métier** : perte de traçabilité d'une sortie d'argent réelle ; écart de caisse invisible.
- **Correction minimale** : dans DELETE, refuser si `dec_statut='paye'` OU si des lignes `cash_ledger` existent pour l'opération → exiger la contre-opération (P0.6 du plan d'audit). Idem pour les encaissements confirmés du moteur canonique (déjà bloqués par le routeur d'interception).
- **Tests** : test MySQL — payer, tenter DELETE → 409 ; vérifier soldes inchangés.
- **Régression** : les annulations légitimes de brouillons/soumis restent possibles.

### ANO-FIN-02 — Modification post-effet — **CRITIQUE**
- **Preuve** : `operations.js:682-749`. `PUT /:id` autorise le changement de `montant`, `position_id`, `type_op` d'une opération `valide`/`paye` tant que l'écriture comptable n'est pas postée. La ligne `cash_ledger` du paiement conserve l'ancien montant/caisse.
- **Note** : les encaissements canoniques sont protégés par le routeur d'interception (`CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION`) ; les décaissements soumis+ sont protégés par le middleware de séparation **pour la soumission/validation**, pas pour l'édition post-paiement.
- **Correction minimale** : règle serveur unique — si l'opération a pris effet (payée, confirmée, ou lignes ledger existantes), les champs financiers sont immuables ; correction par contre-opération.
- **Statut** : ouvert.

### ANO-FIN-04 — Fallback de solde par identifiant — HAUTE
`operations.js:1477` : sans ligne `cashbox_balances`, le paiement retombe sur `getSoldePosition(position, beforeId=op.id)` — l'ordre des id n'est pas chronologique (rétrodatage). Correction : initialiser `cashbox_balances` pour toutes les positions actives (précondition de l'activation canonique) et faire du fallback une erreur.

### ANO-FIN-05 — `solde_position` mensonger pour les virements — HAUTE
Assumé dans le code (`:345`). Ne pas corriger : **déprécier** la colonne (l'API doit lire les soldes canoniques après activation). La documenter comme « photographie legacy, non fiable pour les virements ».

### ANO-FIN-06 — Ledger structurellement incomplet en legacy — HAUTE
Encaissements/virements validés n'écrivent jamais `cash_ledger` → `cashbox_balances` ne peut pas être exact sur une caisse mêlant les trois types. C'est la raison de fond pour laquelle l'activation canonique (ANO-FIN-03) est le correctif racine plutôt que des rustines legacy.

### ANO-SEC-03 — `POST /operations/import` sans garde effective — HAUTE → `10-securite.md`.

## 4. Doubles paiements / doubles encaissements / références externes
- Double paiement décaissement : **protégé** (UPDATE conditionnel `WHERE dec_statut='valide'`, `:1499` + 409 « déjà traité »).
- Référence externe dupliquée : **protégé** (`validateExternalReference`, création et édition).
- Double encaissement legacy : **non protégé** au-delà de la référence externe (pas de statut de confirmation) — couvert par le moteur canonique dormant.

## 5. Chèques, positions Mobile Money, transit
Le PRD exige des positions `CHEQUE_IN_TRANSIT`/`CASH_IN_TRANSIT`. La table `positions` porte un `type` libre (caisse/banque/…) ; aucun traitement spécifique des chèques à encaisser n'existe (un chèque encaissé crédite directement la banque en legacy). **Absent** — à planifier après activation du ledger.

## 6. Ordre de correction recommandé (aligné sur l'ordre de mission)
1. ANO-FIN-01 + ANO-FIN-02 (immutabilité post-effet) — petits diffs sur `operations.js`, tests MySQL dédiés.
2. ANO-SEC-03 (import).
3. Initialisation `cashbox_balances` + activation pilote du ledger (ANO-FIN-03/04/06).
4. Clôture unifiée + rapprochement (C11/C12/C13).
5. `user_cashboxes` (C14).
