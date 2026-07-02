# 00 — État réel du produit Tala SMI

Date : 2026-07-02
Branche d'audit : `claude/decryptage-module-decaissement-vo56c8`
Document directeur : `PRD_industrialisation_redressement.md`

## Méthode

Chaque exigence a été vérifiée dans l'ordre : schéma → migration → service → route → permissions → UI → audit → tests → comportement MySQL → production. Aucune exigence n'a été déclarée conforme sur la seule existence d'un fichier. Les preuves sont des références `fichier:ligne` vérifiées dans le code de la branche.

Limite de vérification : l'état réel du VPS de production (données MySQL, volumes Docker, secrets) n'est pas accessible depuis cet environnement. Les points qui en dépendent sont classés **impossible à vérifier** et listés dans `11-production.md`.

## Synthèse exécutive

Le produit n'est **pas industrialisé** au sens de la Definition of Done du PRD directeur. Trois faits structurants dominent :

1. **La séparation des fonctions de la paie est inopérante en production.** Les gardes de permission de `salaires.js` et `periodes_paie.js` appellent des fonctions async sans `await` : une Promise étant toujours truthy, `if (!canX(req.user))` ne bloque jamais. Pire, `periodes_paie.js:198` auto-valide DG toute période soumise, par n'importe quel utilisateur du module salary (`ANO-SEC-01`, `ANO-SEC-02`). Le correctif existe mais est piégé dans la PR 64 (draft, 12 405 lignes) non fusionnée.

2. **Le socle trésorerie canonique existe mais n'est pas relié.** `treasury-ledger.js`, `cash-receipt-workflow.js` et `finance-operation-canonical.js` implémentent correctement le PRD flux (jambes de ledger idempotentes, verrous `FOR UPDATE`, workflow encaissement brouillon→soumis→validé→confirmé). Mais l'activation est opt-in par position (`positions.ledger_status='ready'`, migration 037 « aucune activation automatique ») et **aucune position n'est activée hors fixtures de test**. En production, tout l'argent circule encore par le chemin legacy d'`operations.js` : encaissements et virements créés directement `valide`, quatre sources de soldes divergentes, annulation destructive possible sur un décaissement payé (`ANO-FIN-01/02/03`).

3. **Deux couches d'accès aux données coexistent** : `backend/db.js` (mysql2/promise, transactions réelles) et `backend/database.js` + `mysql_sync_facade` (API synchrone better-sqlite3 émulée sur MySQL, où `transaction(fn)` est un **no-op**). Toute route « sync » qui croit être transactionnelle ne l'est pas en production (`ANO-TEC-01`).

## Ce qui est solide et prouvé

- **Comptabilité OHADA** : génération idempotente, équilibre débit=crédit vérifié (`accounting.js:530-537`, tolérance 0,01, ≥2 lignes), blocage période clôturée, contre-écriture append-only, `sync_errors` visibles. Testé (SQLite) — voir `06-comptabilite-ohada.md`.
- **Paiement fournisseur** : `supplier_payment_workflow.js` — transaction unique, `FOR UPDATE` facture, rapprochement 3 voies automatique, override DG motivé et audité, test d'atomicité MySQL (`scripts/test_supplier_payment_mysql.js`).
- **Réception stock** : `stock_receipt_validation_workflow.js` — mouvement + stock + audit atomiques, `FOR UPDATE` produit (réserve : `ANO-ACH-01`).
- **IdentityAccessService** : normalisation rôles, sync profils **dans la transaction**, audit atomique, lien agent requis pour rôles opérationnels (réserves : `ANO-IAM-01/02`, contournement `users.js:120`).
- **Paiement décaissement legacy durci** : transaction + `FOR UPDATE cashbox_balances` + UPDATE conditionnel idempotent + ledger dans la même transaction (`operations.js:1469-1518`) — le try/catch avaleur signalé par l'audit du 23 juin a été supprimé sur ce chemin.
- **Séparation des fonctions décaissements** : middleware `cash-operation-permissions` + `cash-out-separation` monté avant le routeur historique (audits du 23 juin), gardes correctement `await`ées.
- **GRH** : 17 anomalies corrigées sur cette branche (13 commits `538bd46`→`025c512`) : N+1, transactions manquantes, fire-and-forget non protégés, corruption JSON checklists, sync parapheur→sources atomique.

