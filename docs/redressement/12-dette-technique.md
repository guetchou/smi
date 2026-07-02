# 12 — Dette technique et architecture

## ANO-TEC-01 — Pseudo-transactions de la couche sync — **CRITIQUE (structurel)**
- **Preuve** : `backend/mysql_sync_facade.js` — `transaction(fn)` retourne `(...args) => fn(...args)` : **aucun BEGIN/COMMIT** en production MySQL. Toute route/service utilisant `database.js` (better-sqlite3 en dev, façade en prod) croit être transactionnel et ne l'est pas.
- **Consommateurs identifiés** : `periodes_paie.js`, `salaires.js` (db.prepare), `users.js`, `agents_safe_write.js`, `organigramme.js`, services organization_*. Les flux migrés vers `db.js` async (congés, avances, offboarding, parapheur sync, ledger, achats/stock workflows) sont, eux, réellement transactionnels.
- **Conséquence** : une panne au milieu d'une transition paie (statut + audit + stats) laisse un état partiel en production, alors que les tests locaux SQLite (vraie transaction) passent — divergence SQLite/MySQL exactement du type recherché par la mission.
- **Correction** : poursuivre la migration par tranches vers `db.js` (issue #43 « Fondation MySQL asynchrone ») en priorisant paie (ANO-RH-03) et users ; à défaut, implémenter de vraies transactions dans la façade (connexion dédiée + BEGIN/COMMIT sync-over-async — complexe, déconseillé).

## ANO-TEC-02 — Double couche d'accès données `database.js` / `db.js` — HAUTE
- `database.js` : 3 664 lignes mêlant schéma dev SQLite, seeds, migrations legacy, helpers. `db.js` : 331 lignes propres (pool mysql2, tx réelles).
- Règle documentée (`docs/ARCHITECTURE_DB.md`) : SQLite = dev/tests uniquement. Tenue en prod (DB_DRIVER=mysql forcé), mais la façade `translate()` (regex `datetime('now')`→`NOW()`, `strftime`→`DATE_FORMAT`, `INSERT OR IGNORE`→`INSERT IGNORE`) est fragile : tout SQL SQLite non couvert par une regex casse silencieusement en prod (les erreurs sont parfois avalées par des try/catch, ex. `server.js:113`).
- **Plan** : geler tout nouvel usage de `database.js` dans les routes (garde statique CI), migrer par domaine, puis réduire `database.js` au bootstrap dev.

## ANO-TEC-03 — Fichiers hors gabarit industriel — MOYENNE
| Fichier | Lignes | Cible |
|---|---|---|
| `frontend/dashboard.html` | 25 452 | découpe par module (PRD-refactorisation : premier incrément payroll-rectifications livré) |
| `backend/database.js` | 3 664 | voir TEC-02 |
| `backend/routes/salaires.js` | 3 208 | extraire services (paiement, corrections, CNSS/DGI) |
| `backend/routes/agents.js` | 2 445 | poursuivre l'extraction (safe_write déjà séparé) |
| `backend/routes/operations.js` | 2 364 | dépérir au profit du moteur canonique |
| `backend/routes/achats.js` | 1 558 | extraire workflows restants |

## ANO-TEC-04 — Vestiges SQLite actifs — BASSE→MOYENNE
- `server.js` : cron de sauvegarde `caisse.db` (sans objet MySQL) — supprimer/conditionner.
- `PRD_operations_workflow.md` : schémas SQLite (`BEGIN IMMEDIATE`, `AUTOINCREMENT`) — marquer historique (CONTRA-09).
- `scripts/migrate_sqlite_to_mysql.js`, `import_excel.py`, `backend/import-excel.js` : classer **keep (migration only)** avec bannière d'avertissement, conformément au PRD directeur (« classified as keep, migrate, or delete »).
- Volume Docker `caisse_data` : conserve l'héritage SQLite + uploads (DANGER.md) — ne pas purger sans inventaire.

## ANO-TEC-05 — Statuts triples sur `operations` — MOYENNE
`statut` + `dec_statut` + (`business_status`,`approval_status`,`payment_status`) coexistent (CONTRA-05). Le PRD flux prévoit la dépréciation des anciens couples après migration canonique. Toute nouvelle lecture doit passer par les colonnes ERP ; écrire un mapping documenté et un backfill.

## ANO-TEC-06 — Duplications fonctionnelles à surveiller — BASSE
- Deux modèles de clôture (C11/CONTRA-04).
- Deux jeux de docs redressement (CONTRA-10).
- `getSoldePosition`/`recalculateSoldes` (legacy) vs `cashbox_balances` (canonique) — assumé pendant la transition, à borner par l'activation.

## Méthode de suppression (rappel de la règle mission)
Avant toute suppression : (1) `rg` dépendances, (2) preuve de non-usage, (3) tests, (4) sauvegarde (git suffit — pas de `.bak`, conformément au control board), (5) plan de rollback (`git revert`). Aucun fichier n'a été supprimé dans cette passe.

## Gardes CI à ajouter (anti-dette, exigence PRD directeur)
1. Interdire `can(` non `await`é dans `backend/routes/**` (voir `10-securite.md`).
2. Interdire tout nouvel import de `database.js` dans `backend/routes/**` (liste blanche des existants, à faire décroître).
3. Interdire `db.transaction` de la façade dans les nouveaux services.
4. Vérifier qu'aucune position `ledger_status='ready'` ne coexiste avec du code legacy modifiant ses soldes hors ledger (invariant d'activation).
