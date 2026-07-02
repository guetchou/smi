# 00 — État réel du produit Tala SMI

## Statut du document

Phase 1 du redressement industriel.

Ce document décrit uniquement des éléments vérifiés dans le dépôt et dans les PR ouvertes. Il ne constitue pas encore un verdict final d’industrialisation.

## Règle de preuve

Une exigence n’est considérée conforme que si les dix niveaux suivants sont prouvés :

1. schéma de données ;
2. migration ;
3. service métier ;
4. route backend ;
5. permissions ;
6. interface ;
7. audit ;
8. tests ;
9. comportement MySQL réel ;
10. déploiement en production.

La seule présence d’un fichier, d’une route, d’une migration ou d’un écran ne vaut pas conformité.

## Verdict global provisoire

**Tala SMI : exploitable sous conditions, non industrialisé à ce stade.**

Justification :

- plusieurs moteurs métier existent et disposent de tests ;
- la production est décrite comme Docker + MySQL ;
- des services canoniques apparaissent pour la trésorerie, les encaissements, les délégations, la comptabilité et les congés ;
- cependant les audits internes prouvent encore des sources de vérité concurrentes, des workflows contradictoires, des contrôles non atomiques et des écarts entre documentation, code et MySQL réel ;
- les PR 63 et 64 sont ouvertes et non fusionnées ; leur contenu ne peut donc pas être considéré comme état de `main`.

## État par domaine — première passe

| Domaine | État provisoire | Preuves observées | Limites non levées |
|---|---|---|---|
| Identité et accès | Partiellement conforme | rôles, profils, permissions effectives et délégations existent ; le PRD directeur exige un service central | aucun `IdentityAccessService` prouvé comme point de passage unique ; coexistence rôles historiques / permissions effectives |
| Agents et comptes | Partiellement conforme | fiche agent, liaison utilisateur et protections de sortie présentes dans le dépôt | tous les chemins de création/import/script/migration ne sont pas encore cartographiés |
| Pointeuse | Partiellement conforme | moteur journalier, vue journalière et correction auditée sur la branche PR 64 | branche non fusionnée ; multi-pointages, shifts, clôture mensuelle et MySQL complet non prouvés |
| Congés | Conforme sur la branche PR 64, non prouvé sur `main` | 145 tests isolés verts ; PR 64 ajoute des scénarios MySQL et durcit les transitions | PR ouverte ; compatibilité complète avec `main` et CI finale à vérifier |
| Paie | Partiellement conforme | périodes, bulletins, rectifications et tests spécialisés existent | cohérence complète présence → paie → trésorerie → comptabilité non prouvée |
| Encaissements | Partiellement conforme | service `cash-receipt-workflow.js`, routes, tests et PR 56/59 | audit du 23 juin signale historique sans workflow, modifications et sources de soldes concurrentes ; état actuel de `main` à revérifier |
| Décaissements | Partiellement conforme | workflow, séparation des fonctions, garde solde, tests et PR 57/58/61 | concurrence, atomicité et cohérence ledger/statut doivent être reproduites sur MySQL actuel |
| Trésorerie | Implémentée mais cohérence non prouvée | `cash_ledger`, `cashbox_balances`, service `treasury-ledger.js`, migration 037, tests MySQL dédiés | audit interne prouve quatre sources de vérité et alimentation historique incomplète |
| Comptabilité OHADA | Partiellement conforme | écritures équilibrées, posting, contre-écriture, mappings et tests | atomicité avec l’opération métier et couverture MySQL complète non prouvées |
| Budget | Impossible à vérifier à ce stade | exigences détaillées dans le PRD Finance | tables, routes, UI et tests non encore cartographiés |
| Achats / fournisseurs / stock | Partiellement conforme | workflows et tests spécialisés existent | chaîne complète demande → réception → dette → paiement → trésorerie → comptabilité non encore prouvée |
| Parapheur | Partiellement conforme | services/routes atomiques et PR 60/62 | toutes les sources documentaires et transitions ne sont pas encore réconciliées |
| Audit | Partiellement conforme | `audit_logs`, audits métier et tests existent | plusieurs chemins avalent encore les erreurs selon l’audit Finance ; atomicité non généralisée |
| Notifications | Partiellement conforme | service dédié et principe non bloquant | ordre post-commit et comportement d’échec à vérifier par workflow |
| Tableaux de bord | Implémentés, fiabilité métier non prouvée | nombreuses vues frontend et endpoints | indicateurs peuvent dépendre de sources financières concurrentes |
| Production | Partiellement conforme | Docker, MySQL, health checks, scripts de déploiement ; PR 63 améliore SHA exact et SSH non-root | PR 63 ouverte ; version réellement déployée et restauration testée à vérifier |

## Constats critiques déjà prouvés

### REAL-001 — Sources de vérité financières concurrentes

- Gravité : critique.
- Exigence : source canonique unique des soldes.
- Preuve : `docs/audits/accounting-flow-control-2026-06-23.md` identifie simultanément `operations`, `operations.solde_position`, `cash_ledger`, `cashbox_balances` et `accounting_entries`.
- Conséquence : deux écrans ou deux recalculs peuvent afficher des soldes différents.
- Statut : ouvert ; l’existence de la migration 037 et du service ledger ne prouve pas que tous les flux historiques et actuels passent par eux.

### REAL-002 — État de `main` différent de la branche de durcissement

- Gravité : haute.
- Preuve : PR 64 est ouverte, en brouillon et non fusionnée vers `main`.
- Conséquence : les tests et correctifs de congés, présence, délégations et paie ajoutés sur cette branche ne sont pas encore état de production présumé.
- Statut : ouvert.

### REAL-003 — CI/CD sécurisé non fusionné

- Gravité : haute.
- Preuve : PR 63 est ouverte et en brouillon ; elle remplace le déploiement automatique par un déploiement manuel d’un SHA exact, interdit root et impose une empreinte SSH connue.
- Conséquence : tant que non fusionnée et déployée, ces garanties ne sont pas acquises.
- Statut : ouvert.

### REAL-004 — Workflow et comptabilité non atomiques sur tous les chemins

- Gravité : critique.
- Preuve : l’audit Finance documente des écritures comptables créées après l’effet métier et des erreurs d’audit ou de ledger parfois ignorées.
- Conséquence : une opération peut être payée ou encaissée sans ledger, sans audit ou sans écriture comptable complète.
- Statut : à reproduire sur l’état actuel de `main` et sur MySQL.

## Travaux Phase 1 restants

- cartographier toutes les tables par domaine ;
- cartographier toutes les routes montées dans `backend/server.js` ;
- identifier les services réellement appelés par chaque route ;
- cartographier les permissions backend et la visibilité frontend ;
- relier chaque écran aux endpoints consommés ;
- inventorier les tests unitaires, intégration, MySQL et UI ;
- vérifier les migrations effectivement exécutées ;
- comparer `main`, PR 63 et PR 64 ;
- vérifier la version Git réellement déployée en production.
