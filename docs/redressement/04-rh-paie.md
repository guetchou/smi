# 04 — Audit RH et paie

## 1. Machines à états observées

### Congés (`leave_workflow.js`)
`brouillon → soumis (parapheur créé dans la même tx) → approuve | rejete` ; chevauchement bloqué par `FOR UPDATE` ; solde vérifié dans la tx ; notifications post-commit. **Conforme.** Lien congé→présence : **absent** (aucune écriture pointage/absence à l'approbation) — la PR 64 introduit `attendance_daily_engine.js` pour combler ce trou.

### Avances (`salary_advance_workflow.js`)
`demande → parapheur → approuve → decaissement` ; auto-approbation sous seuil sans parapheur ; **impact trésorerie du décaissement d'avance corrigé** (commit `0c16038` : solde + ledger). Retenue en paie : rubrique liée au bulletin — la double retenue est empêchée par le statut de l'avance ; test MySQL présent (`scripts/test_salary_advance_parapheur_mysql.js`).

### Paie (bulletins + périodes)
États bulletins `genere → valide → paye` ; périodes `ouverte/preparation/controle_rh/controle_finance → soumis_dg → validee_dg`.

**Défaut majeur : la machine à états est correcte sur le papier et morte en pratique** — voir ANO-SEC-01/02 (`10-securite.md`) : toutes les transitions sensibles (valider bulletin, payer, soumettre DG, valider DG) ont des gardes no-op. La soumission DG **auto-valide** systématiquement la période (`periodes_paie.js:198`).

### Offboarding
`initie → (calcule) → parapheur → valide → applique (employes.actif=0, statut_dossier='sorti')` — synchronisation source atomique depuis le commit `025c512`. Révocation d'accès à la sortie : `user_provisioning.revoquerAcces` → `revokeEmployeeAccess`. **Conforme.**

### Sanctions / HS / pointeuse
Workflows présents, transitions par routes (pas de service central de machine à états) ; N+1 et caches corrigés sur cette branche. Pas de tests de contrat dédiés (sanctions, HS) → **implémentée sans test**.

## 2. Réponses aux points de recherche de la mission

| Point recherché | Constat |
|---|---|
| HS non intégrées à la paie | Intégrées (rubriques HS au calcul bulletin) ; taux paramétrés avec cache 5 min (commit `2d49df0`) |
| Avances décaissées sans impact trésorerie | **Corrigé** commit `0c16038` |
| Avances remboursées/retenues deux fois | Garde par statut avance ; pas de test de double retenue concurrent → à écrire |
| Congés approuvés sans effet présence | **Confirmé — absent** (PR 64 en cours) |
| Agents sortis encore sélectionnables | Filtres `actif=1`/`statut_dossier` présents dans les listes principales ; provisioning refuse un sorti |
| Bulletins recalculables après validation | Verrouillage présent ; rectification post-paiement par flux dédié (`payroll_rectifications_module_test.js`) |
| Historisation des paramètres de paie | **Partielle** : `parametres` clé/valeur sans versionnage — un changement de taux réécrit l'historique implicite des calculs futurs, sans trace de la valeur au moment du calcul → ANO-RH-01 (MOYENNE) : persister les taux utilisés dans le bulletin (snapshot) ou versionner `parametres` |
| Calculs sur chaînes MySQL (DECIMAL) | Normalisation `money()/safe()` systématique — conforme |
| Modification rétroactive non auditée | Audits présents sur les flux durcis ; audit paie via `audit()` periodes_paie — mais écrit hors transaction (sync `db.prepare`) → voir ANO-TEC-01 |
| Paiement sans état approuvé | Contrôlé applicativement (`payerBulletinValide` exige bulletin validé + période) mais la **garde de permission** est no-op (ANO-SEC-02) |
| Séparation préparation/validation/paiement | **Non effective** (ANO-SEC-01/02) |

## 3. Correctifs GRH déjà livrés sur cette branche (preuves)

| Commit | Correctif |
|---|---|
| `78dc6d1`, `d20bc06`, `31e228e` | N+1, pool MySQL, races matricule/numéros, recalcul soldes batché |
| `a50d4ba` | Paiement bulletin : contrôles trésorerie, mutation de période, perf |
| `0c16038` | Avance → trésorerie (solde + ledger) |
| `2d49df0`, `0dcf962`, `538bd46` | caches taux/params, sanctions/grilles N+1, `_appliquerRevision` transactionnel, CTE cycles organigramme |
| `71e34c6` | offboarding fire-and-forget protégés |
| `9147908` | agents GET /:id — avances batch, parametres ciblés |
| `6abe66e` | applyDue mutations : 1 scan hiérarchie au lieu de 200 |
| `c14da23` | corruption JSON checklists offboarding |
| `354da3f` | recalcStatus onboarding exporté + transactionnel |
| `025c512` | sync parapheur→sources (offboarding, révision salariale, achats) atomique |

## 4. Anomalies ouvertes

### ANO-RH-01 — Paramètres de paie non versionnés — MOYENNE
Voir tableau §2. Correction minimale : snapshot des taux dans `bulletins_salaire` (colonnes ou JSON) au moment du calcul.

### ANO-RH-02 — Congé approuvé sans effet présence — MOYENNE
Exigence PRD directeur (user story 29). Correction : à l'approbation, générer les absences justifiées sur la période (ou lien lu par la pointeuse). Ne pas dupliquer le travail de la PR 64 — arbitrer d'abord son sort.

### ANO-RH-03 — Routes paie sur la couche sync sans transactions réelles — HAUTE (structurel)
`salaires.js` et `periodes_paie.js` utilisent `db.prepare` (couche `database.js`/facade). En production MySQL, `transaction()` de cette couche est un no-op (ANO-TEC-01) : les transitions multi-écritures de paie (statut + audit + stats) ne sont pas atomiques. Correction cible : migrer les transitions de paie vers `db.js` async (comme leave/advance/offboarding).

### ANO-SEC-01 / ANO-SEC-02 — voir `10-securite.md` — **CRITIQUE, priorité absolue paie**.
