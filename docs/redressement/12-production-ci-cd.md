# 12 — Audit Production et CI/CD

## 1. Verdict provisoire

**Production / CI-CD : non exploitable comme chaîne de déploiement industrielle prouvée.**

Le dépôt possède :

- workflow GitHub Actions ;
- tests avant déploiement ;
- Docker Compose ;
- MySQL ;
- migrations ;
- sauvegarde avant déploiement ;
- health check ;
- scripts de backfill ;
- vérifications post-déploiement ;
- PR 63 dédiée au durcissement du déploiement.

Mais l’état actuellement présent sur la branche auditée conserve des failles critiques :

- déploiement automatique à chaque push sur `main` ;
- connexion SSH root ;
- `StrictHostKeyChecking=no` ;
- IP de production codée en dur ;
- checkout du dernier `main`, pas d’un SHA exact explicitement autorisé ;
- modification automatique de `.env` en production ;
- mélange MySQL et fallback SQLite ;
- absence de rollback automatisé ;
- absence de preuve de restauration testée dans ce pipeline ;
- migrations, backfills et contrôles exécutés directement sur la production ;
- version réellement exécutée non prouvée hors logs du job.

La PR 63 corrige plusieurs de ces points, mais elle est encore ouverte, en brouillon et non fusionnée. Elle ne peut donc pas être considérée comme garantie active.

## 2. Pipeline observé

### 2.1 Déclenchement

Le workflow `.github/workflows/deploy.yml` se déclenche sur chaque push vers `main`.

### 2.2 Contrôle qualité

Le pipeline :

```text
checkout
→ Node 20
→ npm ci backend
→ npm test
→ configuration SSH
→ connexion VPS
→ git fetch main
→ checkout main
→ scripts/deploy.sh
```

### 2.3 Déploiement serveur

`scripts/deploy.sh` :

1. charge `.env` ;
2. sauvegarde MySQL ou SQLite ;
3. force `DB_DRIVER=mysql` si nécessaire ;
4. met à jour le code depuis la branche ;
5. construit l’image Docker ;
6. démarre MySQL ;
7. exécute les migrations ;
8. migre éventuellement SQLite vers MySQL ;
9. exécute plusieurs backfills ;
10. exécute des contrôles ciblés ;
11. démarre le conteneur applicatif ;
12. vérifie `/api/health`.

## 3. État de la PR 63

La PR 63, `ci: sécuriser la CI/CD de production`, introduit :

- déclenchement manuel ;
- SHA complet obligatoire ;
- confirmation `DEPLOY` ;
- vérification que le SHA appartient à `main` ;
- déploiement d’un SHA exact ;
- environnement GitHub `production` ;
- concurrence contrôlée ;
- actions épinglées par SHA ;
- utilisateur SSH non-root ;
- hôte et empreinte SSH via secrets ;
- suppression de `StrictHostKeyChecking=no` ;
- refus des fichiers suivis modifiés en production ;
- refus de modifier automatiquement `.env` ;
- vérification du SHA réel après déploiement ;
- health check final.

Verdict : **bonne correction de direction, non active tant que non fusionnée et déployée.**

## 4. Anomalies

### PROD-001 — Déploiement automatique à chaque push `main`

- Gravité : critique.
- Conséquence : toute fusion ou push direct peut déployer immédiatement sans fenêtre ni approbation.
- Correction : workflow manuel ou environnement protégé avec approbation.

### PROD-002 — Déploiement root

- Gravité : critique.
- Preuve : `root@5.196.22.149`.
- Conséquence : compromission du pipeline = contrôle total du serveur.
- Correction : compte dédié sans shell privilégié, sudo minimal et commandes autorisées.

### PROD-003 — Vérification SSH désactivée

- Gravité : critique.
- Preuve : `StrictHostKeyChecking=no`.
- Conséquence : attaque de type intermédiaire possible.
- Correction : empreinte fixe stockée dans un secret ou mécanisme de confiance contrôlé.

### PROD-004 — Infrastructure codée en dur

- Gravité : haute.
- Preuve : IP, chemin projet et nommage historique codés dans workflow et script.
- Conséquence : erreurs d’environnement, difficulté de rotation ou migration.
- Correction : variables d’environnement protégées et inventaire d’infrastructure.

### PROD-005 — Déploiement du dernier `main`, pas d’un SHA autorisé

- Gravité : critique.
- Preuve : le serveur fait `git fetch origin main` puis `checkout -B main origin/main`.
- Conséquence : le code testé au début du job peut différer du code récupéré ensuite si `main` avance.
- Correction : SHA immuable transmis au serveur et vérifié.

