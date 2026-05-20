#!/bin/bash
# =============================================================================
# deploy.sh — Déploiement zéro-downtime Caisse TOP CENTER
# Appelé par GitHub Actions à chaque push sur main.
#
# Stratégie :
#   1. Backup DB
#   2. git reset --hard
#   3. docker compose build  ← build PENDANT que l'ancien conteneur tourne
#   4. docker compose up -d --wait  ← swap + attente healthcheck (max 2 min)
#   5. Vérification finale
#
# ⛔ NE JAMAIS utiliser docker-compose down -v (supprime les données !)
# =============================================================================
set -e

PROJECT_DIR="/opt/caisse-topcenter"
BACKUP_DIR="/opt/backups/caisse-topcenter"
DB_VOLUME_PATH="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
DATE=$(date +%Y%m%d_%H%M%S)
BRANCH="${DEPLOY_BRANCH:-main}"

echo "=============================================="
echo "  DÉPLOIEMENT — Caisse TOP CENTER"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="

# ── 1. Backup automatique de la DB ────────────────────────────────────────────
echo "[1/5] Backup de la base de données..."
mkdir -p "$BACKUP_DIR/daily"
if [ -f "$DB_VOLUME_PATH" ]; then
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$DB_VOLUME_PATH" ".backup '$BACKUP_DIR/daily/caisse_${DATE}.db'"
    echo "      ✅ Backup WAL-safe : $BACKUP_DIR/daily/caisse_${DATE}.db"
  else
    cp "$DB_VOLUME_PATH" "$BACKUP_DIR/daily/caisse_${DATE}.db"
    echo "      ⚠️  Backup (cp) : sqlite3 absent, installer avec apt install sqlite3"
  fi
  find "$BACKUP_DIR/daily" -name "caisse_*.db" -mtime +14 -delete
  echo "      ✅ Backups conservés : $(find "$BACKUP_DIR/daily" -name "caisse_*.db" | wc -l)"
else
  echo "      ⚠️  Aucune DB existante (premier déploiement)"
fi

# ── 2. Récupérer le code depuis GitHub ────────────────────────────────────────
echo "[2/5] Mise à jour du code..."
cd "$PROJECT_DIR"

if [ ! -d .git ]; then
  echo "      Init git..."
  git init
  git remote add origin https://github.com/guetchou/smi.git
fi

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "      ✅ Code mis à jour ($(git rev-parse --short HEAD))"

# ── 3. Build de l'image Docker ────────────────────────────────────────────────
# L'ancien conteneur reste actif pendant le build — pas de coupure ici.
echo "[3/5] Build de l'image Docker (l'ancien conteneur reste actif)..."
docker compose build caisse
echo "      ✅ Image construite"

# ── 4. Swap atomique avec attente healthcheck ──────────────────────────────────
# On démarre mysql d'abord et on attend qu'il soit healthy, puis caisse.
# --wait-timeout 120 : 2 minutes max par service.
echo "[4/5] Démarrage des conteneurs (attente healthcheck)..."
docker compose up -d --wait --wait-timeout 120 mysql
docker compose up -d --wait --wait-timeout 120 caisse
echo "      ✅ Conteneurs actifs et sains"

# ── 5. Vérification finale de santé ───────────────────────────────────────────
echo "[5/5] Vérification finale..."
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
echo "  Backup : $BACKUP_DIR/daily/caisse_${DATE}.db"
echo "=============================================="
