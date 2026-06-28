#!/bin/bash
# =============================================================================
# deploy.sh — Déploiement zéro-downtime Caisse TOP CENTER
# Appelé par GitHub Actions à chaque push sur main.
#
# Stratégie :
#   1. Backup DB
#   2. Synchronisation de la branche locale canonique avec origin/main
#   3. docker compose build  ← build PENDANT que l'ancien conteneur tourne
#   4. Migrations + backfill + contrôles MySQL
#   5. docker compose up -d --wait  ← swap + attente healthcheck
#   6. Vérification finale
#
# ⛔ NE JAMAIS utiliser docker-compose down -v (supprime les données !)
# =============================================================================
set -Eeuo pipefail

PROJECT_DIR="/opt/projet-smi"
BACKUP_DIR="/opt/backups/caisse-topcenter"
DB_VOLUME_PATH="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
DATE=$(date +%Y%m%d_%H%M%S)
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA est obligatoire}"

if [ "$(id -u)" -eq 0 ]; then
  echo "ERREUR : déploiement root interdit." >&2
  exit 1
fi

printf '%s' "$DEPLOY_SHA" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "ERREUR : SHA complet invalide." >&2
  exit 1
}
BACKUP_PATH=""

echo "=============================================="
echo "  DÉPLOIEMENT — Caisse TOP CENTER"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="

cd "$PROJECT_DIR"

echo "[1/6] Backup de la base de données..."
mkdir -p "$BACKUP_DIR/daily"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ "${DB_DRIVER:-}" != "mysql" ]; then
  echo "ERREUR : DB_DRIVER doit déjà être configuré à mysql." >&2
  exit 1
fi

if docker compose ps mysql --status running >/dev/null 2>&1; then
  MYSQL_BACKUP="$BACKUP_DIR/daily/mysql_${DATE}.sql.gz"
  docker compose exec -T mysql sh -lc 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
    | gzip > "$MYSQL_BACKUP"
  BACKUP_PATH="$MYSQL_BACKUP"
  echo "      ✅ Backup MySQL : $MYSQL_BACKUP"
  find "$BACKUP_DIR/daily" -name "mysql_*.sql.gz" -mtime +14 -delete
elif [ -f "$DB_VOLUME_PATH" ]; then
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$DB_VOLUME_PATH" ".backup '$BACKUP_DIR/daily/caisse_${DATE}.db'"
    BACKUP_PATH="$BACKUP_DIR/daily/caisse_${DATE}.db"
    echo "      ✅ Backup WAL-safe : $BACKUP_DIR/daily/caisse_${DATE}.db"
  else
    cp "$DB_VOLUME_PATH" "$BACKUP_DIR/daily/caisse_${DATE}.db"
    BACKUP_PATH="$BACKUP_DIR/daily/caisse_${DATE}.db"
    echo "      ⚠️  Backup (cp) : sqlite3 absent, installer avec apt install sqlite3"
  fi
  find "$BACKUP_DIR/daily" -name "caisse_*.db" -mtime +14 -delete
else
  echo "      ⚠️  Aucune DB existante (premier déploiement)"
  BACKUP_PATH="aucune base existante"
fi

echo "[2/6] Mise à jour du code..."
if [ ! -d .git ]; then
  echo "      Init git..."
  git init
  git remote add origin https://github.com/guetchou/smi.git
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERREUR : fichiers suivis modifiés en production." >&2
  git status --short
  exit 1
fi

git fetch origin main --prune
git cat-file -e "${DEPLOY_SHA}^{commit}"
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main
git checkout --detach "$DEPLOY_SHA"
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
echo "      ✅ Code positionné sur ${DEPLOY_SHA}"

echo "[3/6] Build de l'image Docker (l'ancien conteneur reste actif)..."
docker compose build caisse
echo "      ✅ Image construite"

echo "[4/6] Migration, reprise et contrôles MySQL..."
docker compose up -d --wait --wait-timeout 120 mysql

echo "      Schéma MySQL..."
docker compose run --rm caisse node -e "const { runMigrations } = require('./backend/migrations/runner'); const db = require('./backend/db'); runMigrations(db._pool).then(()=>db._pool.end()).catch(e=>{console.error(e); process.exit(1);});"

MYSQL_MIGRATION_MARKER="$BACKUP_DIR/.mysql_data_migrated"
if [ ! -f "$MYSQL_MIGRATION_MARKER" ] && [ -f "$DB_VOLUME_PATH" ]; then
  echo "      Migration données SQLite → MySQL..."
  docker compose run --rm caisse node scripts/migrate_sqlite_to_mysql.js
  date '+%Y-%m-%d %H:%M:%S' > "$MYSQL_MIGRATION_MARKER"
  echo "      ✅ Données migrées vers MySQL"
else
  echo "      ✅ Migration données déjà effectuée ou SQLite source absente"
fi

echo "      Synchronisation des postes officiels..."
docker compose run --rm caisse node scripts/backfill_org_jobs_mysql.js

echo "      Reprise des responsables historiques..."
docker compose run --rm caisse node scripts/backfill_department_functions_mysql.js

echo "      Contrôles du module organisation départementale..."
docker compose run --rm caisse node scripts/check_department_functions_mysql.js
docker compose run --rm caisse node scripts/check_org_event_integrity_mysql.js
echo "      ✅ Schéma, permissions, notifications, unités, postes, événements, unicité et transactions vérifiés"

echo "[5/6] Démarrage du nouveau conteneur..."
docker compose up -d --wait --wait-timeout 120 caisse
echo "      ✅ Conteneurs actifs et sains"

echo "[6/6] Vérification finale..."
if curl -sf --max-time 10 --connect-timeout 5 http://localhost:3337/api/health > /dev/null 2>&1; then
  echo "      ✅ /api/health répond"
else
  echo "      ⚠️  /api/health ne répond pas — vérifier les logs : docker logs caisse-topcenter --tail 50"
  exit 1
fi

echo ""
echo "=============================================="
echo "  ✅ DÉPLOIEMENT TERMINÉ SANS COUPURE"
echo "  Commit : $(git rev-parse --short HEAD)"
echo "  Backup : $BACKUP_PATH"
echo "=============================================="