### PROD-006 — Modification automatique de `.env`

- Gravité : critique.
- Preuve : le script remplace ou ajoute `DB_DRIVER=mysql`.
- Conséquence : configuration production modifiée silencieusement par le déploiement.
- Correction : configuration préexistante validée, jamais corrigée automatiquement.

### PROD-007 — Fallback SQLite encore présent dans le déploiement

- Gravité : critique.
- Preuve : sauvegarde SQLite et migration conditionnelle vers MySQL.
- Conséquence : ambiguity sur la base réellement canonique et risque de rejouer une migration historique.
- Correction : déclarer MySQL comme seul runtime et sortir la migration SQLite du chemin normal de déploiement.

### PROD-008 — Marqueur local de migration fragile

- Gravité : critique.
- Preuve : fichier `.mysql_data_migrated` dans le dossier de backup.
- Conséquence : perte du marqueur, restauration serveur ou changement de volume peut rejouer une migration SQLite → MySQL.
- Correction : migration versionnée et enregistrée dans la base, avec contrôles d’idempotence.

### PROD-009 — Backfills exécutés à chaque déploiement

- Gravité : haute.
- Preuve : scripts organisationnels lancés systématiquement.
- Conséquence : durée variable, risque de réécriture et couplage entre déploiement et correction de données.
- Correction : migrations idempotentes versionnées ou jobs opératoires séparés et approuvés.

### PROD-010 — Tests MySQL métier incomplets avant production

- Gravité : critique.
- Preuve : `npm test` est exécuté, mais la suite globale a déjà rencontré une incompatibilité SQLite/MySQL et tous les scénarios métier MySQL spécialisés ne sont pas démontrés dans le workflow.
- Conséquence : pipeline vert avec chemins production non testés.
- Correction : job MySQL réel avec migrations complètes et tests critiques obligatoires.

### PROD-011 — Absence de preuve de restauration avant déploiement

- Gravité : critique.
- Preuve : sauvegarde créée, mais aucune restauration automatique sur environnement isolé.
- Conséquence : backup existant mais inutilisable au moment d’un incident.
- Correction : test périodique de restauration et rapport horodaté.

### PROD-012 — Backup local uniquement

- Gravité : critique.
- Preuve : sauvegardes sous `/opt/backups/...` sur le même serveur.
- Conséquence : perte simultanée serveur + données + sauvegardes.
- Correction : copie chiffrée hors site, rotation et vérification d’intégrité.

### PROD-013 — Secrets potentiellement exposés au shell

- Gravité : haute.
- Preuve : clé privée écrite dans un fichier local du runner; variables DB chargées dans le shell du script.
- Conséquence : fuite par logs, processus ou mauvaise permission.
- Correction : secret manager, permissions minimales, masquage et rotation.

### PROD-014 — Actions GitHub non toutes épinglées

- Gravité : haute.
- Preuve : `actions/checkout@v4` et `actions/setup-node@v4` dans l’état actuel.
- Conséquence : dépendance supply-chain mouvante.
- Correction : épingler les actions critiques par SHA, comme proposé dans PR 63.

### PROD-015 — Absence de rollback automatisé

- Gravité : critique.
- Preuve : le script quitte après health check en échec, sans restauration automatique du code, de l’image ou de la base.
- Conséquence : production partiellement migrée ou indisponible.
- Correction : stratégie blue/green ou release précédente, migration backward-compatible et procédure rollback testée.

### PROD-016 — Migrations non prouvées réversibles

- Gravité : critique.
- Conséquence : retour applicatif impossible après modification destructive du schéma.
- Correction : expand/migrate/contract et compatibilité N/N-1.

### PROD-017 — “Zéro downtime” non démontré

- Gravité : haute.
- Preuve : build pendant ancien conteneur, mais migration et remplacement du service sont couplés; aucun test de trafic continu n’est fourni.
- Conséquence : coupure ou erreurs pendant migration.
- Correction : test de disponibilité, readiness réelle et stratégie de bascule.

### PROD-018 — Health check trop superficiel

- Gravité : haute.
- Preuve : seul `/api/health` est interrogé.
- Conséquence : serveur répond alors que migrations, permissions, ledger, stockage ou email sont défaillants.
- Correction : readiness vérifiant DB, migrations, dépendances critiques et version.

### PROD-019 — SHA de production non exposé par l’application

- Gravité : haute.
- Conséquence : impossible de confirmer depuis l’extérieur quelle version sert les utilisateurs.
- Correction : endpoint version sécurisé, métrique et bannière d’administration.

### PROD-020 — Absence de registre de déploiement durable

