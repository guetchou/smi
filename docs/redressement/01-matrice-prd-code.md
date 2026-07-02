# 01 — Matrice PRD → code → preuves

## 1. Règle de lecture

Une exigence n’est considérée comme conforme que si les couches suivantes sont prouvées ensemble :

```text
PRD
→ modèle métier
→ schéma MySQL
→ migration appliquée
→ service canonique
→ route réellement montée
→ permission backend
→ interface
→ audit
→ tests MySQL / concurrence / rollback
→ déploiement production vérifié
```

La présence d’un fichier, d’une route, d’une table ou d’un écran ne constitue pas une preuve d’exploitation.

## 2. Statuts canoniques

- **Conforme et prouvée** : chaîne complète démontrée.
- **Partiellement conforme** : plusieurs couches existent, mais une garantie manque.
- **Implémentée mais non reliée** : composants présents sans orchestration bout en bout.
- **Implémentée sans test suffisant** : code présent, preuve MySQL ou concurrence insuffisante.
- **Contradictoire** : plusieurs modèles actifs se concurrencent.
- **Absente** : exigence non trouvée.
- **Obsolète mais active** : chemin ancien supposé remplacé, encore utilisable.
- **Impossible à vérifier** : preuve production ou donnée réelle indisponible.

## 3. Matrice consolidée

