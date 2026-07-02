# 01 — Matrice Exigence PRD → Code → Statut réel

Date : 2026-07-02. Statuts possibles : **conforme et prouvée** · **partiellement conforme** · **implémentée mais non reliée** · **implémentée sans test** · **contradictoire** · **absente** · **obsolète** · **impossible à vérifier**.

Colonnes : Exigence (PRD source) → fichiers clés → tables → routes → permissions → tests → **statut** → preuve.

## Identité et accès (PRD directeur, ACCESS_CONTROL_MODEL.md)

| Exigence | Fichiers | Tables | Routes | Tests | Statut | Preuve |
|---|---|---|---|---|---|---|
| Service central IdentityAccess | `services/identity_access.js` | users, user_profiles | users.js, user_provisioning | static_checks (garde invariant) | **Partiellement conforme** | Sync profils dans la tx (`identity_access.js:163`) mais bypass `users.js:120` |
| Un seul compte actif par agent | idem | users.employe_id | — | négatifs présents | **Partiellement conforme** | Contrôle applicatif `assertEmployeAvailableForUser` hors transaction, **aucun index UNIQUE** (migrations 015/020/022/023) → ANO-IAM-01 |
| Compte opérationnel ⇒ agent actif lié | `identity_access.js:76-79,129` | users | users.js | oui | **Contradictoire** | PRD exempte « admin et comptes d'urgence DG » ; code n'exempte que `admin` (`EMPLOYEE_LINK_EXEMPT_ROLES=['admin']`) → ANO-IAM-02 |
| Révocation à la sortie | `identity_access.js:256`, `user_provisioning.js:82` | users, onboarding_events | offboarding | oui (mysql offboarding) | **Conforme et prouvée** | `revokeEmployeeAccess` + sync offboarding→employes atomique (commit `025c512`) |
| Sync profils synchrone, échec = échec requête | `permissions.js:235-274` | user_profiles | — | oui | **Conforme et prouvée** | `syncUserProfilesFromRoles(..., tx)` dans la transaction de création/màj |
| Décisions par permissions effectives | `permissions.js:58-101` | permissions, profile_permissions, user_permissions, delegations | toutes | partiel | **Partiellement conforme** | Moteur correct, mais gardes non `await`ées dans salaires/periodes_paie → ANO-SEC-01/02 |
| Migration resync users→profils | migrations 017/018/019/020 | users, user_profiles | — | migration_runner_test | **Conforme et prouvée** | 018_resync_user_profiles.sql |
| Visibilité modules = permissions effectives, refus backend | `server.js:218-264` requireModule | user_modules | montage global | frontend_module_mapping_test | **Partiellement conforme** | requireModule au montage ✔ ; gardes internes paie no-op → refus backend incomplet |

## Agents / RH

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Fiche agent, audit création/modif | agents.js, agents_safe_write.js | **Conforme et prouvée** | garde `checkAgentAuditTraceabilityGuard`, correctifs branche (`31e228e`, `9147908`) |
| Onboarding checklist + provisioning compte | onboarding.js, user_provisioning.js | **Conforme et prouvée (après correctifs branche)** | `recalcStatus` exporté + tx (commit `354da3f`) |
| Offboarding atomique + parapheur | offboarding_workflow.js, parapheur_async.js | **Conforme et prouvée** | `scripts/test_offboarding_parapheur_mysql.js` ; checklists JSON corrigées (`c14da23`) |
| Organisation (départements, mutations, cycles) | organization_*.js | **Conforme et prouvée (après correctifs branche)** | CTE récursif, hierarchyMap batché (`6abe66e`), tests organization_* |

## Pointeuse / absences / congés / HS / sanctions

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Machine à états présence formalisée (absent/present/late/checked_out/incomplete/offsite/manual) | pointeuse.js | **Partiellement conforme** | statuts présents dans le code mais non centralisés dans un service dédié ; `manual_adjustment` distingué |
| Congés : workflow + parapheur + solde | leave_workflow.js | **Conforme et prouvée** | tx + FOR UPDATE + notification post-commit ; scénario MySQL `test_leave_parapheur_mysql.js` ; PR 64 l'étend |
| Congés approuvés → impact présence | — | **Absente** | aucun lien congé→pointages automatique trouvé (PR 64 introduit `attendance_daily_engine.js`) |
| HS intégrées à la paie | heures_sup.js, salaires.js | **Partiellement conforme** | rubriques HS présentes dans le calcul bulletin ; historisation taux paramétrée mais non versionnée → `04-rh-paie.md` |
| Sanctions workflow | sanctions.js | **Implémentée sans test** | pas de test de contrat dédié ; N+1 corrigé (`0dcf962`) |

