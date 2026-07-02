# 11 — Audit production et exploitation

## 1. Chaîne de déploiement actuelle (main)

```
push main → GitHub Actions (npm test) → ssh root@5.196.22.149 → git checkout -B main origin/main → scripts/deploy.sh → docker compose build/up
```

### ANO-PROD-01 — CI/CD non durcie — **HAUTE** (corrigée par la PR 63, non fusionnée)
Défauts constatés dans `.github/workflows/deploy.yml` (main) :
- connexion **root** au VPS ;
- `-o StrictHostKeyChecking=no` qui **annule** l'empreinte pourtant ajoutée à `known_hosts` (MITM possible) ;
- IP et clé publique du serveur codées en dur dans le workflow ;
- déploiement de `origin/main` (branche mouvante), pas du SHA validé par les tests — le SHA testé et le SHA déployé peuvent différer si un push intervient entre les deux ;
- `deploy.sh` (main) réécrit silencieusement `.env` pour forcer `DB_DRIVER=mysql` — correction automatique masquant une mauvaise configuration.

### PR 63 — analyse (ne pas fusionner automatiquement : conditions ci-dessous)
Diff vérifié (3 fichiers, +121/−56) : `workflow_dispatch` avec SHA complet + confirmation « DEPLOY », validation `merge-base --is-ancestor` sur main, concurrency group, actions épinglées par SHA, environnement `production`, secrets `VPS_USER/VPS_HOST/VPS_KNOWN_HOSTS`, refus `VPS_USER=root`, `deploy.sh` en `set -Eeuo pipefail`, refus root, refus working tree sale, checkout détaché du SHA exact, vérification post-déploiement SHA + health check. `pr-checks.yml` : concurrency + checkout épinglé.

**Conforme aux exigences de la mission** (SHA exact, non-root, empreinte par secret). Conditions avant fusion :
1. créer l'utilisateur non-root sur le VPS avec droits docker + `/opt/projet-smi` (hors périmètre de ce dépôt — opération manuelle) ;
2. renseigner les 4 secrets, générer `VPS_KNOWN_HOSTS` (`ssh-keyscan` vérifié hors bande) ;
3. **décision d'exploitation** : la PR remplace le déploiement automatique au push par un déclenchement manuel — contredit `CLAUDE.md`/`DANGER.md` (« déploiement automatique via GitHub Actions ») → mettre à jour ces documents dans la même PR, sinon CONTRA documentaire ;
4. répétition sur un tag de test avant de retirer l'ancien chemin.
- `mergeable_state: unstable` au moment de l'audit — vérifier les checks avant fusion.

### PR 64 — analyse (résumé ; détail dans `09-parapheur.md` ANO-PAR-04)
Draft, 54 commits, 74 fichiers, +12 405/−594. Contenu réel : correctif critique des gardes async paie (ANO-SEC-01/02), refonte sync parapheur, moteur de délégations (667 lignes + migrations 043/044), moteur présence quotidienne, congés sans solde → paie, certificats médicaux, 6 migrations, un jeu complet `docs/redressement/` parallèle, et l'extension du scénario MySQL congés.
**Recommandation : ne pas fusionner en l'état.** Découper :
1. **PR-64a (urgente)** : uniquement les `await` de `periodes_paie.js` + `salaires.js` (correctif ANO-SEC-01/02) ;
2. PR-64b : refonte sync parapheur — à rebaser sur les correctifs d'atomicité `025c512` de la présente branche (conflit direct) ;
3. PR-64c : moteurs délégation/présence/congés sans solde — revue fonctionnelle séparée ;
4. PR-64d : documentation — fusionner avec le présent jeu (CONTRA-10).
Risques si fusion telle quelle : conflit avec les 13 commits de cette branche (`parapheur_source_sync_safe.js`, `salaires.js`, `operations.js`, `agents_ecosystem_safe.js`, `leave_workflow.js`), migrations 039-044 non rejouées en préproduction, surface de régression non testable d'un bloc.

## 2. Migrations
- `backend/migrations/runner.js` + journal des migrations appliquées ; testé (`tests/migration_runner_test.js`). Rejouable ✔.
- Migrations additives (pas de DROP destructif observé sur 001→038). Les `ALTER TABLE ADD COLUMN` sans garde sont protégés par le journal (une migration ne se rejoue pas) — idempotence **par le runner**, pas par le SQL : acceptable, à documenter.

## 3. Sauvegarde / restauration / export — **impossible à vérifier** (exécution VPS requise)
Présents dans le dépôt : `scripts/backup_db.sh`, `scripts/test_backup.sh`, `scripts/export_daily.js`, `scripts/rollback.sh`, `scripts/health_check.sh`, procédure DANGER.md. Non vérifiables d'ici : exécution réelle du cron de backup, restauration testée, rotation des logs, espace disque. **Action d'exploitation** : exécuter `test_backup.sh` et une restauration à blanc, consigner la preuve datée dans ce dossier.

## 4. Vestige SQLite en production
`server.js` (fin de fichier) : `setInterval` copiant `DB_PATH` (`caisse.db`) vers `data/backups` — sans objet en production MySQL (fichier absent → try/catch silencieux). À supprimer ou conditionner `DB_DRIVER!=='mysql'` (voir `12-dette-technique.md`).

## 5. Comptes de secours
`scripts/create_admin_secours.js` existe. Interaction avec l'invariant « compte opérationnel ⇒ agent lié » : le rôle `admin` est exempté, donc cohérent. Pour un compte d'urgence **DG**, voir CONTRA-03 (bloqué par le code actuel).

## 6. Santé / reprise
- `/api/health` présent (health_check.sh, PR 63 le sonde post-déploiement).
- Reprise après panne : `docker compose up -d --build` sans `-v` (DANGER.md) ; redémarrage conteneur = relance des crons `setInterval` de server.js — les tâches manquées pendant l'arrêt ne sont pas rattrapées (rappels, escalades) : accepté, à documenter.
- Échec de notification : non bloquant partout après les correctifs de cette branche — conforme PRD (user story 31).

## 7. Cohérence GitHub ↔ production — **impossible à vérifier d'ici**
Procédure existante : `ssh vps-ovh` + `git -C /opt/projet-smi log --oneline -3` (CLAUDE.md). La PR 63 automatise cette preuve (étape « Verify SHA and health »). En attendant : vérification manuelle à chaque déploiement.
