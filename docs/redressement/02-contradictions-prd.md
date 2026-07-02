# 02 — Contradictions entre PRD, audits et code + nomenclature canonique

Date : 2026-07-02.

## 1. Contradictions documentaires

### CONTRA-01 — « Passe validée » vs contournement réel (identité)
- `AUDIT_INDUSTRIEL_MODULES.md` (2026-06-01) déclare : « routes users.js sans écriture directe users/profils ».
- Réalité : `backend/routes/users.js:120` — `UPDATE users SET actif = 0` en direct (désactivation), sans IdentityAccessService ni `permission_audit_logs`. Idem `users.js:370` (photo).
- Conséquence : la documentation revendique un invariant que le code ne tient pas — exactement ce que le PRD directeur interdit.

### CONTRA-02 — PRD cible vs activation réelle (trésorerie)
- `PRD_flux_…` et `tresorerie-prd.md` exigent : brouillon sans impact, validation avant effet, ledger canonique, virement 2 jambes.
- `WORKFLOW_CONTROL_BOARD.md` déclare la tranche « implémenté et testé localement » et l'activation « non exécutée automatiquement » — honnête.
- Mais aucun document ne dit clairement que **la production entière fonctionne encore sur le chemin legacy** (encaissements/virements immédiatement `valide`, migration 037 sans aucune position `ready`). Un lecteur des PRD croit le workflow actif ; il ne l'est pas.

### CONTRA-03 — Exemption lien agent : PRD vs code
- PRD directeur : « except admin and DG emergency accounts ».
- `identity_access.js:16` : `EMPLOYEE_LINK_EXEMPT_ROLES = ['admin']` — le DG n'est pas exempté.
- À trancher : soit le PRD est amendé (durcissement volontaire), soit le code doit exempter un compte d'urgence DG. Aujourd'hui il est impossible de créer un compte d'urgence DG non lié.

### CONTRA-04 — Deux modèles de clôture de caisse
- `PRD_operations_workflow.md` §7 définit `cashbox_closures` (migration 012).
- Le routeur utilise `caisses_clotures` (migration 010).
- Aucun des deux ne verrouille les saisies rétroactives au jour (constat C12 de l'audit du 23/06, non retraité).

### CONTRA-05 — Statuts de décaissement : trois vocabulaires
- PRD directeur : `draft, submitted, approved, paid, rejected, cancelled`.
- `PRD_operations_workflow.md` : `brouillon → soumis → en_attente_approbation → approuvé → payé`, `contrepassé`.
- Code : `dec_statut` ∈ `brouillon, soumis, valide, paye, rejete, annule` + `statut` ∈ `en_attente, valide, annule` + colonnes ERP `business_status/approval_status/payment_status` (migration 031, NULL sur le legacy).
- Trois couches de statuts coexistent sur la même ligne `operations`.

### CONTRA-06 — Statuts d'encaissement
- `PRD_operations_workflow.md` : `brouillon → soumis → validé` (+ litige).
- `PRD_flux_…` : validation ≠ confirmation des fonds (2 étapes distinctes).
- Code legacy : création directe `valide` (une étape). Code canonique (dormant) : `draft → submitted → approved → confirmed` avec fonds confirmés au posting ledger.

### CONTRA-07 — Statuts de paie
- PRD directeur : `generated, validated, submitted_to_dg, approved_by_dg, paid, cancelled`.
- Code périodes : `ouverte/preparation/controle_rh/controle_finance/soumis_dg/validee_dg` ; bulletins : `genere/valide/paye` (+ corrections).
- L'UI et les documents RH emploient « validé » tantôt pour le bulletin, tantôt pour la période — ambigu tant que la nomenclature n'est pas unifiée.

### CONTRA-08 — Modèles de permissions concurrents
- Quatre mécanismes décident d'un accès : rôles historiques (`hasRole`), modules (`requireModule`), profils/permissions effectives (`can()`), délégations. `ACCESS_CONTROL_MODEL.md` assume la transition ; mais des routes mélangent les niveaux (ex. `salaires.js` : module + rôle + permission dans la même route, avec gardes cassées). Le PRD exige que la décision finale soit la permission effective — non tenu partout.

### CONTRA-09 — `PRD_operations_workflow.md` écrit pour SQLite
- Schémas avec `AUTOINCREMENT`, `BEGIN IMMEDIATE`, `datetime('now')` — obsolètes pour la production MySQL. À réviser ou marquer « historique ».

### CONTRA-10 — Deux jeux de livrables de redressement
- La PR 64 (branche `hardening/conges-production-grade`) contient déjà un `docs/redressement/` (00→14, numérotation différente : 09-contrats, 11-audit-notifications, 14-verdict-final).
- Le présent jeu (branche `claude/decryptage-module-decaissement-vo56c8`) suit la numérotation de la mission (09-parapheur, 10-securite, …).
- **À réconcilier avant fusion** : un seul jeu doit faire foi, sinon deux vérités parallèles.

## 2. Nomenclature canonique unique (proposition ferme)

Tant que cette nomenclature n'est pas adoptée, **aucun nouveau code ne doit introduire de statut métier**.

### Opérations financières (encaissement, décaissement, virement)
| Statut canonique | Signification | Impact solde |
|---|---|---|
| `brouillon` | saisi, modifiable, supprimable | aucun |
| `soumis` | en attente de décision | aucun |
| `approuve` | décision favorable rendue (administrative) | aucun |
| `paye` / `confirme` | fonds réellement sortis (décaissement) / reçus (encaissement) | **oui — écriture ledger obligatoire, immuable ensuite** |
| `rejete` | refusé, motif obligatoire, resoumission possible | aucun |
| `annule` | abandonné avant effet | aucun |
| `contrepasse` | corrigé après effet par opération inverse liée | inverse lié |

Règles : `valide` (legacy) est déprécié — il signifie tantôt « approuvé » tantôt « effectif ». La prise d'effet est le posting ledger, jamais un UPDATE de statut seul.

### Paie
| Statut canonique | Objet |
|---|---|
| `genere` | bulletin |
| `valide_finance` | bulletin |
| `soumis_dg` | période |
| `approuve_dg` | période |
| `paye` | bulletin (exige période `approuve_dg` + décaissement lié) |
| `rectifie` | bulletin (post-paiement, par rectification liée, jamais recalcul) |

### RH (congés, avances, HS, sanctions, offboarding)
`brouillon → soumis → (vise_superieur) → approuve | rejete | annule → (applique)` — `applique` = effet système réalisé (solde décrémenté, retenue paie créée, accès révoqués). L'approbation parapheur ne vaut pas application : l'application est la synchronisation source, atomique avec la décision.

### Comptabilité
`draft → posted → reversed` — jamais de suppression ; période clôturée = aucune écriture, aucune anomalie ouverte.

### Présence
`absent, present, late, checked_out, incomplete, offsite` + marqueur orthogonal `manual_adjustment` (jamais un statut).

## 3. Décisions à faire arbitrer (métier)
1. Adopter la nomenclature ci-dessus et geler les synonymes.
2. Choisir la table de clôture unique (`caisses_clotures` OU `cashbox_closures`) et migrer l'autre.
3. Trancher CONTRA-03 (compte d'urgence DG).
4. Planifier l'activation position par position du ledger canonique (plan `scripts/plan_treasury_ledger_backfill_mysql.js`).
5. Fusionner les deux jeux `docs/redressement/` (CONTRA-10).
