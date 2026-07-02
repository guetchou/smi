# 13 — Plan de finalisation priorisé

Ordre imposé par la mission : argent → permissions → soldes → atomicité → parapheur/source → RH-paie → stock/fournisseurs → comptes agents → migrations/production → UI/dette secondaire. Chaque lot = branche dédiée + reproduction + test échouant + correctif minimal + test MySQL + doc. **Aucune fusion automatique.**

## Lot 0 — Débloquer les correctifs existants (immédiat, sans nouveau code)
| Action | Contenu | Risque |
|---|---|---|
| 0.1 | Fusionner la présente branche `claude/decryptage-module-decaissement-vo56c8` (13 commits d'audit GRH/parapheur + ce dossier) après revue | faible — correctifs ciblés testés |
| 0.2 | **Extraire de la PR 64 le seul diff des gardes async** (`periodes_paie.js`, `salaires.js`) en PR dédiée « PR-64a » | quasi nul — resserrement |
| 0.3 | Finaliser la PR 63 (secrets + user non-root VPS + mise à jour CLAUDE.md/DANGER.md) | opérationnel VPS |

## Lot 1 — Argent (pertes, créations, doubles mouvements)
| ID | Correctif | Test préalable (échouant) |
|---|---|---|
| ANO-FIN-01 | DELETE /operations/:id : refus si payé ou lignes ledger ; contre-opération obligatoire | payer→DELETE→attendre 409, soldes stables (MySQL) |
| ANO-FIN-02 | PUT /operations/:id : immutabilité des champs financiers post-effet | payer→PUT montant→409 |
| ANO-ACH-01 | réception : erreur si ligne conforme sans produit résoluble | réception produit orphelin→409 |
| ANO-ACH-02 | plafond cumul réceptions ≤ commandé + tolérance | 2 réceptions 120 %→409 |

## Lot 2 — Permissions contournables
| ID | Correctif |
|---|---|
| ANO-SEC-01/02 | PR-64a (lot 0.2) + revue exhaustive des ~30 sites `salaires.js` |
| ANO-SEC-03 | `router.post('/import', requireWritePermission)` dans le routeur sûr + await legacy |
| ANO-SEC-04 | await `canPayCashOut` dans le filtre de liste + test de scope |
| Garde CI | check statique interdisant `can(` non attendu (verrou anti-récidive) |

## Lot 3 — Soldes (source canonique)
1. Initialiser `cashbox_balances` pour toutes les positions actives (script + vérification `check_finance_integrity_mysql.js`).
2. Supprimer le fallback `getSoldePosition(id, beforeId)` au paiement (ANO-FIN-04) → erreur bloquante si balance absente.
3. Activation pilote `ledger_status='ready'` sur une caisse (plan `plan_treasury_ledger_backfill_mysql.js`), généralisation par vagues (ANO-FIN-03/06).
4. Déprécier `solde_position` (ANO-FIN-05) — lecture seule, bannière de non-fiabilité virements.

## Lot 4 — Atomicité
| ID | Correctif |
|---|---|
| ANO-TEC-01/ANO-RH-03 | migrer les transitions paie (periodes/salaires) vers `db.js` async, transactions réelles |
| ANO-IAM-01 | index UNIQUE `users.employe_id` (détection doublons préalable) |
| ANO-SEC-07 | `auditPermission` : propager l'erreur si exécuteur transactionnel |

## Lot 5 — Parapheur / source
| ID | Correctif |
|---|---|
| ANO-PAR-04 | arbitrer la découpe PR 64 vs `025c512` (recommandation : fusionner cette branche d'abord, rebaser PR-64b) |
| ANO-PAR-01 | décision concurrente : UPDATE conditionnel + test MySQL 409 |
| ANO-PAR-02 | garde initiateur ≠ décideur au parapheur |

## Lot 6 — RH / paie
ANO-RH-01 (snapshot des taux dans le bulletin), ANO-RH-02 (congé approuvé → présence — coordonner avec PR-64c), tests sanctions/HS manquants.

## Lot 7 — Stock / fournisseurs
Compléter ANO-ACH-03 : audit du reste d'`achats.js`, garde suppression pièce comptabilisée, contrôle stock négatif sur les sorties (`produits.js`).

## Lot 8 — Comptes agents
ANO-IAM-03 (désactivation via service + audit), ANO-IAM-04 (révocation multi-comptes), arbitrage CONTRA-03 (compte urgence DG).

## Lot 9 — Migrations / production
PR 63 (si pas faite au lot 0), preuve de restauration backup datée, procédure de reprise comptable (ANO-CPT-02), test cycle comptable MySQL (ANO-CPT-01), unification clôtures (CONTRA-04) puis clôture journalière bloquante (C12) et rapprochement (C13), `user_cashboxes` (C14), gouvernance comptable (ANO-CPT-03).

## Lot 10 — UI / dette secondaire
Découpe `dashboard.html` (poursuivre PRD-refactorisation), dépérissement `operations.js`/`database.js` (ANO-TEC-02/03), vestiges SQLite (ANO-TEC-04), moteur budgétaire (ANO-BUD-01 — projet à part entière, PRD déjà rédigé dans la PR 64, à instruire après le lot 3).

## Jalons de sortie
- **J1 (fin lot 2)** : plus aucune permission contournable connue ; CI verrouille le motif.
- **J2 (fin lot 4)** : plus d'écriture multi-étapes non transactionnelle sur les chemins d'argent et de paie.
- **J3 (fin lot 5)** : parapheur prouvé concurrent-safe ; une seule vérité documentaire.
- **J4 (fin lot 9)** : DoD production tenue (déploiement SHA, non-root, backup prouvé).
- **Déclaration « industrialisé »** : uniquement quand `14-definition-of-done.md` est intégralement démontré.