- Gravité : haute.
- Conséquence : pas d’historique structuré de qui a déployé quoi, quand, pourquoi et avec quel résultat.
- Correction : table ou registre externe des releases, SHA, migrations, backup et validation.

### PROD-021 — Migrations et backfills avec compte DB surpuissant

- Gravité : haute.
- Preuve : `mysqldump` root et exécution de migrations depuis l’application.
- Conséquence : compromission d’un conteneur ou script = privilèges élevés.
- Correction : comptes DB séparés runtime, migration et backup.

### PROD-022 — Répertoire de production modifiable

- Gravité : haute.
- Preuve : l’état actuel écrase la branche locale; PR 63 ajoute seulement ensuite le refus des fichiers suivis modifiés.
- Conséquence : modifications manuelles invisibles ou écrasées.
- Correction : artefact immuable, image signée, aucun checkout mutable en production.

### PROD-023 — Dépendance directe à GitHub depuis la production

- Gravité : moyenne à haute.
- Preuve : `git fetch` depuis le VPS.
- Conséquence : déploiement impossible si GitHub indisponible; exposition de credentials éventuels.
- Correction : pousser un artefact ou une image immuable depuis CI vers un registre.

### PROD-024 — Supervision applicative non prouvée

- Gravité : critique.
- Conséquence : erreurs métier, saturation DB, dead-letter ou échecs cron peuvent rester invisibles.
- Correction : métriques, logs centralisés, alertes, traces et tableaux de bord.

### PROD-025 — Politique de rétention backup limitée et non documentée

- Gravité : haute.
- Preuve : suppression au-delà de 14 jours.
- Conséquence : restauration ancienne impossible; conformité non démontrée.
- Correction : politique RPO/RTO, rétention quotidienne/hebdomadaire/mensuelle et archivage.

### PROD-026 — Environnement de préproduction non prouvé

- Gravité : critique.
- Conséquence : migrations et scénarios réels testés directement en production.
- Correction : staging représentatif avec copie anonymisée et tests de déploiement.

## 5. Points positifs

- Test avant déploiement.
- Sauvegarde avant migration.
- `mysqldump --single-transaction`.
- Health check après démarrage.
- Docker Compose avec attente de santé.
- PR 63 corrige plusieurs défauts majeurs.
- Le script interdit explicitement `docker compose down -v`.

## 6. Pipeline cible

```text
PR
→ tests unitaires
→ tests intégration MySQL
→ analyse sécurité
→ build image immuable
→ signature et SBOM
→ déploiement staging
→ migrations compatibles
→ tests smoke et métier
→ approbation production
→ sauvegarde vérifiée
→ déploiement SHA/image exacte
→ readiness
→ tests post-déploiement
→ enregistrement release
→ supervision
```

## 7. Invariants obligatoires

1. La production exécute exactement le SHA approuvé.
2. Aucun déploiement root.
3. L’identité SSH est vérifiée.
4. Aucun secret n’est codé en dur.
5. Le runtime n’utilise que MySQL.
6. Une migration n’est exécutée qu’une fois et est traçable.
7. Toute sauvegarde critique est restaurable.
8. Une copie hors site existe.
9. Un rollback testé existe avant déploiement risqué.
10. Les artefacts sont immuables.
11. La version courante est observable.
12. Les erreurs critiques déclenchent une alerte.
13. La base runtime n’utilise pas un compte root.
14. Le déploiement possède un registre durable.

## 8. Ordre de redressement

### P0

1. Finaliser et revoir PR 63, sans fusion automatique.
2. Supprimer root et `StrictHostKeyChecking=no`.
3. Déployer un SHA exact.
4. Interdire la modification automatique de `.env`.
5. Retirer SQLite du chemin normal.
6. Ajouter tests MySQL critiques au quality gate.
7. Tester réellement la restauration.
8. Ajouter backup hors site.
9. Définir rollback et version observable.

### P1

1. Artefacts/images immuables.
2. Staging représentatif.
3. Comptes DB séparés.
4. Registre de releases.
5. Supervision centralisée.
6. SBOM et scan de dépendances.

## 9. Conclusion

Le pipeline actuel automatise beaucoup, mais il automatise aussi plusieurs risques. Le terme “zéro downtime” n’est pas encore prouvé, le rollback n’est pas garanti et la production dépend d’un checkout Git mutable exécuté en root. La PR 63 constitue la bonne direction, mais doit être revue, testée et fusionnée explicitement avant d’être considérée comme protection active.

La prochaine étape logique est `13-plan-corrections-priorise.md`, qui consolidera toutes les anomalies par gravité, dépendance et ordre d’exécution.