## Ce qui est cassé, classé par gravité

| ID | Gravité | Constat | Détail |
|---|---|---|---|
| ANO-SEC-01 | Critique | Auto-validation DG de toute période de paie soumise | `04-rh-paie.md`, `10-securite.md` |
| ANO-SEC-02 | Critique | ~30 gardes de rôles paie no-op (validation, paiement bulletins) | `10-securite.md` |
| ANO-FIN-01 | Critique | Annulation destructive d'un décaissement payé (ledger divergent) | `05-finance-tresorerie.md` |
| ANO-FIN-02 | Critique | Modification post-effet d'une opération payée non comptabilisée | `05-finance-tresorerie.md` |
| ANO-FIN-03 | Critique | Ledger canonique et workflow encaissement non reliés (0 position `ready`) | `05-finance-tresorerie.md` |
| ANO-TEC-01 | Critique | `mysql_sync_facade.transaction` = no-op : pseudo-transactions en production | `12-dette-technique.md` |
| ANO-SEC-03 | Haute | `POST /operations/import` sans garde effective | `10-securite.md` |
| ANO-IAM-01 | Haute | Pas d'UNIQUE `users.employe_id` + contrôle hors transaction | `03-identite-acces.md` |
| ANO-BUD-01 | Haute | Moteur budgétaire absent (schéma seul, aucun contrôle avant décaissement) | `07-budget.md` |
| ANO-PROD-01 | Haute | Déploiement SSH root, `StrictHostKeyChecking=no`, par branche et non par SHA | `11-production.md` |
| ANO-FIN-04/05/06 | Haute | Soldes legacy : fallback `id<`, `solde_position` écrasé, ledger jamais alimenté par encaissements/virements | `05-finance-tresorerie.md` |

## Verdict global par module (résumé — détail dans `14-definition-of-done.md`)

| Module | Verdict |
|---|---|
| Comptabilité OHADA | Exploitable sous conditions (mappings inactifs en prod, tests SQLite seulement) |
| Achats / fournisseurs / stock | Exploitable sous conditions |
| Parapheur | Exploitable sous conditions (correctifs branche à fusionner, conflit PR 64) |
| GRH (agents, congés, avances, offboarding, organisation) | Exploitable sous conditions (correctifs branche à fusionner) |
| Identité & accès | Exploitable sous conditions |
| Paie | **Non exploitable** en séparation des fonctions (ANO-SEC-01/02) |
| Encaissements / virements / soldes trésorerie | **Non exploitable** au sens du PRD flux (chemin legacy actif) |
| Budget | **Non exploitable** (absent) |
| Décaissements | Exploitable sous conditions (chaîne durcie, mais ANO-FIN-01/02) |
| Pointeuse, sanctions, heures sup | Exploitable sous conditions |
| Facturation / commercial | Non vérifiable dans cette passe (hors périmètre approfondi) |
| Production / CI-CD | Exploitable sous conditions (PR 63 à finaliser) |

## Rappel de l'exigence documentaire du PRD directeur

> « Documentation no longer claims completion while critical debt remains open. »

`WORKFLOW_CONTROL_BOARD.md` déclare la tranche comptable « implémenté et testé localement » — c'est exact et honnête (activation production explicitement non exécutée). En revanche, `AUDIT_INDUSTRIEL_MODULES.md` déclare la passe « Accès & utilisateurs » validée avec « routes users.js sans écriture directe users/profils », ce qui est contredit par `users.js:120` (désactivation directe). Voir `02-contradictions-prd.md`.
