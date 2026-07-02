# 01 — Matrice PRD → code → preuves

## Légende des statuts

- **Conforme et prouvée** : les dix niveaux de preuve sont démontrés.
- **Partiellement conforme** : plusieurs couches existent, mais la chaîne complète n’est pas prouvée.
- **Implémentée mais non reliée** : composants présents sans preuve d’intégration bout en bout.
- **Implémentée sans test** : code présent sans test de contrat ou MySQL suffisant.
- **Contradictoire** : plusieurs modèles ou workflows se concurrencent.
- **Absente** : exigence non trouvée.
- **Obsolète** : implémentation historique remplacée mais encore présente.
- **Impossible à vérifier** : preuve insuffisante dans cette passe.

## Matrice initiale

| Exigence PRD | Module | Fichiers / services observés | Tables / migrations observées | Routes / permissions / UI | Tests observés | Statut réel provisoire | Preuve ou manque principal |
|---|---|---|---|---|---|---|---|
| Agent actif lié à un compte unique | Identité / RH | `backend/routes/agents.js`, routes d’accès et protections d’offboarding | `employes`, `users`, migrations de liaison | écrans agents et accès | tests de liaison et offboarding présents | Partiellement conforme | tous les chemins de création directe, import, migration et compte d’urgence restent à cartographier |
| Profils synchronisés avec rôles | Identité / Accès | services de permissions et profils | tables profils, permissions et affectations | `/api/access`, navigation frontend | tests statiques et accès présents | Contradictoire | le PRD directeur reconnaît deux modèles : rôles historiques et permissions effectives |
| Service central `IdentityAccessService` | Identité / Accès | aucun service portant ce contrat n’a encore été prouvé | non applicable | non prouvé | non prouvé | Absente ou impossible à vérifier | recherche exhaustive à poursuivre |
| Pointeuse disponible par défaut avec portée self-service | Pointeuse | `backend/routes/pointeuse.js`, `attendance_daily_engine.js` sur PR 64 | `pointages`, tables congés et paramètres | `/api/pointeuse`; UI dans `frontend/dashboard.html` | tests moteur et contrat sur PR 64 | Partiellement conforme | branche non fusionnée ; séparation complète supervision/self-service à tester |
| Congé transitionnel et atomique | Congés | `leave_transition_workflow.js`, routes sécurisées | `employes_conges`, documents, paramètres | endpoints congés et parapheur | 145 tests isolés ; scénarios MySQL ajoutés PR 64 | Conforme sur PR 64 seulement | non prouvé sur `main` ni en production |
| Heures supplémentaires reliées à la paie | RH / Paie | routes et services heures sup / paie | `employes_heures_sup`, bulletins | UI RH / paie | tests spécialisés présents | Impossible à vérifier | chaîne complète jusqu’au bulletin validé et au paiement non encore auditée |
| Avance salariale reliée à la trésorerie et à la retenue paie | RH / Finance | services paie et routes avances | tables avances, bulletins et opérations | UI avances / paie / finance | scénarios MySQL annoncés | Partiellement conforme | double retenue, double paiement et atomicité à reproduire |
| Encaissement contrôlé avant effet | Finance | `cash-receipt-workflow.js`, routes opérations | `operations`, migration 031 | `/api/operations`; UI encaissement | `cash_receipt_workflow_contract_test.js`, script MySQL | Partiellement conforme | historique et routes génériques peuvent contourner le workflow ; audit 2026-06-23 signale création directe valide |
| Décaissement avec séparation initiateur / approbateur / payeur | Finance | `operations.js`, parapheur requis, services intégrité | `operations`, documents finance | routes soumission, validation, paiement | tests séparation fonctions, atomicité et MySQL | Partiellement conforme | cohérence de tous les chemins et état actuel de `main` à prouver |
| Ledger unique append-only | Trésorerie | `backend/services/treasury-ledger.js` | migration `037_treasury_ledger_canonical.sql` | routes opérations et comptabilité | contrat ledger + script MySQL | Contradictoire | audit prouve coexistence de quatre sources et alimentation non uniforme |
| Solde courant atomique | Trésorerie | service ledger et finance-integrity | `cashbox_balances` | UI positions / soldes | tests ledger MySQL | Partiellement conforme | reconstruction complète et verrouillage de tous les flux non prouvés |
| Solde historique à date | Trésorerie | non prouvé comme contrat unique | ledger et opérations | écran journalier non prouvé | audit signale test manquant | Absente ou non prouvée | aucun résultat MySQL démontré pour solde à date/heure |
| Transfert interne à deux jambes | Trésorerie | service ledger cible | `cash_ledger`, `operations` source/destination | formulaires transferts présents | contrats statiques présents | Partiellement conforme | audit signale modèle historique à une ligne et traitement incorrect en clôture/rapprochement |
| Versement banque et retrait comme transferts de positions | Trésorerie | non encore cartographié | positions de trésorerie | UI à vérifier | tests non identifiés | Impossible à vérifier | nomenclature et implémentation à inventorier |
| Référence externe unique | Finance | gardes finance-integrity | colonnes opérations et index possibles | formulaires opérations | `finance_flow_control_guards` | Partiellement conforme | contrainte DB MySQL et tous canaux à vérifier |
| Comptabilité OHADA automatique | Comptabilité | routes `accounting.js`, services de mapping et génération | `accounting_entries`, lignes, mappings | espace comptable frontend | `accounting_workflow_test.js` | Partiellement conforme | génération après effet métier ; atomicité et anomalies bloquantes incomplètes selon audit |
| Total débit = total crédit | Comptabilité | moteur de posting | écritures et lignes | validation comptable | tests d’équilibre présents | Partiellement conforme | preuve MySQL exhaustive et blocage de clôture à confirmer |
| Écriture comptabilisée immuable | Comptabilité | posting et reversal | statuts et reverse links | actions UI contre-passation | tests reversal | Partiellement conforme | routes génériques et suppressions sources à vérifier |
| Affectation tiers / facture / dette | Finance / Facturation | modèles finance source documents | tables sources et allocations | UI affectation à vérifier | `finance_operations_model_test.js` | Partiellement conforme | chaîne dette/créance soldée par opération réelle non encore prouvée |
| Budget engagé et réalisé | Budget | non encore cartographié | tables budget non inventoriées | UI non cartographiée | tests non identifiés | Impossible à vérifier | priorité Phase 1 à compléter |
| Demande achat → réception → dette → paiement | Achats / Stock | routes achats, fournisseurs, stock, paiements | migrations achats et stock | UI achats / réception | tests atomicité fournisseur et réception | Partiellement conforme | chaîne bout en bout et comptabilisation OHADA non prouvées |
| Parapheur décision unique et synchronisation source | Parapheur | routes parapheur, source sync safe, opérations/achats safe | tables parapheur et audit | espace parapheur | tests atomicité et PR 60 | Partiellement conforme | tous types documentaires et rollback source/décision à inventorier |
| Notifications après commit et non bloquantes | Notifications | `backend/services/notif.js` et appels métier | notifications | UI notifications | tests congés et workflows ciblés | Partiellement conforme | ordre transactionnel non prouvé sur tous les modules |
| Audit atomique complet | Audit | helpers locaux et services | `audit_logs` | vues audit | tests ciblés | Partiellement conforme | audit Finance documente des erreurs avalées et écritures séparées |
| Dashboard fondé sur sources canoniques | Dashboard | routes dashboard et frontend monolithique | vues / agrégats divers | dashboard Web | tests statiques | Implémenté mais fiabilité non prouvée | indicateurs finance peuvent lire des sources concurrentes |
| MySQL comme contrat de production | Production | `backend/db.js`, scripts MySQL et Docker | migrations SQL MySQL | health et déploiement | jobs MySQL et scripts spécialisés | Partiellement conforme | `backend/database.js` et compatibilité SQLite restent actives ; classification requise |
| Déploiement d’un SHA exact, SSH non-root | Production | `.github/workflows`, `scripts/deploy.sh` PR 63 | non applicable | workflow GitHub Actions | `npm test`, `bash -n` prévus | Implémenté mais non fusionné | PR 63 ouverte et en brouillon |
| Sauvegarde et restauration prouvées | Exploitation | scripts backup/restore | volumes MySQL | documentation exploitation | tests de restauration signalés historiquement | Impossible à vérifier | preuve actuelle de restauration et production non encore collectée |

## Priorités de preuve suivantes

1. Finance / Trésorerie : comparer `operations`, `cash_ledger`, `cashbox_balances`, `accounting_entries` et rapprochements.
2. Identité / Accès : inventorier chaque écriture dans `users`, profils et liaisons agents.
3. Workflows : extraire toutes les transitions d’état écrites directement dans les routes.
4. MySQL : distinguer tests réellement exécutés des tests seulement présents.
5. Production : comparer SHA de `main`, PR 63, PR 64 et SHA déployé.
