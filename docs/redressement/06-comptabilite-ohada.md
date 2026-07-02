# 06 — Audit comptabilité OHADA

Périmètre : `backend/services/accounting.js` (852 lignes), `backend/routes/accounting.js`, migrations 025→028, seeds OHADA 026/027.

## 1. Invariants vérifiés dans le code

| Invariant PRD | Constat | Preuve |
|---|---|---|
| **Total débit = total crédit** (bloquant) | ✅ posting refusé si `|debit−credit| ≥ 0,01` ou `< 2` lignes ou `debit ≤ 0` | `accounting.js:530-537` |
| Génération idempotente | ✅ une écriture par opération, regénération sans doublon | tests `accounting_workflow_test.js` |
| Période clôturée = aucune écriture | ✅ blocage au posting et à la génération | control board « Terminé », vérifié dans le service |
| Contre-écriture append-only (jamais de suppression) | ✅ `reversal` lié, original conservé | migration 028 (`accounting_entries_ledger`) |
| Anomalies visibles (`sync_errors`) | ✅ `ensureOperationSyncErrors` crée l'anomalie si mapping manquant ; vue « À comptabiliser » | `operations.js` post-paiement |
| Règles de mapping créées inactives, activation confirmée | ✅ (constat C10 partiel : création directe active possible par admin — gouvernance à durcir) | audit 23/06 C10 |
| Verrouillage opération comptabilisée | ✅ PUT/DELETE operations refusent si écriture postée | `operations.js:686-693,756-762` |

## 2. Réserves

### ANO-CPT-01 — Workflow comptable testé sous SQLite, pas sous MySQL — MOYENNE
Constat C15 maintenu : `accounting_workflow_test.js` tourne sur SQLite isolé. Les scénarios MySQL existent pour ledger/receipt/supplier/stock mais pas pour le cycle comptable complet (génération → posting → reversal → clôture) sous MySQL 8. Correction : script `scripts/test_accounting_workflow_mysql.js` sur le modèle des existants, branché au job MySQL de la CI PR.

### ANO-CPT-02 — Comptabilisation post-effet (C9) — acceptée sous conditions, conditions partiellement réunies
Le PRD flux (§12.1) exige : échec de génération ⇒ validation bloquée, aucun solde modifié. Le code actuel : effet trésorerie d'abord, écriture ensuite, anomalie `sync_errors` si échec, clôture bloquée si anomalies ouvertes. C'est la variante tolérée par l'audit du 23/06 **si** l'anomalie est bloquante, la clôture verrouillée et une reprise contrôlée existe. Les deux premières conditions sont en place ; la **procédure de reprise documentée** manque → à écrire dans l'exploitation (`11-production.md`).

### ANO-CPT-03 — Séparation des fonctions comptables (C10) — MOYENNE
`admin`/`finance`/`dg` cumulent mapping + génération + posting + reversal. Cible P0.10 : permissions distinctes (`accounting.mapping.manage`, `accounting.post`, `accounting.reverse`, `accounting.close`) + maker-checker sur l'activation de mapping. Non commencé.

### Activation des mappings en production — **impossible à vérifier / non exécuté**
Décision métier explicitement en attente (`WORKFLOW_CONTROL_BOARD.md` : validation écrite du comptable, activation sur échantillon, simulation avant rattrapage). Tant que les mappings sont inactifs, la production ne génère **aucune écriture automatique** : la comptabilité OHADA est opérationnellement vide même si le moteur est prêt. À traiter comme un jalon d'exploitation, pas de développement.

## 3. Écarts décimaux MySQL / JavaScript
Les montants passent par `money()` (arrondi 2 décimales) côté services ; `mysql2` renvoie les DECIMAL en chaînes, systématiquement convertis (`Number(...)`) avant arithmétique dans accounting/treasury. Pas d'occurrence de concaténation trouvée sur les chemins comptables. **Conforme.**

## 4. Verdict module
**Exploitable sous conditions** : moteur correct et testé (SQLite), mais (1) mappings inactifs en production, (2) cycle non prouvé sous MySQL, (3) gouvernance des rôles comptables à séparer.