| Exigence PRD | Module | Fichiers / services principaux | Tables / migrations | Routes / permissions / UI | Tests / preuves | Statut réel | Anomalies liées | Verdict d’exploitation |
|---|---|---|---|---|---|---|---|---|
| Un agent actif correspond à un compte unique | Identité / RH | `agents.js`, `agents_safe_write.js`, onboarding, offboarding | `employes`, `users` | routes agents et accès | tests liaison/offboarding partiels | Partiellement conforme | IAM-005, IAM-006, IAM-016, PAY-017 | Exploitable sous conditions |
| Désactivation atomique compte + agent à la sortie | Identité / RH | `offboarding_workflow.js`, routes offboarding | agents, users, parapheur | permissions hybrides | test MySQL offboarding/parapheur présent | Partiellement conforme | IAM-016, PAY-017 | Non prouvé bout en bout |
| Profils et permissions comme source unique | Identité / Accès | `services/permissions.js` | profils, user_profiles, user_permissions | `/api/access` | tests ciblés | Contradictoire | IAM-001 à IAM-005 | Non industrialisé |
| Service central `IdentityAccessService` | Identité / Accès | aucun point d’entrée unique prouvé | — | — | — | Absent | IAM-006, IAM-008 | Non exploitable comme gouvernance unique |
| Délégation canonique avec cycles, plafonds et expiration | Identité / Accès | `delegation_engine.js` | `delegations` + modèles historiques | routes accès et parapheur | moteur spécialisé présent | Partiellement conforme | IAM-009 à IAM-015, PAR-014 | Exploitable sous conditions |
| Refus explicite prioritaire | Identité / Accès | `activePermissionsForUser()` | user_permissions | API droits effectifs | tests à confirmer | Partiellement conforme | IAM-002, IAM-003 | Contradictoire pour admin |
| Compte d’urgence gouverné | Identité / Accès | non prouvé | — | — | — | Absent | IAM-018 | Non exploitable |
| Présence/pointeuse self-service et supervision séparée | RH / Présence | pointeuse, attendance engine | pointages, paramètres | UI agent/supervision | tests branche PR 64 | Partiellement conforme | PAY-012, PAY-013 | Non vérifiable comme source de paie |
| Congés transitionnels et atomiques | RH / Congés | leave workflow, calendar, unpaid leave payroll | employes_conges | routes congés + parapheur | 145 tests isolés, scénarios MySQL PR 64 | Conforme sur branche seulement | PAY-012, PAY-017, PAY-018 | Exploitable sous conditions |
| Congé sans solde intégré à la paie | RH / Paie | `unpaid_leave_payroll.js` | employes_conges, parametres | moteur paie | tests spécialisés | Partiellement conforme | PAY-010 à PAY-013, PAY-017, PAY-018 | Exploitable sous conditions |
| Heures supplémentaires reliées au bulletin | RH / Paie | routes/services heures sup et salaires | employes_heures_sup, bulletins | UI RH/paie | tests ciblés | Impossible à vérifier | PAY-012, PAY-013 | Non vérifiable |
| Avance reliée au paiement et à une retenue unique | RH / Paie / Finance | avances, paie, opérations | avances, bulletins, operations | UI avances | preuves partielles | Impossible à vérifier | PAY-014, PAY-015 | Non exploitable comme chaîne garantie |
| Bulletin calculé depuis des entrées figées | RH / Paie | `salaires.js` | bulletins, paramètres | routes salaires | tests calculs ciblés | Contradictoire | PAY-001, PAY-010, PAY-012, PAY-013 | Non exploitable industriellement |
| Barèmes paie versionnés et juridiquement validés | RH / Paie | paramètres dynamiques | parametres | administration | aucune certification collectée | Impossible à vérifier | PAY-010, PAY-011 | Non vérifiable juridiquement |
| Période payée/clôturée immuable | RH / Paie | `periodes_paie.js` | périodes, bulletins | workflow période | tests partiels | Partiellement conforme | PAY-009, PAY-013, PAY-015 | Non prouvé |
| Paiement de paie atomique avec ledger | RH / Finance | routes salaires historiques | operations, ledger | paiement salaire | aucune preuve bout en bout | Contradictoire | PAY-002 à PAY-006, PAY-016 | Non exploitable |
| Encaissement contrôlé avant effet | Finance | `cash-receipt-workflow.js` | operations, migration 031 | routes opérations | contrats + script MySQL | Partiellement conforme | FIN-001 à FIN-003, FIN-010 | Exploitable sous conditions |
| Décaissement séparant initiateur, valideur et payeur | Finance | operations, parapheur, services finance | operations, events | permissions + workflow | tests séparation/atomicité | Partiellement conforme | IAM-001, PAR-001, FIN-010 | Non prouvé sur tous les chemins |
| Référence externe unique et idempotence | Finance | finance-integrity, services paiements | indexes à confirmer | formulaires paiements | tests gardes | Partiellement conforme | PUR-009, PROD-010 | Non prouvé DB globalement |
| Ledger unique append-only | Trésorerie | `treasury-ledger.js` | migration 037 | opérations/finance | tests ledger MySQL | Contradictoire | FIN-001 à FIN-003, FIN-008, FIN-009 | Non exploitable comme source unique |
| Solde courant atomique | Trésorerie | ledger + cashbox balance | cash_ledger, cashbox_balances | UI positions | tests ciblés | Partiellement conforme | FIN-001, FIN-002, FIN-010 | Non prouvé sur tous flux |
| Solde historique à date/heure | Trésorerie | aucun contrat complet prouvé | ledger sans date métier canonique | journal à vérifier | test absent | Absente ou non prouvée | FIN-008 | Non exploitable |
| Reversal canonique | Trésorerie | infrastructure partielle | reversal_of_ledger_id | UI non prouvée | tests insuffisants | Implémentée mais non reliée | FIN-009 | Non exploitable |
| Transfert interne à deux jambes | Trésorerie | ledger attendu legs | cash_ledger | formulaires transfert | contrats statiques | Partiellement conforme | FIN-001, FIN-008 | Non prouvé bout en bout |
| Clôture et rapprochement bloquants | Trésorerie | routes clôtures/rapprochements | modèles de clôture concurrents | UI finance | audit spécialisé | Contradictoire | FIN-001, FIN-012, ACC-009 | Non exploitable |
| Comptabilité automatique après effet financier | Comptabilité | `services/accounting.js` | accounting_entries, lines, mappings | routes accounting | tests workflow | Partiellement conforme | ACC-001, ACC-002, ACC-011 | Exploitable sous conditions |
| Débit = crédit avant posting | Comptabilité | posting service | écritures/lignes | validation comptable | tests présents | Partiellement conforme | ACC-008, ACC-011 | Conforme sur chemin testé |
| Écriture postée immuable | Comptabilité | posting + reversal | statuts, reverse links | actions UI | tests reversal | Partiellement conforme | ACC-012 | Non prouvé pour toutes routes |
| Mapping comptable actif gouverné | Comptabilité | routes accounting | mappings | création/activation | tests partiels | Contradictoire | ACC-003 à ACC-007 | Non industrialisé |
| Plan OHADA certifié | Comptabilité | plan/mappings | comptes | UI comptable | aucune validation métier collectée | Impossible à vérifier | ACC-014 | Non vérifiable |
| Tiers, facture, dette et créance reliés | Finance / Comptabilité | finance source documents, allocations | source_documents, payment_allocations | UI non prouvée | tests modèle | Implémentée mais non reliée | PUR-010, PUR-014, ACC-013 | Non exploitable comme chaîne complète |
| Budget approuvé, versionné et clôturé | Budget | aucun moteur canonique prouvé | champs isolés | UI non prouvée | aucun test identifié | Absent | BUD-001, BUD-010, BUD-011 | Non exploitable |
| Engagement et réalisation distincts | Budget | non prouvé | non prouvé | non prouvé | non prouvé | Absent | BUD-003 | Non exploitable |
| Contrôle concurrent du disponible | Budget | non prouvé | non prouvé | non prouvé | non prouvé | Absent | BUD-004 | Non exploitable |
| Dépassement et override gouvernés | Budget | non prouvé | non prouvé | non prouvé | non prouvé | Absent | BUD-008 | Non exploitable |
| Demande achat → BC → réception → facture → paiement | Achats | achats routes + supplier workflow | migrations achats | UI achats/stock | tests réception/paiement | Contradictoire | PUR-001 à PUR-007 | Exploitable sous conditions seulement |
| Réception stock atomique | Stock | stock receipt workflow | produits, stock_mouvements, receptions | routes réception | test MySQL rollback complet | Conforme sur scénario testé | PUR-011, PUR-012 | Exploitable sous conditions |
| Retour fournisseur décrémente le stock | Stock | non prouvé | statuts retour | UI à vérifier | test absent | Impossible à vérifier | PUR-013 | Non exploitable |
| Paiement fournisseur avec rapprochement 3 voies | Fournisseurs | `supplier_payment_workflow.js` | factures, BC, réceptions | paiement fournisseur | tests spécialisés | Partiellement conforme | PUR-003 à PUR-010 | Non exploitable comme chaîne complète |
| Allocation de paiements partiels | Fournisseurs / Finance | finance allocations existent | payment_allocations | UI non prouvée | test modèle | Implémentée mais non reliée | PUR-010, PUR-014 | Non exploitable |
| Contrat activé après validation et signature | Contrats | `routes/contrats.js` | contrats | routes contrats | tests non identifiés | Contradictoire | CTR-001, CTR-002, CTR-009 | Non exploitable juridiquement |
| Contrat versionné et immuable | Contrats | parent renewal seulement | contrats | UI contrats | test absent | Partiellement conforme | CTR-008, CTR-010, CTR-020 | Suivi administratif seulement |
| Échéance dérivée de facture/paiement réel | Contrats | cron échéances/factures | contrats_echeances | routes statut échéance | test absent | Contradictoire | CTR-007, CTR-014, CTR-017 | Non exploitable financièrement |
| Contrat salarié gouverne la paie | Contrats / RH | non relié de façon canonique | contrats + données RH | UI séparées | aucun E2E | Implémentée mais non reliée | CTR-022 | Non exploitable |
| Contrat fournisseur gouverne l’achat | Contrats / Achats | non prouvé | contrats + achats | UI séparées | aucun E2E | Implémentée mais non reliée | CTR-023 | Non exploitable |
| Parapheur : une décision unique par source | Parapheur | routes + `parapheur_async.js` | parapheur, actions | UI parapheur | tests PR 60 | Partiellement conforme | PAR-001, PAR-012, PAR-013 | Exploitable sous conditions |
| Décision et source synchronisées | Parapheur | `syncSourceDecision()` | source refs | routes approuver/rejeter | preuve surtout décaissement | Implémentée mais non reliée | PAR-001 à PAR-004, PAR-019, PAR-022 | Non exploitable transversalement |
| Confidentialité documentaire réelle | Parapheur | priorité `confidentiel` | parapheur | visibilité par rôle/statut | aucun test sécurité prouvé | Contradictoire | PAR-006 à PAR-008 | Non exploitable pour documents sensibles |
| Signature numérique probante | Parapheur / Contrats | non prouvée | aucune version/signature forte prouvée | UI approbation | aucun test juridique | Absente | PAR-008, PAR-009, CTR-002 | Non exploitable juridiquement |
| Notifications persistantes | Notifications | `services/notif.js` | notif_messages, notif_envois, alertes | routes notifs | tests ciblés | Partiellement conforme | AUD-007 à AUD-015 | Exploitable pour confort |
| Livraison critique garantie après commit | Notifications | setImmediate + email service | notif_envois | SSE/email | worker retry non prouvé | Implémentée mais non reliée | AUD-008 à AUD-012, AUD-022 | Non exploitable pour garantie critique |
| Audit atomique et immuable | Audit | helpers dispersés | audit_logs + tables spécialisées | vues audit | tests ciblés | Contradictoire | AUD-001 à AUD-006, AUD-009, AUD-024 | Non exploitable comme preuve complète |
| Corrélation transversale | Audit | non systématique | colonnes non uniformes | — | — | Absente | AUD-004 | Non exploitable |
| Alertes visibles uniquement aux destinataires | Notifications | routes notifs | alertes_actives | `/api/notifs/alertes` | test sécurité absent | Contradictoire | AUD-016 à AUD-020 | Non exploitable pour données sensibles |
| Dashboard basé sur sources canoniques | Dashboard | dashboard routes/frontend | agrégats multiples | dashboard | tests statiques | Implémenté mais fiabilité non prouvée | FIN-001, BUD-012 | Non vérifiable |
| MySQL seul runtime de production | Production | `backend/db.js`, deploy | migrations MySQL | Docker/health | scripts MySQL | Contradictoire | PROD-006 à PROD-010 | Non industrialisé |
| Déploiement SHA exact et SSH non-root | Production | workflow + PR 63 | — | GitHub Actions | validations proposées PR 63 | Implémenté mais non fusionné | PROD-001 à PROD-005 | Non exploitable industriellement |
| Sauvegarde restaurable hors site | Exploitation | `scripts/deploy.sh` | dumps locaux | exploitation | restauration non prouvée | Impossible à vérifier | PROD-011, PROD-012, PROD-025 | Non exploitable comme PRA |
| Rollback testé | Production | aucun mécanisme complet prouvé | migrations | déploiement | non prouvé | Absent | PROD-015, PROD-016 | Non exploitable |
| Version production observable | Production | logs pipeline seulement | — | health simple | non prouvé | Absent | PROD-019, PROD-020 | Non vérifiable |
| Supervision centralisée | Exploitation | console logs, health | — | aucun tableau complet prouvé | non prouvé | Absente ou partielle | AUD-026, PROD-024 | Non exploitable industriellement |