## Paie / avances

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Machine à états paie : generated→validated→submitted_to_dg→approved_by_dg→paid | salaires.js, periodes_paie.js | **Contradictoire / non exploitable** | états présents, mais gardes no-op : soumission = auto-validation DG (`periodes_paie.js:198`) → ANO-SEC-01 |
| Paiement bulletin exige état validé + trésorerie | salaires.js (payerBulletinValide) | **Partiellement conforme** | contrôles trésorerie corrigés branche (`a50d4ba`) ; garde permission no-op (ANO-SEC-02) |
| Avance décaissée ⇒ impact trésorerie | salary_advance_workflow.js | **Conforme et prouvée (après correctif branche)** | commit `0c16038` (solde + ledger) ; test MySQL avance |
| Totaux numériques (pas de concat DECIMAL) | money()/safe() helpers | **Conforme** | normalisation systématique observée dans salaires/operations/services |

## Encaissements / décaissements / trésorerie / ledger / soldes

| Exigence (PRD flux) | Fichiers | Statut | Preuve |
|---|---|---|---|
| Encaissement brouillon→soumis→validé→confirmé, fonds ≠ validation | cash-receipt-workflow.js (+ router) | **Implémentée mais non reliée** | interception seulement si position `ledger_status='ready'` ; aucune position ready hors tests → ANO-FIN-03 |
| Ledger append-only canonique, jambes virement liées | treasury-ledger.js, migration 037 | **Implémentée mais non reliée** | idem ; contrat MySQL `test_treasury_ledger_canonical_mysql.js` passe mais production sur chemin legacy |
| Décaissement draft→submitted→approved→paid, séparation créateur/approbateur/payeur | operations_parapheur_required_safe.js, cash-out-separation.js | **Conforme et prouvée** | audits 2026-06-23 + tests dédiés ; codes CASH_OUT_SELF_APPROVAL_FORBIDDEN |
| Paiement atomique op+ledger+audit | operations.js:1469-1518 | **Conforme (chemin durci)** | tx + FOR UPDATE + conditionnel ; réserve fallback `getSoldePosition(id, beforeId)` ANO-FIN-04 |
| Immutabilité post-effet, correction par contre-opération | operations.js PUT/DELETE /:id | **Absente** | verrou seulement si écriture comptable postée ; ANO-FIN-01/02 |
| Solde = source canonique unique | — | **Contradictoire** | 4 représentations (operations, solde_position, cash_ledger, cashbox_balances) toujours actives en legacy (C1 audit 23/06) |
| Virement 2 jambes + double confirmation | treasury-ledger (2 jambes) ; PRD_operations_workflow §6 | **Implémentée mais non reliée** (jambes) / **Absente** (double confirmation, statuts transit/litige) | expectedLedgerLegs ✔ ; aucun statut initié/confirmé_source/…​ dans operations.js |
| Référence externe anti-doublon | validateExternalReference | **Conforme** | operations.js:577,710 |
| Clôture journalière bloquante | caisses_clotures vs cashbox_closures | **Contradictoire** | deux modèles (C11) ; operations.js ne contrôle que periodes_cloturees (mois) |
| Rapprochement fiable | rapprochements.js | **Partiellement conforme** | C13 non retraité (calcul virements, non-transactionnel) |
| Permissions par caisse (user_cashboxes) | migration 012 | **Implémentée mais non reliée** | table jamais lue dans operations.js (C14) |

