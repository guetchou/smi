# 14 — Definition of Done et verdicts par module

## 1. DoD du PRD directeur — état démontré au 2026-07-02

| Critère DoD | État | Preuve / blocage |
|---|---|---|
| Aucun utilisateur opérationnel actif sans agent actif lié | **Partiel** | contrôle applicatif ✔, contrainte DB absente (ANO-IAM-01), bypass désactivation (ANO-IAM-03) |
| Aucun utilisateur opérationnel sans profils effectifs synchronisés | **Tenu** (chemins service) | sync dans la tx ; resync migration 018 |
| Compte créé par RH ⇒ modules attendus immédiatement | **Tenu** | provisioning → createUserAccess → sync profils |
| Agent voit pointeuse par défaut + seulement ses modules | **Partiel** | requireModule ✔ ; gardes internes paie no-op (ANO-SEC-02) ⇒ « backend rejection » non tenue |
| Vues supervision séparées du self-service | **Tenu** (pointeuse) / à re-prouver ailleurs | montages distincts |
| Rapports finance/RH/salaires/caisse en totaux numériques | **Tenu** | normalisation systématique |
| CI bloque régressions identité/accès/workflows/migrations/propreté | **Partiel** | contrats nombreux ✔ ; aucun garde sur les motifs de permission cassés ni sur la façade sync |
| La documentation ne déclare plus « terminé » avec dette critique ouverte | **Non tenu** | CONTRA-01, CONTRA-10 |

**Conclusion : la DoD n'est pas démontrée. Tala SMI ne doit pas être déclaré « industrialisé ».**

## 2. Verdicts par module

Base des verdicts : tests exécutés dans le dépôt (contrats + scénarios MySQL scripts/), comportement du code lu ligne à ligne, invariants prouvés ou réfutés, écarts documentés dans les fichiers 03→12.

| Module | Verdict | Motif principal |
|---|---|---|
| Identité & accès | **Exploitable sous conditions** | service central solide ; IAM-01/02/03 ouverts |
| Agents / organisation | **Exploitable sous conditions** | correctifs branche à fusionner (lot 0.1) |
| Pointeuse | **Exploitable sous conditions** | états non centralisés ; lien congés absent |
| Congés | **Exploitable sous conditions** | workflow prouvé MySQL ; effet présence absent (RH-02) |
| Heures sup / sanctions | **Exploitable sous conditions** | implémenté sans tests dédiés |
| Avances salariales | **Exploitable sous conditions** | trésorerie liée (commit `0c16038`) ; fusion requise |
| **Paie** | **Non exploitable** (séparation des fonctions) | ANO-SEC-01/02 : auto-validation DG, gardes no-op ; pseudo-transactions (RH-03) |
| Décaissements | **Exploitable sous conditions** | chaîne durcie + séparation prouvée ; FIN-01/02 à corriger |
| **Encaissements / virements / soldes** | **Non exploitable au sens du PRD flux** | chemin legacy actif : validation directe, 4 sources de soldes, moteur canonique non relié (FIN-03) |
| Ledger trésorerie (canonique) | **Implémenté, testé, non relié** | activation = décision d'exploitation (lot 3) |
| Comptabilité OHADA | **Exploitable sous conditions** | équilibré/idempotent/clôturé ✔ ; mappings inactifs, cycle MySQL non prouvé |
| **Budget** | **Non exploitable (absent)** | schéma seul (BUD-01) |
| Achats / fournisseurs / stock | **Exploitable sous conditions** | paiement + réception prouvés MySQL ; ACH-01/02/03 |
| Facturation / commercial / contrats | **Non vérifiable (cette passe)** | non audités en profondeur — passe dédiée requise |
| Parapheur | **Exploitable sous conditions** | sync atomique (branche) ; PAR-01/02/04 |
| Notifications | **Exploitable** | non bloquantes, post-commit |
| Tableaux de bord | **Exploitable sous conditions** | données OK ; périmètres par rôle non testés |
| Audit (piste) | **Exploitable sous conditions** | trous : SEC-07, IAM-03, audits hors tx sur couche sync |
| Production / CI-CD | **Exploitable sous conditions** | PROD-01 (PR 63) ; backup non prouvé d'ici |

## 3. Conditions de re-déclaration
Un module ne change de verdict que sur preuve : test MySQL exécuté en CI ou script `scripts/test_*_mysql.js` daté, référencé dans ce dossier. Les verdicts « sous conditions » listent leurs conditions dans les fichiers 03→12 ; les lever dans l'ordre du `13-plan-finalisation.md`.