## 4. Synthèse par domaine

| Domaine | Verdict consolidé | Document détaillé |
|---|---|---|
| État global | Exploitable sous conditions, non industrialisé | `00-etat-reel-du-produit.md` |
| Identité / Accès | Partiellement conforme, autorité unique absente | `03-identite-acces.md` |
| RH / Paie | Partiellement exploitable, chaîne financière non fiable | `04-rh-paie.md` |
| Finance / Trésorerie | Non exploitable comme source unique | `05-finance-tresorerie.md` |
| Comptabilité OHADA | Exploitable sous conditions | `06-comptabilite-ohada.md` |
| Budget | Non exploitable | `07-budget.md` |
| Achats / Stock / Fournisseurs | Partiellement exploitable, chaîne non conforme | `08-achats-stock-fournisseurs.md` |
| Contrats | Suivi administratif seulement | `09-contrats.md` |
| Parapheur | File de décision partiellement exploitable | `10-parapheur.md` |
| Audit / Notifications | Best effort, preuve complète absente | `11-audit-notifications.md` |
| Production / CI-CD | Non industrialisé | `12-production-ci-cd.md` |
| Plan de correction | P0/P1/P2 consolidés | `13-plan-corrections-priorise.md` |
| Verdict final | NO-GO comme source unique financière/comptable/juridique | `14-verdict-final.md` |

## 5. Exigences P0 bloquant toute qualification industrielle

1. Déploiement d’un SHA exact sans root.
2. Suppression des fallbacks d’autorisation critiques.
3. Audit et outbox durables.
4. Diagnostic MySQL réel des soldes.
5. Ledger obligatoire et reversal canonique.
6. Paiements paie/fournisseurs atomiques.
7. Synchronisation parapheur/source fiable.
8. Tests MySQL de concurrence et rollback.
9. Restauration prouvée.
10. Version production observable.

## 6. Preuves encore manquantes

- état exact de la base de production ;
- liste des migrations réellement appliquées ;
- SHA effectivement déployé ;
- routes effectivement montées ;
- écarts réels entre opérations, ledger, cache et comptabilité ;
- restauration d’une sauvegarde récente ;
- conformité juridique paie ;
- validation métier du plan OHADA ;
- couverture frontend selon permissions ;
- tests E2E complets des flux critiques.

Ces éléments restent **impossibles à vérifier**. Ils ne doivent jamais être présumés conformes.