## Comptabilité OHADA / budget

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Total débit = total crédit bloquant | accounting.js:530-537 | **Conforme et prouvée** | rejet si écart ≥ 0,01 ou <2 lignes ; tests accounting_workflow_test |
| Génération idempotente + anomalies visibles | accounting.js, sync_errors | **Conforme et prouvée** | WORKFLOW_CONTROL_BOARD « Terminé » vérifié dans le code |
| Comptabilisation atomique avec prise d'effet | — | **Partiellement conforme** | post-effet + sync_errors (C9) ; acceptable si clôture bloque les anomalies — vérifié : blocage présent |
| Mappings actifs en production | — | **Impossible à vérifier / non exécuté** | décision métier en attente (control board) |
| Budget engagé/réalisé, contrôle avant décaissement | table budgets (001), budget_status (024) | **Absente** | `budget_status` seulement 'pending'/'cancelled', jamais 'synced' ; aucun contrôle ; PR 64 ajoute un PRD moteur budgétaire → ANO-BUD-01 |

## Achats / fournisseurs / stock

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Demande→validation→BC→réception→facture→paiement | achats.js + workflows | **Partiellement conforme** | chaîne présente ; rapprochement 3 voies au paiement ✔ |
| Réception ⇒ mouvement stock atomique | stock_receipt_validation_workflow.js | **Conforme et prouvée** | test atomicité MySQL ; réserve ANO-ACH-01 (produit manquant ignoré silencieusement) |
| Paiement fournisseur ⇒ dette réduite, atomique | supplier_payment_workflow.js | **Conforme et prouvée** | test_supplier_payment_mysql.js |
| Sur-réception contrôlée | — | **Partiellement conforme** | pas de plafond quantité_conforme ≤ commandé à la validation (contrôlé seulement au paiement facture) → ANO-ACH-02 |
| Stock négatif interdit | produits.js | **Impossible à vérifier** dans cette passe | à contrôler sur les mouvements de sortie |

## Parapheur

| Exigence | Fichiers | Statut | Preuve |
|---|---|---|---|
| Création atomique demande+source | parapheur_async.js (connecteur tx) | **Conforme et prouvée** | offboarding/congés/avances passent par `creerEntreeParapheurDansTransaction` |
| Approbation ⇒ sync source atomique | parapheur_source_sync_safe.js | **Conforme (après correctifs branche)** | 3 syncs transactionnels (commit `025c512`) ; ⚠ PR 64 réécrit ce fichier → conflit à arbitrer |
| Décision unique / verrou concurrent | parapheur.js + source sync | **Partiellement conforme** | anti-doublon à la création ✔ ; verrouillage concurrent de la décision à prouver sous MySQL (PR 64 ajoute un test 409 concurrent) |
| Intérim (remplaçant, tags, retour validé DG) | parapheur_interim | **Implémentée sans test** | logique présente (notifierParapheurTarget lit interim) ; pas de test dédié |
| Notifications post-commit | parapheur_async.js:97 | **Conforme** | notifier après tx |

## Notifications / dashboards / audit

| Exigence | Statut | Preuve |
|---|---|---|
| Notifications non bloquantes | **Conforme (après correctifs branche)** | patterns setImmediate+catch corrigés (`71e34c6`, `2d49df0`) |
| Dashboards par rôle (PRD_dashboard_vues) | **Partiellement conforme** | endpoints dashboard présents ; vues par rôle côté front dans dashboard.html monolithique — non testé par rôle |
| Audit chaque transition | **Partiellement conforme** | audit présent dans les workflows durcis ; `auditPermission` avale les erreurs (`permissions.js:149`) → ANO-SEC-07 |

## Déploiement / sauvegarde

| Exigence | Statut | Preuve |
|---|---|---|
| Déploiement par SHA exact, SSH non-root, empreinte épinglée | **Contradictoire (main) / corrigé en PR 63 non fusionnée** | deploy.yml actuel : root@IP, StrictHostKeyChecking=no, checkout branche → ANO-PROD-01 |
| Migrations idempotentes rejouables | **Conforme et prouvée** | runner.js + migration_runner_test.js (journal des migrations appliquées) |
| Sauvegarde/restauration/export | **Impossible à vérifier** (exécution VPS) | scripts présents : backup_db.sh, test_backup.sh, export_daily.js, rollback.sh |
| DB_DRIVER=mysql obligatoire en prod | **Conforme** | deploy.sh force/exige mysql ; PR 63 rend l'absence bloquante |
